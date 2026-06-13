# acp-core

Pure ACP workflow types, preset registry, transition validation, and task-context helpers.

Used by the upcoming ACP server and wrkq-backed ACP integrations.

## Webhook Events

`src/webhook/acp-event.ts` defines the canonical `AcpWebhookEvent` model used by
ACP event jobs. `WrkqWebhookEvent` remains the compatibility input for
`/v1/webhooks/wrkq`; wrkq payloads are adapted into `AcpWebhookEvent` before
the scheduler evaluates jobs. Generic producers use `/v1/webhooks/events`.

Event trigger matching is deterministic: `trigger.source` is matched first,
then declared predicates over event, subject, origin, wrkq compatibility fields,
and bounded `payload` path predicates (`eq`, `anyOf`, `exists`). Templates that
affect `scopeRef` or `laneRef` use source-specific structural allowlists and
fail closed; payload values are available only to capped/sanitized prompt input
templates.
