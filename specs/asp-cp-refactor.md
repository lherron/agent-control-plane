# Spec: Clean Separation Between Control‑Plane (Rex / CP) and Agent‑Spaces (ASP)

## Problem statement

The current CP↔ASP integration has unclear boundaries, leaked abstractions, and tangled responsibilities. CP imports ASP internals and performs ASP-owned work (materialization, skill discovery/injection, lock/cache handling). ASP encodes CP concepts (CP context/env semantics) and exposes harness-specific surfaces that force CP to branch on implementation details.

This spec defines a clean separation: CP owns orchestration and UI; ASP owns environment resolution/materialization and harness execution behind a single stable public interface. Harnesses are stateful, conversational sessions; CP persists a harness continuity key (`harnessSessionId`) so subsequent turns attach to the same harness-side history.

## Goals

CP must be able to:
- Execute many conversational turns against the same harness session while keeping harness history continuity.
- Route turns to a harness/model using a capabilities API exposed by ASP.
- Receive a full event stream (event bridge) for UI rendering and orchestration.
- Persist only opaque continuity artifacts returned by ASP (at minimum `harnessSessionId`).

ASP must:
- Encapsulate all space/target resolution, materialization, and skill/hook/tool discovery & injection.
- Provide one harness‑agnostic interface that behaves the same across harness implementations.
- Avoid any CP-specific vocabulary or semantics (no CP types, no parsing of CP-specific env keys).
- Keep caching/locks/materialization strictly internal, operationally configurable under `aspHome`.

## Non‑goals

- Idempotency/retry semantics for `runTurn` (explicitly deferred; `runTurn` is not idempotent).
- Cross-host attachments / remote worker semantics (single-host/shared filesystem only in this phase).
- Interactive permissions/approvals (permissions are disabled / auto-approved).
- Rich stable error taxonomy beyond the minimal MVP codes listed below.

## Terminology

- **External session**: CP’s persistent session concept bound to a conversation. Identified by `externalSessionId` (opaque to ASP).
- **Turn / run**: One prompt execution. Identified by `externalRunId` (CP-generated, opaque to ASP).
- **Harness session**: Harness-native conversational session that owns history/state. Identified by `harnessSessionId` (opaque string returned by ASP after the first successful turn).
- **Space**: Opaque string reference passed from CP to ASP; format is owned by ASP.
- **Target**: Named selection within an ASP targets file located in `targetDir`; CP does not parse TOML.

## Core lifecycle model (stateful harness sessions, implicit creation)

- Harnesses are conversational and maintain history internally (Claude Code / Agent SDK / Pi).
- There is **no explicit `createSession`** step. A harness session is created implicitly by the first `runTurn` (without `harnessSessionId`).
- `harnessSessionId` is only available after the first turn executes successfully.
- ASP is **stateless per session** (no in-memory per-session state across turns). ASP may read/write internal state on disk under `aspHome`.
- Turns are **strictly serial per harness session**: CP MUST NOT run parallel turns for the same `harnessSessionId`.
- Parallel turns across different harness sessions are supported.

## Ownership and boundary

CP owns:
- External session persistence, routing, run queueing, run lifecycle state machines, and UI.
- Turn serialization per `harnessSessionId` across all deployment topologies.
- Harness selection and model selection (validated via ASP capabilities).

ASP owns:
- Resolving spaces/targets to a runnable environment.
- All materialization and injection (skills/hooks/tools) implied by spaces/targets.
- Internal caches/locks/materialization details (not exposed).
- Executing harness turns and emitting a full event stream.

Adapter:
- `session-agent-spaces` remains in CP and is the only layer that speaks to ASP.

---

## Required changes

### 1) Remove CP env/context leakage into ASP

ASP MUST NOT define or depend on CP-specific concepts (e.g., `CpContext`, `CP_RUN_ID` semantics).

Instead:
- ASP accepts `env: Record<string, string>` as literal env passthrough to harness/tool runtime.
- ASP treats env keys/values as opaque; it must not interpret CP-prefixed keys.

### 2) Single public ASP interface; CP imports only from it

CP MUST import only from the public `agent-spaces` surface and MUST NOT import `spaces-config`, `spaces-execution`, or any internal ASP types/utilities.

### 3) CP does no materialization; CP has no notion of skills/hooks/tools

