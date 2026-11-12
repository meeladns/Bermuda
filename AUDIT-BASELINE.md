# Bermuda — Phase A Source Audit Baseline

Scope: source code only (`panel/`, `wizard/web`, `wizard/internal`). Read-only audit; no live API calls, no files modified. Line references are to the working tree at audit time. No secret values are reproduced anywhere in this document.

Status key: **CONFIRMED** = verified in source with location. **NOT FOUND** = searched for, absent. **VERIFY** = source suggests a risk that only a live/runtime check can settle.

---

## 1. Storage layer (`panel/src/settings/store.ts`, `db.ts`)

- **CONFIRMED — Binding contract is consistent.** `Env.db: D1Database` (`panel/src/types/global.d.ts:6`). All storage goes through `env.db` in `store.ts:9,25,40`. Keys in use: `proxySettings`, `warpAccounts`, `telegramBot` (`db.ts:18,19,33`), `pwd`, `secretKey` (`panel/src/auth/auth.ts:19,26,29,55,81,101`), plus direct callers below.
- **CONFIRMED — Table init uses a cached promise that resets on failure.** `store.ts:5` module-level `tableReady`; `ensureStoreTable` (`store.ts:7-21`) creates the promise once, concurrent callers share it, and the rejection branch sets `tableReady = null` and rethrows (`store.ts:13-16`). The mission requirement "failed init resets the cached promise" is already satisfied. Caveat: the cache is global to the isolate and not keyed by `env`/binding (acceptable for this single-binding app, but implicit).
- **CONFIRMED — Init is lazy and unchecked beyond rejection.** `CREATE TABLE IF NOT EXISTS store (...)` runs via `.run()` on first use (`store.ts:9-11`); the D1 result/meta is not inspected. D1 rejects on error, so failures propagate, but there is no explicit success verification.
- **CONFIRMED — Reads/writes propagate errors; no read-back anywhere.** `storeGet` (`store.ts:23-31`) and `storePut` (`store.ts:38-43`) have no try/catch; failures reject to callers. No caller performs a read-after-write verification.
- **CONFIRMED — JSON parsing is unguarded.** `storeGetJson` is a bare `JSON.parse` (`store.ts:33-36`). A corrupt value throws `SyntaxError` to the caller. In `getDataset` that aborts the entire dataset load (see next point); there is no per-key fallback or repair.
- **CONFIRMED — `getDataset` wraps and rethrows, losing the cause chain.** `db.ts:17-47`: any failure (D1, JSON, Warp fetch chain) is logged and rethrown as a new `Error` containing only `safeError(error)` (the message). First-run seeding writes defaults for `proxySettings` (`db.ts:20-23`) and `telegramBot` (`db.ts:34-37`) without read-back. A version mismatch triggers a full `updateDataset` rewrite (`db.ts:29-31`).
- **CONFIRMED — One swallowed write-failure path exists.** `fetchWarpAccounts` (`panel/src/api/warp.ts:11-45`) performs `storePut('warpAccounts', ...)` at line 34 **inside** the same try whose catch (lines 37-44) returns the hardcoded default accounts. If D1 writes are failing, the catch returns defaults and `getDataset` proceeds as if storage were healthy — a failed write is silently treated as success for the Warp path.
- **CONFIRMED — `updateDataset` structure.** Initial read is wrapped separately (`db.ts:60-65`); field resolution may run side-effecting callbacks (incl. `setCustomDomain`, `db.ts:97`) inside `Promise.all` (`db.ts:166-183`) before the single `storePut` at `db.ts:178`. Errors are wrapped the same way as `getDataset`.
- **Direct store callers (complete list).** `panel/src/auth/auth.ts:19,26,29,55,81,101`; `panel/src/handlers/panel.ts:61` (`renderPanel` pwd check), `panel.ts:136` (`getPanelSettings` pwd check), `panel.ts:192` (`storeGetJson` telegramBot); `panel/src/api/telegram.ts:35,88,103`; `panel/src/api/warp.ts:34`. Dataset callers: `panel/src/handlers/panel.ts:144,186,217`; `panel/src/settings/settings.ts:65` (`setSettings`); internal `db.ts:30`.
- **CONFIRMED — Unguarded pre-try read in settings endpoint.** `getPanelSettings` reads `storeGet(env,'pwd')` at `panel.ts:136`, **before** its try block opens at `panel.ts:138`. A D1 failure there escapes the handler entirely (interacts with §3 routing flaw).

