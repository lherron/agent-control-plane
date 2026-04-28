# `asp self` — V2 Spec

Follow-up to the V1 cut (commits `58dc7eb` + `1b2f709`). V1 shipped read-only
introspection (`inspect`, `paths`, `prompt`, `explain`). V2 closes the loop:
**apply-and-restart**, **drift history**, and **pre-flight validation**.

## Status

- **V1:** landed on `main` — 121 CLI tests, gold-standard E2E verified from
  live Claude Code opus session.
- **V2:** this spec — ready for a fresh session to pick up. Authors: clod +
  cody (same peer split as V1 via hrcchat). Verdict from cody: "edit and
  ship" — pushback folded into this revision.

---

## Intent

V1 answered *what* an agent is running with. V2 answers *how does the agent
change itself safely*, and *what changed between this launch and the last*.

The loop V1 documented:
```
asp self paths  →  Edit (existing tool)  →  ???  →  future launches changed
```

V2 fills in the `???`:
```
asp self paths  →  Edit  →  asp self preview  →  asp self restart  →  new runtime
                          (validate + diff)      (HRC SDK; preserve continuation)
```

And adds diagnostic history for when something drifted unexpectedly:
```
asp self history          →  list past launches for this session
asp self diff-launch <id> →  compare two launches (argv / env / prompt)
```

---

## Commands

All commands accept `--json`. All commands infer target/launch from env by
default; all accept `--target <name>` and `--launch-file <path>` overrides to
stay consistent with V1.

### `asp self preview [--json] [--from <launch-id>]`

**Intent:** show what the *next* launch would look like if the agent restarted
now, without actually launching. Differentiates "what I launched with" vs
"what I would launch with now" — critical after self-edits.

**Behavior:**
- Resolve the current durable source state (SOUL.md, profile, templates, spaces).
- Call the new `computeRunPlan()` extraction in `spaces-execution` (see
  Technical anchors) — self-scoped (infer target from `AGENTCHAT_ID` /
  `ASP_PLUGIN_ROOT`).
- Compare the resulting argv/env/prompt/reminder against the current
  `HRC_LAUNCH_FILE`.
- Emit a drift report: *no change*, *prompt changed (N→M chars)*, *new env
  var added*, *plugin order changed*, etc.

**Why separate from `asp run --dry-run`:**
- No target argument required; infers from runtime env.
- Emits a *diff* from the current launch, not just the next command.
- Never writes lockfiles, never refreshes cache.

**JSON shape:**
```json
{
  "target": "clod",
  "current": { "argvHash": "sha256:...", "systemPromptChars": 4727 },
  "next":    { "argvHash": "sha256:...", "systemPromptChars": 5041 },
  "drift": [
    { "kind": "system-prompt", "delta": "+314 chars", "reason": "SOUL.md changed" },
    { "kind": "env",           "added": ["MY_NEW_VAR"] }
  ]
}
```

**Exit codes:**
- `0` — no drift
- `10` — drift detected (informational; still successful)
- `1` — resolution error

### `asp self restart [--preview-only] [--drop-continuation] [--fresh-pty] [--reason <text>]`

**Intent:** apply durable edits by relaunching the runtime, **preserving
continuation by default** so the harness resumes conversation state.

**Behavior (happy path):**
1. Run `asp self preview` first. If drift is error-level, refuse. Surface
   what will be **preserved vs dropped** (continuation, sessionRef,
   generation increment).
2. If `--preview-only`, stop here.
3. Invoke HRC SDK directly (see Technical anchors — do **not** shell out to
   the `hrc` CLI). Pipeline:
   - `resolveSession(ref)` — find the logical session
   - Detect in-flight turn via HRC runtime status; refuse if busy
     (see Edge Cases)
   - `clearContext({ relaunch: true, dropContinuation })` — this already
     rotates continuity, preserves continuation unless `dropContinuation`
     is passed, and re-spawns the runtime with fresh bundle materialization.