CP supplies only spaces or a target (which implicitly defines skills/hooks/tools). CP does not read skill files, parse frontmatter, compute hashes, manage plugin dirs, or manage injection registries.

All skill/hook/tool discovery and injection is strictly internal to ASP.

### 4) Space refs are opaque strings; targets are passed as `targetName + targetDir`

- CP passes space refs as strings without parsing/validation.
- Targets are specified by:
  - `targetName` (string)
  - `targetDir` (absolute path; REQUIRED)
- CP sets `targetDir` to the project root directory on disk (owned by CP; the name “projectDir” does not appear on the boundary).

### 5) Caching/locks/materialization are strictly internal to ASP (no runtime cache flags)

CP does nothing with caching. There are no cache/refresh flags on the CP↔ASP interface.

Assumptions:
- Any “freshness” intent is expressed by selecting different space refs and/or targets (selectors encoded in refs/target composition), not runtime flags.
- ASP has its own operational configuration surface rooted under `aspHome` that can tune cache/lock/materialization behavior.
- CP persists only opaque continuity artifacts (e.g., `harnessSessionId`), never lock/cache details.

### 6) Harness session continuity, model mutability, and capability discovery

** Note: 
Only pi-sdk and agent-sdk harnesses should be advertised as available for use by control-plane, interactive harnesses (Claude Code, Pi) should not be used directly.
agent-sdk providers: api and claude.  models opus/haiku/sonnet (default opus) 
pi providers: api and openai-codex.  models gpt-5.2-codex and gpt-5.2 (codex default)
**

- Resuming a session means resuming a harness session; therefore the **harness is fixed for the lifetime of `harnessSessionId`**.
- The model may change only within what that harness supports.

ASP MUST expose `getHarnessCapabilities()` enumerating:
- available harnesses
- supported model identifiers per harness

Provider distinctions are encoded inside the model identifier string (e.g., `api/opus-4-5` vs `claude/opus-4-5`), not as a separate top-level concept.

ASP MUST return `model_not_supported` when CP requests an unsupported model for a harness.

### 7) Permissions disabled (auto-approve)

No interactive permission callback/events exist on the boundary in this phase. Tool calls proceed automatically. The event bridge remains complete (messages/tool calls/results/complete).

### 8) Minimal error taxonomy (MVP)

The only stable boundary error codes are:
- `resolve_failed`
- `harness_session_not_found`
- `model_not_supported`

Everything else is generic/internal.

### 9) `describe()` inventory

`describe()` returns names-only inventory of **all hooks, skills, and tools** available in the composed/materialized environment. No content/implementation details. No guarantees about uniqueness/order beyond “whatever ASP returns”.

---

## Public interface contract

### Package surface

CP imports only from:

```ts
import { createAgentSpacesClient } from 'agent-spaces';
```

### AgentSpacesClient

```ts
export interface AgentSpacesClient {
  /**
   * Execute one conversational turn.
   *
   * - If harnessSessionId is absent: create a new harness session implicitly.
   * - If harnessSessionId is present: resume that harness session.
   *
   * NOT IDEMPOTENT. Retries may duplicate side effects.
   */
  runTurn(req: RunTurnRequest): Promise<RunTurnResponse>;

  /**
   * Validate that the provided SpaceSpec can be resolved/materialized.
   * Does not create/resume a harness session.
   */
  resolve(req: ResolveRequest): Promise<ResolveResponse>;

  /**
   * Names-only inventory of hooks/skills/tools in the resolved environment.
   * Does not create/resume a harness session.
   */
  describe(req: DescribeRequest): Promise<DescribeResponse>;

  /**
   * Enumerate available harnesses and supported models per harness.
   * Stable for the running ASP instance (does not vary by request).
   */
  getHarnessCapabilities(): Promise<HarnessCapabilities>;
}

export function createAgentSpacesClient(): AgentSpacesClient;
```

### SpaceSpec

Exactly one of `spaces` or `target` is required.

```ts
export type SpaceSpec =
  | { spaces: string[] } // opaque to CP
  | { target: { targetName: string; targetDir: string } }; // targetDir REQUIRED
```

`targetDir` is an absolute path. CP populates it with the project root directory path.

