# Hooks, launchd, deployment and gates

## Sub-features

Just recipes, light commit/push hooks, post-push runner, launchd sources, build/install/deploy and documentation guards.

Source anchors (repo-relative): justfile; .githooks; .github/workflows; launchd. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp server []`
- Surface: `file:.githooks/hook-duration.sh`
- Surface: `file:.githooks/post-commit`
- Surface: `file:.githooks/pre-commit`
- Surface: `file:.githooks/pre-push`
- Surface: `file:.github/workflows/post-push-verify.yml`
- Surface: `file:.github/workflows/publish.yml`
- Surface: `file:launchd/com.praesidium.acp-server.plist`
- Surface: `file:launchd/com.praesidium.hrc-viewer.plist`
- Surface: `file:launchd/com.praesidium.log-rotation.plist`
- Surface: `recipe:advance-producers`
- Surface: `recipe:architecture-records`
- Surface: `recipe:build`
- Surface: `recipe:check`
- Surface: `recipe:check-cli-surface`
- Surface: `recipe:check-deps`
- Surface: `recipe:check-enablement-changelog`
- Surface: `recipe:check-public-surface`
- Surface: `recipe:check-suppressions`
- Surface: `recipe:clean`
- Surface: `recipe:cp-test`
- Surface: `recipe:default`
- Surface: `recipe:doctor`
- Surface: `recipe:e2e`
- Surface: `recipe:e2e-cap-acp`
- Surface: `recipe:e2e-cap-acp-real`
- Surface: `recipe:e2e-cap-pbc`
- Surface: `recipe:env-down`
- Surface: `recipe:env-up`
- Surface: `recipe:info`
- Surface: `recipe:install`
- Surface: `recipe:install-hrc-viewer-launchd`
- Surface: `recipe:install-log-rotation`
- Surface: `recipe:launchd-install`
- Surface: `recipe:launchd-uninstall`
- Surface: `recipe:lint`
- Surface: `recipe:lint-fix`
- Surface: `recipe:publish-dev`
- Surface: `recipe:publish-dev-dry-run`
- Surface: `recipe:publish-worktree`
- Surface: `recipe:publish-worktree-dry-run`
- Surface: `recipe:pull-deps`
- Surface: `recipe:rebuild`
- Surface: `recipe:serve-dashboard`
- Surface: `recipe:test`
- Surface: `recipe:test-integration`
- Surface: `recipe:typecheck`
- Surface: `recipe:verify`
- Surface: `recipe:verify-feature-map`
- Surface: `recipe:wrkq-refactor`

## How to get to it

Use `just --list`, `git config --get core.hooksPath`, and source plist/workflow inspection. Read build_deploy_guide.md before any build.

## Driving it

Run `just verify-feature-map` (structural check) and `bun scripts/verify-feature-map.ts --self-test` (isolated missing-feature/invalid-map rejection). Run `ASP_PROJECT=agent-control-plane just verify` for the full owned gate; preserve existing gate order and normal git hooks. Installed `acp --help` is read-only surface evidence.

## Gotchas

Owner controls install and service lifecycle. Do not run install, bootstrap/bootout, GUI launch, service restart or fleet promotion from this skill. Do not unset harness guards to force a daemon boot. No synthetic verify.upkeep facts or schedules.

## Proven when

Record exact gate exit and logs plus pushed source SHA. Installed SHA must be separately observed, or explicitly unknown/uninstalled. File coverage proves only documented reachability, not installed plist/restart/deployment correctness.
