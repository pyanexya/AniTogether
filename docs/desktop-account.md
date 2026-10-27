# Optional AnixArtix account (Cloudflare development)

This is separate from the Anixart catalogue login (`Login.svelte`) and from anonymous invitation rooms. It is not required for browsing, playback or rooms. The main app does not fetch account services at startup; opening **Settings → Аккаунт AnixArtix** loads account information lazily.

## Deployment prerequisites

The fixed issuer is `https://aniartix.pyanexy.cc`. It must serve the API and portal described in `cloudflare/auth.md`. No deployment, DNS or provider credentials are created by this integration. Google/Discord identity providers must be configured server-side. Google mail access is not requested. A missing backend/provider is an unavailable state, not an anonymous or fabricated authenticated identity.

## Native boundary

- Rust generates a random PKCE verifier and S256 challenge. Only challenge is sent to `/api/desktop/start`.
- An exact HTTPS issuer/path/fragment check precedes opening the system browser. Neither room URLs nor JavaScript can supply an account API origin.
- UI receives only a local attempt ID and visible eight-character pairing code. User must compare it with the browser and explicitly approve. The verifier, grant and browser verification URL remain native.
- `/api/desktop/exchange` is polled no faster than every five seconds, with at most one request per grant in flight and a five-minute deadline. Cancel/restart/logout invalidates old generations, including responses already in flight.
- The resulting opaque bearer never crosses IPC, localStorage or logging. All authenticated requests go through fixed native routes to the issuer; redirects are refused. Responses are bounded to 64 KiB and requests time out after 20 seconds.
- `/api/me` is projected to public profile fields, provider names and linked Shikimori id/nickname, excluding CSRF/provider tokens.
- Profile editing and Shikimori linking use the explicit browser portal, not embedded provider secrets. The browser has its own session and may require a separate login.

## Storage and logout

Without “remember me”, session is memory-only. With it, Windows Credential Manager stores the issuer-bound session using `keyring`'s Windows native backend; there is no plaintext fallback. Vault failures produce a warning and retain only the current in-memory session. If deleting an old credential fails, the warning explicitly notes it might remain in the OS vault.

Logout first clears local state and attempts credential deletion, then attempts backend revocation. Offline revocation failure is disclosed; it is not described as successful remote logout. Expired/wrong-issuer vault entries are rejected; HTTP401 clears the current session. Nothing changes catalogue credentials or custom room URLs.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features --lib` exercises the state machine with a deterministic mock transport and vault; it is not a live OAuth test. `npm test -- --run test/account.test.js` exercises the UI controller's races and fixed IPC routes. Windows CI and a manual Windows10/11 Credential Manager/browser pairing test remain necessary. Do not claim live provider login or backend deployment based on these tests.