## 2. Auth lifecycle (`panel/src/auth/auth.ts`, handlers, assets)

- **CONFIRMED — Password is stored PLAINTEXT under key `pwd`.** Set at `auth.ts:101` (`storePut(env, 'pwd', data.password)`) and compared with plain `!==` at `auth.ts:22` (login) and `auth.ts:97`. No hashing, salt, or KDF anywhere (**NOT FOUND**: no PBKDF2/WebCrypto password hashing in `panel/src`).
- **CONFIRMED — First-run setup endpoint is `resetPassword`.** Routed at `panel.ts:34-35` → `auth.ts:79-107`. Flow: if a `pwd` exists and the request is unauthenticated → 401 (`auth.ts:81-84`). If no `pwd` exists, setup proceeds: username must be present (`auth.ts:89-91`) and equal the embedded account email (`auth.ts:93-95`); then the password is written and a cookie-clearing 200 is returned (`auth.ts:101-106`, message text is the misleading "Successfully logged in!").
- **CONFIRMED — No server-side password policy or presence validation in setup/change.** `resetPassword` never checks that `data.password` exists, is a string, or meets any policy; the only checks are username match and "different from old" (`auth.ts:97-99`). The frontend enforces a policy the backend does not: regex `^(?=.*[A-Z])(?=.*\d).{8,}$` (`panel/src/assets/panel/script.js:768`). Front/back policy agreement: **NOT FOUND**.
- **CONFIRMED — Setup request uses the wrong content type.** The reset form posts JSON with `Content-Type: text/plain` (`panel/src/assets/panel/script.js:774-782`); the backend parses `request.json()` regardless (`auth.ts:86`). Login correctly uses `application/json` (`panel/src/assets/login/script.js:7-14`).
- **CONFIRMED — No HTTP-method check in `resetPassword`.** Unlike `generateJWTToken` (`auth.ts:14-16`), `resetPassword` accepts any method that reaches the route.
- **CONFIRMED — First-run race.** Two concurrent setup requests can both observe `oldPwd == null` and both write (`auth.ts:81,101`); last write wins. No atomicity guard.
- **CONFIRMED — JWT secret generation and persistence.** On first successful login, if `secretKey` is absent, a 256-bit key is generated with `crypto.getRandomValues` (32 bytes → hex, `auth.ts:46-51`) and persisted via `storePut` (`auth.ts:26-30`). No read-back verification; concurrent first logins can race and overwrite each other's key, invalidating just-issued tokens.
- **CONFIRMED — Password change does NOT rotate the JWT secret.** `resetPassword` never touches `secretKey`; previously issued JWTs remain valid for their full 24 h after a password change. Only the requesting browser's cookie is cleared (`auth.ts:103-106`). Session invalidation on password change: **NOT FOUND**.
- **CONFIRMED — Cookie flags (login).** `jwtToken=...; Path=/; HttpOnly; Secure; Max-Age=86400; SameSite=Strict` (`auth.ts:40-43`). Token is HS256 via `jose`, payload `{ id: accID }`, 24 h expiry (`auth.ts:34-38`). Logout cookie (`auth.ts:7-10`) omits `HttpOnly` — minor inconsistency.
- **CONFIRMED — Auth failures and D1 failures are indistinguishable.** `authenticate()` catches **all** errors — including D1 outages — and returns `false` (`auth.ts:53-76`). A storage failure therefore masquerades as "unauthenticated" on every endpoint (and becomes a 500 only in the usage endpoint, §3).
- **CONFIRMED — First-run UX flow.** Panel page is served without auth when no `pwd` exists (`panel.ts:60-68`); the frontend calls `./panel/settings`, receives 401 with body `{ isPassSet: false }` (produced at `panel.ts:136-141`), and opens the non-dismissible password modal (`panel/src/assets/panel/script.js:26-33`). The settings 401 body contract and the frontend check match.
- **CONFIRMED — Unguarded body parsing.** `generateJWTToken` (`auth.ts:18`) and `resetPassword` (`auth.ts:86`) call `request.json()` with no try/catch; malformed JSON throws out of the handler (see §3 for what happens next).