4. Generation increments; session id is stable; `sessionRef` unchanged.

**Flag semantics:**
- `--preview-only` — drift-check without applying
- `--drop-continuation` / `--fresh-context` — the escape hatch for a
  context-poisoned restart (equivalent to `dropContinuation: true`)
- `--fresh-pty` — force a new tmux pane; default reuses existing
- `--reason <text>` — stamped into the HRC launch record for audit

**Safety:**
- Refuse on in-flight turn (HRC runtime status = busy).
- Refuse on `preview` unresolvable error (broken template, missing
  required file).
- Refuse if the active host session has rotated since the current launch
  (stale continuity).
- Never restart a runtime that has no prior intent record (relaunch is
  impossible without it).

### `asp self history [--limit N] [--json] [--by <host-session|session-ref>]`

**Intent:** list past launches for this session so drift is visible.

**Behavior:**
- Read `~/praesidium/var/run/hrc/launches/*.json`.
- Default filter: both `hostSessionId` (runtime continuity) and
  `sessionRef` (logical scope). `--by` narrows to one.
- Emit a table: launch-id, generation, started, harness, argv-hash,
  system-prompt-hash, reminder-hash (sha256s — see Drift fingerprint).
- `--limit` default 10.

**Why:** answers "did something change between my last launch and this one?"
without requiring the agent to remember the prior state.

### `asp self diff-launch <other-launch-id> [--json] [--show <argv|env|prompt|reminder|settings|mcp>]`

**Intent:** unified diff between current launch and a prior one.

**Behavior:**
- Load the other launch artifact by id (resolve via `history` or raw file).
- Pretty-diff each surface:
  - argv — list diff (added/removed/reordered)
  - env — allow-list-filtered keys (see Drift fingerprint)
  - extracted system prompt — char delta + optional content diff
  - extracted reminder — same
  - settings / mcp — content digests + structural diff
- `--show` narrows to one surface.

**Useful for:**
- "Why does my prompt look different than yesterday?"
- "Did the deploy at 14:32 change my argv?"

### `asp self validate [--json]`

**Intent:** pre-flight check the agent's durable sources before `restart`.

