# AnixArtix accounts — source implementation, not a live service

The desktop's existing Anixart credentials remain separate. Google and Discord are
new **AnixArtix** account providers; signing into each creates separate accounts.
There is deliberately no automatic email merge or provider-account linking.
Google mailboxes are never accessed. Discord requests only `identify`.

## Configuration before any deployment

`wrangler.jsonc` contains an intentionally invalid all-zero D1 ID, no route and no
workers.dev endpoint. Replace it only after the owner authorizes resource creation.
The migration is `migrations/0001_auth.sql`. The canonical `APP_ORIGIN` must be HTTPS,
with no trailing slash (default `https://aniartix.pyanexy.cc`). Bind `DB`, `ROOMS`,
and `ASSETS`. No paid plan or resource creation is implied by this source.

Register **your own** Google/Discord/Shikimori applications. Their exact callbacks:

- `https://aniartix.pyanexy.cc/api/auth/google/callback`
- `https://aniartix.pyanexy.cc/api/auth/discord/callback`
- `https://aniartix.pyanexy.cc/api/auth/shikimori/callback`

Set secrets with Wrangler/dashboard, never in Git or a desktop binary:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `SHIKIMORI_CLIENT_ID`, `SHIKIMORI_CLIENT_SECRET`,
`TOKEN_ENCRYPTION_KEY` (cryptographically random 32 bytes, standard base64).
The latter protects Shikimori tokens using AES-256-GCM with user-bound authenticated
data; loss/rotation without migration requires relinking. No Google/Discord provider
tokens or emails are persisted. Missing provider configuration returns 503 and the
capabilities API disables that provider. Live sign-in requires real setup/testing.

## Browser/API contract

- `GET /health`, `GET /api/capabilities` expose configuration, not secret values.
- `POST /api/auth/google/start` or `discord/start` requires exact `Origin` and returns
  `{authorizationUrl}`. Redirect browser there. OAuth state is single-use, hashed,
  10-minute, and bound to an HttpOnly browser cookie. Google also uses nonce and PKCE.
- OAuth callback verifies provider identity and redirects to `/profile` with a
  Secure, HttpOnly, SameSite=Lax, host-only session cookie. Sessions are random
  256-bit values, hashed in D1, with a 30-day hard expiry.
- `GET /api/me` returns own `{profile,csrfToken,identities,shikimori}`. Anonymous 401.
- `PATCH /api/me` allowlist: `username` 3–24 ASCII letters/digits/underscore;
  `displayName` 1–64; `bio` 0–500; `avatar` one of `''`, `cat`, `moon`, `star`,
  `sakura`, `fox`. No control characters. Server ignores no unknown field: rejects it.
- `GET /api/profiles/:id` returns only id/username/displayName/bio/avatar; no provider
  identifiers, emails, tokens, session identifiers or Shikimori linkage.
- Cookie-authenticated writes require exact `Origin` AND `X-CSRF-Token` from `/api/me`.
  Requests with `Authorization: Bearer <own-session>` do not use cookies or CSRF.
- `POST /api/auth/logout` revokes current session; `DELETE /api/auth/sessions` atomically
  revokes all own sessions and approved, unexchanged desktop grants.
- Errors are `{error: snake_case_code}`; no upstream response bodies/secrets logged.

## Native desktop handoff (not yet wired into Tauri)

1. Generate a PKCE verifier (43–128 RFC7636 characters); compute S256 challenge.
2. `POST /api/desktop/start` JSON `{challenge}` returns random `grant`,
   `verificationUrl`, 8-character `pairingCode`, `expiresIn:300`, `interval:5`.
3. Open verification URL in **system browser**. Portal retains fragment grant in
   sessionStorage through sign-in, shows code and warns about unsolicited requests.
4. Authenticated browser calls `POST /api/desktop/inspect` `{grant}` with CSRF to get
   code and expiry; user explicitly compares the code displayed by the initiating
   desktop and approves with `POST /api/desktop/approve` `{grant,consent:true}`.
   Never automatically approve on callback or because the browser is signed in.
5. Desktop polls `POST /api/desktop/exchange` `{grant,verifier}` no faster than 5s.
   428 `authorization_pending`; 400 invalid/expired/consumed; success
   `{accessToken,tokenType:'Bearer',expiresAt}`. Session issuance and grant consumption are one atomic D1 batch; revoke-all cannot
   interleave between them. Approval also checks the browser session is still live.
6. Store bearer in OS credential storage, not plaintext frontend localStorage.

No arbitrary return URI, custom-scheme redirect, shared app token, or embedded
OAuth secret exists. Pairing must be tested end-to-end in Windows before release.

## Shikimori

Authenticated browser explicitly consents via
`POST /api/auth/shikimori/start` `{consent:true}`, CSRF required. Callback is also
bound to the initiating live app session. Ownership comes from authenticated
`/api/users/whoami`, not nickname. Tokens are encrypted server-side. The internal
`shikimoriToken` helper refreshes server-side with a short D1 refresh lease and compare-and-swap storage;
no public endpoint returns them. No list sync is implemented, so no `user_rates`
scope is requested. Add this only with a separate explicit consent feature.
`DELETE /api/shikimori` removes local linkage/tokens; the response explicitly says
provider revocation is still required in Shikimori account settings. This operation
does not pretend to revoke provider-side authorization.

## Tests and limits

`npm ci && npm test`; `npm run check` performs a **dry-run only**. Use writable
`XDG_CONFIG_HOME` if the runner has no home config directory. Tests include real
SQLite query/migration semantics through Node SQLite, actual workerd/D1 auth
runtime including concurrent grant consumption, and workerd/SQLite DO room checks. Provider calls are mocked, not evidence of live OAuth success.
Hourly scheduled cleanup deletes expired grants/states/sessions/rate buckets.
D1 rate buckets bound requests per IP; deploy also needs appropriate Cloudflare
abuse/WAF limits. Invite rooms remain anonymous capabilities, not verified profiles.

Official references checked 2026-10-27:
- https://developers.google.com/identity/openid-connect/openid-connect
- https://docs.discord.com/developers/topics/oauth2
- https://shikimori.io/oauth
- https://developers.cloudflare.com/d1/worker-api/prepared-statements/

## Dashboard-first deployment

The configured database ID is supplied by the owner for `anixartix`. The domain is `aniartix.pyanexy.cc`; no deployment is implied by configuration alone. On that intended database, its Console can run `migrations/0001_auth.sql` once before first deployment. The initial schema is idempotent and does not delete existing rows. Never run unrelated example SQL that drops tables. Later Wrangler migrations can record the initial migration safely, but no schema/data migration should be applied to a different database.

Workers Builds should use this repository's `work/anixartix-tauri` branch, root directory `cloudflare`, Worker name `anixartix-backend`, and deploy command `npx wrangler deploy`. Cloudflare may require a user-approved build token/integration with appropriate account and custom-domain route permissions. Keep tokens in Cloudflare, never in chat or Git. Only enable a paid plan after explicit cost approval. OAuth secrets are configured separately; without them the corresponding provider remains unavailable.