## 3. Routing and error handling (`panel/src/worker.ts`, `handlers/error.ts`, `/panel/usage`)

- **CONFIRMED — Async handler rejections bypass the router's try/catch.** `worker.ts:14-48`: every branch does `return handleX(...)` **without `await`** inside the try. In an async function, returning a non-awaited promise from a try block does not route its rejection to the catch — the rejection propagates to the Workers runtime instead, and `renderError` never runs. Only synchronous throws are caught (e.g. `init()` rejecting a non-wizard install, `settings.ts:31-33`). The WebSocket branch has the same flaw (`worker.ts:17`). `handlePanel` repeats the pattern internally (`panel.ts:21-57`, no try/catch at all).
- **CONFIRMED — The error renderer can itself throw and has no fallback.** `renderError` (`panel/src/handlers/error.ts:3-12`) awaits `decompressGzipBase64(ERROR_HTML_CONTENT)` — `atob`/`DecompressionStream` can throw (`panel/src/common/common.ts:23-39`) — and dereferences build-time globals with no guard and no try/catch. If it rejects, the request dies with a runtime exception.
- **CONFIRMED — The error renderer returns HTTP 200.** `error.ts:9-11` constructs the response with headers only; there is no `status`, so even a "successful" error page is served as 200.
- **CONFIRMED — Unauthenticated `/panel/usage` returns 500, not 401.** `panel/src/api/usage.ts:75-87`: `getUsage` calls `authenticate()`; on `false` it **throws** `Error('Unauthorized or expired session.')`, and its own catch converts every failure — auth and D1 alike — into `HttpStatus.INTERNAL_SERVER_ERROR`. Root cause is local to `getUsage`, not the router. (Other panel endpoints return 401 correctly, e.g. `panel.ts:85-86,114-115,140-141,177-178`.)
- **CONFIRMED — Usage failure modes are conflated.** A Cloudflare GraphQL failure also returns 500 (`usage.ts:82-83`), and `getCfWorkerUsage` swallows the underlying error into a generic message (`usage.ts:70-72`).

## 4. Embedded credentials (`EMBEDED_SETTINGS`)

- **CONFIRMED — Single choke point, wide blast radius.** The only direct reads of the credential fields are in `panel/src/settings/settings.ts`: `init()` copies `accID`/`accEmail`/`apiToken` (plus all other embedded fields) into the request-global at `settings.ts:37-39`, and `getMainSettings()` destructures them out at `settings.ts:74` to keep them out of browser responses. Everything else consumes them via `getGlobals()`. `init()` also *requires* the embedded object and throws if it is undefined (`settings.ts:31-33`).
- **Usage sites of the embedded token/account (all via `getGlobals()`), and what each calls:**
  - `panel/src/api/usage.ts:13,50-57` — Cloudflare **GraphQL** analytics (`workersInvocationsAdaptive`), `Authorization: Bearer` token, `accID` as `accountTag`.
  - `panel/src/api/workers.ts:5,18-21` — **PUT** Worker script (self-redeploy). `workers.ts:32,36` — GET Worker domains. `workers.ts:49,53` — PUT Worker domain. `workers.ts:73,77` — DELETE Worker script.
  - `panel/src/api/pages.ts:5,16` — POST Pages deployment (self-redeploy). `pages.ts:30,34` / `pages.ts:47,51` — GET/POST Pages project domains. `pages.ts:70,75` — DELETE Pages project.
  - `panel/src/api/dns.ts:5,8` — GET zones. `dns.ts:23,27` — POST DNS CNAME record.
  - `panel/src/settings/main.ts:8-23` (`updateMainSettings`) and `main.ts:92-143` (`buildScript`) — rebuilds the panel script and **re-embeds `accID`, `accEmail`, `apiToken` into the new script text** (`main.ts:104-118`, prepended at `main.ts:139`), then redeploys via the Workers/Pages APIs above. Also drives panel **self-update**: `buildScript(true)` downloads the latest release `worker.js` (`main.ts:96-99`) and re-wraps it with fresh embedded settings.
  - `panel/src/auth/auth.ts:20,33,87` — `accEmail` is the login/reset username; `accID` is the JWT payload `id`. (Identity use, not an API call.)
