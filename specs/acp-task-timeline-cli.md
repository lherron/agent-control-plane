# Proposal: `acp task timeline` — Human-readable workflow execution view

**Status:** Proposal · awaiting cody implementation
**Author:** clod
**Date:** 2026-05-11
**Related:** `HEURISTIC_LEARNING_E2E_RUNBOOK.md`, `packages/acp-cli/src/commands/task-show.ts`

---

## 1. Problem

`acp task show --task <id>` (no `--json`) prints only the *current* task state — phase, status, role bindings. There is no first-class CLI surface for the **execution history** of a task: who did what, when, in what order, and whether each command was accepted or rejected.

Today operators reconstruct the timeline by piping `acp task show --json` through ad-hoc `jq` queries, then mentally joining `events`, `evidence`, `participantRuns`, and `workflowHrcRunMaps`. This was the single most frequent friction during the heuristic-learning e2e smoke (see runbook §10.1).

## 2. Goals

- One command that renders the **entire flow** of a workflow task chronologically.
- Information-dense default; drill-down on demand.
- Visually distinguishes accepted / rejected / lifecycle / mapping events at a glance.
- Color when stdout is a TTY; clean ASCII fallback when piped or `--no-color`.
- Composable: `--json` returns the same projection that drives the renderer.

## 3. Non-goals

- HRC runtime turn/tool/exec drilldown — that lives at `hrc events` or a future `hrc timeline`. Timeline only **points** to the HRC scope and seq range.
- Live tailing — covered by `acp tail`. Timeline is a snapshot view.
- Editing or transitioning state — read-only.
- Cross-task aggregation — single task per invocation.

## 4. CLI surface

```
acp task timeline [options]

Options:
  --task <taskId>            REQUIRED — task to render
  --since <when>             only events after when (ISO ts or "5m"/"1h"/"2d")
  --until <when>             only events before when
  --only <kinds>             csv: transitions,evidence,runs,mappings,obligations,effects,anomalies
                             (default: all)
  --skip <kinds>             inverse of --only
  --rejections-only          shorthand for showing only rejected events
  --verbose, -v              show payload, eventHash, evidence ref, hrc seq range
  --no-color                 disable ANSI styling
  --plain                    --no-color + ASCII-only icons
  --markdown                 emit a markdown table (PR/issue-friendly)
  --json                     emit the renderer's projection as JSON
  --width <n>                wrap at column n (default: terminal width or 100)
  --server <url>             standard
  --actor <agentId>          standard
  -h, --help
```

**Exit codes:** 0 on success, 1 on transport error, 2 on bad flags. Renderer never errors on schema gaps — missing fields render as `—`.

## 5. UX mockups

### 5.1 Default (compact, color-on-TTY)

```
┌─ Task hl-mvp-002909 ─────────────────────────────────────────────────────────┐
│ Workflow:  code_defect_fastlane@1                                            │
│ Status:    closed   Phase: verified   Outcome: completed                     │
│ Roles:     implementer=cody · tester=rex · supervisor=clod                   │
│ Span:      05:29:09 → 05:42:14  (13m 5s)   ·   12 events · 1 rejection      │
└──────────────────────────────────────────────────────────────────────────────┘

  seq  time      event                                       actor                      
  ───  ────────  ──────────────────────────────────────────  ─────────────────────────  
  ●  1  05:29:09  task.created                                clod                       
  ●  2  05:29:55  evidence.attached  tdd_green_bundle         cody/implementer           
  ✗  3  05:30:23  transition.rejected  red_to_green           clod         version_conflict
  ●  4  05:30:57  transition.applied  red→green               cody/implementer    v0→v1  
  ▶  5  05:31:32  participant_run.launched  prun_0883         cody/implementer           
  ◆  6  05:32:22  hrc_run.mapped  hrcrun-smoke-1              scope: agent:cody:project:agent-spaces
  ▶  7  05:35:41  participant_run.launched  prun_0888         cody/implementer           
  ◆  7  05:35:41  hrc_run.mapped  hrcrun-smoke-2                                         
  ●  8  05:38:02  evidence.attached  qa_bundle                rex/tester                 
  ●  9  05:38:34  transition.applied  green→verified          rex/tester          v1→v2  
  ●  10 05:42:14  transition.applied  verified→completed      clod/owner          v2→v3  
```

**Symbol legend** (rendered as a one-line footer when `--help` or first run on a TTY):

