# Current Old Workflow Authority Consumers

W1 keeps all existing workflow routes and response DTOs backed by the durable ACP workflow kernel. The wrkf port is available for later phases, but no handler is routed through it yet.

| Consumer | Current old authority shape | Retained route/response shape for W1 |
| --- | --- | --- |
| `acp-cli` `GetTaskResponse` | Expects task detail plus `supervisorRuns`, `participantRuns`, and `workflowHrcRunMaps`. | `GET /v1/tasks/:taskId` continues returning the existing task detail envelope from `handleGetWorkflowTask`. |
| `acp task transition` | Reads the current task version when `--expected-version` is omitted. | `GET /v1/tasks/:taskId` continues exposing `task.version`; `POST /v1/tasks/:taskId/transitions` remains the old transition endpoint. |
| `acp task evidence add --from-run` | Resolves `--from-run` against `participantRuns` from the task snapshot. | `GET /v1/tasks/:taskId` continues returning `participantRuns`; evidence still posts to `POST /v1/tasks/:taskId/evidence`. |
| CLI timeline joins | Joins task events to HRC runtime rows through `workflowHrcRunMaps`. | `GET /v1/tasks/:taskId` continues returning `workflowHrcRunMaps` for timeline projection. |
| `POST /v1/workflow-interact-runs` | Starts open-ended workflow interaction runs. | Route retained and backed by `handleCreateWorkflowInteractRun`. (The legacy `acp workflow interact` CLI was removed in W6a.) |

> **W6a (Phase 6) note:** The obsolete ACP-authoritative workflow routes/commands were removed — `POST /v1/workflows` (`handlePublishWorkflow`), `POST /v1/workflow-supervisor-runs`, `POST /v1/tasks` (workflow task create), `POST /v1/tasks/:taskId/actions`, `POST /v1/tasks/:taskId/{participant,supervisor}-context`, and the `GET …/workflow-patch-proposals` read routes — along with their `acp` CLI commands. Task lifecycle authority is now wrkf; the remaining `/v1/tasks/:taskId` GET/evidence/transitions/obligation routes are thin wrkf facades.
