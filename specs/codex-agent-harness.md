## Spec: Add OpenAI Codex as a harness to agent-spaces (app-server–backed), analogous to `agent-sdk`

### Context and intent

agent-spaces currently supports:
- **Claude CLI** (`claude`) and a “materialize-only / SDK-oriented” variant (`claude-agent-sdk`)
- **Pi** (`pi`) and **Pi SDK** (`pi-sdk`)
- A programmatic “session harness” in `packages/execution/src/session/` with a unified streaming event model (used by `packages/agent-spaces`), currently for `agent-sdk` and `pi`.

This spec adds **Codex** as a first-class harness, using the **Codex app-server** (JSON-RPC over stdio) for the programmatic session path, mirroring the “agent-sdk” integration style (streaming events, resumable sessions), while also supporting `asp install/run` via the Codex CLI binary.

Codex CLI is OpenAI’s open-source coding agent and is built in Rust.  [oai_citation:0‡OpenAI Developers](https://developers.openai.com/codex/cli/?utm_source=chatgpt.com)  
Codex exposes an experimental `codex app-server` subcommand.  [oai_citation:1‡OpenAI Developers](https://developers.openai.com/codex/cli/reference/)

---

## 1) Goals

1. **New harness: `codex`** in `spaces-config` and `spaces-execution`.
2. **`asp install --harness codex`** materializes a *Codex Home template* from spaces (skills/prompts/MCP/config/instructions).
3. **agent-spaces programmatic** API gains `harness: "codex"`; `runTurn()` uses **Codex app-server** with:
   - streaming events mapped into existing `UnifiedSessionEvent` and `AgentEvent`
   - resumability via **thread id** persisted as `harnessSessionId`
4. Reuse existing space primitives where possible:
   - `skills/` → Codex skills
   - `commands/` → Codex custom prompts
   - `mcp/` → Codex MCP config
   - `AGENT.md` / `AGENTS.md` → Codex instructions

---

## 2) Non-goals

- Reimplement Codex CLI UI behavior (TUI) inside agent-spaces.
- Perfect parity with Claude hook semantics; initial implementation focuses on:
  - skills
  - MCP
  - prompts/commands
  - instructions
  - approvals (best-effort)
- Enforcing every `permissions.toml` feature at the OS level (Codex sandbox controls differ). The spec defines a “best-effort mapping + explicit caveats”.

---

## 3) Harness naming and identifiers

### Internal harness ID (spaces-config / spaces-execution)

Add to `packages/config/src/core/types/harness.ts`:

- Extend:
  - `export type HarnessId = 'claude' | 'claude-agent-sdk' | 'pi' | 'pi-sdk' | 'codex'`
  - `export const HARNESS_IDS = [...]` includes `"codex"`
- Add a harness config struct:
  ```ts
  export interface SpaceCodexConfig {
    /** Optional extra config keypaths merged into generated config.toml (see §6) */
    config?: Record<string, unknown>

    /** Optional default model override when this space is included */
    model?: string

    /** Optional: force-enable/disable mapping of commands → prompts */
    prompts?: { enabled?: boolean }

    /** Optional: force-enable/disable mapping of skills */
    skills?: { enabled?: boolean }
  }
  ```
- Extend `SpaceManifestExtension`:
  ```ts
  export interface SpaceManifestExtension {
    harness?: SpaceHarnessConfig
    claude?: SpaceClaudeConfig
    pi?: SpacePiConfig
    codex?: SpaceCodexConfig
  }
  ```

Update schema `packages/config/src/core/schemas/space.schema.json` enum in `harness.supports.items.enum` to include `"codex"`.

### External harness ID (agent-spaces client)

Add `codex` to the harness resolution table (`HARNESS_DEFS` in `packages/agent-spaces/src/client.ts`), similar to existing `agent-sdk` and `pi-sdk`.

Model list should track Codex docs’ recommended models, e.g. `gpt-5.2-codex`, `gpt-5.1-codex-mini`, etc.  [oai_citation:2‡OpenAI Developers](https://developers.openai.com/codex/models/)

Proposed:
```ts
const CODEX_MODELS = [
  "gpt-5.2-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5",
]
```
Default: `"gpt-5.2-codex"`  [oai_citation:3‡OpenAI Developers](https://developers.openai.com/codex/models/)

---

## 4) Codex content model mapping from spaces

### 4.1 Skills

Codex loads skills from several scopes; one of them is `$CODEX_HOME/skills`.  [oai_citation:4‡OpenAI Developers](https://developers.openai.com/codex/skills/)  
Codex supports symlinked skill folders and follows symlink targets while scanning.  [oai_citation:5‡OpenAI Developers](https://developers.openai.com/codex/skills/)

agent-spaces already uses a skill folder structure with `SKILL.md` discovery, so the mapping is direct:

- **Space input**: `spaceRoot/skills/<skillName>/SKILL.md` (and any supporting files)
- **Codex output**: `$CODEX_HOME/skills/<skillName>/SKILL.md`

Merge behavior:
- Load order is target’s resolved space order.
- If `<skillName>` collides, **last one wins** (later space overwrites earlier).

### 4.2 Commands → Codex custom prompts

Codex custom prompts live in `~/.codex/prompts` (or `$CODEX_HOME/prompts`) and Codex scans only **top-level** Markdown files there.  [oai_citation:6‡OpenAI Developers](https://developers.openai.com/codex/custom-prompts/?utm_source=chatgpt.com)

Mapping:
- **Space input**: `spaceRoot/commands/*.md`
- **Codex output**: `$CODEX_HOME/prompts/<filename>.md` (flattened; no subdirs)

Merge behavior:
- If same filename appears in multiple spaces: **last one wins**.

Notes/caveats:
- Spaces’ command content is written for Claude-style slash commands (`# /help` etc). Codex custom prompts will still insert the file text; we don’t require exact parity. Initial goal is portability, not identical UX.

### 4.3 MCP servers

Codex supports MCP servers configured in `config.toml` via `mcp_servers.<name>.*` entries (including `command`, `args`, `env`, and enablement controls).  [oai_citation:7‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)

Mapping:
- **Space input**: existing `mcp/` definitions already composed by agent-spaces into an MCP JSON representation (stdio servers).
- **Codex output**: render those into `config.toml` under `[mcp_servers.<id>]` with:
  - `command`, `args`, `env`
  - `enabled = true` (unless disabled by higher precedence)
  - optional `startup_timeout_ms` (default if not provided)

Conflict policy:
- Same server id: last one wins (consistent with skills/prompt precedence).

### 4.4 Instructions (`AGENT.md` / `AGENTS.md`) → Codex instructions

Codex reads instructions from:
- `$CODEX_HOME/AGENTS.override.md` or `$CODEX_HOME/AGENTS.md`
- then additional `AGENTS.md` (or configured fallback names) from project root → cwd
and concatenates them.  [oai_citation:8‡OpenAI Developers](https://developers.openai.com/codex/guides/agents-md/?utm_source=chatgpt.com)

We need to support the agent-spaces convention of `AGENT.md`, and Codex’s convention of `AGENTS.md`.

Plan:
- Generate a single **global** instructions file at `$CODEX_HOME/AGENTS.md`, which includes content from spaces in load order.
- Ensure Codex will also consider `AGENT.md` as a fallback project doc name via `project_doc_fallback_filenames` (see §6.2).  [oai_citation:9‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)

Space instruction source selection (per space):
1. If the space contains `AGENTS.md`, use it (Codex-specific).
2. Else if it contains `AGENT.md`, use it.
3. Else none.

Concatenation format in generated `$CODEX_HOME/AGENTS.md`:
- A short generated header
- Then per-space blocks:
  ```md
  <!-- BEGIN space: <spaceName>@<version> -->
  <content>
  <!-- END space: <spaceName>@<version> -->
  ```
This makes it debuggable without forcing Codex-visible verbosity.

---

## 5) Materialization outputs

### 5.1 Target-level “Codex Home template” (deterministic)

`CodexAdapter.composeTarget()` produces:

```
<outputDir>/                 # harness output (target-scoped)
  codex.home/                # NEW: deterministic Codex Home template
    AGENTS.md
    config.toml
    skills/
      <skillName>/...
    prompts/
      <promptName>.md
    mcp.json                 # optional: debug artifact (agent-spaces format)
    manifest.json            # optional: build metadata (see below)
```

Rationale:
- Keeps Codex’s own runtime state (auth/history/threads) out of the deterministic “template” directory.
- Avoids concurrency/locking issues when multiple sessions run against the same target.

`manifest.json` (optional but recommended) records:
- target name
- space list with resolved versions
- generation time
- hashes of aggregated instruction sources
- list of skills/prompts/mcp servers produced

### 5.2 Session-level Codex Home (mutable, session-scoped)

For programmatic `runTurn()`:
- Create a per-`externalSessionId` **session Codex Home** directory under `aspHome/sessions/codex/<hash>/home`
- Populate it as:
  - `AGENTS.md` → symlink or copy from template
  - `config.toml` → **copy** from template (so session can mutate without affecting others)
  - `skills/` → create directory; inside it, symlink skill folders from template (or copy on platforms without symlink)
  - `prompts/` → symlink/copy from template
- Set `CODEX_HOME=<sessionHome>` when spawning Codex app-server/CLI.

Codex stores local state in its home directory (e.g., config, auth, history).  [oai_citation:10‡OpenAI Developers](https://developers.openai.com/codex/config-advanced/?utm_source=chatgpt.com)  
This makes each session isolated.

---

## 6) Generated `config.toml`

### 6.1 Base config

Start with a minimal config in template `codex.home/config.toml`:

- **MCP servers**: render from composed MCP into `mcp_servers.*` keys.  [oai_citation:11‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)  
- **Safe defaults** (for interactive CLI runs) can be set, but programmatic runs should override per turn:
  - `sandbox_mode = "workspace-write"` (safe-ish default)  [oai_citation:12‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)
  - `approval_policy = "on-request"` (so approvals can be surfaced)  [oai_citation:13‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)

### 6.2 Ensure Codex picks up `AGENT.md` in repos

Add:
```toml
project_doc_fallback_filenames = ["AGENTS.md", "AGENT.md"]
```
This config knob exists in Codex config reference.  [oai_citation:14‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)

(If Codex already defaults to `AGENTS.md`, this makes `AGENT.md` additionally discoverable without forcing repo changes.)

### 6.3 Space-level config injection

If a space includes `[codex.config]` (keypath → value), merge it into template config at generation time. Keypath semantics should follow Codex config’s dotted keypaths.

Example:
```toml
[codex.config]
"features.web_search_request" = false
```

### 6.4 Target-level overrides

Optionally extend `asp-targets.toml` schema with:
```toml
[codex]
model = "gpt-5.2-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
profile = "default"
```
This is symmetrical to the existing `[claude]` table in `TargetDefinition`. (Not strictly required for programmatic usage, but needed for `asp run --harness codex` ergonomics.)

---

## 7) Execution: Codex app-server session integration

### 7.1 Why app-server

- Codex exposes an experimental `codex app-server` intended for programmatic control.  [oai_citation:15‡OpenAI Developers](https://developers.openai.com/codex/cli/reference/)
- Protocol is JSON-RPC 2.0 over stdio with streaming JSONL (similar to MCP).  [oai_citation:16‡fossies.org](https://fossies.org/linux/codex-rust/codex-rs/app-server/README.md?utm_source=chatgpt.com)
- Attached `codex-artifacts` provides method/type shapes (v2 thread/turn APIs, notifications, approvals).

### 7.2 Add a new unified session kind: `codex`

In `packages/execution/src/session/types.ts`:
- Extend `SessionKind`:
  ```ts
  export type SessionKind = 'agent-sdk' | 'pi' | 'codex'
  ```

In `packages/execution/src/session/factory.ts`:
- Extend `CreateSessionOptions` with codex fields:
  ```ts
  codexAppServerCommand?: string // default "codex"
  codexHomeDir?: string          // session home (CODEX_HOME)
  codexTemplateDir?: string      // target template path (codex.home)
  codexModel?: string
  codexCwd?: string              // repo/project cwd
  codexApprovalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  eventsOutputPath?: string      // optional raw protocol capture
  ```

Then instantiate `new CodexSession(...)`.

### 7.3 CodexSession responsibilities

`CodexSession` implements `UnifiedSession`:

- `start()`: spawn app-server, initialize, start/resume thread.
- `sendPrompt(prompt, {attachments})`: start a turn; stream events until completion.
- `stop()`: graceful shutdown + process teardown.

#### Process spawning

Command:
- `codex app-server`  [oai_citation:17‡OpenAI Developers](https://developers.openai.com/codex/cli/reference/)

Environment:
- `CODEX_HOME=<sessionHome>` (critical)  [oai_citation:18‡OpenAI Developers](https://developers.openai.com/codex/guides/agents-md/?utm_source=chatgpt.com)
- pass through `OPENAI_API_KEY` / provider env vars from `req.env`.

Stdio:
- Read server messages from stdout line-by-line (JSONL).
- Write JSON-RPC messages to stdin, each terminated with `\n`.
- Treat stderr as logs.

#### JSON-RPC handshake (per attached protocol)

1. Request:
   - `initialize` with `{ clientInfo: { name: "agent-spaces", version: <pkgVersion> } }`
2. Notification:
   - `initialized`

(Optionally call `authStatus` and error early if unauthenticated; attach actionable diagnostics.)

#### Thread lifecycle (v2)

- New session:
  - call `thread/start` with:
    - `cwd`: project cwd
    - `model`: chosen model
    - `developerInstructions`: can be `null` (if we rely on `$CODEX_HOME/AGENTS.md`) *or* set explicitly from template. Prefer relying on file for consistency with interactive runs.
    - `profile`: optional
    - `sandbox`: optional
    - `config`: optional overrides
  - store `thread.id` as `harnessSessionId`

- Resume:
  - call `thread/resume` with `{ threadId: <prior> }` plus optional overrides.

Emit:
- `agent_start` unified event as soon as thread id is known (so `agent-spaces` record gets updated).

#### Turn lifecycle (v2)

- call `turn/start` with:
  - `threadId`
  - `input`: array of `UserInput`
    - always include user text
    - add local images for supported attachments
  - `cwd`: project cwd (safe; reinforces)
  - `approvalPolicy`: from options (default `on-request`)
  - `sandboxPolicy` or leave default
  - `model`, `effort`, `summary` optional

Wait until a `turn/completed` notification is received.

### 7.4 Attachments handling

Codex v2 user input supports text and images (including `localImage`). (From attached types.)

Mapping from agent-spaces attachments:
- If `attachment.kind === "url"` → `{ type: "image", url }` (only if it looks like an image URL; else treat as text reference)
- If `attachment.kind === "file"`:
  - If extension in `{png,jpg,jpeg,webp,gif}` → `{ type: "localImage", path }`
  - Else: include as text line `Attached file: <path>` (Codex can read from filesystem anyway)

Hard cap:
- Reject image attachments larger than a configurable byte limit (to avoid blocking), or pass through and let Codex error; prefer preflight.

---

## 8) Approvals and permissions mapping

Codex can request approvals for command execution and file changes (v2 request types in attached protocol). We need to respond programmatically.

### 8.1 Approval policy

Default for programmatic harness: `on-request` (ask when Codex decides it needs to)  [oai_citation:19‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)  
Alternate:
- “YOLO” mode: set `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` if explicitly requested (high-risk).  [oai_citation:20‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)

### 8.2 Decision logic

Initial behavior (to match current agent-spaces `buildAutoPermissionHandler` semantics):
- Always accept, but do it through the approval requests so the system can evolve.

For each `item/commandExecution/requestApproval`:
- respond with decision `"acceptForSession"`

For each `item/fileChange/requestApproval`:
- respond with decision `"acceptForSession"`

### 8.3 Best-effort integration with existing `permissions.toml` (optional but recommended)

If/when we want to honor `permissions.toml`:
- Command execution: parse command and check allowlist/denylist patterns from composed permissions; reject if out of policy.
- File changes: validate target paths within allowed write roots; reject if out of policy.
- Network: Codex sandbox is boolean (on/off) not per-host; if permissions specify hosts, treat as:
  - `networkAccess=true` if any hosts allowed
  - but enforce host list via command approval (reject `curl` etc) and MCP server config (where possible)

Explicitly document limitations.

---

## 9) Event mapping: Codex → UnifiedSessionEvent → AgentEvent

Codex emits a richer event stream (turn start/end, items start/end, deltas for messages and tool outputs). We map it into existing `UnifiedSessionEvent` types without changing the external agent-spaces event contract.

### 9.1 Core mapping

From attached `ServerNotification` (v2):

- `turn/started` → `turn_start`
- `turn/completed` → `turn_end`

Items:
- `item/started`:
  - `agent_message` → `message_start` (assistant)
  - `command_execution` / `file_change` / `mcp_tool_call` / `web_search` / `image_view` → `tool_execution_start`
- `item/agentMessage/delta` → `message_update` with `delta`
- `item/commandExecution/outputDelta` → `tool_execution_update` with `partialOutput`
- `item/mcpToolCall/progress` → `tool_execution_update` with `message`/`partialOutput`
- `item/completed`:
  - `agent_message` → `message_end`
  - tools → `tool_execution_end` with a normalized result

Turn-level artifacts:
- `turn/diff/updated`: either
  - emit `tool_execution_update` on a synthetic tool id like `diff:<turnId>` **or**
  - attach to `turn_end` payload as `diff`
- `turn/plan/updated`: similarly attach/log.

Recommendation: attach these to `turn_end` payload (lowest risk to existing consumers), and optionally emit `log` events if agent-spaces adds a unified `log` type later.

### 9.2 Raw event capture

Add optional `eventsOutputPath` to `CodexSession` to write every parsed server message as JSONL for debugging/repro. This mirrors Codex’s own ability to emit JSON events in exec mode (conceptually), while keeping agent-spaces behavior consistent.

---

## 10) CodexAdapter (spaces-execution harness adapter)

Add `packages/execution/src/harness/codex-adapter.ts` implementing `HarnessAdapter`.

### 10.1 detect()

- Look for `codex` binary in PATH.
- Run `codex --version` to verify it’s installed.
- Optional: run `codex app-server --help` to verify subcommand exists (since it is experimental).  [oai_citation:21‡OpenAI Developers](https://developers.openai.com/codex/cli/reference/)

### 10.2 validateSpace()

- Always valid unless:
  - malformed `skills/` folders (missing `SKILL.md` where folder is referenced)
  - invalid MCP server definitions
- Prefer “warn + continue” rather than hard failures initially (Codex is permissive).

### 10.3 materializeSpace()

Produce a per-space artifact directory containing only what we need to compose:

```
<cache>/<spaceKey>/codex/
  skills/...
  prompts/...
  mcp.json      # composed space-local mcp (optional)
  instructions.md  # extracted from AGENTS.md or AGENT.md (optional)
```

### 10.4 composeTarget()

Build `<outputDir>/codex.home`:
- Merge skills (symlink folders)
- Merge prompts (copy or symlink top-level md)
- Compose MCP servers, then render `config.toml`
- Generate `AGENTS.md`

Return `ComposedTargetBundle` extended with:
```ts
codex?: {
  homeTemplatePath: string // <outputDir>/codex.home
  configPath: string       // <...>/config.toml
  agentsPath: string       // <...>/AGENTS.md
  skillsDir: string        // <...>/skills
  promptsDir: string       // <...>/prompts
}
```

### 10.5 buildRunArgs()

For `asp run --harness codex`:
- If interactive: command `codex` with env `CODEX_HOME=<outputDir>/codex.home` and cwd = user’s `cwd`.
- If non-interactive (prompt provided): `codex exec "<prompt>"` with env CODEX_HOME set similarly.

This aligns with Codex CLI use of `-m/--model` flags and interactive threads, but exact flag selection is out of scope; we can pass model via `--model` if provided by target/run options. Model naming aligns with Codex docs (e.g., `codex -m gpt-5.2-codex`).  [oai_citation:22‡OpenAI Developers](https://developers.openai.com/codex/models/)

---

## 11) agent-spaces client integration (`packages/agent-spaces`)

### 11.1 Add harness def

In `HARNESS_DEFS`:
- external: `"codex"`
- internal: `"codex"`
- models: from §3 (Codex Models page)  [oai_citation:23‡OpenAI Developers](https://developers.openai.com/codex/models/)

### 11.2 Session kind selection

Current logic:
```ts
const sessionKind = harnessDef.id === 'claude-agent-sdk' ? 'agent-sdk' : 'pi'
```

Change to:
```ts
const sessionKind =
  harnessDef.id === 'claude-agent-sdk' ? 'agent-sdk' :
  harnessDef.id === 'codex' ? 'codex' :
  'pi'
```

### 11.3 Session codex home path

Add helper:
```ts
function codexSessionPath(aspHome: string, externalSessionId: string): string
```
Analogous to `piSessionPath`, but under `sessions/codex/`.

Before starting the CodexSession, ensure the session home is populated from the target template:
- copy `config.toml`
- copy/symlink `AGENTS.md`
- symlink skills/prompt entries

Pass `codexHomeDir` to `createSession`.

---

## 12) Compatibility, risks, and fallback strategy

### 12.1 app-server instability

`codex app-server` is explicitly experimental and may change.  [oai_citation:24‡OpenAI Developers](https://developers.openai.com/codex/cli/reference/)  
Mitigations:
- Keep protocol logic isolated in `CodexRpcClient`.
- On startup, if v2 methods fail with “method not found”, optionally fall back to:
  - Codex `exec` mode with JSON output (future enhancement), or
  - hard error with clear remediation.

### 12.2 Concurrency

Avoid using a target-shared CODEX_HOME for programmatic sessions. Use per-session CODEX_HOME (see §5.2) to prevent cross-session state collisions and to keep histories isolated.

### 12.3 Platform differences (symlinks)

- Prefer symlinks on Unix.
- Fallback to copy on Windows or when symlink fails.

### 12.4 Security posture

Codex sandbox and approvals are configurable (`sandbox_mode`, `approval_policy`).  [oai_citation:25‡OpenAI Developers](https://developers.openai.com/codex/config-reference/)  
Default should be conservative; “YOLO” should require explicit opt-in.

---

## 13) Test plan

1. **Unit tests (spaces-execution / CodexAdapter)**
   - merges of skills with collisions
   - commands → prompts flattening and collisions
   - MCP → config.toml rendering correctness
   - `AGENTS.md` concatenation and ordering
2. **Session tests (spaces-execution / CodexSession)**
   - Use a fake app-server (scripted JSON-RPC JSONL) to validate:
     - initialize handshake
     - thread start/resume path
     - mapping of notifications to UnifiedSessionEvent stream
     - approval request/response flow
3. **agent-spaces integration tests**
   - `runTurn()` using the fake app-server, verifying:
     - session record persists `harnessSessionId` (thread id)
     - second run resumes
     - output events are ordered and complete

---

## 14) Rollout

- Add as “experimental” harness in docs and CLI `asp harnesses` output (label it as such).
- Ship behind a feature flag if needed:
  - env `ASP_EXPERIMENTAL_CODEX=1` enables registration in harness registry
- Collect early feedback on:
  - instruction merging behavior
  - prompts compatibility
  - MCP config translation

---

## Appendix A: Minimal JSON-RPC flows (v2)

### Initialize
Client → server:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"agent-spaces","version":"<ver>"}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
```

### Start thread
```json
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/repo","model":"gpt-5.2-codex"}}
```

### Start turn
```json
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"<thread>","input":[{"type":"text","text":"do X","text_elements":[]}],"cwd":"/repo","approvalPolicy":"on-request"}}
```

### Approvals (server → client request, client → server response)
Server:
```json
{"jsonrpc":"2.0","id":42,"method":"item/commandExecution/requestApproval","params":{...}}
```
Client:
```json
{"jsonrpc":"2.0","id":42,"result":{"decision":"acceptForSession"}}
```

### Completion
Server:
```json
{"jsonrpc":"2.0","method":"turn/completed","params":{"turnId":"...","status":"completed"}}
```
