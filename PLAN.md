# Bermuda Panel — Build Plan

Version: 1.1 — Date: 2026-11-12
Status: **Awaiting Milad's approval** — no panel code written yet. (Gate 0 pilot, section 9, is being built now on Milad's order.)
Repo: `meeladns/Bermuda` (private). All building happens here. CRM integration is a separate phase and starts only after its own approval.

**Project language: English** — all documents, code, comments and the panel UI are in English.

---

## 1) Goal

Build our own VPN panel with the feature level we saw and liked in ZEUS (multi-subscription management, quotas, locations, quota statistics), but:

- No ZEUS code is used (its license forbids forks and selling). Only the *feature list* is inspired by ZEUS, never its code.
- A purpose-built API for the VPN CRM from day one, so the Telegram bot can create, renew and cut subscriptions directly.
- An obfuscated build output so the panel survives on Cloudflare Workers — the layer proven decisive in the A/B test on our own account on 2026-11-12 (readable code dies instantly, obfuscated code lives).
- API-based installation on separate accounts (current model: one panel per account).

End state: a fleet of Bermuda panels across ~50 Cloudflare accounts, managed by the CRM as a new panel type next to BPB.

## 2) Principles and red lines

- **Free plans only.** No feature may require a paid service or paid quota.
- **No third-party live channels in the panel:** no remote auto-update, no IP lists pulled from someone else's server. Everything the panel needs is either built in or comes from our own repo.
- **Security stays pragmatic (owner's decision):** everything runs on our own accounts under our own control, so there is no extra hardening program. The basics stay because they are the door lock, not decoration: a secret panel path, an admin password, and a separate API token for the CRM (so the CRM never needs the admin password).
- **Building happens only in this repo.** Until Phase 3 is approved separately, the VPN CRM is not touched.

## 3) Architecture

| Part | Role | Technology |
|---|---|---|
| Data plane (connection core) | VLESS and Trojan tunnels over WebSocket, outbound via `cloudflare:sockets`, ProxyIP/NAT64 retry | Derived from BPB v5.1.1 (GPL-3.0) |
| Control plane (admin panel) | English web UI, user and settings management | Inside the same Worker, behind a secret path |
| Database | Users, quotas, usage, settings, sessions | Cloudflare D1 |
| Integration API | Create/renew/cut/report subscriptions for the CRM and the bot | Same Worker, `/api/ext/*` routes, separate Bearer token |
| Build pipeline | Build → obfuscate → final `worker.js` | Build scripts in this repo |
| Installer | Create D1, deploy Worker, set secrets, hand back panel link + API token | API script, no browser clicking |

Final subscription flow: bot sale → CRM → target panel API → user created with a plan (volume/days) → subscription link returns and is stored in the CRM → customer connects and the quota clock starts at first use.

## 4) Key architecture decisions (with reasons)

1. **Protocol core from BPB, not a rewrite.** BPB's data plane is proven in production. Our from-scratch attempt (MeeladPanel) never got a fully verified TCP path. What gets panels killed is readable code, not the relay itself — obfuscation solves that.
2. **Many users per panel (D1 model), not one user per panel (BPB's KV model).** The liked features (per-user quotas, auto-renew, per-user stats) are impossible without a user database. A conservative per-panel subscription cap is measured in the pilot, then fixed (starting estimate: 10–20).
3. **Obfuscation is part of the build, never manual.** Every deployed output passes through build + obfuscator. Readable code is never deployed to a real account.
4. **Updates are manual and come only from our own repo.** The panel never downloads anything. A new version means a fresh deploy with the installer, after review.
5. **Quota statistics inside the panel.** Daily request and D1 usage against the free caps (100k requests/day) are visible on the dashboard, so no new subscription is placed on a panel that is about to hit the wall.
6. **Panel location is a first-class option (owner's request).** The admin can set the panel's region — Smart (Cloudflare decides) or a specific region — applied by redeploying with the new placement, like the ZEUS panel does.

## 5) Phases

### Gate 0 — Survival pilot (immediate)
- [ ] Take the existing MeeladPanel worker code, run it through the obfuscation pipeline, deploy it as a Worker on a workers.dev domain, ZEUS-style.
- [ ] Verify: panel page serves (no instant 1101 like the readable version), WebSocket upgrade works, protocol test from a real client.
- [ ] Leave it running as the durability pilot; re-check over the following days.

**If Gate 0 fails, we stop and go back to the drawing board before building anything else.**

### Phase 1 — Core (MVP)
- [ ] Repo skeleton, build + obfuscation pipeline, final `worker.js` output
- [ ] VLESS + Trojan data plane (from BPB) with authentication against the user database
- [ ] User model in D1: name/UUID, volume cap (GB), day cap, request cap, device cap, start-on-first-connect, active/inactive
- [ ] Real per-user usage accounting (volume and requests) with automatic cut-off at quota
- [ ] English admin panel: login, user list, create/edit/delete, reset volume/time, text subscription link + per-user status page
- [ ] Stats dashboard: total traffic, live connections, today's requests vs the free cap, D1 usage
- [ ] **Panel location option:** Smart or specific region, applied via redeploy
- [ ] API installer: create D1 + deploy + secrets + hand back "panel link + API token"
- [ ] Acceptance tests (section 7) and a multi-day live pilot on one throwaway account

**Phase 1 output:** a working panel on its own account that manages several quota subscriptions and is proven to survive on Workers.

### Phase 2 — Full feature set (the ZEUS-liked extras)
- [ ] Shadowsocks as the third protocol
- [ ] YAML (Clash) subscriptions and subscription QR codes
- [ ] Bulk actions, filters and search in the user list
- [ ] Automatic volume/request renewal (configurable time)
- [ ] Fragment and ECH, TLS fingerprint choice, per-user ad/porn blocking
- [ ] Multiple ports per user and multi-location configs
- [ ] Clean-IP repository with Iranian operator filters + automatic IP rotation
- [ ] Settings/users backup and restore

### Phase 3 — CRM integration (only after Milad's separate approval)
- [ ] External panel API (`/api/ext/*`): create subscription with a plan, renew, cut/activate, usage report — separate token
- [ ] A new "Bermuda" panel type in the VPN CRM next to BPB (no change to current BPB behavior)
- [ ] Bot hookup: purchase → subscription auto-created on a panel with capacity → link delivered to the customer
- [ ] Automatic rotation: when a panel dies or fills up, subscriptions are rebuilt on the next panel (API replacement for the Pandora flow)
- [ ] Gradual migration; existing BPB subscriptions stay untouched until they expire

### Phase 4 — Optional (after Phase 3 is stable)
- [ ] Telegram proxy (MTProxy) inside the panel
- [ ] Per-user outbound SOCKS5/HTTP chaining and a static-IP proxy repository
- [ ] A dedicated clean-IP scanner

## 6) Deployment model and capacity

- One panel per Cloudflare account (from the pool of ~50 accounts). Creating accounts (Sazesh) stays manual with Milad, as today; everything from installation on is automatic.
- Hard cap per account: 100,000 requests/day (Workers free plan). Real per-subscription consumption is measured in the pilot, and the per-panel subscription cap is set from the real number plus a safety margin (starting estimate: 10–20 active subscriptions per panel).
- Distributed risk: losing one account only affects that panel's subscriptions, and the CRM rebuilds them on the next panel.

## 7) Tests and acceptance

A phase is "done" only when these are green:

- **Real protocol test:** an external test client establishes VLESS and Trojan connections, traffic passes and bytes come back.
- **Quota test:** create a user with a small cap; consume to the cap and verify automatic cut-off; verify reset and renewal.
- **Survival test:** the obfuscated build deployed on a throwaway account stays alive (HTTP 200 and working connections) across the pilot period. Readable code is never deployed to a real account.
- **Install test:** the installer takes a fresh account from zero to a ready panel with no manual clicks.
- **Internal review:** before Phase 3, a ZEUS-audit-style review of our own code (token paths, sessions, API).

## 8) Risks and mitigations

| Risk | Mitigation |
|---|---|
| Cloudflare's scanner one day catches obfuscated code too | Design for fast rotation (API install takes seconds); subscriptions are rebuildable on the next account |
| Abuse reports on accounts | Accounts are treated as disposable; each panel is independent; customer data lives in the CRM, not only in the panel |
| Hitting the 100k/day free request cap | In-panel quota stats + per-panel subscription cap + warning before the cap |
| API token or panel password leaks | Separate, replaceable API token; panel behind a secret path |
| Mistakes during CRM migration | Phase 3 is separate and approved on its own; BPB stays untouched until migration ends |

## 9) Immediate steps

1. Gate 0 pilot (above) — build and deploy now, verify, leave running.
2. Milad approves this plan (+ the open decisions in section 10).
3. Phase 1 build + acceptance tests + multi-day pilot.
4. Pilot report to Milad → approval → Phase 2.
5. Phase 2 report → separate approval → Phase 3 (CRM integration).

## 10) Open decisions for Milad

1. **Display name:** the repo is Bermuda; does the customer-facing panel name stay MeeladVPN?
2. **Pilot account:** Gate 0 runs as a throwaway test on the main account's workers.dev and can be deleted at any time. The Phase 1 pilot needs one throwaway account token (account creation stays with Milad, Sazesh-style).
