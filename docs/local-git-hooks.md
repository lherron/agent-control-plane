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
