# HRCCHAT_SPEC.md

Status: Proposed v1  
Audience: HRC core, server, storage, SDK, and CLI implementation teams  
Primary deliverable: a new user-facing semantic CLI component named `hrcchat`

## 1. Purpose

This specification defines `hrcchat`, a user-facing semantic layer for directed agent messaging on top of native HRC primitives.

The intended user experience is:

- agents are always addressable for requests
- agents do not need to remain instantiated between requests
- a request can summon a target into a project/thread/lane on first contact
- subsequent requests resume the same logical target using persisted HRC continuity and continuation state
- users and agents can block on durable responses without client polling
- peers can inspect each other’s live work when a runtime is currently bound

`hrcchat` replaces the old agentchat-style registry / heartbeat / online-tracking UX with a session-centric semantic layer backed by HRC continuity, runtime, and durable message state.

## 2. Scope

This document covers:

- the user-facing `hrcchat` command surface
- the semantic model for directed messages (`dm`) and durable message history
- just-in-time target summon / runtime binding semantics
- blocking `watch` / `wait` semantics with timeout
- `peek` as a selector-based convenience layer over existing HRC capture functionality
- the HRC server, storage, contracts, and SDK additions required to implement the above

This document does **not** define launcher UX for `hrc run` / `hrc start` / `hrc attach`, nor does it redefine the low-level runtime-management surface.

## 3. Non-goals

The following are explicitly out of scope for v1:

- app-managed sessions as the backing store for harness-backed agent targets
- agent registration, deregistration, heartbeats, leases, prune, bind, or unbind semantics
- fuzzy target resolution or “best guess” matching
- client-side sleep / poll loops for blocking waits
- reconstructing semantic chat state from the raw HRC event log alone
- requiring a live runtime merely to keep an agent addressable

## 4. Architectural decision

### 4.1 Canonical backing model

Harness-backed agent targets remain **native HRC continuities/sessions/runtimes**.

`hrcchat` is a semantic layer on top of HRC. It is **not** a second ownership model for sessions, and it must not route harness-backed agents through `app_managed_sessions`.

The stable identity model is:

- stable logical target: `sessionRef`
- current active incarnation: `hostSessionId`
- ephemeral execution resource: runtime / run

### 4.2 User-facing component

V1 must create a dedicated CLI component named `hrcchat`.

Recommended packaging:

- new package: `packages/hrcchat`
- output binary: `hrcchat`
- implementation language/runtime: same as existing HRC CLI packages
- transport: typed calls through `packages/hrc-sdk`
- parsing/normalization: reuse `packages/agent-scope`

`hrcchat` should be treated as the canonical user-facing semantic layer. A future `hrc chat ...` alias is optional and out of scope for this spec.

### 4.3 Native HRC remains the source of truth

HRC remains authoritative for:

- target identity and continuity
- active host session generation
- persisted execution profile and continuation
- runtime lifecycle and liveness
- durable message storage and blocking wait primitives
- runtime capture for `peek`

## 5. Key design goals

1. **Always addressable, not always instantiated.** A target may be requestable even when no runtime is currently attached.
2. **Just-in-time summon and binding.** First contact may materialize a target and execute a turn in one operation.
3. **Deterministic continuity.** Later requests reuse the same logical target, project, lane, and stored execution profile.
4. **Durable semantic history.** User-visible message history is stored explicitly; it is not inferred from raw event rows.
5. **Blocking without polling.** `watch` and `wait` are implemented server-side with wake-up on message commit.
6. **Separation of semantic turns from literal typing.** `dm` and `send` are intentionally different operations.
7. **Agent-usable as well as human-usable.** The same surface must work from a terminal and from an agent process with `HRC_SESSION_REF` set.

## 6. Codebase constraints that shape the design

These current HRC facts are relevant to implementation:

