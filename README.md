# Cloudflare Access + MojeID + Seznam.cz

Návod a hotové Cloudflare Workers na napojení **MojeID** a **Seznam.cz** jako přihlašovacích metod
(Identity Providerů) do Cloudflare Access, součásti platformy
[Cloudflare One](https://developers.cloudflare.com/cloudflare-one/) (dřív Cloudflare Zero Trust).
Oficiální dokumentace obou služeb tohle přímo nepokrývá a člověk narazí na pár nečekaných zdí — tenhle
repo je zápis toho, jak se přes ně dostat.

- **[mojeid/](mojeid/)** — tenký proxy worker (žádné úložiště, žádné závislosti)
- **[seznam/](seznam/)** — plný OIDC shim (Seznam žádný OIDC vůbec nemá)

## Proč to nejde napřímo

Cloudflare Access generic OIDC formulář čeká tři věci od identity providera: Auth URL, Token URL a
**Certificate URL** (`jwks_uri`, kterým ověřuje podpis `id_tokenu`). A hlavně: **Cloudflare čte
identitu (email, jméno, ...) jen z `id_tokenu`**, nikdy z `/userinfo` endpointu — i když by tam
příslušná data byla.

**MojeID** je plnohodnotný OIDC provider a splňuje všechny formální požadavky, ale běží na knihovně
pyoidc, která v běžném autorizačním flow (`response_type=code`) vrátí e-mail jen na `/userinfo`,
dokud si ho člověk explicitně nevyžádá parametrem `claims`. Cloudflare ale do Auth URL neumí přidat
vlastní query parametr (pokusí se za něj přilepit svoje vlastní a vznikne rozbité
`?claims=...?client_id=...`). Řešení je tenký worker, který jen tohle přesměrování obstará —
[mojeid/](mojeid/).

**Seznam.cz** nabízí jen obyčejné OAuth 2.0 ([dokumentace](https://vyvojari.seznam.cz/oauth/doc)),
ne OpenID Connect — žádný `id_token`, žádné JWKS, žádná discovery. Tady musí worker sehrát roli
celého OIDC providera (autorizace + token + JWKS) a vlastní `id_token` poskládat sám z dat, která
vrátí Seznam API — [seznam/](seznam/).

## Past u MojeID: špatná autentizační metoda

I s registrovaným klientem může výměna kódu za token spadnout na:

```
Failed to exchange code for token. Make sure the client secret is correct.
```

Cloudflare posílá `client_secret` k token endpointu přes **HTTP Basic autentizaci**
(`client_secret_basic`), zatímco nově založený klient u MojeID je defaultně nastavený na
**`client_secret_post`** (secret v těle požadavku). MojeID žádost s nesprávnou metodou odmítne dřív,
než se vůbec dostane ke kontrole kódu — takže secret je ve skutečnosti správně, jen se posílá jinak,
než klient čeká. Oprava je v consumer_admin přepnout **Přihlašovací metoda pro token endpoint** na
variantu s HTTP hlavičkou.

## Rychlý start

Podrobný návod je v [mojeid/README.md](mojeid/README.md) a [seznam/README.md](seznam/README.md).
V kostce pro oba:

1. Zaregistrovat klienta (MojeID: `consumer_admin`, Seznam: `vyvojari.seznam.cz/oauth/admin`) s
   redirect URI `https://<váš-team>.cloudflareaccess.com/cdn-cgi/access/callback`.
2. `git clone`, zkopírovat `wrangler.toml.example` na `wrangler.toml`, vyplnit, `npx wrangler deploy`.
3. V Cloudflare One dashboardu přidat nový OpenID Connect login method, Auth/Token/Certificate URL
   ukázat na worker (u MojeID jen Auth URL, Token/Certificate zůstávají přímo na `mojeid.cz`).
4. **Test** v Login methods, pak zapojit do politik konkrétních Access aplikací.

## Poděkování

Princip "worker jako OIDC shim před Cloudflare Access" není nový — inspirace a ověření, že Cloudflare
akceptuje `id_token` s libovolným `iss` a bez `nonce`/skutečného OIDC `sub`, pokud má platný podpis
přes JWKS: [Erisa/discord-oidc-worker](https://github.com/Erisa/discord-oidc-worker).

## Licence

[MIT](LICENSE)
