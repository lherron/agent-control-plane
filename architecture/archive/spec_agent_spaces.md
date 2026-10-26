# Agent-Spaces Spec: Provider-Typed Continuity + CP-Orchestrated Interactive Processes

**Status:** Living spec for the current provider-typed continuity model.
**Scope:** The `agent-spaces` monorepo contract for CP/HRC-owned sessions, provider-typed continuity, placement-based materialization, and CLI invocation preparation.

---

## 0) Canonical intent (constraints from model)

Agent-spaces must support the separation:

1) **Work units** (runs / turns) — CP-initiated units of work  
2) **Continuity** — provider-typed `HarnessContinuationKey` stored on **CP session**  
3) **Runtime execution** — OS processes + PTY hosting + attachments owned by CP

Agent-spaces participates as:
- the *harness backend* (SDK execution and harness-specific materialization/argv generation),
- not the orchestrator of tmux panes or ghostty surfaces.

---

## 1) Terminology in agent-spaces (public + internal)

- **Provider domain**: `anthropic | openai`
- **HarnessContinuationKey**: provider-native opaque string used to resume a conversation (typed to provider; untyped within provider)
- **ProcessInvocationSpec**: structured `{argv,cwd,env,...}` for CP to spawn a CLI harness process (no shell parsing)
- **NonInteractive turn**: agent-spaces executes a “turn” via SDK-style harness (no PTY attach semantics)
- **CLI harness process**: spawned by CP; agent-spaces only prepares invocation + materialization
- **RuntimePlacement**: host-provided placement packet describing agent root, project root, run mode, bundle selection, scaffold packets, and optional correlation metadata.
- **hostSessionId**: CP/HRC-owned host session identifier used only for correlation and active runtime addressing. It is not a provider continuation key.

> Naming: `hostSessionId` is canonical in public request/event shapes. `cpSessionId` may remain only as a deprecated compatibility alias at the boundary.

---

## 2) Public API changes (breaking)

### 2.1 Replace `harnessSessionId` with provider-typed continuity key

**Old:** `harnessSessionId?: string`  
**New:** `continuation?: { provider: ProviderDomain; key?: HarnessContinuationKey }`

Rationale: CP session is the only “session” primitive; continuity belongs to CP session, and is typed by provider.

### 2.2 Rename “external” identifiers to host correlation terminology

**Old** (agent-spaces `RunTurnRequest`):
- `externalSessionId`
- `externalRunId`

**New**:
- `hostSessionId`
- `runId`

These are correlation ids for events/logs, not continuity.

`cpSessionId` is a legacy alias accepted for compatibility only. New callers must send `hostSessionId`, either as a top-level compatibility field or in `placement.correlation.hostSessionId`.

### 2.3 Prefer placement-based requests

New host-facing calls should pass `placement: RuntimePlacement`.

Placement owns:
- `agentRoot`, optional `projectRoot`, and effective `cwd`
- run mode and bundle selection
- scaffold packets
- optional correlation metadata: `hostSessionId`, `runId`, and `sessionRef`

Legacy `aspHome + SpaceSpec + cwd` request fields remain supported for compatibility, but placement-based requests are the forward contract and should not require legacy fields.

### 2.4 Split responsibilities: `runTurnNonInteractive` vs `buildProcessInvocationSpec`

Agent-spaces exposes two distinct operations:

#### A) `runTurnNonInteractive` (SDK execution; existing `runTurn` semantics)
Executes a single turn via a nonInteractive harness (e.g. Agent SDK / Pi SDK).  
Returns (optionally) a newly observed continuation key.

#### B) `buildProcessInvocationSpec` (CLI process preparation; new)
Returns a structured process invocation spec for CP to spawn an interactive/headless CLI harness process, optionally resuming via continuation key if present.

This is the critical enabling change for tmux/ghostty integration: CP gets a fully formed `argv/env/cwd` contract and remains the only component that manipulates tmux/ghostty.