| Symbol | Meaning                | ASCII fallback (`--plain`) |
|--------|------------------------|----------------------------|
| ●      | accepted command       | `[+]`                      |
| ✗      | rejected command       | `[x]`                      |
| ▶      | run lifecycle          | `[>]`                      |
| ◆      | mapping / effect       | `[*]`                      |
| ◇      | obligation             | `[o]`                      |
| ⚠      | anomaly                | `[!]`                      |
| ⏸      | run paused / waiting   | `[~]`                      |

### 5.2 Color palette (chalk on TTY)

| Element                  | Style                                             |
|--------------------------|---------------------------------------------------|
| Header box border        | `chalk.gray`                                      |
| Header labels            | `chalk.bold.gray`                                 |
| Header values            | `chalk.white`                                     |
| Status: open/active      | `chalk.cyan`                                      |
| Status: closed (success) | `chalk.green`                                     |
| Status: closed (rejected)| `chalk.red`                                       |
| Accepted symbol/seq      | `chalk.green('●')`                                |
| Rejected symbol/seq      | `chalk.red('✗')` + entire row dim red             |
| Run-lifecycle symbol     | `chalk.cyan('▶')`                                 |
| Mapping symbol           | `chalk.blue('◆')`                                 |
| Anomaly symbol           | `chalk.yellow('⚠')`                               |
| Event type               | `chalk.bold` + `chalk.dim` for the parameters     |
| Phase transition arrow   | `chalk.magenta('→')`                              |
| Version delta `vN→vM`    | `chalk.dim`                                       |
| Actor                    | `chalk.cyan(id) + chalk.dim('/' + role)`          |
| Rejection code           | `chalk.red.bold`                                  |
| Timestamp                | `chalk.dim`                                       |
| Verbose payload lines    | `chalk.dim` indented                              |

**Accessibility:** never rely on color alone — symbol + position + text all encode meaning. `chalk.supportsColor` (or `process.stdout.isTTY && !process.env.NO_COLOR`) gates color; `--no-color` and `NO_COLOR=1` both disable.

### 5.3 Verbose (`--verbose`)

```
  ✗  3  05:30:23  transition.rejected  red_to_green           clod         version_conflict
                  payload: {"transitionId":"red_to_green","expectedVersion":99,"role":"implementer"}
                  reason : Task version 0 does not match expected version 99
                  hash   : sha256:e9eb9007…  prev: sha256:cb034c6d…
```

### 5.4 Filtered (`--only transitions,rejections`)

```
  ✗  3  05:30:23  transition.rejected  red_to_green           clod         version_conflict
  ●  4  05:30:57  transition.applied   red→green              cody/impl    v0→v1
  ●  9  05:38:34  transition.applied   green→verified         rex/tester   v1→v2
  ● 10  05:42:14  transition.applied   verified→completed     clod/owner   v2→v3
```

### 5.5 Markdown (`--markdown`)

```markdown
## Task hl-mvp-002909 · code_defect_fastlane@1

**Status:** closed · **Outcome:** completed · 12 events, 1 rejection · 13m 5s

| seq | time     | event                            | actor              | notes              |
|----:|----------|----------------------------------|--------------------|--------------------|
|   1 | 05:29:09 | ✅ task.created                   | clod               |                    |
|   2 | 05:29:55 | ✅ evidence.attached tdd_green    | cody/implementer   |                    |
|   3 | 05:30:23 | ❌ transition.rejected red_to_green | clod             | version_conflict   |
|   4 | 05:30:57 | ✅ transition.applied red→green   | cody/implementer   | v0→v1              |
| ... | ...      | ...                              | ...                |                    |
```

### 5.6 Plain (`--plain`)

```
Task hl-mvp-002909 — code_defect_fastlane@1
Status: closed  Outcome: completed  Span: 13m 5s  Events: 12  Rejections: 1

[+]  1 05:29:09  task.created                              clod
[+]  2 05:29:55  evidence.attached tdd_green_bundle        cody/implementer
[x]  3 05:30:23  transition.rejected red_to_green          clod              version_conflict
[+]  4 05:30:57  transition.applied red->green             cody/implementer  v0->v1
[>]  5 05:31:32  participant_run.launched prun_0883        cody/implementer
[*]  6 05:32:22  hrc_run.mapped hrcrun-smoke-1             scope: agent:cody:project:agent-spaces
```

## 6. Data model

The renderer projects `acp task show --json` into a unified event stream:

```ts
type TimelineRow = {
  seq: number               // workflowSeq for ledgered events; synthesized for joined items
  ts: string                // ISO
  kind: 'accepted'|'rejected'|'recorded'|'run'|'mapping'|'evidence'|'obligation'|'effect'|'anomaly'
  category: 'transition'|'evidence'|'run'|'mapping'|'obligation'|'effect'|'anomaly'|'meta'
  type: string              // event.type or synthesized label
  actor?: { kind: string; id: string }
  role?: string
  rejectionCode?: string
  versionDelta?: { from: number; to: number }
  scopeRef?: string         // for mappings
  refs?: string[]           // evidence refs, hrc run ids, etc.
  payload?: unknown         // verbose only
  eventHash?: string
  prevHash?: string
}
```

Source data:
- `task` → header
- `events` → primary stream (transitions, evidence.attached, participant_run.launched, workflow_hrc_run.mapped, effect.intent.*, anomaly.recorded, etc.)
- `evidence`, `participantRuns`, `workflowHrcRunMaps`, `obligations`, `effects`, `anomalies` → enrichment for the matching event row (e.g., resolve `evidenceId` → `kind`+`ref`+`summary`)

The renderer never invents events — every row maps to a ledger entry. Joined details are decorations, not new rows.

## 7. Implementation notes

### 7.1 Package additions

Add to `packages/acp-cli/package.json`:
```json
"chalk": "^5.6.2"
```
Already used by `hrc-cli` (^5.6.2), `cli` (^5.3.0), and `execution`. Pin to ^5 for ESM compatibility.

### 7.2 File layout

- `packages/acp-cli/src/commands/task-timeline.ts` — command handler + flag parsing
- `packages/acp-cli/src/output/timeline-render.ts` — pure renderer: `(input: TaskTimelineInput, opts: RenderOptions) => string`
- `packages/acp-cli/src/output/timeline-project.ts` — pure projection: `(taskShowResponse) => TimelineRow[]`
- `packages/acp-cli/src/__tests__/timeline-render.test.ts` — golden-file tests for color and `--plain`
- `packages/acp-cli/src/__tests__/timeline-project.test.ts` — projection unit tests

### 7.3 Reuse

- `task-show.ts` already calls `GET /v1/tasks/:taskId`. `task-timeline.ts` calls the same endpoint and forwards the response into the projection.
- `output/task-render.ts` `renderRoleMap` can be reused for the header roles line.

### 7.4 Color gate

```ts
import chalk, { type ChalkInstance } from 'chalk'

function makeStyle(opts: { color: boolean }): ChalkInstance {
  if (!opts.color) return new chalk.Instance({ level: 0 })
  return chalk
}

const useColor =
  !flags.plain &&
  !flags.noColor &&
  process.stdout.isTTY &&
  process.env.NO_COLOR === undefined
```

### 7.5 Width handling

- Default to `process.stdout.columns ?? 100`.
- Truncate the longest column (event description) with `…` rather than wrapping rows.
- `--verbose` lines wrap with hanging indent.

### 7.6 Edge cases

- Task with zero events (just-created): render header, then `(no events yet)`.
- Task with rejection but no acceptance: render normally; rejected rows still bear seq/hash.
- Participant runs without a corresponding `workflow_hrc_run.mapped` event: row shows `mapping: —`.
- Effects table empty: skip the section entirely (don't print empty headers).
- Very long actor/role/payload strings: truncate to fit, full value visible in `--verbose` or `--json`.

## 8. Acceptance criteria

- `acp task timeline --task hl-mvp-002909` (a fully-completed task) renders the header + 12-row event stream within 200ms on a warm cache.
- `--rejections-only` returns only `result=rejected` rows.
- `--markdown` output round-trips through a markdown renderer (no broken pipes/tables).
- `--plain` output contains zero ANSI escape sequences.
- `--json` output is the input to `--plain` (renderer is a pure function over the projection).
- Snapshot test: render of the smoke's `hl-mvp-002909` matches a checked-in golden file.

## 9. Out of scope

- HRC turn/tool drilldown (separate command).
- Cross-task / project-wide timeline.
- Diffing two task timelines.
- Real-time tailing.
- Filtering by actor (could be a follow-up flag).

## 10. Open questions

1. Should `acp task show` (default, no flags) call the timeline renderer in compact mode, making `acp task timeline` a verbose alias? My preference: keep them separate so `task show` stays a fast state-only view.
2. Should we bake in a `wlearn`-aware mode (`--with-trace`) that fetches and overlays trace metrics? Probably a follow-up.
3. Color scheme accessibility: should we ship a `--colorblind` palette (blue/orange instead of red/green)? Worth considering if there's user demand.