- `resolveSession()` is create-on-miss today, which is unsuitable for read-only target inspection. V1 needs explicit read-only target lookup plus explicit target ensure/summon.
- Native HRC session rows already have the durable fields needed for summonable agent targets: `parsed_scope_json`, `last_applied_intent_json`, and `continuation_json`.
- Session rotation already carries intent and continuation forward to the new active generation. V1 should preserve and rely on that behavior.
- The SDK-backed execution path already supports non-interactive semantic turns. This is required for agent-sdk-backed targets.
- The current SDK adapter rejects `interactive !== false`; therefore the current SDK path is suitable for `dm`, not for literal interactive send.
- Existing CLI/headless support is mode-dependent by provider/frontend. V1 should model capabilities explicitly rather than assuming every harness can do detached semantic turns.
- Existing capture support is runtime-based. `peek` needs a selector-based wrapper so callers do not need raw `runtimeId`.
- Existing bridge/literal-input events do not persist message bodies, so durable user-visible history requires a new message store.

## 7. Terminology

### 7.1 Target

An executable target identified by a stable `sessionRef`.

### 7.2 Discoverable target

A target whose canonical `sessionRef` and execution profile can be derived deterministically from `agent-scope` resolution and current project/lane context, but which has not yet been materialized in HRC.

### 7.3 Summoned target

A target for which HRC has an active continuity-backed session with persisted execution profile, but which may have no live runtime.

### 7.4 Bound runtime

A currently attached runtime associated with the active host session.

### 7.5 Directed message

A durable semantic message with explicit `from`, `to`, body, sequencing, and thread metadata. Directed messages are the authoritative backing store for `messages`, `watch`, and `wait`.

### 7.6 Semantic turn

A just-in-time execution of a target in `nonInteractive` or `headless` mode, producing a durable request message and, when available, a durable reply message.

### 7.7 Literal send

Raw text injection into a live literal-capable runtime. This is a low-level operation distinct from a semantic turn.

## 8. Invariants

1. Stable executable identity is native HRC `sessionRef`.
2. `hostSessionId` is an incarnation detail and may rotate over time.
3. Harness-backed agent targets remain native HRC continuities/sessions; they are not app-managed sessions.
4. A target may be `dm`-ready with no live runtime.
5. Read-only commands (`who`, `messages`, `watch`, `wait`, `status`, `doctor`) must not create targets.
6. `summon` materializes a target without starting a runtime.
7. `dm` may auto-summon a discoverable target on first contact.
8. `send` must never auto-summon and must never silently fall back to `dm`.
9. Durable message history is stored explicitly and keyed by stable addresses, not inferred from event rows.
10. Blocking waits are server-side and wake on message commit.
11. `peek` inspects the currently bound runtime, if any; it is not a replay/history API.
12. A target is considered “available for requests” when HRC can either execute a semantic turn immediately or summon then execute using a deterministic stored/derived execution profile.
13. Project/thread/lane resolution must be deterministic and explicit; there is no fuzzy matching in v1.

## 9. Address model

### 9.1 Executable target forms

`hrcchat` must continue to reuse `agent-scope` grammar for executable targets:

- `SessionHandle`, for example `cody@agentchat~review`
- `ScopeHandle`, for example `cody@agentchat`
- canonical `scopeRef`
- canonical `sessionRef`

Normalization rules:

- omitted lane defaults to `main`
- omitted project resolves from `--project`, else cwd inference, else failure
- no fuzzy or best-candidate matching

### 9.2 Special semantic entities

The directed message layer must also support the special non-executable entities:

- `human`
- `system`
- `me` as CLI shorthand

Canonical internal form:

```ts
type HrcMessageAddress =
  | { kind: 'session'; sessionRef: string }
  | { kind: 'entity'; entity: 'human' | 'system' }
```

Resolution of `me`:

- if `HRC_SESSION_REF` is set: `{ kind: 'session', sessionRef: HRC_SESSION_REF }`
- otherwise: `{ kind: 'entity', entity: 'human' }`

## 10. User-facing CLI surface