- **CONFIRMED — No secret-binding usage exists today.** **NOT FOUND**: any `secret_text`/`plain_text` binding, `CF_API_TOKEN`, or `CF_ACCOUNT_ID` in `panel/src`, `wizard/web/src`, or `wizard/internal`. `Env` (`global.d.ts:4-9`) declares only `CF_PAGES`, `db`, and legacy optional `UUID`/`TR_PASS` — and `init()` *rejects* installs that set `env.UUID`/`env.TR_PASS` (`settings.ts:31`), so that legacy env surface is dead and contradictory.
- **CONFIRMED — What breaks if the token moves to `env.CF_API_TOKEN` / `env.CF_ACCOUNT_ID`:**
  1. `init()` must source `accID`/`apiToken` from `env` (it already receives `env`, `settings.ts:30`) and `EmbededSettings`/global typing must change (`panel/src/types/settings.ts:85-99`); the hard failure at `settings.ts:31-33` must be reworked.
  2. `buildScript`/`updateMainSettings` must stop embedding the token into rebuilt scripts (`main.ts:104-139`) — and self-redeploy must **retain** the bindings: Workers upload metadata currently keeps only `keep_bindings: ['d1']` (`panel/src/api/workers.ts:6-11`) and the Pages redeploy sends no `deployment_configs`/`env_vars` at all (`panel/src/api/pages.ts:7-20`). Without retention changes, the first settings-save or panel-update redeploy would strip the secret/plain-text bindings and brick the panel's API access.
  3. Both wizards must create the bindings at install time (see §5) instead of writing the token into script text.
  4. Call sites in `api/*.ts` need no individual changes if `getGlobals()` keeps returning the same field names sourced from `env`.
- **CONFIRMED — No token leak into panel/subscription responses was found.** Settings responses are built from `getMainSettings()`, which omits `accID`/`apiToken`/`accEmail`/`mainDomain` (`settings.ts:73-76`; type-level omit at `types/settings.ts:101-106`), used at `panel.ts:144-152`. Subscription/share output uses `getSharedSettings()` (`settings.ts:78-102`, consumed at `panel/src/handlers/subscription.ts:99`), which picks only non-credential embedded fields. **NOT FOUND**: any response that serializes the full `getSettings()` object (which does contain the token, `settings.ts:104-107`).
- **CONFIRMED — Credential-shaped material hardcoded in source (location only).** `panel/src/settings/settings.ts:110-123` contains two built-in fallback WARP accounts including private-key fields, also used as the silent fallback in `panel/src/api/warp.ts:13,43`. Values are intentionally not reproduced here; provenance (inherited BPB defaults vs. live accounts) must be verified before rotation/removal.
- **CONFIRMED — Stale self-reference.** The panel's version check fetches `raw.githubusercontent.com/meeladnsai/Bermuda-Panel/...` (`panel/src/assets/panel/script.js:85`) — a pre-Bermuda repository path that no longer matches this project (`meeladns/Bermuda`).

## 5. Wizards — provisioning sequence and parity

### Web wizard (`wizard/web/src`)

