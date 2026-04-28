# Interactive Pi Harness Assessment

Date: 2026-04-25

## Scope

The interactive Pi CLI harness has not been exercised recently. This assessment compares the current Pi CLI adapter against the Claude/Codex interactive harness paths, the HRC launch/event infrastructure, and the live Pi CLI surface from `pi --help` and `~/tools/pi-mono`.

No code changes are proposed here beyond this assessment document.

## Verified Inputs

Live `pi --help` shows the CLI supports:

- `--provider <name>`
- `--model <pattern>`
- `--system-prompt <text>`
- `--append-system-prompt <text>`
- `--mode text|json|rpc`
- `--print`
- `--continue`
- `--resume`
- `--session <path|id>`
- `--fork <path|id>`
- `--session-dir <dir>`
- `--no-session`
- `--models <patterns>`
- `--no-tools`
- `--no-builtin-tools`
- `--tools <tools>`
- `--thinking off|minimal|low|medium|high|xhigh`
- `--extension <path>`
- `--no-extensions`
- `--skill <path>`
- `--no-skills`
- `--prompt-template <path>`
- `--no-prompt-templates`
- `--theme <path>`
- `--no-themes`
- `--no-context-files`
- `--export <file>`
- `--list-models`
- `--verbose`
- `--offline`

Pi also uses:

- `PI_CODING_AGENT_DIR` as its agent/session/config directory.

Current `asp run --harness pi --dry-run` for a simple space generates:

```bash
ASP_PROJECT=base AGENTCHAT_ID=base PI_CODING_AGENT_DIR=/tmp/.../pi \
  /Users/lherron/.nvm/versions/node/v22.20.0/bin/pi \
  --no-extensions --no-skills --model gpt-5.5 --provider openai-codex
```

Current `asp run cody --harness pi --dry-run` generates the composed Pi bundle and displays system prompt, session reminder, and priming prompt in the ASP dry-run UI, but the Pi argv still does not pass the system prompt or session reminder to Pi:

```bash
PI_CODING_AGENT_DIR=/Users/lherron/praesidium/var/spaces-repo/projects/agent-spaces-05934522/targets/cody/pi \
  pi \
  --extension /Users/lherron/praesidium/var/spaces-repo/projects/agent-spaces-05934522/targets/cody/pi/asp-hooks.bridge.js \
  --no-skills \
  --model gpt-5.5 \
  --provider openai-codex \
  'You are Cody, a Codex agent. Cody code rules the world.'
```

The composed Pi bundle for `cody` contains:

- `system-prompt.md`
- `session-reminder.md`
- `skills/`
- `hooks-scripts/`
- `asp-hooks.bridge.js`
- `auth.json`
- `settings.json`

It does not contain:

- `SYSTEM.md`
- `APPEND_SYSTEM.md`
- `AGENTS.md`
- `AGENT.md`
- `CLAUDE.md`

