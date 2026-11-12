# BPB: KV → D1 Conversion Map

Date: 2026-11-12 — Source analysed: BPB Worker Panel v5.1.1 (`src/`, TypeScript).
Purpose: every place BPB touches Cloudflare KV, and exactly what each becomes on D1.

## 1) Inventory — the whole KV surface

Binding: `env.kv` (declared in `src/types/global.d.ts`). Total direct calls: **22**, in 5 files.
Almost everything flows through one hub: `src/settings/kv.ts` (`getDataset` / `updateDataset`).
Only **5 keys** exist:

| # | KV key | Shape | Read at | Written at | Frequency |
|---|---|---|---|---|---|
| 1 | `proxySettings` | One JSON blob — the full `KvSettings` object (~80 fields: DNS, ports, protocols, fragment, ECH, bypass/block rules, warp, noises, custom subs/configs, `panelVersion`) | `settings/kv.ts` `getDataset()` + `updateDataset()`; reached via `setSettings()` (subscription + telegram handlers) and the panel handler | First boot (defaults), version-mismatch migration, and every settings save from the panel (`handlers/panel.ts`) | Reads: panel loads & sub-page requests. Writes: rare (admin saves only). **Not** read per proxied packet |
| 2 | `warpAccounts` | JSON array of WARP account objects | `getDataset()` | `api/warp.ts` when accounts are fetched/refreshed | Rare |
| 3 | `telegramBot` | JSON `{ telegramBotToken, telegramUserId }` | `getDataset()`, panel handler, `api/telegram.ts` (bot webhook path) | Bot setup (`api/telegram.ts`), default-init in `getDataset()` | Rare |
| 4 | `pwd` | Plain string (admin password) | Login checks (`auth/auth.ts`, panel handler ×2) | Password set/change (`auth/auth.ts`) | Per login |
| 5 | `secretKey` | Plain string (session/JWT signing secret) | Auth session verify (`auth/auth.ts` ×2) | Once, generated when missing (`auth/auth.ts`) | Per session check |

**Conclusion:** BPB has no per-user data and no counters in KV at all. KV is only a settings drawer — which is why this conversion is small.

## 2) Conversion design

### Option A — Drop-in adapter (recommended for the settings swap)
One table mirrors KV 1:1; only the hub file changes, panel logic untouched:

```sql
CREATE TABLE store (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL          -- JSON string, exactly as KV held it
);
```

| KV operation | D1 equivalent |
|---|---|
| `env.kv.get('proxySettings', {type:'json'})` | `SELECT value FROM store WHERE key='proxySettings'` → `JSON.parse` |
| `env.kv.put('proxySettings', JSON.stringify(x))` | `INSERT INTO store(key,value) VALUES('proxySettings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value` |
| `env.kv.get('pwd')` / `put('pwd', …)` | Same pattern, key `pwd` |
| `env.kv.get('secretKey')` | Same pattern, key `secretKey` |

Touchpoints to change:
- `src/settings/kv.ts` — rewrite `getDataset`/`updateDataset` storage calls (the 3 gets in `getDataset` become one `db.batch()` of 3 SELECTs).
- `src/auth/auth.ts` — 5 calls (`pwd`, `secretKey`) → store helpers.
- `src/api/telegram.ts` — 3 calls (`telegramBot`) → store helpers.
- `src/api/warp.ts` — 1 call (`warpAccounts`) → store helper.
- `src/handlers/panel.ts` — 3 direct gets (`pwd`, `telegramBot`) → store helpers.
- `src/types/global.d.ts` — `kv: KVNamespace` → `db: D1Database`; installer/wrangler binding changes from `kv_namespaces` to `d1_databases`.

Estimated effort: **half a day** including tests. Behaviour identical.

### Option B — Normalized settings table
One row, one column per settings field (~80 columns). Enables per-field queries and partial updates, but every settings read/write in the panel must be reworked field by field. **Not recommended** for settings alone — no feature needs it.

### Where D1 actually pays off (separate from this swap)
Normalized tables for the multi-user model — this is the real reason to adopt D1:

```sql
CREATE TABLE users (
  uuid TEXT PRIMARY KEY, name TEXT, limit_gb REAL, used_gb REAL DEFAULT 0,
  expiry_days INTEGER, limit_req INTEGER, used_req INTEGER DEFAULT 0,
  first_connect_at INTEGER, is_active INTEGER DEFAULT 1, created_at INTEGER
);
```

## 3) Why D1 beats KV for the parts that grow

- **Free quotas:** D1 free plan = 5M rows read / 100k rows written per day. KV free plan = 100k reads / **1,000 writes** per day. Usage counters on KV would exhaust the write cap almost immediately; on D1 they are workable (with per-connection batching).
- **Consistency:** KV is eventually consistent — counters and quota checks can drift. D1 (SQLite) reads/writes are consistent, so "cut at quota" is exact.
- **Queries:** user lists, filters and usage reports are SQL, not key scans.

## 4) Migration path for existing panels

1. Ship a build with both bindings; on boot, `getDataset` checks D1 first.
2. If the `store` table is empty and KV has data, copy all 5 keys KV → D1 once, then continue on D1 only.
3. Next release can drop the KV binding (and the installer stops creating the namespace).

## 5) Bottom line

- Settings KV → D1: **small, mechanical, low-risk** (22 calls, one hub file, 5 keys).
- The swap alone changes nothing user-visible. Its value is as the foundation step: once storage is D1, the users/quota tables of the Bermuda plan (Phase 1) plug into the same database.
