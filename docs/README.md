# ACP documentation

Start with the [current implementation spec](agent-control-plane-current-spec.md)
for live behavior and authority boundaries. The pages below provide focused
references, operating procedures, and historical context.

## Architecture and mobile interfaces

- [Server architecture](server-architecture.md) — ACP server responsibilities, delegated authority, and integration boundaries.
- [Mobile gateway surface](mobile-gateway-surface.md) — Mobile-facing APIs, ports, and implementation boundaries.
- [Mobile bearer authentication](mobile-surface-bearer-auth-spec.md) — Approved authentication design and trust rules for mobile routes.

## Operations and contribution

- [Operations runbook](operations-runbook.md) — Running and inspecting ACP and its embedded gateways; apply the current restart-authority rules in AGENTS.md.
- [Advancing producer tuples](producer-advance.md) — Coordinating ASP/HRC dependency advances and deployment readback.
- [Local Git hooks](local-git-hooks.md) — Bootstrapping and understanding the repository's commit and push gates.
- [Suppression guard](SUPPRESSION_GUARD.md) — Reviewed suppression markers, inventory, and validation policy.

## Workflow and scenario verification

Workflow and scenario guides retain older command examples. Check the current
implementation spec and live CLI help before executing them; the workflow
verification page identifies removed ACP-authoritative routes explicitly.

- [Supervisor playbook](acp-supervisor-playbook.md) — Workflow supervisor procedure and evidence/checkpoint coordination.
- [Workflow verification](acp-workflow-verification.md) — Workflow checkpoints and historical verification procedures, including obsolete-surface notices.
- [Active-run contribution smoke checklist](active-run-contribution-virtu-smoke-checklist.md) — Historical Virtu smoke cases for active-run provider contributions.
- [Evidence provenance scenario](runbooks/flow-presets/evidence-provenance-attach.md) — Exercise standalone evidence attachment with three-source provenance.
- [Hotfix scenario](runbooks/flow-presets/hotfix-implementer-tester.md) — Exercise implementer/tester separation of duties for a hotfix.
- [Obligation lifecycle scenario](runbooks/flow-presets/obligation-waive-cancel-lifecycle.md) — Exercise obligation waiver and cancellation paths.
- [Supervisor authority scenario](runbooks/flow-presets/participant-supervisor-evidence-authority.md) — Exercise participant execution and evidence-backed supervisor authority.
- [Procurement scenario](runbooks/flow-presets/procurement-legal-approval.md) — Exercise vendor waiting and legal approval.
- [Support escalation scenario](runbooks/flow-presets/support-escalation-customer-response.md) — Exercise a support escalation awaiting customer response.

## Archived harness design

These documents preserve the June 2026 PBC harness design discussion; use the
current implementation spec for present behavior.

- [PBC harness concept](archive/PBC_HARNESS.md) — Original proposal for an ACP execution facade over wrkf.
- [PBC harness implementation plan](archive/PBC_HARNESS_IMPL_PLAN.md) — Historical implementation plan grounded against the then-current repositories.
- [PBC harness validation and specification](archive/PBC_HARNESS_VALIDATION_AND_SPEC.md) — Historical design validation, corrections, and formal implementation target.
