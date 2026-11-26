# ACP documentation

Start with the [current implementation spec](agent-control-plane-current-spec.md)
for ACP's authority boundaries and the [operations runbook](operations-runbook.md)
for local operations and validation.

## Architecture and contracts

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Current implementation spec](agent-control-plane-current-spec.md) | spec | `packages/acp-server/src/**`, `packages/acp-cli/src/**`, `packages/acp-core/src/**` | `packages/acp-server/test/wrkq-tasks-list.test.ts`, `packages/acp-server/test/mobile-sessions-create.test.ts`, `packages/acp-server/test/admin-jobs.test.ts`, `tests/conformance/acp-workflow/flow-presets-scenarios.test.ts` |
| [Durable architecture records](../architecture/README.md) | guide | | |
| [ADR 0001 — Adopt durable architecture records](../architecture/adr/0001-adopt-durable-architecture-records.md) | decisions | | |
| [Active invariants](../architecture/INVARIANTS.md) | guide | | |
| [Accepted risks](../architecture/RISKS.md) | guide | | |
| [Ledger input cancellation](../architecture/contracts/ledger-input-cancellation.yaml) | record | | |
| [Mobile and iOS gateway surface](mobile-gateway-surface.md) | guide | | |
| [Mobile bearer authentication](mobile-surface-bearer-auth-spec.md) | spec | `packages/acp-server/src/mobile-auth/**`, `packages/acp-server/src/handlers/mobile-auth-admin.ts`, `packages/acp-server/src/mobile-apis.ts` | `packages/acp-server/test/mobile-bearer-auth.test.ts`, `packages/acp-server/test/mobile-auth-store.test.ts`, `packages/acp-cli/test/mobile-auth-cli.test.ts` |
| [Discord message flow and virtu testing](gateway-discord-message-flow.md) | guide | | |
| [Discord lifecycle event cards](discord-event-architecture.md) | guide | | |

## Operation and verification

| Document | Kind | Code | Grader |
| --- | --- | --- | --- |
| [Operations runbook](operations-runbook.md) | guide | | |
| [Scheduled jobs and flows](ACP_JOBS_TASKS_USAGE.md) | guide | | |
| [Advancing producer tuples](producer-advance.md) | guide | | |
| [Suppression guard](SUPPRESSION_GUARD.md) | guide | | |
| [Agent enablement changelog](agent-enablement-changelog.md) | record | | |
| [ACP CLI usage](../packages/acp-cli/README.md) | guide | | |
| [ACP server usage](../packages/acp-server/README.md) | guide | | |
| [Workflow kernel conformance suite](../tests/conformance/acp-workflow/README.md) | guide | | |
| [Flow preset scenarios](../scenarios/flow-presets/README.md) | guide | | |

The [ACP verification skill](../spaces/verify-agent-control-plane/skills/verify-agent-control-plane/SKILL.md)
maps source surfaces to verification steps and explains what each check can prove.
