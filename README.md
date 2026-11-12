# Bermuda

Our own multi-user VPN panel for Cloudflare Workers — quota-based subscription management, a CRM integration API, and an obfuscated build output that survives on Workers.

**Status:** design phase. Gate 0 survival pilot in progress; no panel code written yet.

Full build plan, architecture, phases and acceptance tests: [PLAN.md](PLAN.md)

Project rules:
- Protocol core from BPB (GPL-3.0); everything else written from scratch and owned by us. No code is copied from other panels.
- Project language is English (docs, code, UI).
- Building happens only in this repo; CRM integration is a separate phase, done only after its own approval.
- Free Cloudflare plans only; one panel per account.