- **CONFIRMED — Sequence.** `index.ts:32-47`: verify token + load account (`api.ts:17-31`) → pick unused random worker name (`index.ts:35-37`) → `createD1Database` (`index.ts:40`) → Workers or Pages deploy (`index.ts:43-47`). Deploy runs in a detached async IIFE streaming NDJSON (`index.ts:25-59`); the HTTP response is 200 regardless of outcome — failure exists only as stream text.
- **CONFIRMED — D1 steps present/absent (web).** Has: a D1 **access pre-check** (LIST databases, `api.ts:52-59`) with an actionable error; create (`api.ts:61-73`); table init via query endpoint (`api.ts:77-91`). **NOT FOUND (web)**: UUID format validation (the returned `result.uuid` is trusted as-is, `api.ts:75`); **read-back** of the `store` table after creation; any post-deploy verification.
- **CONFIRMED — Worker upload metadata (web).** `api.ts:123-148`: raw PUT with `main_module`, current-date compatibility date, `nodejs_compat`, and exactly one binding `{ type: 'd1', name: 'db', id }` (`api.ts:126-132`). Response `success` is checked (`api.ts:146-148`). **No secret/plain-text bindings are set.** Pages path binds D1 as `d1_databases: { db: { id } }` (`api.ts:174-194`).
- **CONFIRMED — Token is embedded into the panel script.** `script.ts:41-61` builds `EMBEDED_SETTINGS` including `apiToken: account.token` and prepends it to the downloaded release `worker.js`. The panel script itself is fetched from the public GitHub release URL with only an HTTP-status check (`script.ts:20-36`); no integrity/hash verification (**NOT FOUND**).
- **CONFIRMED — `nameTaken` logic flaw (web).** `api.ts:33-49`: for `deployType === 'pages'` it checks the Pages project, then **falls through** and also checks the Worker script; any error anywhere returns `false` ("not taken"). A name taken only as a Pages project reads as free, and network/auth errors are indistinguishable from "name free".
- **CONFIRMED — No completion verification (web).** The panel URL is emitted via `complete()` immediately after the subdomain enable call (`index.ts:120-133`); nothing fetches the panel URL or re-reads Worker metadata. "Upload succeeded" is reported as "installed" — the exact false-success pattern the live 1101 incident exposed.
- **CONFIRMED — Empty-account crash risk (web).** `accounts.result[0].id` (`api.ts:30`) throws a bare TypeError if the token sees zero accounts.

### Go CLI wizard (`wizard/internal`, `wizard/main.go`)