ASP resolution rule for targets:
- ASP reads `${targetDir}/asp-targets.toml` (and any other targetDir-relative resources per existing ASP behavior) and selects `targetName`.

### Requests / responses

#### RunTurnRequest

```ts
export interface RunTurnRequest {
  // CP correlation identifiers (opaque to ASP; echoed on events)
  externalSessionId: string;
  externalRunId: string;

  // ASP operational root (REQUIRED)
  aspHome: string;

  // Environment selection
  spec: SpaceSpec;

  // Harness selection (REQUIRED)
  harness: string;

  // Model selection (optional; must be supported by harness)
  model?: string;

  // Harness continuity (omitted on first turn)
  harnessSessionId?: string;

  // Working directory for harness/tools (REQUIRED)
  cwd: string;

  // Opaque env passthrough to harness/tool runtime (optional)
  env?: Record<string, string>;

  // Turn input
  prompt: string;

  // Attachments are absolute filesystem paths (optional)
  attachments?: string[];

  // Full event bridge
  callbacks: SessionCallbacks;
}
```

Notes:
- `aspHome` is the only operational root on the boundary. CP chooses it (typically the project root directory), and ASP stores internal state beneath it.
- There is intentionally no `projectDir` field on the boundary. CP may compute `targetDir`/`cwd`/`aspHome` from its internal notion of project root.

#### RunTurnResponse

```ts
export interface RunTurnResponse {
  // Present when a harness session exists (returned after successful first turn, and on resumed turns)
  harnessSessionId?: string;

  // Effective selections (useful for UI/debugging)
  harness: string;
  model?: string;

  result: RunResult;
}
```

#### ResolveRequest / ResolveResponse

```ts
export interface ResolveRequest {
  aspHome: string;
  spec: SpaceSpec;
}

export interface ResolveResponse {
  ok: boolean;
  error?: AgentSpacesError; // when ok=false (may use code resolve_failed)
}
```

#### DescribeRequest / DescribeResponse

```ts
export interface DescribeRequest {
  aspHome: string;
  spec: SpaceSpec;
}

export interface DescribeResponse {
  hooks: string[];
  skills: string[];
  tools: string[];
}
```

### Harness capabilities

Simplified, stable inventory (no request parameters):

```ts
export interface HarnessCapabilities {
  harnesses: Array<{
    id: string;        // e.g. "agent-sdk", "claude-code", "pi"
    models: string[];  // e.g. ["api/opus-4-5", "claude/opus-4-5", ...]
  }>;
}
```

### Event bridge

#### Callbacks

```ts
export interface SessionCallbacks {
  onEvent(event: AgentEvent): void | Promise<void>;
}
```

Event ordering/backpressure:
- For a given `externalRunId`, events MUST be emitted in-order with a monotonically increasing `seq`.
- If `onEvent` returns a Promise, ASP MUST await it to preserve ordering (CP handlers must be fast).

#### AgentEvent schema (minimum)

```ts
export type AgentEvent =
  | BaseEvent & { type: 'state'; state: SessionState }
  | BaseEvent & { type: 'message'; role: 'user' | 'assistant'; content: string }
  | BaseEvent & { type: 'message_delta'; role: 'assistant'; delta: string }
  | BaseEvent & { type: 'tool_call'; toolUseId: string; toolName: string; input: unknown }
  | BaseEvent & { type: 'tool_result'; toolUseId: string; toolName: string; output: unknown; isError: boolean }
  | BaseEvent & { type: 'log'; level: 'debug'|'info'|'warn'|'error'; message: string; fields?: Record<string, unknown> }
  | BaseEvent & { type: 'complete'; result: RunResult };

export interface BaseEvent {
  ts: string; // ISO-8601
  seq: number;

  externalSessionId: string;
  externalRunId: string;

  // Filled once known (may be absent early in first turn)
  harnessSessionId?: string;
}

export type SessionState =
  | 'running'
  | 'complete'
  | 'error';
```

Event bridge requirements:
- Tool calls/results MUST correlate by `toolUseId`.
- A `complete` event MUST be emitted exactly once per `externalRunId` and is terminal for that run.
- `runTurn()` Promise resolution MUST occur after `complete` is emitted (or after an unrecoverable internal failure in which case CP may receive a rejected promise and partial events).

### RunResult and errors