`hrcchat` is the canonical public surface.

```bash
hrcchat [--project <project>] who
hrcchat [--project <project>] who --lane <lane>
hrcchat [--project <project>] who --discover
hrcchat who --all-projects
hrcchat who --json

hrcchat [--project <project>] summon <target>
hrcchat [--project <project>] summon <target> --json

hrcchat [--project <project>] dm <target|human|system> [message|-]
hrcchat [--project <project>] dm <target|human|system> --file <path>
hrcchat [--project <project>] dm <target> --mode auto|headless|nonInteractive
hrcchat [--project <project>] dm <target|human|system> --respond-to <me|human|system|target>
hrcchat [--project <project>] dm <target|human|system> --reply-to <message-id|seq>
hrcchat [--project <project>] dm <target|human|system> --json

hrcchat [--project <project>] send <target> [message|-]
hrcchat [--project <project>] send <target> --file <path>
hrcchat [--project <project>] send <target> --enter
hrcchat [--project <project>] send <target> --no-enter
hrcchat [--project <project>] send <target> --json

hrcchat [--project <project>] messages [<target>]
hrcchat [--project <project>] messages --to <me|human|system|target>
hrcchat [--project <project>] messages --from <me|human|system|target>
hrcchat [--project <project>] messages --responses-to <me|human|system|target>
hrcchat [--project <project>] messages --thread <message-id|seq>
hrcchat [--project <project>] messages --after <cursor>
hrcchat [--project <project>] messages --limit <n>
hrcchat [--project <project>] messages --json

hrc monitor watch [selector] [--follow] [--timeout <duration>] [--json]
hrc monitor wait msg:<message-id> --until response-or-idle [--timeout <duration>] [--json]

hrcchat [--project <project>] peek <target>
hrcchat [--project <project>] peek <target> --lines <n>
hrcchat [--project <project>] peek <target> --json

hrc monitor show
hrc monitor show --json
hrc monitor show <target>

hrcchat doctor
hrcchat doctor --json
hrcchat [--project <project>] doctor <target>
```

## 11. Command semantics

### 11.1 `who`

Purpose: list target availability computed from HRC truth, not heartbeats.

Default behavior:

- show summoned/bound/busy/broken targets in current project context
- do not create or summon targets
- surface a target-oriented view rather than raw session rows

`--discover` behavior:

- include discoverable-but-not-yet-summoned targets that resolve from current context
- these entries are candidates for first-contact `dm` / `summon`

Recommended output fields:

- display target handle
- canonical `sessionRef`
- state: `discoverable | summoned | bound | busy | broken`
- `dmReady: boolean`
- `sendReady: boolean`
- `peekReady: boolean`
- supported modes
- current generation
- active host session id, if any
- last activity timestamp

### 11.2 `summon`

Purpose: materialize a target into HRC without keeping a live harness around.

Required behavior:

1. normalize target to canonical `sessionRef`
2. derive deterministic execution profile using the same placement/provider resolution logic used for launch flows
3. create the active continuity/session if missing
4. persist the execution profile on the active session
5. persist parsed scope metadata on the active session
6. do **not** start a runtime
7. do **not** execute a turn

`summon` must be idempotent from an operator perspective. Re-running it must not reset continuation, rotate generation, or create a runtime.

### 11.3 `dm`

Purpose: send a semantic directed request.

`dm` is the primary semantic primitive for `hrcchat`.

#### 11.3.1 Address behavior

- if `to` is a session target, `dm` executes a semantic turn
- if `to` is `human` or `system`, `dm` stores a durable message only and performs no execution

#### 11.3.2 Auto-summon behavior

If the target is discoverable but not yet summoned, `dm` must auto-summon it before execution.

#### 11.3.3 Execution modes

Supported v1 modes for `dm`:

- `nonInteractive`
- `headless`
- `auto`

`interactive` is not a required `dm` mode in v1. Interactive-only runtimes may still be used through `send`, but they are not required to support dormant summon-and-turn semantics.

