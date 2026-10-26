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

- [ACP verification skill](../spaces/verify-agent-control-plane/skills/verify-agent-control-plane/SKILL.md) — Scratch drives, feature maps, evidence limits and structural coverage gate.

## Workflow and scenario verification

Workflow and scenario guides retain older command examples. Check the current
implementation spec and live CLI help before executing them; the workflow
verification page identifies removed ACP-authoritative routes explicitly.

- [Supervisor playbook](acp-supervisor-playbook.md) — Workflow supervisor procedure and evidence/checkpoint coordination.
- [Workflow verification](acp-workflow-verification.md) — Workflow checkpoints and historical verification procedures, including obsolete-surface notices.
- [Evidence provenance scenario](runbooks/flow-presets/evidence-provenance-attach.md) — Exercise standalone evidence attachment with three-source provenance.
- [Hotfix scenario](runbooks/flow-presets/hotfix-implementer-tester.md) — Exercise implementer/tester separation of duties for a hotfix.
- [Obligation lifecycle scenario](runbooks/flow-presets/obligation-waive-cancel-lifecycle.md) — Exercise obligation waiver and cancellation paths.
- [Supervisor authority scenario](runbooks/flow-presets/participant-supervisor-evidence-authority.md) — Exercise participant execution and evidence-backed supervisor authority.
- [Procurement scenario](runbooks/flow-presets/procurement-legal-approval.md) — Exercise vendor waiting and legal approval.
- [Support escalation scenario](runbooks/flow-presets/support-escalation-customer-response.md) — Exercise a support escalation awaiting customer response.

## Delegated work

- [Reconciler reference](../packages/acp-reconciler/README.md) — Live request marker, reserve-before-start protocol, stall rules, configuration and read-only explain command.
- [Delegated request lifecycle](proposals/acp-reconciler-design/delegated-request-lifecycle.png) — As-built lifecycle diagram ([editable](proposals/acp-reconciler-design/delegated-request-lifecycle.arris.json)).

Finished design and smoke records live with their tasks: the PBC harness drafts
on T-11912, provider-contribution checklist on T-01381, and reconciler intent and
proposal on T-09980. Use `wrkq attach ls <task>` to find and retrieve them.