Pi source confirms it reads native context from `AGENTS.md` or `CLAUDE.md`, and system prompt files from `.pi/SYSTEM.md`, `PI_CODING_AGENT_DIR/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, or `PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`. It does not read ASP's `system-prompt.md` or `session-reminder.md` by filename unless those are passed via CLI flags.

## High-Level Findings

Interactive Pi is only partially wired.

`asp run --harness pi` can materialize a Pi bundle and start the Pi binary, but it does not pass the full ASP runtime context to Pi. In particular, system prompt and session reminder are materialized but not consumed by Pi, bundle skills are materialized but not explicitly loaded, and continuation is handled with the interactive picker rather than deterministic session selection.

`hrc run` cannot currently select interactive Pi CLI as a distinct frontend. HRC and agent-spaces collapse OpenAI CLI to `codex-cli`. Even though `HrcHarness` includes `pi`, the public agent-spaces CLI frontend types only expose `claude-code` and `codex-cli`, and HRC maps provider `openai` to `codex-cli`.

HRC event capture is Codex/Claude-specific today. Codex uses OTEL ingestion into `hrc_events`; Claude uses hooks through `HRC_LAUNCH_HOOK_CLI`. Pi's generated hook bridge only runs shell scripts and emits in-band Pi custom messages. It does not currently write HRC hook, OTEL, or semantic turn/tool events to `hrc_events`.

## Detailed Gaps

### 1. HRC Cannot Select Interactive Pi CLI

Relevant current behavior:

- `HrcHarness` includes `pi`.
- `HarnessId` includes `pi`.
- `HARNESS_CATALOG` has `pi` as an OpenAI CLI harness, but it has no public frontend.
- agent-spaces public CLI invocation only supports frontends `claude-code` and `codex-cli`.
- HRC `SUPPORTED_CLI_HARNESSES` is `claude-code` and `codex-cli`.
- HRC maps provider `openai` to `codex-cli`.
- `identity.harness = "pi"` resolves to provider `openai`, then HRC derives the interactive frontend as `codex-cli`.

Impact:

- `hrc run` cannot intentionally launch Pi CLI.
- A Pi agent profile is not enough; the specific harness variant is lost during intent parsing.
- Runtime rows and launch artifacts cannot reliably identify an interactive Pi CLI runtime.

Recommended fix:

- Add a public CLI frontend for Pi, probably `pi-cli`, while keeping internal harness id `pi`.
- Extend agent-spaces types, frontend registry, model lists, and `BuildProcessInvocationSpecRequest` to allow `pi-cli`.
- Preserve requested harness/frontend in HRC runtime intent instead of only provider.
- Update HRC frontend resolution so `identity.harness = "pi"` maps to `pi-cli`, not `codex-cli`.
- Ensure runtime rows and launch artifacts record `harness: "pi"` or `frontend: "pi-cli"` consistently.

### 2. System Prompt Is Materialized But Not Passed To Pi

ASP/HRC currently materializes prompt content:

- `system-prompt.md`
- `session-reminder.md`

Claude passes system prompt content via:

- `--system-prompt <content>`
- `--append-system-prompt <content>`

Codex injects the prompt/reminder into `CODEX_HOME/AGENTS.md`.

Pi adapter currently ignores:

- `HarnessRunOptions.systemPrompt`
- `HarnessRunOptions.systemPromptMode`
- `HarnessRunOptions.reminderContent`

Pi source supports:

- `--system-prompt <text-or-existing-file>`
- `--append-system-prompt <text-or-existing-file>`
- `PI_CODING_AGENT_DIR/SYSTEM.md`
- `PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`

Impact:

- Pi launches with its default system prompt plus whatever native context it discovers.
- ASP's computed Praesidium system prompt is visible in dry-run display but likely absent from the actual Pi session.
- Session reminder is written to disk but not consumed by Pi.
- `asp self prompt system` and HRC launch display may report prompt content that the Pi process did not actually receive.

Recommended fix:

- For replace mode, pass `--system-prompt <bundle/system-prompt.md>`.
- For append mode, pass `--append-system-prompt <bundle/system-prompt.md>`.
- If `session-reminder.md` exists, pass it as an additional `--append-system-prompt <bundle/session-reminder.md>`, or compose a Pi-specific prompt file that includes both prompt and reminder in the intended order.
- Prefer file paths rather than long prompt text in argv to avoid giant command lines.
- Ensure launch display and `asp self prompt` can recover the same prompt paths/content.

### 3. Priming Prompt Works For Pi, But HRC Introspection Does Not

Pi accepts positional message arguments as the initial interactive prompt. Current Pi adapter appends `options.prompt` as a positional argument, and manual dry-run shows the priming prompt is present.

HRC launch display and `asp self prompt priming` conventionally extract the priming prompt from the value after `--`. Pi's parser does not currently handle `--` as a separator; adding `--` before the prompt would be interpreted as an unknown flag by Pi's current parser.

Impact:

- Pi may receive the initial prompt.
- HRC launch header may not display the priming prompt.
- `asp self prompt priming` may fail unless `ASP_PRIMING_PROMPT` is set and used.

Recommended fix:

- Short term: set `ASP_PRIMING_PROMPT` for Pi runs and make HRC launch display use it as fallback when no `--` separator is present.
- Longer term: update Pi's CLI parser to support `--` as an end-of-options separator, then update Pi adapter to use the shared argv convention.

### 4. Bundle Skills Are Materialized But Not Loaded

Pi bundle contains `skills/`. Current Pi argv always includes:

```bash
--no-skills
```

It does not include:

```bash
--skill <bundle/skills>
```

Pi source shows that explicit `--skill` paths are still merged even when `--no-skills` is true.

Impact:

- Default user/project skill discovery is disabled, which is good for isolation.
- Bundle skills are likely not loaded unless another code path picks them up. Based on Pi source, `PI_CODING_AGENT_DIR/skills` alone is not enough when `--no-skills` is used without explicit `--skill`.

Recommended fix:

- Keep `--no-skills` to disable defaults.
- Add `--skill <bundle/skills>` when the composed bundle has skills.
- Validate `before_agent_start.systemPromptOptions.skills` or slash-command/autocomplete includes expected skill names.

### 5. Context File Naming Is Incompatible

Pi source reads context files named:

- `AGENTS.md`
- `CLAUDE.md`

ASP Pi materialization links space instructions as `AGENT.md` for individual artifacts, but the final composed Pi target currently does not include a root `AGENTS.md`, `AGENT.md`, or `CLAUDE.md`.

Impact:

- Space instruction files are not necessarily delivered to Pi's native context loader.
- For agent/project runs this is partly hidden by ASP's separate system-prompt materialization, but that prompt is also not passed to Pi today.

Recommended fix:

- Do not rely on native context file discovery for ASP-composed prompt content.
- Pass the materialized ASP prompt through Pi's explicit system prompt flags.
- If native Pi context files are desired, compose root `AGENTS.md` in the Pi bundle and decide whether to add `--no-context-files` to prevent project cwd leakage.

### 6. Hook Bridge Does Not Write HRC Events

The Pi adapter generates `asp-hooks.bridge.js` when hooks exist. It subscribes to Pi events such as:

- `tool_call`
- `tool_result`
- `session_start`
- `session_shutdown`

It runs hook shell scripts with ASP-specific environment variables and emits Pi custom messages via `pi.sendMessage`.

It does not:

- call `HRC_LAUNCH_HOOK_CLI`
- post HRC callbacks
- emit OTEL logs
- append semantic event rows to `hrc_events`

HRC launch exec does provide these env vars to all child harnesses:

- `HRC_LAUNCH_FILE`
- `HRC_CALLBACK_SOCKET`
- `HRC_SPOOL_DIR`
- `HRC_LAUNCH_ID`
- `HRC_HOST_SESSION_ID`
- `HRC_GENERATION`
- `HRC_RUNTIME_ID`
- `HRC_LAUNCH_HOOK_CLI`

Impact:

- HRC events will show launch/tmux lifecycle, but not Pi turn/tool/message lifecycle.
- Hooks can run, but HRC cannot observe them except indirectly through logs or terminal capture.
- Existing ops/timeline/event consumers will not get Pi semantic turn data.

Recommended fix:

- Add a generated Pi HRC event extension, separate from or integrated into `asp-hooks.bridge.js`.
- Subscribe to Pi extension events:
  - `before_agent_start`
  - `agent_start`
  - `agent_end`
  - `turn_start`
  - `turn_end`
  - `message_start`
  - `message_update`
  - `message_end`
  - `tool_execution_start`
  - `tool_execution_update`
  - `tool_execution_end`
  - `session_shutdown`
- Send these events to HRC through `HRC_LAUNCH_HOOK_CLI` or a Pi-specific callback endpoint.
- Prefer adding a Pi normalizer in `hrc-events` rather than forcing Pi event payloads into Claude hook shape.
- Emit raw audit events and derived semantic events where possible, matching Codex OTEL and Claude hook behavior.

### 7. Codex OTEL Path Is Not Reusable As-Is

HRC injects OTEL config only for `codex-cli`, and Pi source does not expose a compatible OTEL exporter in the inspected CLI code. Pi has rich extension events and RPC mode, but no native HRC OTLP log emission path.

Impact:

- We cannot assume Pi event capture will happen through the current Codex OTEL ingestion.

Recommended fix:

- For interactive full PTY, use a Pi extension event bridge.
- For future headless/noninteractive Pi, evaluate `--mode rpc` as a structured event stream option.

### 8. Session Resume Uses The Wrong Pi Option

Current Pi adapter maps `continuationKey` to:

```bash
--resume
```

Pi help/source shows:

- `--resume` opens a session picker.
- `--session <path|id>` opens a specific session.
- `--session-dir <dir>` constrains storage/lookup.
- `--continue` resumes recent session.

Impact:

- HRC/automation cannot deterministically resume a known Pi continuation.
- A managed PTY may block on an interactive picker.

Recommended fix:

- Use `--session <key>` when a continuation key is present.
- Add `--session-dir <stable bundle/runtime session dir>`.
- Use `--resume` only when the user explicitly asks for a picker.
- Decide whether `PI_CODING_AGENT_DIR` or a separate `--session-dir` should own managed sessions; validate session files are stable across restarts.

### 9. Missing CLI Option Generation

Current Pi adapter emits:

- `--extension <path>`
- `--no-extensions` when none
- `--no-skills`
- `--model <model>`
- `--provider openai-codex`
- `--print` for noninteractive
- `--resume` for continuation
- `extraArgs`
- positional prompt

Likely missing or under-modeled options:

- `--system-prompt`
- `--append-system-prompt`
- `--skill`
- `--prompt-template`
- `--no-prompt-templates`
- `--theme`
- `--no-themes`
- `--no-context-files`
- `--session-dir`
- `--session`
- `--continue`
- `--no-session`
- `--thinking`
- `--tools`
- `--no-tools`
- `--no-builtin-tools`
- `--models`
- `--offline`
- `--verbose`
- `--mode rpc` for structured noninteractive/headless exploration

## Recommended Implementation Order

1. Add a `pi-cli` public frontend through config, agent-spaces, and HRC.
2. Preserve explicit harness/frontend identity in HRC runtime intent and launch artifacts.
3. Wire Pi system prompt, reminder, priming env, explicit skills, and deterministic session flags.
4. Add Pi HRC event bridge extension and event normalizer.
5. Validate directory materialization and prompt loading with a Pi `before_agent_start` capture extension.
6. Add tests for dry-run argv and launch artifact generation.
7. Run the manual ghostmux e2e checklist below.

## Manual E2E Validation Plan

These validations should be performed with ghostmux to exercise a real full PTY.

### A. Dry-Run Command Generation

Run:

```bash
ASP_HOME=/Users/lherron/praesidium/var/spaces-repo \
  bun packages/cli/bin/asp.js run cody --harness pi --dry-run