Mode resolution for `--mode auto`:

1. explicit stored target profile default, if present and valid
2. provider/frontend capability for the target
3. preferred order:
   - `nonInteractive` for SDK-backed targets
   - `headless` for detached CLI/headless-capable targets
4. fail with `unsupported_capability` if no semantic turn mode is available

#### 11.3.4 Request/response message behavior

A successful `dm` to an executable target must create at least one durable message record:

- the outbound request message

When the semantic turn produces final textual output, `dm` must also create a durable reply message record:

- `from = target session`
- `to = respond-to address` (default: `me`)
- `replyTo = outbound request message`
- `root = outbound request message root`
- `body = final textual output`

This automatic reply creation is what makes `messages`, `watch`, and `wait` usable for semantic turns without relying on raw events.

#### 11.3.5 Threading and `--reply-to`

If `--reply-to <message-id|seq>` is supplied, the new outbound message must:

- set `replyToMessageId` to the referenced message
- inherit `rootMessageId` from the referenced message’s root

This is required so agents can reply into an existing thread explicitly, including replies addressed to `human` or `system`.

#### 11.3.6 Default `respond-to`

Default `respond-to` is `me`.

That means:

- from a human terminal: replies default to `human`
- from within an agent session: replies default to that agent’s session address

`--respond-to human` is the mechanism for controller-agent workflows where another agent should answer the human directly.

#### 11.3.7 Handoff envelope and monitor wait

`dm --json` returns a handoff envelope. Callers that need to block for a response use `hrc monitor wait msg:<messageId> --until response-or-idle`.

The monitor wait condition correlates the response to the newly created outbound request message.

#### 11.3.8 Output behavior

Human-mode output rules:

- if `dm` produces an immediate reply message addressed to `me`, print the reply body
- otherwise print an acknowledgement with the request target and message sequence/id

JSON-mode output returns the request record, execution metadata, reply record if available, and top-level monitor handoff fields.

### 11.4 `send`

Purpose: literal text injection into a currently live runtime.

Required behavior:

1. resolve target to active continuity
2. require a live literal-capable runtime
3. append a durable message record representing the literal send
4. inject text with `enter=true` by default
5. persist delivery result

`send` must not:

- create a target
- auto-summon a target
- silently fall back to `dm`
- pretend success when only a dormant profile exists

### 11.5 `messages`

Purpose: query durable directed messages.

This command replaces generic `history` terminology. `messages` is the canonical public name.

Positional target behavior:

- `messages <target>` means “messages involving this target as sender or recipient”

Filters:

- `--to`
- `--from`
- `--responses-to` as a user-facing alias for `--to`
- `--thread` for a message root chain; the supplied message id/seq may be any message in the thread and must resolve to the root
- `--after` using durable monotonic cursor/sequence
- `--limit`

Results are ordered by durable sequence.

### 11.6 `watch`

Purpose: stream matching durable directed messages.

Behavior:

- without `--follow`, return a filtered tail
- with `--follow`, block and stream future matches
- with `--timeout`, terminate cleanly when no matching message arrives before timeout

Implementation requirement:

- `watch` must be backed by a server-side stream over the durable message store, not client polling

### 11.7 `wait`

Purpose: block until the first matching durable message appears.

Behavior:

- returns exactly one matched message, or timeout
- uses the same filter grammar as `watch`
- must be implemented server-side

Recommended timeout behavior:

- timeout returns a structured non-error result, not an HTTP failure
- CLI may map timeout to exit code `124`

### 11.8 `peek`

Purpose: inspect what a peer is currently working on.

Behavior:

1. resolve target to the active continuity
2. find the most relevant currently bound runtime
3. if tmux-backed, use capture-pane semantics
4. if SDK-backed, read runtime buffers
5. return text; callers should not need raw `runtimeId`

`peek` is best-effort on a currently bound runtime. If no capturable runtime is active, return `runtime_unavailable`.

