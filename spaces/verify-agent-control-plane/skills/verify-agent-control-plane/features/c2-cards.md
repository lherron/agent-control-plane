# C2 mobile cards

## Sub-features

ACP hosts the always-on C2 controller (`@praesidium/c2-core`, pinned exactly) and the phone's card transport: snapshot and long poll, actions with receipts and replay, read-only reconciliation, card-linked artifacts, the acted line to Vesta, and the `acp c2 scope` operator CLI for the Vesta-seat scope row (T-12207; wire law hrc-ios `architecture/contracts/C2_MOBILE_CARDS.md` r2.1). Card policy, receipts and outcomes are c2-core's. HRC annotations are the only card store.

Source anchors (repo-relative): packages/acp-server/src/c2 (config, hrc-adapter, controller-host, routes, artifacts, scope); packages/acp-cli/src/commands/c2.ts; packages/acp-server/test/c2. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp c2 []`
- Surface: `cli:acp c2 scope []`
- Surface: `cli:acp c2 scope set [--allow --json --table --vesta-seat]`
- Surface: `cli:acp c2 scope show [--json --table --vesta-seat]`
- Surface: `route:GET /v1/mobile/c2/actions/:requestId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/artifacts/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/cards @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/c2/actions @ packages/acp-server/src/routing/exact-routes.ts`

## How to get to it

The routes sit under the existing mobile gate (bearer tier when enforcing; nothing C2-specific). The controller starts wherever acp-server has an HRC client. `ACP_C2_VESTA_SEAT` is the one per-instance setting; it defaults to `agent:vesta:project:c2:task:primary`, and the node id comes from HRC `status.node.nodeId`. Only the production-Vesta instance also observes out-of-scope seats holding c2 rows (D5 lifecycle). An instance with any other Vesta sees only that Vesta and its scope. The scope row is `{subject: seat, ns: c2, kind: config, id: scope}` on the Vesta seat, and an absent row allows nothing. The fixture instance recipe (port 18471, fixture Vesta) is `var/wrkq-artifacts/T-12207/fixture-instance.md`.

## Driving it

Route behavior is proven by `bun test packages/acp-server/test/c2`. That runs the real router and listener on Bun.serve and a real hrc-sdk client over a unix-socket HRC double that mirrors rusthrc's annotation admission, attention, sessions and fenced literal input. It covers the snapshot and long poll, actions, replay and mismatch, a two-client race, reconciliation, a literal-input timeout (unknown_outcome, no retry), artifact refusals with a full-resolution control, annotation capacity, scope narrowing, the acted line, and instance ownership. Read-only live checks: `GET /v1/mobile/c2/cards` on 18470/18471, `acp c2 scope show --table`, and hrc-ios `scripts/c2-mobile-contract-e2e.py --mode read`. Actions run only on the 18471 fixture instance against C2-owner-provided `c2fixture-*` cards and manifest (`--mode actions`).

## Gotchas

Never act on real human cards. A POST to production 18470 delivers literal input to a real seat and records an HRC ledger act; use the fixture instance and C2's disposable cards. Any acp-server pointed at the live HRC socket without `ACP_C2_VESTA_SEAT` becomes a second production-Vesta controller, with classify, wake, lifecycle and prune on real cards. That includes an isolated probe instance, so set the fixture Vesta, or don't give a probe the live HRC. The dev-env scratch server talks to the scratch HRC only. `acp c2 scope set` writes the live HRC row as `agent:lance` and changes what every host shows within one tick; run it only with the scope owner's (mable@c2 or Lance) authority, and read both scope rows back before fixture action runs (one-controller rule). A literal-input timeout is `unknown_outcome` and the card stays locked; never clear `pending` or resend by hand without checking the seat transcript. Activation is `acp server restart` by Mable only. `acp` is source-linked to the canonical checkout, so uncommitted C2 work there goes live on any restart or crash.

## Proven when

`bun test packages/acp-server/test/c2` green proves route and controller-host behavior against the HRC double only. Installed proof is owner-driven and recorded under var/wrkq-artifacts/T-12207. It needs Stella's contract driver green against installed max3: actions on 18471 and a read-only pass on 18470. It also needs live readback of one fixture reply: receipt `done` with the HRC receipt, one `session.annotation.action` with `requestId`, and the seat transcript showing the exact text. Add one full-resolution artifact via `/v1/mobile/c2/artifacts`, all with Loggia closed. Health or a snapshot alone proves nothing about actions.
