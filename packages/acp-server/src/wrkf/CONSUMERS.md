# Current Old Workflow Authority Consumers

W1 keeps all existing workflow routes and response DTOs backed by the durable ACP workflow kernel. The wrkf port is available for later phases, but no handler is routed through it yet.

| Consumer | Current old authority shape | Retained route/response shape for W1 |
| --- | --- | --- |
| `acp-cli` `GetTaskResponse` | Expects task detail plus `supervisorRuns`, `participantRuns`, and `workflowHrcRunMaps`. | `GET /v1/tasks/:taskId` continues returning the existing task detail envelope from `handleGetWorkflowTask`. |
| `acp task transition` | Reads the current task version when `--expected-version` is omitted. | `GET /v1/tasks/:taskId` continues exposing `task.version`; `POST /v1/tasks/:taskId/transitions` remains the old transition endpoint. |
| `acp task evidence add --from-run` | Resolves `--from-run` against `participantRuns` from the task snapshot. | `GET /v1/tasks/:taskId` continues returning `participantRuns`; evidence still posts to `POST /v1/tasks/:taskId/evidence`. |
| CLI timeline joins | Joins task events to HRC runtime rows through `workflowHrcRunMaps`. | `GET /v1/tasks/:taskId` continues returning `workflowHrcRunMaps` for timeline projection. |
| Workflow publish command | Publishes definitions through the ACP workflow kernel. | `POST /v1/workflows` remains backed by `handlePublishWorkflow`. |
| Workflow patch list/show commands | Read patch proposals from the ACP workflow kernel. | `GET /v1/tasks/:taskId/workflow-patch-proposals` and `GET /v1/workflow-patch-proposals/:proposalId` keep their existing response shapes. |
| Workflow supervise command | Starts supervisor records and related HRC run mappings in the ACP workflow kernel. | `POST /v1/workflow-supervisor-runs` keeps returning the existing supervisor launch envelope. |
| Workflow interact command | Starts open-ended workflow interaction runs using old workflow task/run mappings. | `POST /v1/workflow-interact-runs` keeps returning the existing attach/runtime response. |
