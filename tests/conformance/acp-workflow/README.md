# ACP Workflow Conformance Suite

Run `bun test tests/conformance/acp-workflow` to exercise the in-memory
`acp-core` workflow kernel.

- [Flow preset scenarios](../../../scenarios/flow-presets/README.md) cover the
  hotfix separation-of-duties and vendor and customer waiting flows. The checked
  scenario fixtures define the expected states, effect intents and refusals.
- [Evidence provenance](evidence-provenance.test.ts) checks that inline
  transition evidence records its author, role and run, and that the transition
  records only the caller-selected evidence references.
- [Participant runtime](participant-runtime.conformance.test.ts) checks run
  lifecycle states and recompilation of participant context on resume.

Live task routes delegate authority to wrkf. Use the
[current implementation spec](../../../docs/agent-control-plane-current-spec.md#workflow-boundary)
for that boundary.