```

Expected after fixes:

- Command includes `PI_CODING_AGENT_DIR=<...>/pi`.
- Command includes `--provider openai-codex`.
- Command includes expected `--model`.
- Command includes `--system-prompt <.../system-prompt.md>` or `--append-system-prompt <.../system-prompt.md>`.
- Command includes reminder delivery, likely `--append-system-prompt <.../session-reminder.md>`.
- Command includes `--skill <.../skills>` when skills exist.
- Command keeps `--no-skills` to disable default discovery.
- Command includes `--no-extensions` only when no explicit bundle extensions or bridge extension exist.
- Command includes `--extension <.../asp-hooks.bridge.js>` when hooks exist.
- Command includes deterministic session flags when continuation is supplied.
- Dry-run display shows system prompt, session reminder, and priming prompt.

Current expected failures:

- No system prompt flag.
- No reminder flag.
- No explicit skill path.
- Continuation uses `--resume` picker.

### B. Bundle Materialization Inspection

Run:

```bash
ASP_HOME=/Users/lherron/praesidium/var/spaces-repo \
  bun packages/cli/bin/asp.js run cody --harness pi --dry-run
```

Inspect the printed `PI_CODING_AGENT_DIR`.

Expected files:

```bash
find "$PI_DIR" -maxdepth 3 -type f -o -type l | sort
```

Validate:

- `system-prompt.md` exists and contains platform + SOUL sentinel content.
- `session-reminder.md` exists when the template has reminder sections.
- `skills/<name>/SKILL.md` exists for expected skills.
- `hooks-scripts/` contains hook scripts and hook config.
- `asp-hooks.bridge.js` exists when hooks exist.
- `settings.json` exists and disables Codex/Claude/user/project defaults unless inherit flags are used.
- `auth.json` symlink exists if user Pi auth exists.

Also validate Pi-native files if we choose to write them:

- `SYSTEM.md` or `APPEND_SYSTEM.md`, if that strategy is chosen.
- `AGENTS.md`, if native context file strategy is chosen.

The key validation is not just file presence; Pi must receive the content through its supported loading path.

### C. Full PTY ASP Pi Launch

Run:

```bash
ghostmux new \
  --title pi-asp-e2e \
  --cwd /Users/lherron/praesidium/agent-spaces \
  --command 'ASP_HOME=/Users/lherron/praesidium/var/spaces-repo bun packages/cli/bin/asp.js run cody --harness pi'