### 11.9 `status`

Without target:

- HRC connectivity
- API compatibility
- current project inference
- caller identity (`human` or current session)
- message store availability

With target:

- normalized target
- `sessionRef`
- target state
- supported modes
- persisted profile summary
- active host session/generation
- runtime summary, if bound
- `dmReady`, `sendReady`, `peekReady`

### 11.10 `doctor`

Without target:

- HRC daemon/socket reachability
- server/schema version compatibility
- tmux availability where relevant
- message store and watch/wait infrastructure health

With target:

- parse/normalization errors
- missing project context
- target not discoverable
- target discoverable but not summonable
- invalid or missing execution profile
- provider mismatch
- stale active generation / stale context
- no dm-capable mode available
- no live runtime for `send` / `peek`

## 12. Capability model

Every target view should compute capabilities explicitly.

Recommended target capability shape:

```ts
type TargetCapabilityView = {
  state: 'discoverable' | 'summoned' | 'bound' | 'busy' | 'broken'
  modesSupported: Array<'headless' | 'nonInteractive'>
  defaultMode: 'headless' | 'nonInteractive' | 'none'
  dmReady: boolean
  sendReady: boolean
  peekReady: boolean
}
```

Interpretation:

- `discoverable`: target can be resolved but has not been materialized
- `summoned`: target exists in HRC, has persisted profile, no live runtime is required for `dm`
- `bound`: live runtime present and idle
- `busy`: live runtime has an active run
- `broken`: target exists but its stored profile/continuation is invalid or cannot currently be used

Recommended readiness rules:

- `dmReady` is true when the target supports `nonInteractive` or `headless`, or can be auto-summoned into such a mode
- `sendReady` is true only when a live literal-capable runtime is currently bound
- `peekReady` is true only when a capturable runtime is currently bound

## 13. Persisted target profile

V1 should persist the execution profile on the active native HRC session rather than creating a second target store.

The persisted profile is composed from existing native fields:

- `sessions.last_applied_intent_json`
- `sessions.parsed_scope_json`
- `sessions.continuation_json`

Required semantics:

- `summon` stores a deterministic execution profile without starting a runtime
- `dm` reuses the stored profile by default
- session rotation preserves intent and continuation into the new active generation
- explicit future profile refresh/update flags are optional and out of scope for v1

## 14. Durable message model

### 14.1 Why a dedicated message store is required

Current HRC events and bridge delivery events do not persist full message bodies. Therefore a durable user-visible message store is required for:

- `messages`
- `watch`
- `wait`
- durable request/reply threading
- blocking on responses to `human`, `system`, or another agent

### 14.2 Required schema

Suggested schema:

```sql
CREATE TABLE messages (
  message_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  reply_to_message_id TEXT,
  root_message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  body_format TEXT NOT NULL,
  execution_state TEXT NOT NULL,
  execution_mode TEXT,
  session_ref TEXT,
  host_session_id TEXT,
  generation INTEGER,
  runtime_id TEXT,
  run_id TEXT,
  transport TEXT,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT
);

CREATE INDEX idx_messages_to_seq       ON messages(to_kind, to_ref, message_seq);
CREATE INDEX idx_messages_from_seq     ON messages(from_kind, from_ref, message_seq);
CREATE INDEX idx_messages_root_seq     ON messages(root_message_id, message_seq);
CREATE INDEX idx_messages_reply_to_seq ON messages(reply_to_message_id, message_seq);
CREATE INDEX idx_messages_session_seq  ON messages(session_ref, message_seq);
CREATE INDEX idx_messages_run          ON messages(run_id);
```

### 14.3 Required record shape