---

## 3) Current agent-spaces API surface (TypeScript)

### 3.1 Core types

```ts
export type ProviderDomain = 'anthropic' | 'openai';

export type HarnessContinuationKey = string;

export type HarnessContinuationRef = {
  provider: ProviderDomain;
  key?: HarnessContinuationKey; // absent until first successful provider turn when applicable
};

export type InteractionMode = 'interactive' | 'headless' | 'nonInteractive';
export type IoMode = 'pty' | 'pipes' | 'inherit';

export type HarnessFrontend =
  | 'agent-sdk'
  | 'pi-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi-cli';

export type ProcessInvocationSpec = {
  provider: ProviderDomain;
  frontend: HarnessFrontend;

  argv: string[];                   // authoritative argv; CP MUST NOT shell-parse
  cwd: string;
  env: Record<string, string>;

  interactionMode: InteractionMode; // headless/interactive/nonInteractive
  ioMode: IoMode;                   // pty/pipes/inherit

  continuation?: HarnessContinuationRef;

  // Optional UX-only string (copy/paste)
  displayCommand?: string;

  // Optional audit/inspection path when the invocation materializes a system prompt file.
  systemPromptFile?: string;
};
```

### 3.2 NonInteractive turn execution

```ts
export type PlacementRunTurnNonInteractiveRequest = {
  placement: RuntimePlacement;
  hostSessionId?: string;
  runId?: string;

  frontend: 'agent-sdk' | 'pi-sdk';
  model?: string;
  continuation?: HarnessContinuationRef;
  env?: Record<string,string>;
  prompt: string;
  attachments?: Array<string | AttachmentRef>;
  yolo?: boolean;
  callbacks: SessionCallbacks;
};

export type LegacyRunTurnNonInteractiveRequest = {
  hostSessionId: string;
  /** @deprecated Use hostSessionId */
  cpSessionId?: string;
  runId: string;
  aspHome: string;
  spec: SpaceSpec;
  frontend: 'agent-sdk' | 'pi-sdk';
  model?: string;
  continuation?: HarnessContinuationRef;
  cwd: string;
  env?: Record<string,string>;
  prompt: string;
  attachments?: Array<string | AttachmentRef>;
  yolo?: boolean;
  callbacks: SessionCallbacks;
};

export type RunTurnNonInteractiveRequest =
  | PlacementRunTurnNonInteractiveRequest
  | LegacyRunTurnNonInteractiveRequest;

export type RunTurnNonInteractiveResponse = {
  continuation?: HarnessContinuationRef; // set when discovered/updated
  provider: ProviderDomain;
  frontend: 'agent-sdk' | 'pi-sdk';
  model?: string;
  result: RunResult;
  resolvedBundle?: ResolvedRuntimeBundle;
};
```

### 3.3 CLI invocation preparation

```ts
export type PlacementBuildProcessInvocationSpecRequest = {
  placement: RuntimePlacement;
  hostSessionId?: string;

  provider: ProviderDomain;
  frontend: 'claude-code' | 'codex-cli' | 'pi-cli';
  model?: string;

  interactionMode: 'interactive' | 'headless';
  ioMode: 'pty' | 'inherit' | 'pipes'; // CP chooses based on hosting strategy

  continuation?: HarnessContinuationRef; // if key present, build resume args
  env?: Record<string,string>;

  // Optional: CP can request emission paths for logs/events
  artifactDir?: string;

  // Prompt and file attachments to encode into CLI argv when supported.
  prompt?: string;
  attachments?: AttachmentRef[];
  yolo?: boolean;
};

export type LegacyBuildProcessInvocationSpecRequest = {
  hostSessionId?: string;
  /** @deprecated Use hostSessionId */
  cpSessionId?: string;
  aspHome: string;
  spec: SpaceSpec;
  provider: ProviderDomain;
  frontend: 'claude-code' | 'codex-cli' | 'pi-cli';
  model?: string;
  interactionMode: 'interactive' | 'headless';
  ioMode: 'pty' | 'inherit' | 'pipes';
  continuation?: HarnessContinuationRef;
  cwd: string;
  env?: Record<string,string>;
  artifactDir?: string;
  prompt?: string;
  attachments?: AttachmentRef[];
  yolo?: boolean;
};

export type BuildProcessInvocationSpecRequest =
  | PlacementBuildProcessInvocationSpecRequest
  | LegacyBuildProcessInvocationSpecRequest;

export type BuildProcessInvocationSpecResponse = {
  spec: ProcessInvocationSpec;
  // Optional: materialization/audit outputs useful for CP/UI
  resolvedBundle?: ResolvedRuntimeBundle;
  warnings?: string[];
};
```

