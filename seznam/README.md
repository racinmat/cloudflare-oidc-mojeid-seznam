# Seznam.cz → Cloudflare Access

Cloudflare Worker, který umožní přihlášení přes účet **Seznam.cz** v Cloudflare Zero Trust Access.
Ověřeno funkční (2026-09).

## Proč je potřeba

Cloudflare Access generic OIDC formulář vyžaduje tři URL: Auth URL, Token URL a **Certificate URL**
(`jwks_uri`, kterým Cloudflare ověřuje podpis `id_tokenu`). Seznam OAuth 2.0
([dokumentace](https://vyvojari.seznam.cz/oauth/doc)) je ale čisté OAuth2 podle RFC 6749, **ne
OpenID Connect** — nevydává žádný `id_token`, nemá JWKS, nemá ani discovery
(`.well-known/openid-configuration`). Bez podepsaného `id_tokenu` nemá Cloudflare jak Seznamu věřit.

Řešení: tenhle worker se navenek tváří jako OIDC provider (vlastní Auth/Token/JWKS endpoint), uvnitř
mluví se Seznamem přes jeho OAuth2 API a z odpovědi `/api/v1/user` poskládá vlastní podepsaný
`id_token`. Stejný princip používají existující projekty na napojení Discordu do Cloudflare Access,
např. [Erisa/discord-oidc-worker](https://github.com/Erisa/discord-oidc-worker) — odtud i inspirace
pro strukturu tohoto workeru.

## Krok 1 — registrace služby u Seznamu

1. Přihlaste se na <https://vyvojari.seznam.cz/oauth/admin> a přidejte novou službu.
2. **redirect_uri**: `https://<váš-team>.cloudflareaccess.com/cdn-cgi/access/callback`
   (zjistíte v Zero Trust → Settings → Custom Pages, sekce team domain) — to je redirect URI
   **workeru vůči Cloudflare**; worker při přesměrování na Seznam pošle tuhle stejnou hodnotu jako
   svůj vlastní `redirect_uri` pro Seznam.
3. Po uložení vznikne **ID klienta** a **OAuth tajemství**.

## Krok 2 — nasadit workera

```bash
git clone https://github.com/racinmat/cloudflare-oidc-mojeid-seznam.git
cd cloudflare-oidc-mojeid-seznam/seznam

cp wrangler.toml.example wrangler.toml
# do wrangler.toml vyplnit SEZNAM_CLIENT_ID a SEZNAM_REDIRECT_URL

npm install
npx wrangler login   # jen poprvé

npx wrangler kv namespace create KV
# vrácené "id" zapsat do wrangler.toml

npx wrangler secret put SEZNAM_CLIENT_SECRET
# vložit skutečné OAuth tajemství ze Seznamu

openssl rand -hex 32   # vygeneruje vlastní vymyšlený secret
npx wrangler secret put CF_CLIENT_SECRET
# vložit vygenerovanou hodnotu

npx wrangler deploy
```

**Dva různé secrety, nezaměňovat:**

| Secret | Odkud | K čemu |
|---|---|---|
| `SEZNAM_CLIENT_SECRET` | skutečné OAuth tajemství z `vyvojari.seznam.cz/oauth/admin` | worker ho používá jen při volání `login.seznam.cz`, Cloudflare ho nikdy nevidí |
| `CF_CLIENT_SECRET` | vlastní vymyšlený řetězec (`openssl rand -hex 32`) | worker jím ověřuje, že `/seznam/token` volá skutečně Cloudflare Access, ne někdo, kdo uhodl URL |

## Krok 3 — přidat Seznam jako IdP do Cloudflare

Zero Trust dashboard → **Settings → Authentication → Login methods → Add new → OpenID Connect**:

| Pole | Hodnota |
|---|---|
| App ID (Client ID) | ID klienta z `vyvojari.seznam.cz` |
| Client secret | vlastní vymyšlený secret (`CF_CLIENT_SECRET`), **ne** ten od Seznamu |
| Auth URL | `https://<worker>.workers.dev/seznam/authorize` |
| Token URL | `https://<worker>.workers.dev/seznam/token` |
| Certificate URL | `https://<worker>.workers.dev/jwks.json` |
| PKCE | vypnuto |

Uložit → **Test**.

## Debugging

```bash
npx wrangler tail
```

| Chyba | Příčina |
|---|---|
| `Bad request.` na `/seznam/authorize` | `client_id` nebo `redirect_uri` od Cloudflare neodpovídá `wrangler.toml` |
| `Bad request.` na `/seznam/token`, log ukazuje selhání ověření secretu | `CF_CLIENT_SECRET` v Cloudflare dashboardu se neshoduje s tím z `wrangler secret put` |
| `Seznam token exchange failed` v logu | špatný `SEZNAM_CLIENT_SECRET`, nebo Seznam změnil formát API (zkontrolovat aktuální [dokumentaci](https://vyvojari.seznam.cz/oauth/doc)) |
| `Seznam účet nemá nastavený e-mail…` | uživatel opravdu nemá e-mail u účtu vyplněný — není co ladit |
| worker vrací 500 bez logu | KV binding se nejmenuje přesně `KV` |
