# Bermuda — Repair Notes (Mission Phases B–E, code only)

Implemented from `AUDIT-BASELINE.md`. Local changes only: no deploys, no API calls, no pushes. No secret values were printed or introduced anywhere; every change below moves credentials *out* of embedded script text and into Worker bindings.

## Panel (`panel/`)

### `src/settings/store.ts`
- `storeGetJson` is now corruption-safe: a `JSON.parse` failure logs only the key name and returns `null` (callers fall back to defaults for that key) instead of aborting the whole dataset load. The failure-resetting init promise was already correct and is unchanged.

### `src/api/warp.ts`
- The `storePut('warpAccounts', …)` inside `fetchWarpAccounts` is wrapped in its own try/catch: a persistence failure is logged explicitly (message only, no values) and rethrown, so the outer fallback to default accounts is no longer silent about the failed write.

### `src/auth/auth.ts` (rewritten)
- **Password hashing:** new passwords are stored under `pwd` as a versioned PBKDF2 record `pbkdf2$<iterations>$<salt_b64>$<hash_b64>` — WebCrypto PBKDF2/SHA-256, 100,000 iterations, 16-byte random salt, 32-byte derived key, constant-time comparison.
- **Legacy migration:** a stored value without the `pbkdf2$` prefix is treated as legacy plaintext; on a successful login it is immediately re-stored hashed.
- **Login (`generateJWTToken`):** verifies via the new verifier for both formats; unchanged 401 on genuine mismatch.
- **JWT secret:** when a new `secretKey` is generated it is read back after the write; login only proceeds if the read-back matches, otherwise a 500 is returned.
- **`authenticate()`:** storage (D1) errors now propagate and surface as 500-class failures; only a missing secret/key or a JWT verification failure returns `false`.
- **`resetPassword`:** POST-only; server-side presence + type checks for the password; server-side policy identical to the frontend rule (`^(?=.*[A-Z])(?=.*\d).{8,}$`); "same as old password" is detected via the verifier (works for hashed and legacy records); the new hash is read back after writing; on success the stored `secretKey` is rotated, invalidating all previously issued JWTs.

### `src/assets/panel/script.js`
- The reset-password form now posts `Content-Type: application/json` (was `text/plain`), matching the backend's JSON parsing.

### `src/worker.ts`
- Every handler call inside the router's try/catch (including the WebSocket branch, the fallback, and `renderError` itself) is now `await`ed, so asynchronous rejections reach the error boundary instead of escaping to the runtime.

### `src/handlers/error.ts`
- Rendering is guarded: if decompression/rendering throws, a minimal plain-text `500` response is returned. Error pages now return HTTP **500** (previously 200). The original error is logged via `safeError` (no values beyond the message).

### `src/api/usage.ts`
- `getUsage`: unauthenticated requests now return **401** (previously the auth failure was thrown and converted to 500). Internal/upstream failures still return 500; storage errors thrown by `authenticate()` land in the 500 path.

### Credential bindings (`CF_API_TOKEN` / `CF_ACCOUNT_ID`)
- `src/types/global.d.ts`: `Env` gains `CF_API_TOKEN: string` and `CF_ACCOUNT_ID: string`.
- `src/settings/settings.ts` (`init()`): the runtime token/account ID are sourced from the env bindings first, falling back to `EMBEDED_SETTINGS` only when the bindings are absent (transition compatibility for existing installs). All existing consumers keep using `getGlobals()` unchanged.
- `src/settings/main.ts`: `buildScript` and `updateMainSettings` now embed `apiToken: ''` — a rebuilt or self-updated script never re-embeds the runtime token. (This also stops the token from appearing in the settings object returned by the reset-settings endpoint.)
- `src/api/workers.ts` (`deployWorkers`): upload metadata keeps the `d1` binding via `keep_bindings: ['d1']` and additionally sets `CF_API_TOKEN` as a `secret_text` binding and `CF_ACCOUNT_ID` as `plain_text`, with values taken from the current runtime globals (which `init()` sourced from the env bindings).
- `src/api/pages.ts` (`deployPages`): the deployment multipart now includes `deployment_configs.production.env_vars` with `CF_API_TOKEN` as `secret_text` and `CF_ACCOUNT_ID` as `plain_text`, so Pages redeploys preserve the bindings too.

