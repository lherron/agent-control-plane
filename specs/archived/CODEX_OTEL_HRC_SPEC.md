Below is a coding-agent-ready implementation spec.

---

# Spec: Codex CLI OTEL Event Ingest for HRC

## Status

Approved for implementation (amended 2026-04-17 after co-review by clod/cody: nested-table TOML as normative, no `otel.enabled`, no `acceptedUntil` on artifact, daemon-stable endpoint sourcing, explicit OTLP partialSuccess shape, bytes-as-base64, v1-scoped runId correlation).

## Objective

Add Codex CLI event capture to HRC by ingesting Codex OpenTelemetry log exports and persisting them through the existing HRC event pipeline so that:

- events are written into the existing `events` SQLite table via `db.events.append(...)`
- live followers receive them through the existing `notifyEvent(...)` fanout
- `hrc monitor watch --follow` works for Codex with no CLI read-path changes

This implementation is intended to make Codex event capture behave like current Claude Code capture at the HRC boundary: durable append into SQLite plus live NDJSON streaming to watchers.

## Current State

The current HRC event path already has the correct persistence and streaming boundaries:

- `packages/hrc-store-sqlite/src/repositories.ts`: `EventRepository.append(...)`
- `packages/hrc-server/src/index.ts`: `notifyEvent(...)`
- `packages/hrc-sdk/src/client.ts`: `watch(...)` on `GET /v1/events`
- `packages/hrc-cli/src/cli.ts`: `hrc monitor watch` / `watch`

