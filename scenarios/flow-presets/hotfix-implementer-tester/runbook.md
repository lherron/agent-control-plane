# Runbook — Hotfix With Implementer/Tester SoD

End-to-end walkthrough for `hotfix_fastlane@1` (see `workflow.json` and
`scenario.json`). This scenario is validated through the workflow kernel
scenario conformance test:

```bash
bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts
```

Legacy task commands such as `task evidence add`, `task transitions`, and
`toPhase` mutation are intentionally removed and are not valid validation
commands.

## Flow

1. Publish `workflow.json` as a `WorkflowDefinition`.
2. Create `T-HOTFIX-DEMO` with workflow `hotfix_fastlane@1`, risk `medium`,
   implementer `agent:clod`, and tester `agent:cody`.
3. Attach `failing_test` evidence.
4. Apply `start`: `open/red` -> `active/red`.
5. Attach `commit_ref` and `regression_test` evidence.
6. Apply `implement_fix`: `active/red` -> `active/green`.
   Expected effects: `declare_handoff` to tester and `wake_role_session` for
   tester.
7. Attach `verification_report` evidence as tester.
8. Apply `verify`: `active/green` -> `active/verified`.
9. Apply `close_success`: `active/verified` -> `closed/success`.

## Negative Checks

- `implementer-actor-cannot-act-as-tester`: expect `role_not_bound`.
- `sod-same-actor-both-roles`: expect `sod_violation`.
- `missing-evidence-blocks-fix`: expect `missing_evidence`.
