# C2 mobile cards

## Sub-features

ACP hosts the always-on C2 controller (`@praesidium/c2-core` 0.2.0, pinned exactly) and the phone's transport for seat questions (c2 `docs/card-contract.md` rev 4.1; wire law §12 "Mobile wire", version 2). A seat's open questions are rows in its own HRC record `{subject: seat, ns: hrc, kind: asks, id: open}` (hrc-runtime seat-asks r1.3). The controller reads those rows and does the following:
- runs the turn-end backstop (one `[c2]` line to a seat that ended a lit turn with no open row, on a `c2.ping`);
- wakes Vesta to review rows;
- sends the rotated line;
- delivers answers under per-row claims with receipts;
- recovers and prunes.

The transport is:
- the v2 snapshot and long poll;
- actions with receipts and replay;
- read-only reconciliation;
- row explanations (`c2.detail` HTML);
- the acted line to Vesta;
- the `acp c2 scope` operator CLI for the Vesta-seat scope row.

The v1 card routes remain registered and answer 410 `wire_version_unsupported`, so an old phone build fails closed. Row policy, receipts and outcomes belong to c2-core. HRC annotations are the only store.

Source anchors (repo-relative): packages/acp-server/src/c2 (config, hrc-adapter, controller-host, routes, artifacts, scope); packages/acp-cli/src/commands/c2.ts; packages/acp-server/test/c2. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp c2 []`
- Surface: `cli:acp c2 scope []`
- Surface: `cli:acp c2 scope set [--allow --json --table --vesta-seat]`
- Surface: `cli:acp c2 scope show [--json --table --vesta-seat]`
- Surface: `route:GET /v1/mobile/c2/v2/actions/:requestId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/v2/artifacts/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/v2/snapshot @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/c2/v2/actions @ packages/acp-server/src/routing/exact-routes.ts`
The four v1 routes below answer 410 `wire_version_unsupported` and execute nothing.

- Surface: `route:GET /v1/mobile/c2/actions/:requestId @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/artifacts/:id @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/c2/cards @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:POST /v1/mobile/c2/actions @ packages/acp-server/src/routing/exact-routes.ts`

## How to get to it

The routes sit under the existing mobile gate (bearer tier when enforcing; nothing C2-specific). The controller starts wherever acp-server has an HRC client. `ACP_C2_VESTA_SEAT` is the one per-instance setting. It defaults to `agent:vesta:project:c2:task:primary`, and the node id comes from HRC `status.node.nodeId`.

The production-Vesta instance also observes out-of-scope seats that hold c2 rows; its one-release legacy prune reaches them. An instance with any other Vesta sees only that Vesta and its scope.

The scope row is `{subject: seat, ns: c2, kind: config, id: scope}` on the Vesta seat, and an absent row allows nothing. Vesta's own asks record is shown whatever the scope says. The fixture instance recipe (port 18471, fixture Vesta) is `var/wrkq-artifacts/T-12207/fixture-instance.md`.

## Driving it

Route and controller behavior is proven by `bun test packages/acp-server/test/c2`. That runs the real router and listener on Bun.serve and a real hrc-sdk client over a unix-socket HRC double. The double mirrors rusthrc's annotation admission, attention, sessions, runtimes and fenced literal input. The suite covers:
- the v2 snapshot and long poll, and the v1 410s (no write, no send);
- answer round trip: the question in the text, `sent` stamped per row, the row claim's outcome and one ledger act per row;
- replay and mismatch, a two-client race on one row, reconciliation;
- a literal-input timeout (unknown_outcome, claim held, recovery records unknown and the row becomes `uncertain` with `release`);
- explanation artifact refusals, annotation capacity, scope narrowing, the acted line, the rotated line from the HRC runtime record, and instance ownership.

c2-core's own suite (c2 `packages/c2-core`) covers the row-claim interleavings and the backstop.

Read-only live checks:
- `GET /v1/mobile/c2/v2/snapshot` on 18470/18471 (`wire: 2`);
- `GET /v1/mobile/c2/cards` answers 410;
- `acp c2 scope show --table`.

Actions run only against C2-owner-provided disposable fixture seats (the 18471 fixture instance, or a fixture seat the C2 owner has cleared in production scope), never against a real seat's rows. Scratch-only driving: a dev-env acp-server against the scratch HRC, with `ACP_C2_VESTA_SEAT` set to a fixture Vesta.

## Gotchas

**Real seats**
- Never answer real rows. A POST to production 18470 delivers literal input to a real seat, stamps `sent` on its HRC record and records ledger acts.
- With rev 4 live, the controller also sends lines to seats on its own:
  - the backstop line to a seat in scope that ends a lit turn without an open row;
  - the review wake and the rotated line to Vesta.

  Widening the scope row widens that, so treat `acp c2 scope set` as a production change. It writes the live HRC row as `agent:lance` and changes what every host shows and pings within one tick. Run it only with the scope owner's authority (mable@agent-control-plane per D5, at the C2 owner's ruling, or Lance).

**A second controller**
- Any acp-server pointed at the live HRC socket without `ACP_C2_VESTA_SEAT` becomes a second production-Vesta controller, with backstop, wakes, recovery and prune on real seats. That includes an isolated probe instance, so set the fixture Vesta, or don't give a probe the live HRC.

**Uncertain outcomes**
- A literal-input timeout is `unknown_outcome`. The row claim stays held and the row later reads `uncertain`. Only Lance's `release`, after checking the seat transcript, frees it. Never delete a claim or resend by hand.

**Activation**
- Activation is `acp server restart`, by Mable only. `acp` is source-linked to the canonical checkout, so uncommitted C2 work there goes live on any restart or crash.

## Proven when

`bun test packages/acp-server/test/c2` green proves route and controller-host behavior against the HRC double only.

Installed proof is owner-driven and recorded on c2 T-12239. It covers card contract rev 4.1 §11 and seat-asks §8, against installed max3 on a fixture seat the C2 owner cleared. The live readback of one fixture answer must show:
- the seat transcript with the exact text, including the question;
- `sent {by, runId, at, text}` on the row in `seat_annotations`;
- the receipt `done`;
- one `session.annotation.action` per answered row with `requestId`.

It also needs the backstop's single ping and its re-arm, and a rotation that changes no asks record. The phone's half is the §12.7 gates (hrc-ios T-12259). A snapshot alone proves nothing about actions.
