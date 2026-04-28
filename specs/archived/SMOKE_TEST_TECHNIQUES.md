# Smoke Test Techniques

Practical validation techniques for HRC and CLI changes where a runtime can look "ready" even though the actual harness never started, or where attach can target the wrong tmux session.

This document exists because the following signals are not sufficient on their own:

- `hrc start <scope>` returned a `ready` runtime
- `hrc attach <scope>` opened a tmux window
- `GET /v1/runtimes/attach` returned an attach descriptor

Those only prove that tmux state exists. They do not prove that the harness process is running in the pane, nor that attach is targeting the correct live tmux session.

## Required Rule

For any implementation that changes `hrc start`, `hrc attach`, runtime attach descriptors, or launch semantics:

1. Prove the harness actually started after `hrc start`.
2. Prove `hrc attach` will target the correct live tmux session.
3. Prefer a real live validation path when practical.
4. If an attach shim is used, pair it with pane capture or another direct signal that the harness is already running.

Do not close these tasks with only "runtime is ready" or "attach command was generated".

## Technique 1: Detached Start Proof

Use this when validating `hrc start <scope>`.

### Goal

Prove that `start` launched the harness, not just the tmux pane.

### Procedure

1. Start the runtime.

```bash
hrc start <scope>
```

2. Get the runtime id from the JSON output.

3. Capture the pane contents immediately.

```bash
hrc capture <runtimeId>
```

4. Look for harness evidence, not just shell evidence.

Examples of acceptable evidence:

- Claude/Codex startup text
- harness prompt text
- agent/system prompt preamble
- model/tool startup output
- absence of a fresh shell prompt when the harness should already be attached to stdin/stdout

Examples of unacceptable evidence:

- empty pane
- only a shell banner
- only a zsh/bash prompt
- only tmux metadata

### Pass Criteria

- `start` returns a runtime id
- `capture` shows harness output in the pane

### Fail Example

- `start` returns `ready`
- `capture` shows only shell startup text or a shell prompt

That indicates the pane exists but the harness was never launched.

## Technique 2: Attach Target Proof Without Taking Over The Terminal

Use this when validating `hrc attach <scope>` or stale-session fixes.

### Goal

Prove the CLI will attach to the correct live tmux target without actually hijacking the validating terminal.

### Procedure

1. Create a temporary tmux shim that logs its argv and exits `0`.

```bash
tmpdir=$(mktemp -d)
cat > "$tmpdir/tmux" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$TMPDIR_ATTACH_LOG"
exit 0
EOF
chmod +x "$tmpdir/tmux"
```

2. Run attach through the CLI entrypoint with the shim earlier in `PATH`.

```bash
TMPDIR_ATTACH_LOG="$tmpdir/attach.log" PATH="$tmpdir:$PATH" \
  bun packages/hrc-cli/src/cli.ts attach <scope>
```

3. Inspect the logged tmux arguments.

```bash
cat "$tmpdir/attach.log"
```

4. Compare the target against runtime state from `hrc runtime list` or the server response.

### Pass Criteria

- logged argv uses the live tmux target for the selected runtime
- for stale-session regressions, the target must be the live `sessionId` or other live-safe identifier, not the stale logical `sessionName`

### Important Limitation

This technique proves the attach target selection only. It does not prove the harness is already running. Pair it with Technique 1.

## Technique 3: Live Start + Attach Proof

Use this when the feature is supposed to work end to end for a real agent.

### Goal

Prove the whole user path works:

1. `hrc start <scope>`
2. harness launches in the tmux pane
3. `hrc attach <scope>` reaches that live harness

### Procedure

1. Restart the daemon on patched code if needed.

```bash
bun packages/hrc-cli/src/cli.ts server restart
```

2. Start the target agent.

```bash
hrc start <scope>
```

3. Capture the pane and confirm harness startup.

```bash
hrc capture <runtimeId>
```

4. If you cannot attach directly in the validating terminal, use the attach shim from Technique 2 and confirm the target is correct.

5. If you can attach directly, attach for real.

```bash
hrc attach <scope>
```

6. Confirm the attached terminal is the actual harness, not a naked shell.

Acceptable evidence:

- harness banner/prompt visible after attach
- pane responds as the harness would
- follow-up `hrc capture <runtimeId>` still shows harness output

### Pass Criteria

- `start` produced a runtime
- `capture` proved the harness launched
- `attach` targeted or reached the same live runtime

## Technique 4: Stale Session Regression Proof

Use this when fixing bugs where tmux session names become stale across restarts or runtime replacement.

### Goal

Prove attach prefers a live tmux identifier rather than a stale stored logical name.

### Procedure

1. Start a runtime and record its live tmux values from `hrc runtime list`.
2. Corrupt the persisted `sessionName` in a test or fixture while keeping the live `sessionId`.
3. Request attach.
4. Assert the returned or executed attach command targets the live `sessionId`.

### Pass Criteria

- attach succeeds or the attach descriptor targets the live `sessionId`
- it does not target the stale `sessionName`

## Minimum Evidence To Report In Handoff

For HRC start/attach changes, every handoff should include:

1. Exact commands run.
2. Whether `capture-pane` or `hrc capture` was used after `start`.
3. A brief statement of what the pane showed.
4. Whether attach was validated by live attach, shimmed attach, or both.
5. If a shim was used, the exact attach target that was logged.

## Example Acceptance Template

```text
Validation:
- hrc start clod -> returned runtime rt-...
- hrc capture rt-... -> showed harness startup text, not a shell prompt
- PATH-prepended tmux shim + bun packages/hrc-cli/src/cli.ts attach clod
  -> logged attach-session -t $89
- live attach or equivalent confirmed the pane belonged to the harness
```

If any one of those bullets is missing, the validation is incomplete for start/attach lifecycle changes.
