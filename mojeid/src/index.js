/**
 * Tenký OIDC proxy pro MojeID.
 *
 * Cloudflare Access čte identitu jen z id_tokenu, ne z /userinfo. MojeID
 * (pyoidc) v běžném code flow dá email do id_tokenu jen na výslovné
 * vyžádání parametrem `claims`, a Cloudflare neumí do Auth URL přidat
 * vlastní query parametry. Tenhle worker proto jen přeposílá autorizační
 * request na MojeID a parametr `claims` do něj dopíše. Token endpoint i
 * JWKS zůstávají přímo na mojeid.cz - worker nezná client secret a nic
 * nepodepisuje.
 */

const MOJEID_AUTH_ENDPOINT = 'https://mojeid.cz/oidc/authorization/'

const MOJEID_CLAIMS = JSON.stringify({
	id_token: { email: { essential: true } },
	userinfo: { email: { essential: true } },
})

export default {
	async fetch(request, env) {
		const url = new URL(request.url)

		if (url.pathname !== '/mojeid/authorize') {
			return new Response('Not found.', { status: 404 })
		}

		if (url.searchParams.get('client_id') !== env.MOJEID_CLIENT_ID) {
			return new Response('Bad request.', { status: 400 })
		}

		const params = new URLSearchParams(url.search) // vše, co poslal Cloudflare
		params.set('claims', MOJEID_CLAIMS)

		return Response.redirect(`${MOJEID_AUTH_ENDPOINT}?${params.toString()}`, 302)
	},
}