Codex is the missing ingress path. Claude Code can emit lifecycle/hook events directly into HRC; Codex cannot provide equivalent hook coverage and instead exposes structured OpenTelemetry log export. Codex supports OTEL log export through `[otel]`, with `otel.exporter` selectable as `otlp-http` or `otlp-grpc`, configurable endpoint/headers/protocol, and representative `codex.*` event families including conversation, API, SSE, and tool events. Exporters batch asynchronously and flush on shutdown.  [oai_citation:0‡OpenAI Developers](https://developers.openai.com/codex/config-advanced)

## Design Decision

Implement OTEL ingest in the **HRC daemon**, not in the launcher.

### Why

The daemon already owns:

- SQLite writes
- event fanout to live subscribers
- launch metadata
- runtime/session correlation

Keeping OTEL ingest in the daemon preserves a single write authority and reuses the existing append/fanout path.

### Transport decision

Implement **OTLP/HTTP JSON** in v1, listening on loopback only.

Rationale:

- Codex officially supports both `otlp-http` and `otlp-grpc` exporters for OTEL logs.  [oai_citation:1‡OpenAI Developers](https://developers.openai.com/codex/config-advanced)
- OTLP/HTTP is standard POST request/response, supports JSON protobuf encoding, and uses `/v1/logs` as the default log endpoint path. JSON payloads require `Content-Type: application/json`, and the response must use the same content type as the request.  [oai_citation:2‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)
- There is a recent Codex discussion reporting that `otlp-grpc` yielded low-level `resourceSpans`/h2 transport noise instead of the expected `codex.*` log events, while switching to HTTP JSON produced the expected events. Treat this as an operational signal, not a protocol guarantee.  [oai_citation:3‡GitHub](https://github.com/openai/codex/discussions/17687)

Do **not** implement gRPC in v1.

## Non-Goals

This spec does **not** include:

- trace ingestion
- metrics ingestion
- redaction or payload filtering
- derived/synthetic high-level events beyond direct OTEL log capture
- changes to `hrc monitor watch --follow` output format
- normalization of Codex logs into Claude-style hook semantics

This version stores full Codex OTEL event payloads as received and normalized.

## Requirements

### 1. Add a new event source

Extend `HrcEventSource` in `packages/hrc-core/src/contracts.ts`:

```ts
export type HrcEventSource = 'agent-spaces' | 'hook' | 'hrc' | 'tmux' | 'otel'
```

No SQLite migration is required for `events.source`; it is already stored as `TEXT`.

### 2. Add an OTLP/HTTP listener to the daemon

Add a second HTTP listener in `packages/hrc-server/src/index.ts` with these constraints:

- bind to `127.0.0.1` only
- preferred port: `4318`; if occupied, fall back to an OS-chosen ephemeral port on loopback
- route: `POST /v1/logs`
- accept only OTLP/HTTP JSON in v1
- reject non-loopback binds in server config
- do not expose this listener on Unix socket or public interfaces

OTLP/HTTP uses POST, the default path for log export is `/v1/logs`, and the default OTLP/HTTP port is `4318`.  [oai_citation:4‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

The resolved listener endpoint (host + port + path, e.g. `http://127.0.0.1:4318/v1/logs`) is **daemon-stable**: the daemon binds once at startup and every launch artifact written by that daemon embeds the same `endpoint`. Only per-launch auth material (`secret` / `authHeaderValue`) rotates between launches. This avoids hardcoded-port collisions when multiple HRC daemons run on the same host (dev/test/user) while keeping a single well-known default.

### 3. Authenticate and correlate each Codex OTEL export to an HRC launch

Do **not** use anonymous OTEL ingest.

Use launch-scoped authentication and correlation.

#### 3.1 Launch auth model

At launch creation time for Codex runtimes:

- generate `otelSecret` as a random opaque string
- persist it in the launch artifact
- configure Codex to send a static auth header on every OTEL request

Use this header:

- `x-hrc-launch-auth: <launchId>.<otelSecret>`

This avoids relying on environment interpolation in OTEL headers. Codex supports static OTEL exporter headers, and there is a current bug report showing `${ENV}` interpolation in OTEL exporter headers does not reliably work, while hardcoded values do.  [oai_citation:5‡OpenAI Developers](https://developers.openai.com/codex/config-reference)

#### 3.2 Why header auth instead of per-launch paths

Use the standard OTLP path `/v1/logs` and correlate via header auth rather than inventing per-launch URL paths. OTLP does allow non-default paths, but using the standard path keeps the receiver OTLP-shaped and minimizes protocol drift.  [oai_citation:6‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

#### 3.3 Correlation source of truth

Do **not** add a new DB table for OTEL tokens in v1.

Instead:

- extend `HrcLaunchArtifact` with an optional `otel` block
- persist launch OTEL auth material in the existing launch artifact JSON
- validate incoming auth by:
  1. parsing `launchId` from `x-hrc-launch-auth`
  2. loading the launch record from `db.launches`
  3. reading the existing launch artifact file from `launch.launchArtifactPath`
  4. comparing the stored `otel.secret` to the supplied secret in constant time

This reuses existing launch persistence and survives daemon restarts without a schema migration.

### 4. Extend `HrcLaunchArtifact`

In `packages/hrc-core/src/contracts.ts`, extend `HrcLaunchArtifact`:

```ts
otel?: {
  transport: 'otlp-http-json'
  endpoint: string
  authHeaderName: 'x-hrc-launch-auth'
  authHeaderValue: string
  secret: string
}
```

Notes:

- Presence of the `otel` block means OTEL ingest is enabled for this launch; there is no separate `enabled` flag.
- `endpoint` is sourced from the running daemon's resolved OTLP listener (see §2). It is daemon-stable, not per-launch.
- `authHeaderValue` is `"<launchId>.<secret>"`, duplicated here for debug/test convenience; server code MUST re-derive and compare secrets via the `launchId → launch record → artifact → secret` path rather than trusting this string.
- Post-exit grace (see §10.4) is handled in server code by reading `launch.exitedAt` plus a fixed window — it is NOT persisted in the artifact.

### 5. Configure Codex at launch time

During Codex launch composition, inject OTEL config into the generated `CODEX_HOME/config.toml` using the existing Codex adapter config merge path in `packages/harness-codex/src/adapters/codex-adapter.ts`. Because the endpoint is known only after the daemon has started, injection happens at **launch time** (not at target-compose time). The adapter reads the `otel` block from the launch artifact and merges it into the composed config.

The normative emitted TOML uses nested-table form, which is the shape produced by `@iarna/toml` serialization of a JS object:

```toml
[otel]
environment = "hrc"
log_user_prompt = false
metrics_exporter = "none"
trace_exporter = "none"

[otel.exporter.otlp-http]
endpoint = "http://127.0.0.1:4318/v1/logs"
protocol = "json"

[otel.exporter.otlp-http.headers]
"x-hrc-launch-auth" = "<launchId>.<secret>"
```

Codex `0.121.0` also accepts the inline-table form (`exporter = { otlp-http = { ... } }`) documented on the Advanced Config page, but the nested-table form above is what this spec normatively requires because it matches the adapter's existing JS-object → TOML serialization path and removes documentation ambiguity.

This is aligned with Codex config support for:

- `otel.environment`
- `otel.exporter = otlp-http | otlp-grpc`
- `otel.exporter.<id>.endpoint`
- `otel.exporter.<id>.headers`
- `otel.exporter.<id>.protocol = binary | json`
- `otel.metrics_exporter = none | statsig | otlp-http | otlp-grpc`
- `otel.trace_exporter = none | otlp-http | otlp-grpc`  [oai_citation:8‡OpenAI Developers](https://developers.openai.com/codex/config-advanced)

Implementation requirements:

- only apply this block for Codex launches
- do not overwrite unrelated user Codex settings; merge into existing composed config the same way other Codex overrides are merged today
- explicitly set `metrics_exporter = "none"` and `trace_exporter = "none"` in v1 to keep the ingest surface limited to logs, even though Codex supports separate trace and metric exporters.  [oai_citation:9‡OpenAI Developers](https://developers.openai.com/codex/config-reference)

### 6. Implement OTLP/HTTP JSON request handling

Add a handler in `packages/hrc-server/src/index.ts`:

```ts
private async handleOtlpLogs(request: Request): Promise<Response>
```

Behavior:

1. Verify method is `POST`.
2. Verify `Content-Type` is `application/json` or starts with `application/json`.
3. Read `x-hrc-launch-auth`.
4. Validate launch auth and resolve launch/session/runtime context.
5. Parse request body as OTLP JSON `ExportLogsServiceRequest`.
6. Normalize records.
7. Append one HRC event row per OTEL `LogRecord`.
8. Call `notifyEvent(...)` after each append.
9. Return OTLP JSON success response.

If the request is malformed, return an OTLP-compatible HTTP failure code. If part of the batch is bad but the rest is valid, return success with `partialSuccess` semantics. OTLP/HTTP defines request/response behavior, full success, partial success, retryable failure handling, and same-content-type response requirements.  [oai_citation:10‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

### 7. Normalize OTLP JSON structure

The OTLP JSON body structure to support is:

- `resourceLogs[]`
  - `scopeLogs[]`
    - `logRecords[]`

JSON protobuf field names are lowerCamelCase, unknown fields must be ignored, and 64-bit integers in JSON may be encoded as decimal strings.  [oai_citation:11‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

Implement a normalizer that produces an internal intermediate shape like:

```ts
type NormalizedOtelLogRecord = {
  resource?: Record<string, unknown>
  scope?: { name?: string; version?: string; attributes?: Record<string, unknown> }
  logRecord: {
    timeUnixNano?: string
    observedTimeUnixNano?: string
    severityNumber?: number
    severityText?: string
    body?: unknown
    attributes?: Record<string, unknown>
    droppedAttributesCount?: number
    flags?: number
    traceId?: string
    spanId?: string
  }
}
```

Support OTLP `AnyValue` decoding for:

- string → string
- bool → boolean
- int → number (or string if exceeds safe-integer range; OTLP JSON permits int64 as decimal string)
- double → number
- bytes → **base64 string, as received** (no decoding in v1)
- array → array of decoded `AnyValue`s
- kvlist → object of `{ key → decoded AnyValue }`
- null / missing → `null`

`traceId` and `spanId` arrive as hex strings in OTLP JSON; store them verbatim.

### 8. Map each OTEL `LogRecord` into an HRC event row

For every normalized `LogRecord`, append exactly one HRC event.

#### 8.1 HRC envelope fields

Map as follows:

- `ts`:
  - first choice: `timeUnixNano`
  - second: `observedTimeUnixNano`
  - fallback: current server timestamp
- `hostSessionId`: from validated launch artifact / launch record
- `scopeRef`: from validated launch / session
- `laneRef`: from validated launch / session
- `generation`: from validated launch / session
- `runtimeId`: from launch/runtime when present
- `runId`: use `launchArtifact.runId` when present; otherwise omit. v1 does NOT attempt to correlate individual Codex turns to HRC runs — the launch's initial `runId` is used as a coarse tag only, and Codex turn/conversation correlation lives in `eventJson.codex.conversationId`.
- `source`: `'otel'`
- `eventKind`: extracted Codex event name or fallback
- `eventJson`: normalized OTEL payload plus HRC correlation metadata

#### 8.2 `eventKind` extraction

Use this extraction order:

1. `logRecord.attributes["event.name"]`
2. `logRecord.attributes["event_name"]`
3. `body.eventName`
4. `body.event_name`
5. fallback: `"otel.log"`

If extraction fails, do **not** reject the record; store it with `eventKind = "otel.log"`.

#### 8.3 `eventJson` structure

Persist a normalized JSON object shaped like:

```json
{
  "otel": {
    "resource": { "...": "..." },
    "scope": { "name": "...", "version": "...", "attributes": { "...": "..." } },
    "logRecord": {
      "timeUnixNano": "....",
      "observedTimeUnixNano": "....",
      "severityNumber": 9,
      "severityText": "INFO",
      "body": {},
      "attributes": {},
      "traceId": "...",
      "spanId": "..."
    }
  },
  "codex": {
    "eventName": "codex.api_request",
    "conversationId": "...",
    "model": "...",
    "appVersion": "...",
    "environment": "hrc"
  },
  "hrc": {
    "launchId": "...",
    "hostSessionId": "...",
    "runtimeId": "...",
    "runId": "..."
  }
}
```

`codex.*` log events and metadata such as conversation id, model, CLI/app version, environment tag, and sandbox/approval context are documented by Codex OTEL docs.  [oai_citation:12‡OpenAI Developers](https://developers.openai.com/codex/config-advanced)

Do not try to shrink or reinterpret Codex payloads in v1. Preserve as much structure as practical.

### 9. Preserve existing watch/read behavior

Do not change:

- `GET /v1/events`
- `hrc-sdk` watch semantics
- `hrc monitor watch --follow`
- monitor JSON line format

Codex OTEL events must appear as ordinary HRC events once appended.

### 10. Graceful handling and reliability

#### 10.1 Auth failures

If auth is missing or invalid:

- return `401` or `403`
- do not append any rows
- log a daemon-side warning with launch id if parseable

#### 10.2 Malformed OTLP JSON

If the body is not valid JSON or not shaped like OTLP `ExportLogsServiceRequest`:

- return `400`
- do not append partial garbage

#### 10.3 Partial success

If some `LogRecord`s in the batch are valid and some are not:

- append valid records
- return HTTP `200` with `Content-Type: application/json` and body:

```json
{
  "partialSuccess": {
    "rejectedLogRecords": "<N>",
    "errorMessage": "<human-readable reason>"
  }
}
```

Per OTLP/HTTP, `rejectedLogRecords` is an int64 serialized as a JSON decimal string. A fully-successful batch returns `{}` (empty JSON object) with `200`. [oai_citation:OTLP‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

#### 10.4 Post-exit grace

Because Codex exporters batch asynchronously and flush on shutdown, OTEL auth for a launch must remain valid briefly after child exit.  [oai_citation:13‡OpenAI Developers](https://developers.openai.com/codex/config-advanced)

Implementation: a fixed grace window of **30 seconds** after `launch.exitedAt`, evaluated in server code against the live launch record. Do NOT persist grace state in the launch artifact — it stays write-once.

## Implementation Plan

### Files to change

#### `packages/hrc-core/src/contracts.ts`

- add `'otel'` to `HrcEventSource`
- extend `HrcLaunchArtifact` with optional `otel` block

#### `packages/harness-codex/src/adapters/codex-adapter.ts`

- add OTEL config injection/merge support for Codex launches
- preserve existing config merge behavior
- ensure composed `config.toml` includes the `[otel]` block above when HRC enables OTEL ingest

#### `packages/hrc-server/src/index.ts`

Add:

- OTLP listener bootstrap on `127.0.0.1` (prefer port `4318`, fall back to an OS-chosen ephemeral port) and expose the resolved endpoint to callers that write launch artifacts
- `handleOtlpLogs(...)`
- `validateOtelLaunchAuth(...)`
- `readLaunchArtifactForOtel(...)`
- `normalizeOtlpJsonRequest(...)`
- `appendNormalizedOtelLogs(...)`

Implementation rule: after each successful append, call `this.notifyEvent(appended)` immediately, exactly like other event-producing paths.

#### `packages/hrc-server/src/launch/exec.ts`

- surface OTEL listener info if helpful in launch summary/debug output
- no change to existing callback/spool behavior required

### Internal helper APIs

Add internal helpers in `packages/hrc-server/src/index.ts` or a new local module:

```ts
type OtlpLaunchContext = {
  launchId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string
  runId?: string
  launchArtifactPath: string
}

async function validateOtelLaunchAuth(
  db: HrcDatabase,
  authHeader: string | null
): Promise<OtlpLaunchContext>

function normalizeOtlpJsonRequest(body: unknown): NormalizedOtelLogRecord[]

function appendNormalizedOtelLogs(
  ctx: OtlpLaunchContext,
  records: NormalizedOtelLogRecord[]
): { appended: number; rejected: number }
```

## Acceptance Criteria

Implementation is complete when all of the following are true.

### Functional

1. Launching a Codex runtime through HRC writes OTEL config into the generated `CODEX_HOME/config.toml`.
2. Codex sends OTEL logs to the HRC daemon over loopback HTTP.
3. The daemon appends those logs into the existing `events` table with `source = 'otel'`.
4. `hrc monitor watch --follow` shows those events live without any CLI read-path changes.
5. Historical replay via `--from-seq` includes previously ingested Codex OTEL events.
6. Launch/session/runtime correlation fields are populated from the HRC launch context, not guessed from Codex payloads.

### Safety / robustness

7. Invalid auth does not append rows.
8. Malformed OTLP JSON does not crash the daemon.
9. Mixed valid/invalid batches return partial success and still append valid records.
10. A daemon restart does not invalidate correlation for still-running Codex launches, because auth is validated against persisted launch artifacts rather than only in-memory state.

## Test Plan

Add tests in the existing server and codex adapter suites.

### Codex adapter tests

In `packages/harness-codex/src/adapters/...` add tests that verify:

- composed `config.toml` includes `[otel]`
- `otel.exporter = { otlp-http = ... }`
- `protocol = "json"`
- `headers["x-hrc-launch-auth"]` is written literally
- `metrics_exporter = "none"`
- `trace_exporter = "none"`

### Server tests

In `packages/hrc-server/src/__tests__/...` add tests for:

1. `POST /v1/logs` with valid auth and one valid OTLP JSON log record
   - appends one `events` row
   - `source === 'otel'`
   - `notifyEvent(...)` followers receive it

2. valid batch with multiple log records
   - appends one row per record
   - sequence ordering preserved

3. malformed auth header
   - 401/403
   - no append

4. malformed JSON body
   - 400
   - no append

5. partial-success batch
   - valid records appended
   - response includes partial success

6. post-exit grace
   - launch marked exited
   - request within grace window still accepted
   - request after grace window rejected

7. restart scenario
   - create launch artifact with OTEL secret
   - reconstruct server
   - authenticate incoming OTEL request using persisted artifact

### Fixture strategy

Create at least one captured or synthetic OTLP JSON fixture shaped like:

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "codex" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "codex" },
          "logRecords": [
            {
              "timeUnixNano": "1713370000000000000",
              "severityNumber": 9,
              "severityText": "INFO",
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "codex.api_request" } },
                { "key": "conversation.id", "value": { "stringValue": "conv_123" } },
                { "key": "model", "value": { "stringValue": "gpt-5.4-codex" } }
              ],
              "body": { "kvlistValue": { "values": [] } }
            }
          ]
        }
      ]
    }
  ]
}
```

Use lowerCamelCase JSON keys; OTLP JSON requires that shape.  [oai_citation:14‡OpenTelemetry](https://opentelemetry.io/docs/specs/otlp/)

## Explicit v1 constraints

- v1 ingests **logs only**
- v1 uses **OTLP/HTTP JSON only**
- v1 stores **full normalized payloads**
- v1 does **not** derive higher-level synthetic lifecycle events
- v1 does **not** attempt to backfill Codex events into Claude hook semantics

## Completion Notes for the Coding Agent

When implementation is done, provide:

1. the exact files changed
2. any added helper types/functions
3. the OTEL config emitted into Codex `config.toml`
4. the server route and listener configuration
5. the event row mapping logic
6. test results and any remaining caveats
