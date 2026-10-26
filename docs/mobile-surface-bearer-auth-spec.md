# Mobile Surface Bearer Auth — Contract and Operations

**Design status:** APPROVED — rev 4 (content ruled in DM #19592, committed as 20d6a8f; base APPROVE #19585, scope-amendment REJECT #19590 resolved here). Ruled by mable@agent-control-plane in daedalus's stead.
**Author:** mable · 2026-08-19
**Ruled by:** Lance (option 3, 2026-08-19): enforce bearer auth on `/v1/mobile/*`.
**Implementation:** `packages/acp-server/src/mobile-auth/{gate,store}.ts`,
`handlers/mobile-auth-admin.ts`, `handlers/mobile.ts`, `create-acp-server.ts`
and `cli.ts`; operator commands live in `packages/acp-cli/src/commands/mobile.ts`.
This describes shipped behavior. The original design closed the tailnet access
gap identified by T-07335; the current enforcement posture is runtime state,
read with `acp mobile auth status`, not implied by this document.

---

## 1. Trust model

Peer locality (loopback vs non-loopback) is evaluated per request against the socket peer address (the `RouteContext.peer` plumbing built in T-07335; fail-closed on absent peer, no `X-Forwarded-For` trust).

There are **three credential classes** on this surface — none (exempt routes), the single-use pairing code (the pair route only), and the bearer token (everything else). With enforcement enabled, the table below is the credential gate; **§2 and §3 describe the same rules and add mechanism, never different rules** — where any other section names a narrower path set than this table, this table wins.

**Scope: every `/v*/mobile/*` path, present and future.** The surface is not only `/v1` — `/v2/mobile/sessions` and the `/v2/mobile/dashboard` WS (federation dashboard) exist today and carry the same session data; gating only `/v1` would leave the hole open. The identical table applies to all mobile-prefixed versions; a future version's routes land in the bearer tier by default, and only the exempt rows below (which have no `/v2` counterparts today) are ever open:

| Route class | Loopback peer | Non-loopback peer |
| --- | --- | --- |
| `GET /v1/mobile/health`, `GET /v1/mobile/pairing` (descriptor) | open | open — needed pre-pairing, leak nothing secret |
| `POST /v1/mobile/pair` | open (today's no-op ack; code redemption is also honored from loopback — a valid code mints a token regardless of peer) | **valid pairing code is the credential** — `{ pairingCode }` redeems for a bearer token; missing/invalid/expired code → 401. Bearer is never required here: this is the issuance path, and a device pairing has no bearer yet by definition. |
| Every other `/v*/mobile/*` route (all versions — `/v1` and `/v2` today, future versions by default) | no bearer required — preserves local scripting, HRCMac, and attach-info semantics unchanged | `Authorization: Bearer <token>` required, HTTP and WS upgrade alike. Missing or invalid → `401 {"ok":false,"code":"unauthorized"}`, identical body for both cases. |

WS upgrades (dashboard, timeline, messages/watch, diagnostics) use the same bearer tier. Remote clients must include the bearer on the upgrade request when enforcement is enabled.

attach-info keeps its stricter loopback-only gate on top; bearer never substitutes for locality there.

## 2. Token model: minted at pairing, code-gated

The pairing endpoint returns `token` only on successful code redemption:

- **Pairing code**: `acp mobile pairing-code` (CLI, talks to the server over loopback — the operator-authority step) mints a single-use code, 8 chars from an unambiguous alphabet, TTL 5 minutes, printed with the gateway URL. At most one outstanding code; minting a new one voids the old.
- **Pair**: `POST /v1/mobile/pair` accepts `{ pairingCode, deviceName? }` from any peer, per the §1 table (the code is that route's credential; bearer is never demanded there). Valid code → mint a 256-bit random token, return it once in `PairingResponse.token`, store only its SHA-256 alongside `{ deviceName, pairedAt, deviceId }` — `deviceId` is a short random operator handle for `devices list|revoke` (deviceName isn't unique); it is never a credential and is never accepted as auth. Invalid/expired/replayed code → 401, constant-time compare, code consumed on first success only. With enforcement enabled, a no-code pair body remains valid **from loopback peers only** and mints nothing; disabled enforcement also acknowledges no-code remote pairing.
- **The unauthenticated descriptor never carries a code**: `GET /v1/mobile/pairing` MUST leave its `pairingCode` field absent. The shipped iOS client falls back to redeeming a descriptor-served code (ConnectionView), and the descriptor route is open by design — populating it would hand the credential to any tailnet caller. Codes travel only through the operator's loopback CLI.
- **Store**: flat JSON under the acp state dir (`mobile-auth.json`): `{ enforce: bool, devices: [{ tokenHash, deviceName, pairedAt, deviceId }] }`. Every stored hash is a valid credential; revocation = delete the entry (`acp mobile devices list|revoke`). No scopes, no roles, no expiry in v1.
- Verification is constant-time against each stored hash. Tokens never appear in logs, access logs included.

## 3. Enforcement point

One middleware ahead of **every mobile route table — the path classifier matches the `/v*/mobile/` prefix, not an enumerated version list** (HTTP, covering `/v1` and `/v2` today and any future version by construction) plus the same check in the Bun WS upgrade path in `cli.ts` before `server.upgrade()` (which likewise classifies by prefix — the `/v2/mobile/dashboard` upgrade is inside the gate). A single function owns the decision (`authorizeMobileRequest({ pathname, peer, authorization, store }) → allow | unauthorized`) for the shared HTTP/WS bearer decision. Pair-code redemption and the stricter loopback-only operator/attach routes retain handler checks.

## 4. Operating enforcement

The state file's `enforce` flag defaults to **false**. While disabled, the bearer
gate allows requests and a no-code pair request acknowledges from any peer;
attach-info and operator auth routes retain their own loopback checks. A supplied
invalid pairing code still returns 401. Valid code redemption works in either
posture. The §1 table describes the enabled posture.

The server is the state file's only writer. The CLI uses loopback-only admin
routes; do not edit the file as an alternate activation path:

```bash
acp mobile auth status
acp mobile pairing-code
acp mobile devices list
acp mobile auth enable
acp mobile auth disable
```

Pair a real device with the operator-issued code before enabling. Enabling with
an empty device roster is refused unless `--force` is explicit. State lives at
`~/praesidium/var/state/acp-server/mobile-auth.json` by default, overridable with
`ACP_MOBILE_AUTH_PATH`. Changes apply without restarting ACP.

Validate activation with tokenless and authenticated non-loopback HTTP and WS
requests, loopback access, and the real client. Gateway-discord's dashboard WS
uses ACP's first host entry: keep that entry loopback and verify its connection.

## 5. Client contract

Remote clients redeem the operator-issued code and retain the returned token,
then send `Authorization: Bearer <token>` on HTTP and WS upgrade requests.
Loopback clients do not need a bearer. The unauthenticated descriptor never
contains a pairing code. This repository's server implementation does not prove
a particular external iOS/Mac client has completed pairing; verify that client
when activating enforcement.

## 6. Non-goals

- No per-route scopes/roles, no multi-user, no token expiry/rotation schedule (revocation covers v1).
- No TLS work — transport privacy is tailscale's job.
- The separate non-production `gateway-ios` process (:18480, `ACP_IOS_GATEWAY_TOKEN`) is untouched and out of scope.
- The acp-viewer vite dev proxy is out of scope but noted as a standing hazard: it forwards `/v1` (ws included) to 127.0.0.1:18470 and accepts tailnet hostnames, laundering remote browsers into the loopback tier while it runs. Operational rule, not spec mechanism: dev vite stays off the tailnet.
- No change to attach-info's locality gate.

## 7. Verification (proof-type gated)

| Phase | Proof |
| --- | --- |
| Server + CLI | Unit: middleware allow/deny matrix (loopback/tailnet × token absent/valid/invalid/revoked × HTTP/WS), **run over both a `/v1` route and the `/v2` routes (`GET /v2/mobile/sessions` HTTP, `/v2/mobile/dashboard` WS upgrade)** so version coverage is asserted, not assumed; pairing-code TTL/single-use/void-on-remint; constant-time paths. Live (enforce off): no behavior change on real gateway. |
| Client + activation | Live: real iOS device pairs via code over tailscale, uses the surface with enforcement ON; tokenless tailnet requests 401 on HTTP + WS **for both `/v1` and `/v2` paths (explicitly including `GET /v2/mobile/sessions`)**; HRCMac loopback unaffected; revoke → device 401s. |

## 8. Risks

- **Lockout**: enforcement flips on with zero paired devices → iOS bricked until re-pair. Mitigation: `acp mobile auth enable` warns (and requires `--force`) when the device list is empty; rollback is one loopback CLI call.
- **WS client that never sent bearers**: any third-party script watching the dashboard WS from the tailnet breaks at activation. Accepted — that break is the point of the change.
- **State-file tampering**: anything that can write the state dir can mint access; that class of actor already owns the machine (loopback tier). Accepted.
