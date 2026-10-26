# Capabilities and learning

## Sub-features

Capability host/catalog routing; wlearn trace materialization, replay, drafts, curation and promotion readiness.

Source anchors (repo-relative): packages/acp-capability-host/src; packages/wlearn/src/cli.ts; scripts/e2e/cap-acp/smoke.sh. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `package:acp-capability-host`
- Surface: `package:wlearn`

## How to get to it

Inspect `packages/wlearn/src/cli.ts` usage and `bun scripts/discover-acp.ts packages acp-capability-host`.

## Driving it

For a local non-network drive run `bun packages/wlearn/src/cli.ts playbook draft --trace verify-scratch` and `bun packages/wlearn/src/cli.ts patch draft --trace verify-scratch --target test-facet`; retain JSON with draft lifecycle. Replay requires a real captured scratch WorkflowKernelSnapshot; do not invent promotion facts. Capability smoke currently requires sibling semantic-capabilities tools; its live recipe is excluded from this task.

## Gotchas

wlearn drafts are local outputs, not activation or promotion proof. `e2e-cap-acp-real` / `e2e-cap-pbc` enqueue real HRC work; never run them for scratch-only verification.

## Proven when

Draft JSON fields can prove local draft construction only. Replay/eval/promotion and installed catalog routing remain undriven without isolated catalog server and trace provenance.
