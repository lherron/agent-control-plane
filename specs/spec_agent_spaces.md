# Agent-Spaces Spec: Provider-Typed Continuity + CP-Orchestrated Interactive Processes

**Status:** Draft spec for a breaking-change rewrite (agent-spaces first).  
**Scope:** Changes required in the `agent-spaces` monorepo to realize the canonical model in the reference doc, with CP owning “sessions”, runtime attachments, and terminal/mux orchestration.

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

**Provider domain**: `anthropic | openai` (plus `unknown` only for non-ASP/testing contexts)  
**HarnessContinuationKey**: provider-native opaque string used to resume a conversation (typed to provider; untyped within provider)  
**ProcessInvocationSpec**: structured `{argv,cwd,env,...}` for CP to spawn a CLI harness process (no shell parsing)  
**NonInteractive turn**: agent-spaces executes a “turn” via SDK-style harness (no PTY attach semantics)  
**CLI harness process**: spawned by CP; agent-spaces only prepares invocation + materialization

> Naming: allow `cpSessionId` in request structs; avoid “session” elsewhere.

---

## 2) Public API changes (breaking)

### 2.1 Replace `harnessSessionId` with provider-typed continuity key

**Old:** `harnessSessionId?: string`  
**New:** `continuation?: { provider: ProviderDomain; key?: HarnessContinuationKey }`

Rationale: CP session is the only “session” primitive; continuity belongs to CP session, and is typed by provider.

### 2.2 Rename “external” identifiers to CP terminology

**Old** (agent-spaces `RunTurnRequest`):
- `externalSessionId`
- `externalRunId`

**New**:
- `cpSessionId`
- `runId`

These are correlation ids for events/logs, not continuity.

### 2.3 Split responsibilities: `runTurn` vs `buildProcessInvocationSpec`

Agent-spaces exposes two distinct operations:

#### A) `runTurnNonInteractive` (SDK execution; existing `runTurn` semantics)
Executes a single turn via a nonInteractive harness (e.g. Agent SDK / Pi SDK).  
Returns (optionally) a newly observed continuation key.

#### B) `buildProcessInvocationSpec` (CLI process preparation; new)
Returns a structured process invocation spec for CP to spawn an interactive/headless CLI harness process, optionally resuming via continuation key if present.

This is the critical enabling change for tmux/ghostty integration: CP gets a fully formed `argv/env/cwd` contract and remains the only component that manipulates tmux/ghostty.

---

## 3) Proposed agent-spaces API surface (TypeScript)

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

export type HarnessFrontend = 'agent-sdk' | 'pi-sdk' | 'claude-code' | 'codex-cli';

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
};
```

### 3.2 NonInteractive turn execution

```ts
export type RunTurnNonInteractiveRequest = {
  cpSessionId: string;
  runId: string;

  aspHome: string;
  spec: SpaceSpec;

  frontend: 'agent-sdk' | 'pi-sdk';
  model?: string;

  continuation?: HarnessContinuationRef;

  cwd: string;
  env?: Record<string,string>;

  prompt: string;
  attachments?: string[];

  callbacks: SessionCallbacks;
};

export type RunTurnNonInteractiveResponse = {
  continuation?: HarnessContinuationRef; // set when discovered/updated
  provider: ProviderDomain;
  frontend: 'agent-sdk' | 'pi-sdk';
  model?: string;
  result: RunResult;
};
```

### 3.3 CLI invocation preparation

```ts
export type BuildProcessInvocationSpecRequest = {
  cpSessionId: string;
  aspHome: string;
  spec: SpaceSpec;

  provider: ProviderDomain;
  frontend: 'claude-code' | 'codex-cli';
  model?: string;

  interactionMode: 'interactive' | 'headless';
  ioMode: 'pty' | 'inherit' | 'pipes'; // CP chooses based on hosting strategy

  continuation?: HarnessContinuationRef; // if key present, build resume args
  cwd: string;
  env?: Record<string,string>;

  // Optional: CP can request emission paths for logs/events
  artifactDir?: string;
};

export type BuildProcessInvocationSpecResponse = {
  spec: ProcessInvocationSpec;
  // Optional: materialization outputs useful for CP/UI
  warnings?: string[];
};
```

---

## 4) Event model changes (agent-spaces `AgentEvent`)

Agent-spaces events remain “turn scoped” events for nonInteractive execution and/or harness output parsing.

### 4.1 Base event fields

**Old**: `{ externalSessionId, externalRunId, harnessSessionId? }`  
**New**: `{ cpSessionId, runId, continuation? }`

```ts
export interface BaseEvent {
  ts: string;
  seq: number;
  cpSessionId: string;
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
- `pi-sdk`, `codex-cli` ⇒ `provider=openai`

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
- Any required “session correlation” env vars should be namespaced and optional (e.g., `CP_SESSION_ID`, `CP_PROJECT_ID`) — CP decides whether to include them.

### 6.3 `cwd`
- Must be absolute.
- Must be appropriate for the harness to run (often project root or workspace dir).

---

## 7) Phased rewrite plan (agent-spaces executed first)

### Phase ASP-1 — Terminology + type rewrite (mechanical, repo-wide)
- Rename `harnessSessionId` → `HarnessContinuationRef` in all exported types.
- Rename `externalSessionId` → `cpSessionId`, `externalRunId` → `runId`.
- Update all internal propagation and tests.

**Exit criteria:** Typecheck + unit tests pass; no remaining `harnessSessionId` in public API.

### Phase ASP-2 — Provider-typed harness registry
- Annotate harnesses with provider domain.
- Update `getHarnessCapabilities()` to expose `{provider,frontends,models}` (breaking).
- Enforce provider match when `continuation` is provided.

**Exit criteria:** capability output contains provider; mismatch returns deterministic error.

### Phase ASP-3 — Add `buildProcessInvocationSpec`
- Implement CLI invocation builder for `claude-code` and `codex-cli`.
- Ensure materialization paths are stable/deterministic for CP-managed spawns.
- Confirm `displayCommand` is only UX aid; `argv` is authoritative.

**Exit criteria:** CP can spawn a CLI harness using only `{argv,cwd,env}`.

### Phase ASP-4 — NonInteractive turn execution alignment
- Rename `runTurn` → `runTurnNonInteractive` (or keep `runTurn` but restrict semantics).
- Ensure response includes `continuation` when first discovered.
- Ensure events carry `continuation` after it is known.

**Exit criteria:** CP can create a CP session with no key, run 1st turn, and receive typed `continuation`.

---

## 8) Testing strategy (agent-spaces)

- Unit tests for:
  - provider typing + mismatch errors
  - argv/env/cwd generation for both CLI harnesses
  - continuation key propagation through events and responses
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