- **CONFIRMED — Sequence.** `main.go:94-125`: prompt deploy type → prompt/validate worker name (`main.go:96-106`) → `CreateD1Database` (`main.go:110`) → `DeployToPages`/`DeployToWorkers` (`app.go:52-105`) → success message + URL (`main.go:123-125`).
- **CONFIRMED — D1 steps present/absent (Go).** Create + table init (`api.go:164-203`); requires `parsed.Success` and a non-empty UUID (`api.go:181-183`). **NOT FOUND (Go)**: the D1 access pre-check the web wizard has; UUID format validation; read-back of the `store` table; post-deploy verification. "Bermuda Panel successfully installed!" (`main.go:123`) is printed from the constructed URL string alone.
- **CONFIRMED — Silent-failure bug in account creation (Go).** `api.go:85-88`: if token verification returns an error **or** a non-`active` status, the function returns `err` — which is `nil` in the non-active case, yielding `(nil account, nil error)`. The caller checks only `err` (`app.go:44-47`), so a nil account flows into `main.go:61-65` and will panic on first field access.
- **CONFIRMED — Unguarded account indexing (Go).** `accountsRes.Result[0]` (`api.go:94`) panics on an empty account list.
- **CONFIRMED — REST helper ignores HTTP status.** `cfREST` (`api.go:129-155`) returns the body for any status code; correctness depends entirely on each caller parsing `success` (the D1/Pages callers do; the surface is fragile).
- **CONFIRMED — Worker upload metadata (Go).** `api.go:237-304`: multipart PUT with the same contract as web (`main_module`, today's date, `nodejs_compat`, single `d1` binding named `db`), checking `parsed.Success` (`api.go:299-301`). **No secret/plain-text bindings.** Pages project creation mirrors web (`api.go:322-357`). One asymmetry: Go's `EnableSubdomain` does not set `previews_enabled` (web: `api.ts:166-172` sets it `true`; Go: `api.go:306-320` omits it).
- **CONFIRMED — Token embedded (Go).** `script.go:56-85` builds the same `EMBEDED_SETTINGS` JSON including `ApiToken: acc.Token` and prepends it to a **local** `worker.js` read from beside the executable (`script.go:30-43`) — no download, no integrity check, and a stale local file is used silently.
- **Parity gaps (summary).** Web-only: D1 access pre-check with actionable message; token-template URL in page assets (`wizard/web/assets/app.js:9-19`). Go-only: locally stored/reused logins (`main.go:50-92`, `internal/token_store.go`); user-chosen worker names vs web's random names; email not lowercased at account load (`api.go:100` vs web `api.ts:30` — currently harmless because the panel lowercases at `settings.ts:38`). Shared gaps: no UUID validation, no D1 read-back, no secret bindings, no post-deploy verification, token embedded in script. Token permission lists currently match (`app.go:246-257` vs `web/assets/app.js:9-19`). Go module/import path still uses the pre-Bermuda name `meeladvpn-wizard` (`wizard/go.mod:1`, `wizard/main.go:11`) — cosmetic only.

## 6. Build and tests

- **CONFIRMED — Panel scripts.** `panel/package.json`: `check` = `tsc --noEmit`, `build` = `node scripts/build.js`, `build-dev` = `node scripts/build-dev.js`. **No `test` script.** `panel/scripts/` contains only `build.js`, so the `build-dev` entry point is **missing/broken**.
- **CONFIRMED — No automated tests exist.** **NOT FOUND**: any test/spec file under `panel/` or `wizard/` (excluding `node_modules`), and no test runner in any `package.json`.
- **CONFIRMED — Wizard web has no npm scripts at all.** `wizard/package.json` defines no `check`/`build`/`test` scripts; type-checking is ad hoc (`npx tsc`). Its `tsconfig.json` is `strict: true`, `noEmit: true`.
- **CONFIRMED — Panel type strictness.** `panel/tsconfig.json`: `strict: true`, `skipLibCheck: true`, `isolatedModules: true`, path aliases for all modules (incl. `@store`, `@db`). Build is esbuild-based via `panel/scripts/build.js` with terser/html-minifier in devDependencies.
- **CONFIRMED — Go module.** `wizard/go.mod`: module `meeladvpn-wizard`, Go 1.26.5, `cloudflare-go/v7`. No Go tests (**NOT FOUND**: any `*_test.go`).

---

## Prioritized fix list

### P0 — D1 reliability
1. Add read-after-write verification (or explicit result checks) for critical keys — at minimum `pwd` and `secretKey` — in the storage layer or auth callers (`store.ts:38-43`, `auth.ts:29,101`).
2. Remove the swallowed-write path: restructure `fetchWarpAccounts` so its `storePut` failure is not caught by the fallback that returns defaults (`panel/src/api/warp.ts:34-44`).
3. Make `storeGetJson` corruption-safe: catch `JSON.parse` failure per key, log safely, and let `getDataset` fall back to defaults for that key instead of aborting the whole dataset (`store.ts:33-36`, `db.ts:17-47`).
4. Move the pre-try `storeGet('pwd')` inside the try in `getPanelSettings` (`panel.ts:136-138`).
5. **VERIFY** live: `keep_bindings: ['d1']` semantics on panel self-redeploy (`panel/src/api/workers.ts:8`) — whether it preserves the named `db` binding across upgrades.

### P0 — Credential bindings (`CF_API_TOKEN` secret / `CF_ACCOUNT_ID`)
6. Source `accID`/`apiToken` from `env` in `init()`; extend `Env` typing; retire the `settings.ts:31-33` hard failure for env-based installs (`settings.ts:30-39`, `global.d.ts:4-9`, `types/settings.ts:85-99`).
7. Stop re-embedding the token in `buildScript` (`main.ts:104-139`) and extend binding retention: Workers `keep_bindings` must also keep `secret_text`/`plain_text` (`workers.ts:6-11`); Pages redeploys must send `env_vars` in `deployment_configs` (`pages.ts:7-20`).
8. Wizards: upload `CF_API_TOKEN` as a `secret_text` binding and `CF_ACCOUNT_ID` as `plain_text` (Workers metadata + Pages `deployment_configs.production.env_vars`); remove `apiToken` from the embedded settings JSON (`wizard/web/src/api.ts:123-148,174-194`, `wizard/web/src/script.ts:41-61`, `wizard/internal/api.go:237-304,322-357`, `wizard/internal/script.go:56-85`).
9. Verify the built/deployed artifact contains no token (string scan) as a release gate; assess the hardcoded WARP fallback key material at `settings.ts:110-123` (provenance first, values never logged).

### P0 — Auth / password
10. Hash passwords with versioned PBKDF2 (Web Crypto, per-password random salt) under `pwd`; verify legacy plaintext once and migrate on successful login; never store new plaintext (`auth.ts:19-24,79-107`).
11. Add server-side password policy + presence/type validation in `resetPassword`, aligned with the frontend rule; switch the reset form to `application/json`; add a method check; guard the first-run race (`auth.ts:79-107`, `panel/src/assets/panel/script.js:768,774-782`).
12. Rotate `secretKey` on password change to invalidate existing sessions (`auth.ts:101-106`); add read-back after `secretKey`/`pwd` writes and serialize first-login key creation (`auth.ts:26-30`).
13. Distinguish storage failure from bad credentials: let `authenticate()` surface D1 errors as 500/503 instead of collapsing them to `false` (`auth.ts:53-76`).

### P1 — Async errors / status codes
14. `await` (or otherwise adopt with error handling) every handler call in `worker.ts:17-44` and `panel.ts:21-57` so rejections reach the error boundary.
15. Harden `renderError`: internal try/catch with a minimal plain-text fallback, and return an explicit 500 status (`handlers/error.ts:3-12`).
16. Fix `getUsage` to return 401 for unauthenticated requests and reserve 500 for genuine upstream/storage failures (`panel/src/api/usage.ts:75-87`).

### P1 — Wizard provisioning
17. Both wizards: validate the D1 UUID format, read the `store` table back after init, and verify the deployed Worker (metadata read-back + panel URL probe) before printing/returning success (`wizard/web/src/api.ts:51-94`, `wizard/web/src/index.ts:120-133`, `wizard/internal/api.go:164-203`, `wizard/main.go:110-125`).
18. Port the web wizard's D1 access pre-check to the Go CLI (`api.ts:52-59` → `wizard/internal/api.go:164`).
19. Fix Go `(nil, nil)` return on non-active token and the `Result[0]` panic (`wizard/internal/api.go:85-94`); fix web `nameTaken` fall-through and error conflation (`wizard/web/src/api.ts:33-49`); guard web `accounts.result[0]` (`api.ts:30`).
20. Add script integrity verification for the downloaded panel artifact (web) and a freshness/provenance check for the CLI's bundled `worker.js` (`wizard/web/src/script.ts:20-36`, `wizard/internal/script.go:30-43`).

### P2 — Build hygiene
21. Restore or remove the broken `build-dev` script (`panel/package.json`, missing `panel/scripts/build-dev.js`); add `check` scripts to `wizard/package.json`; add at least smoke tests for the storage/auth/wizard paths (none exist today).
22. Fix the stale version-check URL (`panel/src/assets/panel/script.js:85`) and the leftover Go module name (`wizard/go.mod:1`).
