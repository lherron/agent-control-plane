# ACP Scheduled Jobs & Flows — Usage Guide

How to author, register, and validate scheduled/automated work on the ACP job
engine. This is the mechanism behind cron automations like cody's
`wrkq-refactor` and mneme's `xdevs-watch`.

- **Engine:** `packages/acp-jobs-store` (scheduler, cron, flow validation, native
  step executor) + `packages/acp-server/src/jobs` (flow engine, exec step).
- **Scheduler cadence:** the acp-server ticks the scheduler every **5s**
  (`DEFAULT_JOBS_SCHEDULER_INTERVAL_MS`), gated by `ACP_SCHEDULER_ENABLED=1`.
  Cron granularity is per-minute.

---

## 1. Anatomy of a job

A job is a **trigger** (schedule/cron or event) plus a **flow** (an ordered
`sequence` of steps, with an optional `onFailure` sequence). Each tick that is
due mints a *job run*; the flow engine advances it step by step, persisting each
step's result to `job_step_runs`.

### Step kinds (`flow.sequence[].kind`)

| kind | what it does | branch on |
|------|--------------|-----------|
| `exec` | spawn a sandboxed subprocess (argv-only, no shell) | `branches.exitCode` |
| `probe` | run a **built-in named** probe (idle/work decision) | `branches.outcome` |
| `wrkq-task` | idempotent create-or-find a wrkq task | continue/fail |
| `pulpit-message` | deliver a message to an interface binding (Discord, etc.) | continue/fail |
| `agent-dispatch` | dispatch a turn to an agent session via `/v1/inputs` | continue/fail |
| *(omitted)* / `agent` | legacy agent step — dispatch the step `input` as an agent turn | continue/fail |

`probe.name` must be in the built-in registry (`knownProbeNames`:
`hrc-stale-tty-reap.v1`, `wrkq-refactor-eligible.v1`). You cannot invent a probe
in a flow file — for custom "only-run-when-there-is-work" gating, use an `exec`
step and branch on its exit code.

### Flow control

Every step resolves a **transition**: a terminal token (`continue`, `succeed`,
`fail`) or the `id` of another step in the same phase.

- `exec` → `branches.exitCode["<n>"]`, else `branches.default`. **Independent of
  pass/fail:** an unmapped or "failed" exit code still follows the branch map, so
  an error code can be routed to an alarm step rather than aborting the flow.
- `probe` → `branches.outcome.idle` / `branches.outcome.work`.
- any step → explicit `next: "<stepId>"` if present.
- otherwise `continue` (next step) on success, `fail` on failure.

### `exec` step

```jsonc
{
  "id": "poll",
  "kind": "exec",
  "exec": {
    "argv": ["/abs/path/python", "/abs/path/script.py"],  // argv-only, no shell, no interpolation
    "cwd": "/allowed/root",                                 // MUST be inside an allowlisted root
    "env": { "FOO": "bar" },                                // string→string, merged over baseline
    "successExitCodes": [0, 10],                            // which codes count as "succeeded" (default [0])
    "timeout": "PT4M"                                       // ISO-8601 duration
  },
  "branches": { "exitCode": { "0": "done", "10": "work" }, "default": "alarm" }
}
```

`exec` is **policy-gated** (`packages/acp-server/src/jobs/exec-policy.ts`), via
env on the acp-server process:

| env | meaning |
|-----|---------|
| `ACP_JOB_FLOW_EXEC_ENABLED=1` | master switch (off by default) |
| `ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS` | comma-list of roots a step `cwd` may resolve inside |
| `ACP_JOB_FLOW_EXEC_INHERIT_ENV_ALLOWLIST` | extra process-env keys to pass through (e.g. `XAI_API_KEY`) |
| `ACP_JOB_FLOW_EXEC_*_TIMEOUT_MS`, `*_MAX_OUTPUT_BYTES` | caps |

Only the step **cwd** is checked against the allowlist — `argv[0]` (the binary)
and script paths may live anywhere. So a watcher can live in `~/tools/...` while
the step `cwd` is set to an already-allowlisted repo root. Baseline env is
`PATH`/`HOME`/`TMPDIR` only; anything else must be in the allowlist or `exec.env`.
The result (`exitCode`, `stdout`, `stderr`, `timedOut`, …) is persisted and
readable downstream (see §2).

### Step-output refs & templates (thread data between steps)

Native steps (`wrkq-task`, `pulpit-message`, `agent-dispatch`) resolve two forms
in their **content/input** fields against **prior succeeded steps in the same
phase**:

- structured ref: `{ "$step": "poll", "field": "stdout" }`
- handlebars template: `"...text {{poll.stdout}} more..."`

