# ACP documentation

Start with the [current implementation spec](agent-control-plane-current-spec.md)
for live behavior and authority boundaries. The pages below provide focused
references, operating procedures, and historical context.

## Architecture and interfaces

- [Package index](package-index.md) — Every package under `packages/` and its responsibility.
- [Server architecture](server-architecture.md) — ACP server responsibilities, delegated authority, and integration boundaries.
- [Mobile gateway surface](mobile-gateway-surface.md) — Mobile-facing APIs, ports, and implementation boundaries.
- [Mobile bearer authentication](mobile-surface-bearer-auth-spec.md) — Approved authentication design and trust rules for mobile routes.
- [gateway-discord message flow](gateway-discord-message-flow.md) — Discord ingress/egress, bindings, and real-Discord virtu smoke recipe.
- [Discord event architecture](discord-event-architecture.md) — System-events → Discord lifecycle cards, and how to add a card.

## Operations and contribution

- [Operations runbook](operations-runbook.md) — Running and inspecting ACP and its embedded gateways; apply the current restart-authority rules in AGENTS.md.
- [Scheduled jobs and flows](ACP_JOBS_TASKS_USAGE.md) — Authoring, registering, and validating jobs on the ACP job engine.
- [Agent enablement changelog](agent-enablement-changelog.md) — Append-only record of agent-enablement lessons and their routed carrier.
- [Advancing producer tuples](producer-advance.md) — Coordinating ASP/HRC dependency advances and deployment readback.
- [Local Git hooks](local-git-hooks.md) — Bootstrapping and understanding the repository's commit and push gates.
- [Suppression guard](SUPPRESSION_GUARD.md) — Reviewed suppression markers, inventory, and validation policy.

- [ACP verification skill](../spaces/verify-agent-control-plane/skills/verify-agent-control-plane/SKILL.md) — Scratch drives, feature maps, evidence limits and structural coverage gate.

## Workflow kernel scenarios

These walkthroughs drive the in-memory `acp-core` workflow kernel and are
checked by `bun test tests/conformance/acp-workflow/flow-presets-scenarios.test.ts`.
They do not describe the wrkf-backed `/v1/tasks/:taskId` server routes.

- [Hotfix scenario](runbooks/flow-presets/hotfix-implementer-tester.md) — Exercise implementer/tester separation of duties for a hotfix.
- [Procurement scenario](runbooks/flow-presets/procurement-legal-approval.md) — Exercise vendor waiting and legal approval.
- [Support escalation scenario](runbooks/flow-presets/support-escalation-customer-response.md) — Exercise a support escalation awaiting customer response.

## Delegated work

Specialist requests use reply-required room mail to the request's task seat.
Mail delivery starts the worker; its reply carries the result and evidence.

Finished design and smoke records live with their tasks: the PBC harness drafts
on T-11912, provider-contribution checklist on T-01381, reconciler intent and
proposal on T-09980, and the retired ACP workflow supervisor playbook,
verification log and CLI-walk scenario runbooks on T-01936. Use
`prae task attachment find <task>` to list them and `prae task attachment get`
to retrieve one.