## Web wizard (`wizard/web/`)

### `src/api.ts`
- `createD1Database`: the returned database UUID is validated against a UUID regex; after the `store` table is created, it is read back via a `SELECT` on the query endpoint and the install fails with a stage-named error if the table is not visible.
- `deployWorker`: upload metadata bindings now include the `d1` binding plus `CF_API_TOKEN` (`secret_text`, the token being installed with) and `CF_ACCOUNT_ID` (`plain_text`).
- `createPagesProject`: `deployment_configs.production.env_vars` now includes the same `CF_API_TOKEN`/`CF_ACCOUNT_ID` pair alongside the D1 binding.
- New `verifyWorkerDeployment` / `verifyPagesDeployment`: read back the Worker settings (or Pages project) and confirm the `d1` binding named `db` points at the created database and that both credential bindings exist; failures throw stage-named errors ("Error verifying deployment: …").

### `src/script.ts`
- `EMBEDED_SETTINGS.apiToken` is now embedded as `''` — the account token travels only via the `CF_API_TOKEN` secret binding.

### `src/index.ts`
- Both deploy flows verify the deployment (above) after the deploy/subdomain steps and only then emit success + the private panel link. Any failed stage aborts the stream with the stage-named error.

## Go CLI wizard (`wizard/internal/`) — mirrored, not compiled

No Go toolchain exists in this environment, so these changes are syntactically conservative mirrors and **have not been compiled or run**. A brace/paren balance smoke check passes on all touched files.

- `script.go`: `EmbeddedSettings.ApiToken` is now `""` (token travels only via the secret binding).
- `api.go`:
  - `CreateCfAccount`: fixed the `(nil, nil)` return — a non-`active` token verification now returns a real error (`API token is <status>`); also guards an empty account list before indexing `Result[0]` (previously a panic).
  - `cfREST`: non-2xx HTTP responses are now returned as errors (status + body) instead of being handed to callers as if successful.
  - `CreateD1Database`: UUID format validation (package-level regex) and a `store`-table read-back after initialization, with stage-named errors.
  - `DeployWorker`: upload metadata bindings add `CF_API_TOKEN` (`secret_text`) and `CF_ACCOUNT_ID` (`plain_text`).
  - `CreatePagesProject`: `deployment_configs.production.env_vars` adds the same pair.
  - New `VerifyWorkerDeployment` / `VerifyPagesDeployment` mirroring the web wizard's read-back checks.
- `app.go`: both deploy flows call the verification step after deploy (fatal on failure, like other stages) and log "Deployment verified successfully!" before the panel URL is produced.

## Verification (all local, executed)

| Command | Result |
| --- | --- |
| `cd panel && npm run check` (`tsc --noEmit`) | ✅ exit 0, clean (one `Uint8Array<ArrayBuffer>` typing fix in `auth.ts` was needed and applied) |
| `cd panel && npm run build` | ✅ exit 0; `panel/dist/worker.js` = 392,202 bytes |
| `grep -o 'apiToken:[^,;}]*' panel/dist/worker.js` | Only string-literal assignments are `apiToken:""` (×2: `updateMainSettings`, `buildScript`); remaining matches are minified property reads (globals/env), no embedded token value or placeholder |
| Source sweep for token embedding | `panel/src/settings/main.ts` (×2), `wizard/web/src/script.ts`: `apiToken: ''`; `wizard/internal/script.go`: `ApiToken: ""` |
| `cd wizard && npx tsc --noEmit` | ✅ exit 0, clean |
| `wrangler deploy --dry-run` (wizard) | ✅ bundles successfully |
| Go files | ⚠️ Not compiled (no Go toolchain in this environment); balance smoke check only |

## Not done / caveats

- **Go CLI is unverified by compilation** — it must be built once with a Go toolchain before release.
- Existing installs keep working through the embedded-settings fallback in `init()`; they pick up binding-based credentials on their next wizard install or after a redeploy through the updated panel (which now re-sets the bindings on every self-redeploy).
- The wizard still fetches the panel release script without an integrity hash (audit item noted; out of this task's scope).
- `keep_bindings: ['d1']` semantics on Workers self-redeploy remain a live-verification item (audit P0 #5) — the code follows the instructed contract, but only a staging deploy can prove binding retention end-to-end.