```

Capture:

```bash
ghostmux capture-pane -t pi-asp-e2e -S - -E -
```

Send a simple prompt:

```bash
ghostmux send-keys -t pi-asp-e2e -l 'Reply exactly PI_E2E_READY.'
```

Expected:

- Pi TUI starts in the PTY.
- No resume picker appears unless explicitly requested.
- Initial prompt path works.
- Response appears in the PTY.
- No obvious prompt/context errors are printed.

### D. Prompt Loading Proof With Pi Extension

Create or inject a temporary Pi extension for validation only. It should listen to `before_agent_start` and write:

- `event.prompt`
- `event.systemPrompt`
- `event.systemPromptOptions.skills`
- `event.systemPromptOptions.agentsFiles`

to a temp file, for example:

```text
/tmp/pi-interactive-e2e/before-agent-start.json
```

Launch with ghostmux and send:

```bash
ghostmux send-keys -t pi-asp-e2e -l 'Reply exactly PI_PROMPT_CAPTURED.'
```

Validate captured JSON:

- `systemPrompt` contains the Praesidium platform sentinel.
- `systemPrompt` contains the agent SOUL sentinel.
- `systemPrompt` contains reminder content if reminder is delivered as append.
- `prompt` contains the priming or user prompt sent through the PTY.
- `skills` includes expected bundle skills.
- Project/user default context is absent unless inherit flags are intentionally enabled.

This is the strongest validation for the user's added requirement: directories may be materialized correctly, but this proves Pi actually loaded the intended system prompt, session reminder, priming prompt, and skills.

### E. HRC Pi Selection

Create a temporary agent profile with:

```toml
schemaVersion = 2
priming_prompt = "PI_E2E_PRIMING_SENTINEL"