### 3.4 Active SDK turn control

Agent-spaces may expose in-flight controls for SDK-backed nonInteractive turns:

- `runTurnInFlight(req)` starts an SDK turn that can accept queued input while active.
- `queueInFlightInput(req)` appends input to the active SDK turn.
- `interruptInFlightTurn(req)` asks the active SDK turn to stop or interrupt.

These controls are scoped to active SDK execution only. They do not make agent-spaces the owner of CP sessions, tmux panes, ghostty surfaces, or CLI process lifecycle.

---

## 4) Event model changes (agent-spaces `AgentEvent`)

Agent-spaces events remain “turn scoped” events for nonInteractive execution and/or harness output parsing.

### 4.1 Base event fields

**Old**: `{ externalSessionId, externalRunId, harnessSessionId? }`  
**New**: `{ hostSessionId, runId, continuation? }`

```ts
export interface BaseEvent {
  ts: string;
  seq: number;
  hostSessionId: string;
  /** @deprecated Use hostSessionId */
  cpSessionId?: string;
  runId: string;
  continuation?: HarnessContinuationRef; // optional; set after first observed key
  payload?: unknown;
}
```

### 4.2 Compatibility note (CP owns stream taxonomy)
Agent-spaces does **not** introduce “session runtime events” (process start/exit, tmux/surface bindings). Those are CP events.

---

## 5) Internal implementation changes required (agent-spaces repo)

### 5.1 Provider typing for harnesses
Update harness registry / capabilities so each harness frontend is explicitly typed:

- `agent-sdk`, `claude-code` ⇒ `provider=anthropic`
- `pi-sdk`, `codex-cli`, `pi-cli` ⇒ `provider=openai`

This typing is used to:
- validate that a continuation key is only reused within the same provider domain
- produce the `HarnessContinuationRef` returned to CP

### 5.2 Refactor harness adapters to “build argv/env” without spawning
Today adapters often both materialize + invoke. We need a clean split:

- `materialize(spec, aspHome, ...) -> artifactPaths + env delta`
- `buildInvocation(options) -> {argv,cwd,env,displayCommand}`

NonInteractive execution still spawns internally (for SDK harnesses), but CLI harnesses must support **invocation-only** mode.

### 5.3 Normalize “resume” semantics to continuation key
Ensure that:
- Claude CLI “resume” uses the Anthropic continuation key format
- Agent SDK returns the *same* key for the same conversation (within provider)
- Codex CLI resume uses OpenAI continuation key format (thread id or equivalent)
- Pi SDK uses OpenAI provider domain and returns a provider-typed key

### 5.4 Remove “session” as a first-class concept inside agent-spaces
Agent-spaces must not store long-lived CP sessions. It may:
- read/write harness-native state directories under `aspHome`
- materialize artifacts deterministically
- return newly observed continuation keys

But it must not attempt to manage tmux panes, ghostty surfaces, or process lifecycles.

---

## 6) argv/env/cwd contract (normative; CP integration)