```ts
type HrcMessageRecord = {
  messageSeq: number
  messageId: string
  createdAt: string
  kind: 'dm' | 'literal' | 'system'
  phase: 'request' | 'response' | 'oneway'
  from: HrcMessageAddress
  to: HrcMessageAddress
  replyToMessageId?: string
  rootMessageId: string
  body: string
  bodyFormat: 'text/plain'
  execution: {
    state: 'not_applicable' | 'accepted' | 'started' | 'completed' | 'failed'
    mode?: 'headless' | 'nonInteractive' | 'literal'
    sessionRef?: string
    hostSessionId?: string
    generation?: number
    runtimeId?: string
    runId?: string
    transport?: 'sdk' | 'tmux'
    errorCode?: string
    errorMessage?: string
  }
  metadataJson?: Record<string, unknown>
}
```

### 14.4 Phase semantics

Recommended derivation rules:

- `dm` to an executable session target creates a `phase='request'` message
- an automatic reply created from semantic turn output uses `phase='response'`
- a manually-authored message with `--reply-to` should use `phase='response'`
- a manually-authored message without `--reply-to` to `human` or `system` should use `phase='oneway'`
- `send` uses `kind='literal'` and `phase='oneway'`

### 14.5 Thread semantics

For root request messages:

- `replyToMessageId = null`
- `rootMessageId = messageId`

For replies:

- `replyToMessageId = parent message id`
- `rootMessageId = root request message id`

This is required so `dm --json plus hrc monitor wait`, `watch --thread`, and `wait --thread` can be precise and avoid waking on unrelated messages to the same recipient.

## 15. HRC primitive additions

### 15.1 Read-only target lookup/listing

Need a non-mutating target view.

Suggested routes:

```http
GET /v1/targets?projectId=<id>&lane=<lane>&discover=<bool>
GET /v1/targets/by-session-ref?sessionRef=<canonical>
```

These routes must not create missing sessions.

Suggested response shape:

```ts
type HrcTargetView = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  state: 'discoverable' | 'summoned' | 'bound' | 'busy' | 'broken'
  parsedScopeJson?: Record<string, unknown>
  lastAppliedIntentJson?: HrcRuntimeIntent
  continuation?: HrcContinuationRef
  activeHostSessionId?: string
  generation?: number
  runtime?: {
    runtimeId: string
    transport: 'sdk' | 'tmux'
    status: string
    supportsLiteralSend: boolean
    supportsCapture: boolean
    activeRunId?: string
    lastActivityAt?: string
  }
  capabilities: TargetCapabilityView
}
```

### 15.2 Explicit target ensure / summon primitive

Need an explicit materialization primitive.

Suggested route:

```http
POST /v1/targets/ensure
```

Suggested request:

```ts
type EnsureTargetRequest = {
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  parsedScopeJson?: Record<string, unknown>
}
```

Required behavior:

- create continuity/session if missing
- persist `lastAppliedIntentJson`
- persist `parsedScopeJson`
- do not start a runtime
- return `HrcTargetView`

### 15.3 Selector-based semantic turn primitive

Need a high-level semantic turn primitive suitable for `dm`.

Suggested route:

```http
POST /v1/turns/by-selector
```

Suggested request:

```ts
type DispatchTurnBySelectorRequest = {
  selector: { sessionRef: string }
  prompt: string
  mode?: 'auto' | 'headless' | 'nonInteractive'
  runtimeIntent?: HrcRuntimeIntent
  createIfMissing?: boolean
  parsedScopeJson?: Record<string, unknown>
  fences?: HrcFence
}
```

Suggested response:

```ts
type DispatchTurnBySelectorResponse = {
  runId: string
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux'
  mode: 'headless' | 'nonInteractive'
  status: 'completed' | 'started'
  finalOutput?: string
  continuationUpdated: boolean
}
```

`finalOutput` is the key addition needed so a semantic `dm` can persist an automatic reply record when a turn completes with textual output.

### 15.4 Selector-based literal send primitive

Need a high-level literal-input primitive so `hrcchat send` does not depend on bridge lifecycle internals.

Suggested route:

```http
POST /v1/literal-input/by-selector
```

Suggested request:

```ts
type DeliverLiteralBySelectorRequest = {
  selector: { sessionRef: string }
  text: string
  enter?: boolean
  fences?: HrcFence
}
```

### 15.5 Durable message APIs

Need durable query and blocking APIs.

Suggested routes:

```http
POST /v1/messages
GET  /v1/messages
GET  /v1/messages/watch
POST /v1/messages/wait
```

Suggested query/wait filter shape:

```ts
type HrcMessageFilter = {
  participant?: HrcMessageAddress
  from?: HrcMessageAddress
  to?: HrcMessageAddress
  thread?: { rootMessageId: string }
  afterSeq?: number
  kinds?: Array<'dm' | 'literal' | 'system'>
  phases?: Array<'request' | 'response' | 'oneway'>
  limit?: number
}
```

Implementation requirements:

- durable append before publish
- wake `watch` / `wait` subscribers only after commit
- `wait` timeout returns a structured timeout result

### 15.6 Atomic semantic DM helper

The cleanest implementation path is to add a server-side helper that `hrcchat dm` can call atomically.

Suggested route:

```http
POST /v1/messages/dm
```

Suggested request:

```ts
type SemanticDmRequest = {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  mode?: 'auto' | 'headless' | 'nonInteractive'
  respondTo?: HrcMessageAddress
  replyToMessageId?: string
  runtimeIntent?: HrcRuntimeIntent
  createIfMissing?: boolean
  parsedScopeJson?: Record<string, unknown>
  wait?: {
    enabled: boolean
    timeoutMs?: number
  }
}
```

Required behavior:

1. append outbound request message
2. if `to.kind === 'session'`, summon target if allowed and needed
3. execute semantic turn
4. if final text is produced, append reply message linked to the request thread
5. if `wait.enabled`, block on the default/requested filter server-side
6. return request record, execution metadata, and matched reply if available

This helper is not strictly required if the implementation prefers client-side composition over lower-level routes, but it is the recommended v1 path because it keeps request creation, execution, reply creation, and waiting coherent.

### 15.7 Selector-based capture

Need selector-based capture for `peek`.

Suggested route:

```http
POST /v1/capture/by-selector
```

Suggested request:

```ts
type CaptureBySelectorRequest = {
  selector: { sessionRef: string }
  lines?: number
}
```

## 16. `watch` and `wait` implementation model

The target environment does not permit client-side sleep/poll loops. Therefore:

- `watch` and `wait` must be implemented inside HRC server
- message commits must wake blocked subscribers
- `watch --follow` should stream NDJSON or another incremental framing format
- `wait` should return exactly one matched message or a timeout result

Recommended timeout result:

```ts
type WaitMessagesResponse =
  | { matched: true; record: HrcMessageRecord }
  | { matched: false; reason: 'timeout' }
```

## 17. `peek` implementation model

`peek` is a convenience layer over existing capture mechanisms.

Resolution order:

1. resolve target by `sessionRef`
2. find the currently bound runtime for the active host session
3. if runtime transport is `tmux`, use capture-pane
4. if runtime transport is `sdk`, return concatenated runtime buffer text
5. if no capturable bound runtime exists, return `runtime_unavailable`

`peek` is intentionally live-state oriented. It is not a substitute for durable `messages` history.

## 18. Error model

Reuse HRC domain errors where possible.

Recommended codes:

- `unknown_session`
- `stale_context`
- `runtime_busy`
- `runtime_unavailable`
- `unsupported_capability`
- `provider_mismatch`
- `missing_runtime_intent`
- `malformed_request`

Command guidance:

- `dm` to a non-discoverable target: `unknown_session` or resolution error
- `dm` to an interactive-only target with no semantic mode: `unsupported_capability`
- `send` to a dormant target: `runtime_unavailable`
- `peek` with no live capturable runtime: `runtime_unavailable`
- `wait` timeout: structured timeout result, not HTTP failure

## 19. Package-level implementation work

### 19.1 `packages/hrc-core`

