# Local Git Hooks

ACP uses Lefthook for light local checks. The hooks never build, typecheck or
run tests: `just verify` runs after each push to `main` on mini's self-hosted
GitHub Actions runner (`.github/workflows/post-push-verify.yml`, T-11909). A red
run shows up as the `agent-control-plane-postpush` check.run and as a
`verify.postpush` record on the agent-control-plane timeline.

- pre-commit: gitleaks, lint (fixes are re-staged), and the sub-second static
  checks (suppressions, boundaries, manifests, dependency pins, CLI surface,
  public surface, enablement changelog, dependency freshness).
- pre-push: no gate. The wrapper only reports the pushed refs to the timeline
  through `wrkp git push`, best-effort.

Both wrappers also publish a best-effort whole-hook duration receipt
(`.githooks/hook-duration.sh`, T-11908).

Materialize the gate after cloning:

```sh
just install
```

For a minimal dependency-only bootstrap, run:

```sh
bun install
bun run install:hooks
```

The hook installer sets the clone-local Git config `core.hooksPath=.githooks`.
The committed `.githooks/pre-commit` and `.githooks/pre-push` wrappers look for
`node_modules/.bin/lefthook` in the repo and then in each ancestor directory
(the praesidium dev workspace hoists it to the shared root), and exit non-zero
if none is found. A fresh clone must not rely on Git's sample hooks or an unmaterialized
`lefthook.yml`.

The post-push supervisor (`scripts/post-push-watchdog.py`) starts its silence
clock after acquiring the shared verify lock. At 8 minutes without a new output
line it records the job process tree, per-Bun/Node/tsc `sample` stacks and `lsof`,
host/cache-lock state, and the verify-lock holder. At 10 minutes of silence it
prints `STALL_DIAGNOSED` and terminates the session, with a bounded kill fallback.
New verify output resets the silence clock; diagnostic output does not. The
45-minute wall deadline still applies, including time waiting for the lock.
Cancellation kills the verify session immediately, without posting a failure.

Evidence is printed into the Actions log and retained on mini under
`~/praesidium/var/postpush-artifacts/agent-control-plane/<run-id>-<attempt>/`.
`verify.log` contains only command output; `diagnostic-*/` contains probe results,
including tool errors/timeouts. Probes run separately with a 60-second budget.
No retry or cache/dependency cleanup is performed by the supervisor.
Run its process-level regression checks on macOS with
`python3 scripts/post-push-watchdog.test.py`. For a scratch forced-stall check,
invoke the supervisor with a scratch lock/artifact directory and
`-- bun -e 'setInterval(() => {}, 1000)'`; production thresholds are 480/600 seconds.