[identity]
display = "Pi E2E"
role = "coder"
harness = "pi"

[spaces]
base = ["space:defaults@dev", "space:praesidium-defaults@dev"]
```

Run:

```bash
hrc run pi-e2e@agent-spaces --dry-run
```

Expected after fixes:

- Dry-run shows frontend/harness as Pi, not `codex-cli`.
- Env includes `PI_CODING_AGENT_DIR`.
- Command is `pi`, not `codex`.
- Command includes prompt/system/session/skill flags described above.

Current expected failure:

- OpenAI interactive resolves to `codex-cli`.

### F. Full PTY HRC Launch With Events

Start event follower:

```bash
ghostmux new \
  --title pi-hrc-events \
  --cwd /Users/lherron/praesidium/agent-spaces \
  --command 'hrc monitor watch pi-e2e@agent-spaces --follow --json'
```

Start Pi through HRC:

```bash
ghostmux new \
  --title pi-hrc-e2e \
  --cwd /Users/lherron/praesidium/agent-spaces \
  --command 'hrc run pi-e2e@agent-spaces --force-restart -p "PI_E2E_PRIMING_SENTINEL"'
```

Trigger a tool:

```bash
ghostmux send-keys -t pi-hrc-e2e -l 'Use bash to run: printf PI_TOOL_DONE. Then reply exactly PI_TOOL_DONE.'
```

Expected after event bridge fixes:

- `hrc_events` includes launch lifecycle events.
- `hrc_events` includes Pi session/turn/message/tool events.
- Tool start/end events include tool name and input/result.
- Events include correct `hostSessionId`, `runtimeId`, `launchId`, generation, scope, and lane.
- If using hook callback path, source is `hook` or a deliberately chosen Pi source.
- If using OTEL path, source is `otel`.
- HRC event follower sees semantic turn/tool events where expected.

Current expected failure:

- HRC will show only launch/tmux lifecycle and no Pi semantic tool/message events.

### G. Hook Script Execution And HRC Event Capture

Use a space with hooks configured, or add a temporary hook script that writes a sentinel file:

```text
/tmp/pi-interactive-e2e/hook-fired.txt
```

Trigger a matching tool call.

Expected:

- Hook script runs.
- Sentinel file is written.
- Pi hook bridge logs to `~/praesidium/var/logs/asp-hooks.log`.
- HRC receives corresponding hook/event rows.
- Blocking hook behavior is explicitly documented. Current Pi CLI bridge marks blocking hooks as unsupported/best-effort, so validation should confirm warning behavior unless blocking support is added.

### H. Resume And Session Directory

First run:

```bash
ghostmux new \
  --title pi-resume-1 \
  --cwd /Users/lherron/praesidium/agent-spaces \
  --command 'hrc run pi-e2e@agent-spaces --force-restart -p "Remember the token PI_RESUME_TOKEN."'
