# Bermuda

Our own VPN panel for Cloudflare Workers, with a D1-backed storage layer and its own installer wizard.

**Status:** Panel and wizard are built and compile-verified. Not yet deployed or released.

## Layout

- `panel/` — **Bermuda Panel** (v1.0.0): based on BPB Worker Panel v5.1.1 (GPL-3.0), rebranded, with the storage layer converted from KV to **D1** (see [KV-TO-D1-MAP.md](KV-TO-D1-MAP.md)). Build output: `panel/dist/worker.js`.
- `wizard/` — **Bermuda Wizard**: installer (web edition in `wizard/web/`, Go CLI in `wizard/internal/` + `main.go`). Like the BPB wizard, it takes a Cloudflare API token and installs the panel — but instead of creating a KV namespace it creates a **D1 database**, initializes the `store` table, and binds it to the panel as `db`.
- [PLAN.md](PLAN.md) — the full product plan (multi-user quotas, CRM API, phases). The current panel is the D1 foundation step of that plan; the multi-user/quota layer is Phase 1 work that builds on this storage.

## Notes

- The panel keeps BPB's single-subscription model for now; settings, password, telegram bot and warp accounts live in the D1 `store` table (same keys/JSON shapes KV held).
- The wizard downloads the panel script from this repo's GitHub releases (`worker.js` asset). A release has not been published yet.
- The Go CLI source is converted to D1 as well, but has not been compiled (no Go toolchain in the build environment).
