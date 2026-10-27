---
id: agent-control-plane/package-index
title: ACP Package Index
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# ACP package index

All packages below live in this ACP checkout under `packages/`. In particular,
the `hrc-*` names here describe HRC-facing clients and presentation; search this
repo first for their implementation. HRC runtime authority remains in
`hrc-runtime`.

| Package | Responsibility |
| --- | --- |
| [`acp-admin-store`](../packages/acp-admin-store) | SQLite admin records: agents, projects, memberships, identities, heartbeats, and system events. |
| [`acp-capability-host`](../packages/acp-capability-host) | Production host wiring for the capability catalog and router. |
| [`acp-cli`](../packages/acp-cli) | `acp` operator CLI and HTTP client for `acp-server`. |
| [`acp-conversation`](../packages/acp-conversation) | SQLite conversation threads, turns, audiences, and run links. |
| [`acp-core`](../packages/acp-core) | Workflow domain types, presets, validation, kernel, and task context helpers. |
| [`acp-e2e`](../packages/acp-e2e) | End-to-end workflow integration tests. |
| [`acp-interface-store`](../packages/acp-interface-store) | Interface bindings, inbound message sources, outbound attachments, and durable deliveries. |
| [`acp-jobs-store`](../packages/acp-jobs-store) | SQLite jobs, job runs, and step runs. |
| [`acp-ops-projection`](../packages/acp-ops-projection) | Operator dashboard event and session projections, including payload redaction. |
| [`acp-ops-reducer`](../packages/acp-ops-reducer) | Client dashboard state reducer for snapshots and streamed updates. |
| [`acp-reconciler`](../packages/acp-reconciler) | Reserves and starts delegated wrkq requests through HRC; reports stalled assignments. |
| [`acp-server`](../packages/acp-server) | ACP HTTP server, workflow orchestration, jobs, gateway hosting, and runtime/session integration. |
| [`acp-state-store`](../packages/acp-state-store) | Runs, input admission and attempts, transition outbox, workflow runtime state, and mobile timeline projection. |
| [`acp-viewer`](../packages/acp-viewer) | Browser-based read-only operator dashboard. |
| [`coordination-substrate`](../packages/coordination-substrate) | SQLite coordination events, handoffs, and wake requests. |
| [`gateway-discord`](../packages/gateway-discord) | Discord ingress, replies, bindings, and lifecycle event cards. |
| [`gateway-ios`](../packages/gateway-ios) | Mobile HTTP/WebSocket API, session capabilities, history, timeline, and input controls. |
| [`hrc-injector-core`](../packages/hrc-injector-core) | HRC socket injection boundary and durable delivery-store helpers. |
| [`hrc-mail-injector`](../packages/hrc-mail-injector) | Standalone collaboration-mail delivery owner using wrkq and HRC. |
| [`hrc-viewer`](../packages/hrc-viewer) | Ghostty/Ghostmux terminal presentation sidecar, panes, status bars, and agent colors (`src/agent-theme.ts`). |
| [`wlearn`](../packages/wlearn) | Workflow trace learning tools, deterministic replay, and promotion readiness. |
| [`wrkq-lib`](../packages/wrkq-lib) | Async wrkq RPC adapters for ACP store ports and the collaboration ledger. |

Refresh the inventory with `bun scripts/discover-acp.ts packages --json` when
adding, removing, or changing package ownership.
