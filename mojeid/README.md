# MojeID → Cloudflare Access

Tenký Cloudflare Worker, který umožní přihlášení přes **MojeID** v Cloudflare Access, součásti
platformy [Cloudflare One](https://developers.cloudflare.com/cloudflare-one/) (dřív Cloudflare Zero
Trust). Funkčnost ověřena (2026-09).

## Proč je potřeba

MojeID je plnohodnotný OpenID Connect provider a Cloudflare s ním umí mluvit napřímo — **až na jednu
věc**: MojeID (běží na knihovně pyoidc) v běžném autorizačním flow vrátí `email` jen na `/userinfo`
endpointu, ne přímo v `id_tokenu`. Cloudflare Access ale čte identitu **jen z `id_tokenu`**, takže
bez dalšího zásahu skončíte na chybě:

```
User email was not returned. API permissions are likely incorrect.
```

MojeID e-mail do `id_tokenu` dá, pokud se o něj explicitně požádá parametrem `claims` v autorizačním
requestu. Jenže Cloudflare neumí do pole "Auth URL" v dashboardu přidat vlastní query parametr —
pokusí se za něj přilepit svoje vlastní (`client_id`, `redirect_uri`, ...) a vznikne rozbité
`?claims=...?client_id=...`.

Řešení: tenhle worker sedí mezi Cloudflare a MojeID `/authorization/` endpointem a parametr `claims`
dopíše za běhu. **Token endpoint i JWKS zůstávají přímo na `mojeid.cz`** — worker nikdy nevidí ani
nezná client secret, jen přesměrovává. Žádné úložiště, žádné závislosti.

## Krok 1 — registrace klienta u MojeID

1. Přihlaste se na <https://mojeid.cz/consumer_admin/> → **Založení nové služby**.
2. **Název klienta**: cokoliv popisného.
3. **Seznam URI**: `https://<váš-team>.cloudflareaccess.com/cdn-cgi/access/callback`
   (zjistíte v Cloudflare One dashboardu → Settings → Custom Pages, sekce team domain).
4. **Přihlašovací metoda pro token endpoint**: "Základní HTTP autentifikace". Důležité, protože jinak
   dostanete `Failed to exchange code for token. Make sure the client secret is correct`,
   i když je secret správně (MojeID žádost jen odmítne dřív, než se dostane ke kontrole kódu).
5. Uložit → v seznamu vznikne **ID klienta**. Přes odkaz **Aktualizovat** otevřete detail —
   **Tajemství klienta** je na posledním řádku formuláře.

Testovací instance pro vyzkoušení předem: <https://mojeid.regtest.nic.cz/consumer_admin/>
(stejný postup, endpointy na `mojeid.regtest.nic.cz`).

## Krok 2 — přidat MojeID jako IdP do Cloudflare

Cloudflare One dashboard → **Settings → Authentication → Login methods → Add new → OpenID Connect**:

| Pole | Hodnota |
|---|---|
| App ID (Client ID) | ID klienta z consumer_admin |
| Client secret | Tajemství klienta z consumer_admin |
| Auth URL | *(zatím)* `https://mojeid.cz/oidc/authorization/` |
| Token URL | `https://mojeid.cz/oidc/token/` |
| Certificate URL | `https://mojeid.cz/oidc/key.jwk` |
| PKCE | vypnuto (MojeID discovery neinzeruje `code_challenge_methods_supported`) |
| Scopes | `openid email profile` |

Klikněte **Test** — pokud dostanete `User email was not returned`, pokračujte krokem 3.

## Krok 3 — nasadit workera

```bash
git clone https://github.com/racinmat/cloudflare-oidc-mojeid-seznam.git
cd cloudflare-oidc-mojeid-seznam/mojeid

cp wrangler.toml.example wrangler.toml
# do wrangler.toml vyplnit MOJEID_CLIENT_ID = ID klienta z kroku 1

npm install
npx wrangler login   # jen poprvé, otevře prohlížeč
npx wrangler deploy
```

Výstup ukáže URL workeru, typicky `https://mojeid-oidc-cloudflare-access-proxy.<vaše-subdomain>.workers.dev`.

## Krok 4 — přepnout Cloudflare na worker

Zpátky v Login methods → MojeID → upravit **jen Auth URL**:

```
https://mojeid-oidc-cloudflare-access-proxy.<vaše-subdomain>.workers.dev/mojeid/authorize
```

Token URL a Certificate URL nechte beze změny na `mojeid.cz`. Uložit → **Test** → očekávaný výsledek:
`Your connection works!` s vyplněným `email`.

**Worker nechte na `*.workers.dev`** — pokud by ho pokryla vlastní Access aplikace na vaší doméně,
worker by se zamkl sám za sebe.

## Debugging

```bash
npx wrangler tail
```

Spustit před kliknutím na Test v Cloudflare.

| Chyba | Příčina |
|---|---|
| `Not found.` (404) | Cloudflare volá jinou cestu, než `/mojeid/authorize` |
| `Bad request.` (400) | `client_id` od Cloudflare neodpovídá `MOJEID_CLIENT_ID` ve `wrangler.toml` |
| `Failed to exchange code for token` i po nasazení workeru | Token URL byl omylem přepsaný na worker — musí zůstat na `mojeid.cz` |
| `User email was not returned` i po nasazení workeru | Auth URL pořád ukazuje na `mojeid.cz` přímo, ne na worker |

Ruční ověření, co MojeID skutečně vrací (bez Cloudflare, přímo curl/PowerShell):

```bash
# 1) otevřít v prohlížeči, redirect_uri musí být přesně registrované URI
https://mojeid.cz/oidc/authorization/?response_type=code&scope=openid%20email%20profile&client_id=<ID_KLIENTA>&state=x&redirect_uri=<REDIRECT_URI>

# 2) z adresy po přihlášení vzít ?code=... a hned vyměnit (kód je jednorázový a krátce platný)
curl -s -X POST https://mojeid.cz/oidc/token/ \
  -u <ID_KLIENTA>:<TAJEMSTVI_KLIENTA> \
  -d grant_type=authorization_code \
  -d code=<CODE> \
  -d redirect_uri=<REDIRECT_URI>

# 3) prostřední část id_tokenu (JWT) dekódovat jako base64url a zkontrolovat "email"
```