**Behavior:**
- Lint `agent-profile.toml` against the JSON schema — source of truth lives
  with the parser at `packages/config/src/core/config/agent-profile-toml.ts`
  (see Open Questions #4).
- Parse `SOUL.md`, `HEARTBEAT.md` — ensure UTF-8 and non-empty if referenced.
- Parse `context-template.toml` (agent-local + shared) — check section refs
  resolve, check `required` paths exist.
- Check referenced spaces exist in the lock.
- Emit findings with path:line where possible.

**Exit codes:**
- `0` — clean
- `1` — errors (would fail `restart`)
- `2` — warnings only

---

## File layout

Extends V1's `packages/cli/src/commands/self/`:

```
packages/cli/src/commands/self/
  index.ts          # dispatcher — extend to register 4 new subcommands
  lib.ts            # shared helpers (V1). Extend with:
                    #   - launchHistory(ctx): list/filter past launches
                    #   - computeDriftFingerprint(plan): normalized hash
                    #   - diffLaunches(a, b): structural diff
  preview.ts        # NEW (clod)
  history.ts        # NEW (clod)
  diff-launch.ts    # NEW (clod)
  restart.ts        # NEW (cody)
  validate.ts       # NEW (cody)
  inspect.ts paths.ts prompt.ts explain.ts  # unchanged from V1
  __tests__/        # add one test file per new command
```

---

## Technical anchors

- **Dry-run resolution extraction** — `packages/execution/src/run.ts` is
  the real home (not `packages/engine/`). Currently `run()` /
  `runLocalSpace()` / `executeHarnessRun()` have the materialize flow
  braided in (`materializeSystemPrompt`, `discoverContextTemplate`,
  `resolveContextTemplateDetailed`, defaults merge, bundle loading).
  **Extract a new non-spawning function** in `spaces-execution`:

  ```ts
  // packages/execution/src/run-plan.ts (proposed)
  export async function computeRunPlan(input: ComputeRunPlanInput): Promise<RunPlan>
  // Returns: command (argv[]), displayCommand (str), systemPrompt,
  // reminder, priming, sectionSizes, build metadata — no spawn, no side effects.
  ```

  Both `asp run --dry-run` and `asp self preview` should call it.

- **Restart plumbing — HRC SDK, not subprocess.** HRC already exposes:
  - `resolveSession(ref)` — find the logical session
  - `ensureRuntime(...)` / `startRuntime(...)` — spawn
  - `clearContext({ relaunch, dropContinuation })` — **this is the key
    primitive**; rotates continuity, preserves continuation unless
    `dropContinuation: true`, re-spawns the runtime. `asp self restart`
    is essentially a thin wrapper around this with pre-flight checks.

  Do **not** shell out to the `hrc` CLI from `asp self restart` — call
  the SDK directly from the CLI package.

- **Launch history** lives at `~/praesidium/var/run/hrc/launches/*.json`.
  All files are `HrcLaunchArtifact` JSON; filter by `hostSessionId`,
  `sessionRef`, or both.

- **Drift fingerprint** — hash of normalized argv + system prompt +
  reminder + priming + settings digest + mcp digest + stable fields
  (harness, provider, model). **Exclude:**
  - All `HRC_*` env vars (launch/runtime ids, sockets, spool paths)
  - Temp/socket paths in argv
  - `PATH` (too volatile, cody's explicit nit)
  - Anything with a timestamp or uuid pattern

  **Include (env allow-list, starting point):**
  - MCP-server-related vars
  - `ASP_PROJECT`, `ASP_HOME`, `ASP_AGENTS_ROOT`
  - Model selectors (`CLAUDE_MODEL`, etc.)
  - User-scoped config paths

- **Validation schema** — promote from agent-minder's markdown skill into
  a proper JSON schema. Parser truth today is at
  `packages/config/src/core/config/agent-profile-toml.ts`; schema + parser
  should converge there. Markdown stays as human docs, not source of truth.
  Target file: `packages/config/src/core/schemas/agent-profile.schema.json`.

---

## Acceptance criteria

**Per command:**
- Unit tests for pure logic (diff, hash, history filtering) via temp
  fixtures — same pattern as V1's `lib.test.ts`.
- CLI integration tests via `execFile` with fixture env — same pattern as
  V1's `cli.test.ts`.
- `--json` from day one.

**End-to-end, from a live session:**
1. Edit `SOUL.md` to add a new line.
2. `asp self preview` shows `drift: [{ kind: "system-prompt", delta: "+N chars" }]`.
3. `asp self validate` — clean.
4. `asp self restart` — runtime relaunches via HRC SDK, same `sessionRef`,
   continuation preserved, generation increments.
5. Harness resumes conversation state (Claude Code `--resume` behavior).
6. `asp self history --limit 3` — lists old launch + new launch with
   different prompt hashes.
7. `asp self diff-launch <old-id>` — shows the SOUL.md-sourced char delta
   explicitly.
8. `asp self restart --drop-continuation` — verify escape hatch: new
   conversation, same session ref.

---

## Edge cases (expand here as restart discovers more)

1. **Runtime busy / in-flight turn** → refuse with clear error; surface
   how to check status. Do not force-kill.
2. **Stale continuity** — active host session has rotated since current
   launch. Refuse; require explicit `--force-stale`.
3. **No prior runtime intent** — runtime record missing, relaunch is
   impossible. Report, don't crash.
4. **Headless vs interactive restart semantics** — headless runtimes
   shouldn't preserve tmux panes; interactive should reuse by default.
5. **Heartbeat / maintenance mode** — restart must preserve the prior
   intent (`runMode=heartbeat`) unless explicitly overridden. Heartbeat
   agents shouldn't silently become query agents.
6. **Command runtimes vs harness runtimes** — command runtimes
   (one-shot) don't have continuation to preserve; restart semantics
   differ. Document what's not supported.

---

## Open questions (flag to human before implementing)

1. **Session continuity during restart** — cody's framing wins: "preserve
   continuation by default, `--drop-continuation` is the escape hatch."
   Still need to confirm the specific Claude Code resume behavior:
   `clearContext --relaunch` rotates continuity without losing conversation
   state, but what happens if the underlying Claude session id has expired?

2. **Should `self restart` require confirmation?** A mis-fired restart
   kills in-flight work. Options: (a) always prompt unless `--yes`,
   (b) require `--yes` to restart, (c) detect in-flight turns and refuse.
   Leaning (c) — the agent usually knows when it's idle, and preview-first
   already surfaces what will change.

3. **`self validate` — schema convergence path.** Agreed: promote from
   agent-minder skill to JSON schema co-located with the parser at
   `packages/config/src/core/config/agent-profile-toml.ts` → new
   `packages/config/src/core/schemas/agent-profile.schema.json`. Open
   question is who owns the migration (cody's `validate` task, or a
   separate prep task?).

4. **Drift fingerprint — env allow-list finalization.** Starting point is
   specified above; the first implementation should ship with a
   conservative allow-list and let real usage reveal what's missing. Also:
   should the fingerprint be public (shown in `history`) or internal-only?
   Leaning public — agents can use it as a "has anything changed?" shortcut.

5. **History filter default** — include both `hostSessionId` and
   `sessionRef` unless `--by` narrows. Display both columns in the output.

---

## Out of scope for V2

- **Mid-session reload of the system prompt** — not supported by Claude
  Code CLI and never will be per V1 design consensus.
- **Automatic rollback** on broken restart — too complex for first cut.
- **`asp self edit <surface>` that opens $EDITOR** — V1 design decision
  stands: use the normal Edit tool, keep `self path` for discovery.
- **Cross-agent introspection** — an agent using `self` to audit *another*
  agent's live runtime. V1 supports `--target <name>` for file-level
  introspection, but peeking into another agent's live launch artifact is
  a privacy/safety question for a different PR.
- **HRC restart API endpoint** (as opposed to SDK call) — if the SDK call
  path reveals it should be a first-class HTTP endpoint, promote in V3.

---

## Split proposal

If clod + cody drive V2 the same way we did V1:

- **clod:** `self preview` + `self history` + `self diff-launch` +
  `computeRunPlan()` extraction in `spaces-execution`. All read-plane or
  shared-plumbing work.
- **cody:** `self restart` + `self validate` + schema convergence. All
  mutation and config-surface work.

Both:
- Update this doc as scope shifts.
- Coordinate via hrcchat with CP1/CP2/CP3 handoffs (worked well in V1).

---

## Phase boundaries

**Prep (standalone PRs — land before V2 work starts):**
- [x] V1 on main (done — `1b2f709`)
- [ ] **Prep PR A:** `agent-profile.schema.json` at
      `packages/config/src/core/schemas/`, co-located with the parser at
      `packages/config/src/core/config/agent-profile-toml.ts`. Markdown in
      agent-minder skill demoted to human docs referencing the schema.
      Risk-split rationale: schema/parser convergence is useful
      independent work, and `validate` depends on it conceptually.
- [ ] **Prep PR B:** `computeRunPlan()` extracted in `spaces-execution`,
      both `asp run --dry-run` and (future) `asp self preview` call it.
      Verify existing `asp run` behavior unchanged.

**V2 proper:**
- [ ] `preview` + `history` + `diff-launch` implemented + tested (clod)
- [ ] `validate` implemented against the new schema (cody)
- [ ] `restart` implemented against HRC SDK (`clearContext({ relaunch })`
      + `resolveSession` + in-flight detection) (cody)
- [ ] E2E: edit → preview → validate → restart → history shows drift,
      continuation preserved, escape hatch works

V3 could add: rollback, HRC restart API endpoint, cross-agent audit, rich
diff visualizations.
