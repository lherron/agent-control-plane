# Mobile Surface Bearer Auth — Design Spec

**Status:** APPROVED — rev 2 (6da6129), ruled 2026-08-19 by mable@agent-control-plane in daedalus's stead (DM #19585; rev 1 REJECT #19580 resolved in §1)
**Author:** mable · 2026-08-19
**Ruled by:** Lance (option 3, 2026-08-19): enforce bearer auth on `/v1/mobile/*`.
**Grounding:** T-07335 established the gap — the surface is loopback-*trusted* but tailnet-*reachable* (acp-server binds 127.0.0.1 AND the tailscale address), so any tailnet process can read every session and post input/interrupts into any agent session with no credential. attach-info (T-07335) is currently the only route that enforces locality.

---

## 1. Trust model

Two tiers, evaluated per request against the socket peer address (the `RouteContext.peer` plumbing built in T-07335; fail-closed on absent peer, no `X-Forwarded-For` trust):

There are **three credential classes** on this surface — none (exempt routes), the single-use pairing code (the pair route only), and the bearer token (everything else). The table below is the single normative gate; §2 describes the same rules and adds mechanism, never different rules:

| Route class | Loopback peer | Non-loopback peer |
| --- | --- | --- |
| `GET /v1/mobile/health`, `GET /v1/mobile/pairing` (descriptor) | open | open — needed pre-pairing, leak nothing secret |
| `POST /v1/mobile/pair` | open (today's no-op ack; code redemption is also honored from loopback — a valid code mints a token regardless of peer) | **valid pairing code is the credential** — `{ pairingCode }` redeems for a bearer token; missing/invalid/expired code → 401. Bearer is never required here: this is the issuance path, and a device pairing has no bearer yet by definition. |
| Every other `/v1/mobile/*` route | no bearer required — preserves local scripting, HRCMac, and attach-info semantics unchanged | `Authorization: Bearer <token>` required, HTTP and WS upgrade alike. Missing or invalid → `401 {"ok":false,"code":"unauthorized"}`, identical body for both cases. |

WS upgrades (dashboard, timeline, messages/watch, diagnostics) are in the third row — the shared iOS/Mac client already sends the bearer on upgrade requests, so no client protocol change is needed.

attach-info keeps its stricter loopback-only gate on top; bearer never substitutes for locality there.

## 2. Token model: minted at pairing, code-gated

The client contract already anticipates this — `PairingResponse.token` and `pairingCode` exist in the shipped iOS client and are simply never populated. We fill them in rather than inventing a parallel scheme:

- **Pairing code**: `acp mobile pairing-code` (CLI, talks to the server over loopback — the operator-authority step) mints a single-use code, 8 chars from an unambiguous alphabet, TTL 5 minutes, printed with the gateway URL. At most one outstanding code; minting a new one voids the old.
- **Pair**: `POST /v1/mobile/pair` accepts `{ pairingCode, deviceName? }` from any peer, per the §1 table (the code is that route's credential; bearer is never demanded there). Valid code → mint a 256-bit random token, return it once in `PairingResponse.token`, store only its SHA-256 alongside `{ deviceName, pairedAt }`. Invalid/expired/replayed code → 401, constant-time compare, code consumed on first success only. The current no-op pair body (no code) remains valid **from loopback peers only** (it mints nothing, as today).
- **The unauthenticated descriptor never carries a code**: `GET /v1/mobile/pairing` MUST leave its `pairingCode` field absent. The shipped iOS client falls back to redeeming a descriptor-served code (ConnectionView), and the descriptor route is open by design — populating it would hand the credential to any tailnet caller. Codes travel only through the operator's loopback CLI.
- **Store**: flat JSON under the acp state dir (`mobile-auth.json`): `{ enforce: bool, devices: [{ tokenHash, deviceName, pairedAt }] }`. Every stored hash is a valid credential; revocation = delete the entry (`acp mobile devices list|revoke`). No scopes, no roles, no expiry in v1.
- Verification is constant-time against each stored hash. Tokens never appear in logs, access logs included.

## 3. Enforcement point

One middleware ahead of the `/v1/mobile/*` route table (HTTP) plus the same check in the Bun WS upgrade path in `cli.ts` before `server.upgrade()`. A single function owns the decision (`authorizeMobileRequest(peer, authHeader) → allow | 401`) so the HTTP and WS paths cannot drift. No per-handler auth code.

## 4. Rollout: dark → validated → enforced

Enforcement ships behind `enforce` in the state file (defaults **false**), settable via `acp mobile auth enable|disable`. **The server is the file's only writer**: the CLI calls a loopback-only admin route (same locality check as attach-info) and the server persists — two writers to one flat file is the shape this avoids. Sequence:

1. Land server + CLI; `enforce: false` — zero behavior change, all tests green, surface docs updated.
2. Live validation: mint a code, pair the real iOS app over tailscale, confirm the token round-trips (keychain storage already exists client-side); confirm HRCMac over loopback is untouched.
3. `acp mobile auth enable` → verify a tokenless tailnet request 401s on HTTP and WS, iOS keeps working, loopback keeps working. This is the activation gate; the flag stays available as emergency rollback. Activation checklist also verifies gateway-discord's in-process dashboard WS still connects: it dials the FIRST `ACP_HOST` entry, so its tier depends on that ordering staying loopback-first — assert it at activation rather than trusting the convention.

State-file flag rather than plist env: it's mutable at runtime by the loopback CLI without a daemon bootout (plist env reloads are a known trap), and auth posture is state, not deployment config.

## 5. Client work

- **iOS**: wire the already-present `pairingCode` entry into the pairing flow (ConnectionView) and store the returned token in the existing keychain path. The request-side bearer plumbing already exists.
- **HRCMac**: no change (loopback tier). When remote-Mac support ever matters, it uses the same pairing flow.

## 6. Non-goals

- No per-route scopes/roles, no multi-user, no token expiry/rotation schedule (revocation covers v1).
- No TLS work — transport privacy is tailscale's job.
- The separate non-production `gateway-ios` process (:18480, `ACP_IOS_GATEWAY_TOKEN`) is untouched and out of scope.
- The acp-viewer vite dev proxy is out of scope but noted as a standing hazard: it forwards `/v1` (ws included) to 127.0.0.1:18470 and accepts tailnet hostnames, laundering remote browsers into the loopback tier while it runs. Operational rule, not spec mechanism: dev vite stays off the tailnet.
- No change to attach-info's locality gate.

## 7. Verification (proof-type gated)

| Phase | Proof |
| --- | --- |
| Server + CLI | Unit: middleware allow/deny matrix (loopback/tailnet × token absent/valid/invalid/revoked × HTTP/WS), pairing-code TTL/single-use/void-on-remint, constant-time paths. Live (enforce off): no behavior change on real gateway. |
| Client + activation | Live: real iOS device pairs via code over tailscale, uses the surface with enforcement ON; tokenless tailnet curl 401s (HTTP + WS); HRCMac loopback unaffected; revoke → device 401s. |

## 8. Risks

- **Lockout**: enforcement flips on with zero paired devices → iOS bricked until re-pair. Mitigation: `acp mobile auth enable` warns (and requires `--force`) when the device list is empty; rollback is one loopback CLI call.
- **WS client that never sent bearers**: any third-party script watching the dashboard WS from the tailnet breaks at activation. Accepted — that break is the point of the change.
- **State-file tampering**: anything that can write the state dir can mint access; that class of actor already owns the machine (loopback tier). Accepted.
