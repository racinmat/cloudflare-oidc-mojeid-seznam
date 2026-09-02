import * as jose from 'jose'

/**
 * Plný OIDC shim pro Seznam.
 *
 * Seznam OAuth2 nevydává id_token ani JWKS, takže Cloudflare s ním
 * napřímo mluvit nemůže. Worker se navenek tváří jako OIDC provider
 * (autorizace + token + jwks), uvnitř mluví se Seznamem přes obyčejné
 * OAuth2 a z /api/v1/user poskládá vlastní podepsaný id_token.
 */

const SIGNING_ALGORITHM = {
	name: 'RSASSA-PKCS1-v1_5',
	modulusLength: 2048,
	publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
	hash: { name: 'SHA-256' },
}

const IMPORT_ALGORITHM = {
	name: 'RSASSA-PKCS1-v1_5',
	hash: { name: 'SHA-256' },
}

const KEY_ID = 'seznam-oidc-shim-1'

const SEZNAM_AUTH_ENDPOINT = 'https://login.seznam.cz/api/v1/oauth/auth'
const SEZNAM_TOKEN_ENDPOINT = 'https://login.seznam.cz/api/v1/oauth/token'
const SEZNAM_USER_ENDPOINT = 'https://login.seznam.cz/api/v1/user'

async function loadOrGenerateKeyPair(kv) {
	const stored = await kv.get('keys', 'json')

	if (stored) {
		return {
			publicKey: await crypto.subtle.importKey('jwk', stored.publicKey, IMPORT_ALGORITHM, true, ['verify']),
			privateKey: await crypto.subtle.importKey('jwk', stored.privateKey, IMPORT_ALGORITHM, true, ['sign']),
		}
	}

	const keyPair = await crypto.subtle.generateKey(SIGNING_ALGORITHM, true, ['sign', 'verify'])

	await kv.put('keys', JSON.stringify({
		privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
		publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
	}))

	return keyPair
}

function handleSeznamAuthorize(url, env) {
	const clientId = url.searchParams.get('client_id')
	const redirectUri = url.searchParams.get('redirect_uri')

	// redirect_uri musí být přesně ten, co je zaregistrovaný u Seznamu -
	// worker ho k Seznamu posílá dál beze změny, nemůže to být cokoliv od
	// volajícího (jinak by šlo workera zneužít jako open redirect).
	if (clientId !== env.SEZNAM_CLIENT_ID || redirectUri !== env.SEZNAM_REDIRECT_URL) {
		return new Response('Bad request.', { status: 400 })
	}

	const params = new URLSearchParams({
		client_id: env.SEZNAM_CLIENT_ID,
		scope: 'identity',
		response_type: 'code',
		redirect_uri: env.SEZNAM_REDIRECT_URL,
		state: url.searchParams.get('state') ?? '',
	})

	return Response.redirect(`${SEZNAM_AUTH_ENDPOINT}?${params.toString()}`, 302)
}

// Cloudflare pošle client_secret buď v HTTP Basic hlavičce, nebo v těle
// požadavku (client_secret_post) - podporujeme obojí.
function extractClientSecret(request, body) {
	const authHeader = request.headers.get('Authorization')

	if (authHeader?.startsWith('Basic ')) {
		const decoded = atob(authHeader.slice('Basic '.length))
		const separatorIndex = decoded.indexOf(':')
		if (separatorIndex !== -1) {
			return decoded.slice(separatorIndex + 1)
		}
	}

	return body.get('client_secret')
}

async function handleSeznamToken(request, env) {
	const body = new URLSearchParams(await request.text())
	const code = body.get('code')
	const redirectUri = body.get('redirect_uri')
	const clientSecret = extractClientSecret(request, body)

	// CF_CLIENT_SECRET je secret vymyšlený jen pro tenhle účel (viz
	// README - wrangler secret put) - NENÍ to tajemství klienta u Seznamu.
	// Ověřuje, že volání přišlo skutečně od Cloudflare Access.
	if (clientSecret !== env.CF_CLIENT_SECRET) {
		return new Response('Bad request.', { status: 400 })
	}

	if (!code || redirectUri !== env.SEZNAM_REDIRECT_URL) {
		return new Response('Bad request.', { status: 400 })
	}

	const tokenResponse = await fetch(SEZNAM_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		// Seznam na rozdíl od většiny OAuth2 serverů chce JSON tělo, ne
		// application/x-www-form-urlencoded.
		body: JSON.stringify({
			grant_type: 'authorization_code',
			code,
			redirect_uri: env.SEZNAM_REDIRECT_URL,
			client_id: env.SEZNAM_CLIENT_ID,
			client_secret: env.SEZNAM_CLIENT_SECRET,
		}),
	})

	if (!tokenResponse.ok) {
		console.error('Seznam token exchange failed', tokenResponse.status, await tokenResponse.text())
		return new Response('Bad request.', { status: 400 })
	}

	const tokenData = await tokenResponse.json()

	const userResponse = await fetch(SEZNAM_USER_ENDPOINT, {
		headers: { Authorization: `bearer ${tokenData.access_token}`, Accept: 'application/json' },
	})

	if (!userResponse.ok) {
		console.error('Seznam user info failed', userResponse.status, await userResponse.text())
		return new Response('Bad request.', { status: 400 })
	}

	const userInfo = await userResponse.json()

	if (!userInfo.email) {
		// Bez tohohle by Cloudflare stejně odpověděl nesrozumitelnou hláškou
		// "User email was not returned" - radši to zarazit rovnou tady.
		console.error('Seznam user has no email set', userInfo.oauth_user_id)
		return new Response('Seznam účet nemá nastavený e-mail, přihlášení nelze dokončit.', { status: 400 })
	}

	const now = Math.floor(Date.now() / 1000)
	const name = [userInfo.firstname, userInfo.lastname].filter(Boolean).join(' ') || userInfo.email

	const { privateKey } = await loadOrGenerateKeyPair(env.KV)

	const idToken = await new jose.SignJWT({
		sub: String(userInfo.oauth_user_id),
		email: userInfo.email,
		email_verified: true,
		name,
		preferred_username: userInfo.email,
	})
		.setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
		.setIssuer(new URL(request.url).origin)
		.setAudience(env.SEZNAM_CLIENT_ID)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey)

	return Response.json({
		access_token: tokenData.access_token,
		refresh_token: tokenData.refresh_token,
		token_type: 'Bearer',
		expires_in: tokenData.expires_in,
		id_token: idToken,
	})
}

async function handleJwks(env) {
	const { publicKey } = await loadOrGenerateKeyPair(env.KV)

	return Response.json({
		keys: [{ alg: 'RS256', kid: KEY_ID, use: 'sig', ...(await crypto.subtle.exportKey('jwk', publicKey)) }],
	})
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)

		if (request.method === 'GET' && url.pathname === '/seznam/authorize') {
			return handleSeznamAuthorize(url, env)
		}

		if (request.method === 'POST' && url.pathname === '/seznam/token') {
			return handleSeznamToken(request, env)
		}

		if (request.method === 'GET' && url.pathname === '/jwks.json') {
			return handleJwks(env)
		}

		return new Response('Not found.', { status: 404 })
	},
}