```

Find the Pi session file under the managed session directory.

Second run should use deterministic continuation:

```bash
hrc run pi-e2e@agent-spaces --dry-run
```

Expected after fixes:

- Command includes `--session-dir <stable managed dir>`.
- Command includes `--session <id-or-path>` when continuation is known.
- Command does not use `--resume` unless a picker was explicitly requested.
- Launch does not block on the Pi resume picker.
- Pi has previous conversation context.

### I. Isolation And Inheritance

Plant sentinel defaults:

- `~/.pi/agent/skills/user-sentinel/SKILL.md`
- `<project>/.pi/skills/project-sentinel/SKILL.md`
- `<project>/.pi/SYSTEM.md`
- `<project>/AGENTS.md`

Run default Pi ASP/HRC launch.

Expected default behavior:

- User/project Pi skills are not loaded.
- Project `.pi/SYSTEM.md` is not loaded if `--no-context-files` or explicit prompt policy is meant to isolate it.
- Project `AGENTS.md` behavior matches the chosen policy.

Run with inherit flags:

```bash
ASP_HOME=/Users/lherron/praesidium/var/spaces-repo \
  bun packages/cli/bin/asp.js run cody --harness pi --inherit-user --inherit-project --dry-run
```

Expected:

- Inheritance changes are visible in settings/argv.
- Only intended default paths are loaded.

### J. Prompt Templates And Themes

If Pi parity includes prompt templates:

- Add a bundle command/prompt template with sentinel `PI_TEMPLATE_SENTINEL`.
- Launch Pi.
- Validate slash autocomplete or `/template-name` expansion works.
- Confirm command generation includes `--prompt-template <dir>`.

If themes are intentionally unsupported for ASP composition, document that and ensure default theme discovery is disabled or isolated as intended.

### K. Exit And Cleanup

Exit Pi from the PTY:

```bash
ghostmux send-key -t pi-hrc-e2e C-d
```

or use Pi's normal exit command if available.

Validate:

- HRC records launch exit/runtime termination.
- No orphan Pi process remains.
- Event follower receives final lifecycle event.
- Re-running `hrc run` reuses/restarts according to the requested restart style.

## Acceptance Criteria

Interactive Pi should be considered functional when:

- `hrc run` can deliberately launch Pi CLI as Pi, not Codex.
- `asp run --harness pi --dry-run` and HRC dry-run show the same intended Pi command surface.
- `PI_CODING_AGENT_DIR` is always present in printed and spawned commands.
- Pi receives the ASP system prompt, session reminder, and priming prompt.
- Pi loads composed bundle skills while suppressing defaults by default.
- Pi executes composed extensions and hooks.
- Pi emits turn/message/tool/session events into `hrc_events`.
- Resume uses deterministic `--session`/`--session-dir`, not the interactive picker.
- Ghostmux full-PTY validation passes for ASP and HRC launches.