Add contracts/types for:

- `HrcTargetView`
- target lookup/list/ensure
- selector-based semantic turn dispatch
- selector-based literal send
- durable message record/filter/query/watch/wait
- selector-based capture
- semantic `dm` helper, if implemented server-side

### 19.2 `packages/hrc-store-sqlite`

Add:

- `messages` table
- indexes listed above
- repository methods for insert/query/watch cursor support
- migration coverage and tests

### 19.3 `packages/hrc-server`

Implement:

- read-only target lookup/list
- target ensure/summon
- selector-based semantic turn dispatch with `finalOutput`
- selector-based literal input
- durable message APIs
- server-side watch/wait wake-up plumbing
- selector-based capture
- atomic semantic `dm` helper, if adopted

### 19.4 `packages/hrc-sdk`

Expose typed methods for all new routes used by `hrcchat`.

### 19.5 `packages/hrcchat`

Create a new package with:

- binary entrypoint `hrcchat`
- CLI parsing and rendering
- JSON and human-readable output modes
- stable exit code behavior for timeout/errors
- direct use of `agent-scope` normalization and `hrc-sdk` transport

Recommended structure:

- `src/main.ts`
- `src/commands/*.ts`
- `src/render/*.ts`
- `src/normalize.ts`
- `src/errors.ts`

## 20. Acceptance criteria

V1 is complete when all of the following work end-to-end.

1. A previously nonexistent but discoverable target can be summoned without starting a runtime.
2. `hrcchat dm <target> ...` can auto-summon and execute a semantic turn for:
   - SDK-backed targets in `nonInteractive` mode
   - detached headless-capable targets in `headless` mode
3. A successful semantic turn stores:
   - an outbound request message
   - an automatic reply message when final text is available
4. `hrcchat dm <target> ... --respond-to human` stores the reply addressed to `human`.
5. `hrc monitor wait msg:<messageId> --until response-or-idle --timeout <d>` blocks server-side and returns the monitor condition result.
6. `hrc monitor watch --follow` streams new durable messages without polling.
7. `hrcchat send <target> ...` succeeds only when a live literal-capable runtime is present.
8. `hrcchat peek <target>` captures live output without requiring raw `runtimeId`.
9. `who` / `doctor` report availability from HRC truth, not heartbeats; monitor state lives under `hrc monitor show`.
10. Session rotation preserves continuation/profile such that later `dm` requests continue the same logical target.

## 21. Representative examples

Summon a dormant agent into the current project/lane:

```bash
hrcchat summon cody@agentchat
```

Prime a cold agent and print the immediate semantic reply if one is produced:

```bash
hrcchat dm cody@agentchat "Read the repo and prepare a review plan."
```

Controller-agent asks a worker to answer the human directly:

```bash
hrcchat dm cody@agentchat "Summarize the current risks for the human." --respond-to human
```

Wait until someone responds to the human on the same request thread:

```bash
hrc monitor wait msg:msg_01J... --until response-or-idle --timeout 15m
```

Tail all messages involving a target:

```bash
hrcchat messages cody@agentchat --limit 50
```

Follow new replies to the current caller:

```bash
hrc monitor watch msg:msg_01J... --follow --timeout 10m
```

Literal-type into a currently live runtime:

```bash
hrcchat send cody@agentchat "continue from the last checkpoint" --enter
```

Peek at current live work:

```bash
hrcchat peek cody@agentchat --lines 120
```

## 22. Final recommendation

The right v1 shape is:

- a dedicated user-facing semantic component named `hrcchat`
- native HRC continuities/sessions as the backing target model
- `summon` for materialization without instantiation
- `dm` as the primary semantic request primitive
- `send` as the live literal-input primitive
- `messages` as the durable message-history/query surface
- server-side `watch` and `wait` over the message store
- `peek` as selector-based live runtime capture

This yields the desired experience: agents are always reachable as logical targets, but do not need to remain instantiated unless work is actively running.