```ts
export interface RunResult {
  success: boolean;
  finalOutput?: string;
  error?: AgentSpacesError;
}

export interface AgentSpacesError {
  message: string;
  code?: 'resolve_failed' | 'harness_session_not_found' | 'model_not_supported';
  details?: Record<string, unknown>; // not stable
}
```

---

## Attachments (MVP)

- `attachments` are absolute filesystem paths.
- Assumptions:
  - CP, ASP, and harness/tool runtime share the same filesystem namespace.
  - CP ensures paths remain valid and readable for the duration of the turn.
  - No cross-host / remote-worker semantics are required in this phase.

---

## Session continuity and “environment identity” clarification

There is no `environmentId` in this MVP interface.

“Environment” (the composed/materialized set of skills/hooks/tools and runtime setup implied by the SpaceSpec) is:
- derived from `spec` and the files/state under `aspHome` (including ASP’s internal caches/locks/materializations),
- owned entirely by ASP, and
- not exposed as a token on the CP boundary.

If future requirements demand explicit pinning or reproducibility tokens across time independent of space selectors, an opaque environment token can be added later, but it is out of scope here.

---

## Concurrency and run state (CP responsibilities)

### Enforcing “no parallel turns per harness session”

CP is solely responsible; ASP provides no guards/detection. If CP violates this, behavior is undefined (harness state corruption and/or interleaved events are possible).

Implementation expectation inside CP (`session-agent-spaces` + router):

- CP maintains a per-external-session record that includes `harnessSessionId` once known.
- CP enforces serialization by maintaining a per-session run queue/lock keyed by:
  - `externalSessionId` always (since it exists before `harnessSessionId`), and effectively
  - the stored `harnessSessionId` once it exists (it should be 1:1 with externalSessionId in this model).
- CP only dispatches a new `runTurn` when no prior run is in-flight for that session.

### Calculating run state for a session

CP does not need TTLs to compute correctness. It can compute run state from its own orchestration:

- **Idle**: no in-flight `runTurn` for the external session.
- **Running**: a `runTurn` call has been issued and not yet completed.
- **Completed/Error**: the in-flight run finishes; CP updates run history based on `RunResult.success` and/or `AgentSpacesError`.

CP may optionally implement UI “stalled” heuristics:
- track `lastEventTs` per in-flight run from `AgentEvent.ts`,
- if no events for some threshold, mark as “stalled” in UI.
This is CP policy only; there is no ASP TTL contract in this phase and no guarantee of event periodicity.

---

## Harness session persistence and expiry

Assumption: harness sessions are “forever resumable” on a best-effort basis. CP has no contract with harness providers.

- If a harness reports a missing/invalid session on resume, ASP surfaces `harness_session_not_found` (or propagates harness error details in `details`).
- CP decides how to handle it (e.g., surface error vs start a new session by omitting `harnessSessionId` on next run).

---

## Permissions (Phase 1)

Permissions are disabled / auto-approved. Tool calls proceed without CP approval. Tool call/result events are still emitted.

---

## Migration plan

1. Implement the `agent-spaces` public surface (`runTurn`, `resolve`, `describe`, `getHarnessCapabilities`) and hide internal packages from CP.
2. Wrap existing harness adapters behind `runTurn`, emitting a consistent event stream.
3. Move all materialization + skill/hook/tool discovery/injection behind ASP internals (no CP file reads/injection registry/pluginDirs plumbing).
4. Update `session-agent-spaces` in CP to:
   - call `getHarnessCapabilities()` for routing decisions,
   - persist `harnessSessionId` returned by the first successful turn,
   - enforce no parallel turns per session,
   - forward ASP events to CP’s event fanout/UI and record run completion.
5. Remove CP imports of `spaces-config`/`spaces-execution` and delete CP-side materialization/skill handling.
6. Disable/remove interactive permissions flow; keep auto-approve behavior in ASP.

---

## Open questions

1) **Streaming semantics.** The event schema includes `message_delta`, but exact streaming guarantees are not specified (chunking granularity, whether deltas are always emitted, interleaving rules with tool events, etc.). If CP UI depends on specific streaming behavior, this needs a follow-on spec.  

2) **Idempotency / retries.** `runTurn` is explicitly non-idempotent today; a future spec may define retry semantics, dedupe keys, and side-effect handling.