### 6.1 `argv`
- MUST be a fully formed argv array.
- MUST NOT require shell parsing, quoting, or interpolation.
- MUST include all flags needed for headless/interactive behavior.

### 6.2 `env`
- Must be provided as a flat key/value map.
- Agent-spaces may include only the delta it requires; CP merges it into the process environment.
- Agent-spaces must not set Ghostty/tmux environment variables (those are CP-owned).
- Correlation env vars are advisory and derived only from explicit host placement/correlation input.
- `placement.correlation.sessionRef` produces `AGENT_SCOPE_REF`, `AGENT_LANE_REF`, and `HRC_SESSION_REF`.
- `placement.correlation.hostSessionId` produces `AGENT_HOST_SESSION_ID`.
- Placement-based CLI invocations may also derive `AGENTCHAT_ID` from `agentRoot` and `ASP_PROJECT` from `projectRoot`.
- HRC-specific launcher paths may additionally provide `HRC_HOST_SESSION_ID`, `HRC_RUN_ID`, `HRC_GENERATION`, or task context vars. Those are CP/HRC-owned and should not be invented from provider state.

### 6.3 `cwd`
- Must be absolute.
- Must be appropriate for the harness to run (often project root or workspace dir).

---

## 7) Phased rewrite plan (agent-spaces executed first)

### Phase ASP-1 — Terminology + type rewrite (completed)
- Rename `harnessSessionId` → `HarnessContinuationRef` in all exported types.
- Rename `externalSessionId` → `hostSessionId`, `externalRunId` → `runId`.
- Update all internal propagation and tests.

**Exit criteria:** Typecheck + unit tests pass; no remaining `harnessSessionId` in public API.

### Phase ASP-2 — Provider-typed harness registry (completed)
- Annotate harnesses with provider domain.
- Update `getHarnessCapabilities()` to expose `{provider,frontends,models}` (breaking).
- Enforce provider match when `continuation` is provided.

**Exit criteria:** capability output contains provider; mismatch returns deterministic error.

### Phase ASP-3 — Add `buildProcessInvocationSpec` (completed)
- Implement CLI invocation builder for `claude-code`, `codex-cli`, and `pi-cli`.
- Ensure materialization paths are stable/deterministic for CP-managed spawns.
- Confirm `displayCommand` is only UX aid; `argv` is authoritative.

**Exit criteria:** CP can spawn a CLI harness using only `{argv,cwd,env}`.

### Phase ASP-4 — NonInteractive turn execution alignment (completed)
- Rename `runTurn` → `runTurnNonInteractive` (or keep `runTurn` but restrict semantics).
- Ensure response includes `continuation` when first discovered.
- Ensure events carry `continuation` after it is known.

**Exit criteria:** CP can create a CP session with no key, run 1st turn, and receive typed `continuation`.

### Phase ASP-5 — Placement cutover (in progress)
- Make placement-based request types first-class and avoid requiring legacy `aspHome/spec/cwd` fields when `placement` is present.
- Keep deprecated compatibility aliases (`cpSessionId`, legacy `SpaceSpec`) at the boundary only.
- Ensure placement helper exports are generated from the same harness catalog and request types as the primary client.

**Exit criteria:** TypeScript callers can use placement requests without `as any`; helper exports accept the same supported frontends as `AgentSpacesClient`.

---

## 8) Testing strategy (agent-spaces)

- Unit tests for:
  - provider typing + mismatch errors
  - argv/env/cwd generation for CLI harnesses
  - continuation key propagation through events and responses
  - placement correlation env generation
  - placement request typing without legacy-field requirements
- Integration tests:
  - nonInteractive: start new conversation (no key) → key observed
  - resume: run with key → conversation continues
  - CLI invocation: build spec → spawn harness in a local test (smoke)

---

## 9) Deliverables

- New agent-spaces package exports/types
- `buildProcessInvocationSpec()` API
- Provider-typed harness capabilities
- Updated docs for CP integration contract
