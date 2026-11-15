# Mobile Jobhunt forwarding

## Sub-features

ACP forwards four fixed phone routes to Jobhunt's HTTP service on the same host and returns Jobhunt's status and JSON body unchanged (architecture record `agent-control-plane.mobile-jobhunt-forwarding`). ACP owns admission, the route allowlist, the caller header and the answer when the hop itself fails. Jobhunt owns every lead schema, fence, decision and tailoring outcome; ACP reads none of them.

- Admission is the mobile gate's `strict` class: a loopback peer or a valid paired-device bearer token, whether or not mobile auth enforcement is on.
- ACP sends `X-Principal: user:lance` itself and copies no header from the phone.
- One attempt per request: no retry, no redirect following, no caching.
- Hop failures use Jobhunt's `{error: {code, message, details}}` envelope with `gateway_` codes: `gateway_jobhunt_unavailable` (connection refused; a POST adds `submitted: false`), `gateway_jobhunt_timeout` and `gateway_jobhunt_bad_response` (GET), `gateway_jobhunt_uncertain` (POST, `submitted: "unknown"`).

Source anchors (repo-relative): packages/acp-server/src/handlers/mobile-jobhunt.ts; packages/acp-server/src/mobile-auth/gate.ts; packages/acp-server/test/jobhunt. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `route:GET /v1/mobile/jobhunt/leads/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/jobhunt/triage @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/jobhunt/leads/:id/ask @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/mobile/jobhunt/leads/:id/decision @ packages/acp-server/src/routing/param-routes.ts`

## How to get to it

Call the routes on ACP's listener. The upstream base is `ACP_JOBHUNT_URL` (default `http://127.0.0.1:18455`); a base that is not a loopback HTTP host disables forwarding and every route answers `gateway_jobhunt_unavailable`. Jobhunt's tracker binds `127.0.0.1` only, IPv4, so the base must say `127.0.0.1` and not `localhost`. The upstream paths are constants: `/api/hunt/mobile/triage`, `/api/hunt/mobile/leads/:id`, `/api/hunt/mobile/leads/:id/decision` and `/api/hunt/leads/:id/ask`.

## Driving it

Source behaviour: `bun test packages/acp-server/test/jobhunt` runs the real ACP router against a fake Jobhunt over HTTP, in both enforcement states.

Installed, read-only: `~/praesidium/var/wrkq-artifacts/T-13506/live-acceptance.sh [lead-id]`. It checks 401 for a tokenless request on ACP's tailnet address, 404 outside the four paths, and that triage and one lead come back byte-identical to Jobhunt's direct answer. It makes no decision and sends no ask. A decision or an ask is a real write as Lance: drive those only on a disposable lead, with Jobhunt's owner. `~/praesidium/var/wrkq-artifacts/T-13506/live-write-acceptance.py <pass-lead> <maybe-lead>` does that for a stale refusal, a Pass, its identical repeat and a spoofed caller header; it needs two undecided disposable leads and never sends pursue or ask.

## Gotchas

A non-JSON upstream answer is a gateway error, not a pass-through. Jobhunt's 404 for a path it does not serve is plain text, so until Jobhunt deploys a route the GETs answer 502 `gateway_jobhunt_bad_response` and the decision POST answers 502 `gateway_jobhunt_uncertain`. After any `gateway_jobhunt_uncertain` the write may have been applied; read the lead again before another write. The other `/v1/mobile` routes keep the enforcement switch; only this prefix is strict. A lead id outside `^[A-Za-z0-9_.:-]{1,128}$` is 400 and a POST body must be a JSON object of at most 64 KiB. Each request logs one `jobhunt.forward` line with route, outcome and duration, never a body.

## Proven when

The jobhunt test file passes, and on the installed server the read-only acceptance script exits 0 against Jobhunt's deployed adapter. Before that deployment the script's admission and allowlist checks pass and its pass-through checks fail; that proves the gate, not the forwarding. Claim a working decision only from a run on a disposable lead.