Only **top-level string** fields resolve (`stdout`, `stderr` on an exec result;
numbers like `exitCode` do not). The source step must be `succeeded` — so if you
want an exec's stdout downstream, include its "signal" exit code in
`successExitCodes`. Authority fields (argv, cwd, binding, scopeRef) reject
interpolation by design.

There is one narrow exception for diagnostic content. When a terminal failed
`exec` explicitly selects the current native step through its recorded
`branches.exitCode` or `branches.default` transition, that target's content
template may read string result fields and the persisted error projections
`errorCode` / `errorMessage`. Eligible missing fields render as empty strings,
which lets one notification cover both process exits and pre-spawn failures:

```toml
content = "exec error\ncode={{poll.errorCode}}\nmessage={{poll.errorMessage}}\nstderr={{poll.stderr}}"
```

This exception is content-only, same-run, and same-phase. It does not authorize
an unrelated or implicit successor, and structured refs remain
succeeded-source-only.

> Legacy `agent` steps take a static `input` (no interpolation) but support
> `fresh: true` for a clean per-run context. To hand a payload to a fresh agent
> turn, either use `agent-dispatch` with `{{...}}` in `input.content`, or have an
> earlier `exec` step write the payload to a file the agent reads.

---

## 2. Two ways to create a job

### A. Agent-authored schedule (preferred for recurring automations)

Drop a TOML file in the agent's config and compile+apply it. This is how cody's
refactor and mneme's watcher are defined.

```
var/agents/<agent>/schedules/<name>.toml
```

```toml
schema = 1
name = "my-watcher"
title = "..."
enabled = true

[trigger]
cron = "*/15 * * * *"

[target]
project = "<project>"; agent = "<agent>"; lane = "main"; task = "<task>"

[input]
content = "..."          # job-level input (available as {{input.content}})

[[flow.sequence]]
id = "gate"
kind = "exec"
exec = { argv = [...], cwd = "...", successExitCodes = [0, 10] }
branches = { exitCode = { "0" = "succeed", "10" = "work" }, default = "alarm" }

[[flow.sequence]]
id = "work"
fresh = true
input = "..."            # the agent turn
```

Compile → apply:

```bash
asp resources plan <agent> --project <project> > /tmp/plan.json   # compiles schedules/ + channels/ + event-hooks/
acp admin managed-resource apply --in /tmp/plan.json              # applies to the live jobs/interface stores
# use `reconcile` instead of `apply` to also disable stale (removed-source) resources
```

The compiler validates the flow; a bad flow fails here with a specific error
code. Editing the TOML and re-applying updates the live job (idempotent by
source hash).

### B. Direct job file (one-offs / non-agent jobs)

```bash
acp job validate --in job.json
acp job create   --in job.json
```

---

## 3. Notifying / side effects

- **Discord (pulpit):** a `pulpit-message` step with `binding = "<binding-id>"`
  (e.g. `agent-mneme.discord-primary`). Binding ids live in the interface store
  (`interface_bindings`) and are compiled from `var/agents/<agent>/channels/*.toml`.
- **wrkq task:** a `wrkq-task` step (`container`, `title`, `description`).
- **Agent turn:** `agent-dispatch` (explicit scopeRef) or a legacy `agent` step
  (dispatches to the schedule's `[target]`).
- **Email:** run `gog send ...` from inside an `exec` step or an agent turn.

---

## 4. Operate & validate

```bash
acp job list                         # all jobs
acp job show   --job <jobId>         # one job + schedule
acp job run    --job <jobId> --wait  # trigger a run NOW, wait for terminal status (each call = one run)
acp job patch  --job <jobId> --enabled | --disabled | --cron "..."
acp admin managed-resource status --in /tmp/plan.json   # drift vs desired
```

`acp job run --wait --json` returns the full run with per-step `status`,
`result` (exec stdout/stderr, exitCode), and `branchTaken` — the fastest way to
validate a flow without waiting for cron. Delivery of a `pulpit-message` can be
confirmed in the interface store:

```bash
sqlite3 var/db/acp-interface.db \
  "SELECT delivery_request_id, status, created_at FROM delivery_requests \
   WHERE binding_id='<binding>' ORDER BY created_at DESC LIMIT 3;"
```

---

## 5. Worked examples in this collective

- **cody / `wrkq-refactor`** — `var/agents/cody/schedules/wrkq-refactor.toml`.
  `probe` gate (`wrkq-refactor-eligible.v1`) → `idle: succeed` / `work: <agent
  step>`. The canonical "only dispatch an agent when there's work" pattern.
- **mneme / `xdevs-watch`** — `var/agents/mneme/schedules/xdevs-watch.toml`.
  `exec` gate (`~/tools/xdevs-watch`) → `exitCode 0: pulpit` / `10: fresh agent
  analyze` / `default: pulpit`. The "custom detector + conditional analysis"
  pattern, with a debug pulpit on every run.
