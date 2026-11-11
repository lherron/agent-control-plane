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
- Surface: `recipe:install-mail-delivery`
- Surface: `recipe:install-mail-delivery-on`
- Surface: `recipe:install-mail-delivery-shadow`
- Surface: `recipe:launchd-install`
- Surface: `recipe:launchd-uninstall`
- Surface: `recipe:lint`
- Surface: `recipe:lint-fix`
- Surface: `recipe:mail-delivery-owner`
- Surface: `recipe:mail-delivery-owner-on`
- Surface: `recipe:publish-dev`
- Surface: `recipe:publish-dev-dry-run`
- Surface: `recipe:publish-worktree`
- Surface: `recipe:publish-worktree-dry-run`
- Surface: `recipe:pull-deps`
- Surface: `recipe:rebuild`
- Surface: `recipe:serve-dashboard`
- Surface: `recipe:test`
- Surface: `recipe:test-integration`
- Surface: `recipe:test-mail-delivery`
- Surface: `recipe:typecheck`
- Surface: `recipe:uninstall-mail-delivery`
- Surface: `recipe:uninstall-mail-delivery-shadow`
- Surface: `recipe:verify`
- Surface: `recipe:verify-feature-map`
- Surface: `recipe:wrkq-refactor`

## How to get to it

Use `just --list`, `git config --get core.hooksPath`, and source plist/workflow inspection. Read build_deploy_guide.md before any build.

## Driving it

Run `just verify-feature-map` (structural check) and `bun scripts/verify-feature-map.ts --self-test` (isolated missing-feature/invalid-map rejection). Run `ASP_PROJECT=agent-control-plane just verify` for the full owned gate; preserve existing gate order and normal git hooks. Installed `acp --help` is read-only surface evidence.

Run `just test-mail-delivery` for the opt-in standard-library Python policy, ownership and scoring tests in `programs/mail-delivery/tests` (`python3.14 -m unittest`). The local `install-mail-delivery` / `uninstall-mail-delivery` recipes copy/remove the kernel program, with `-shadow` aliases retained during cutover. Installation stages the manifest and Python sources plus generated wrkq pin and ACP provenance; it needs no daemon restart. With desired owner `injector` (the default), the program shadows. `just mail-delivery-owner` prints the row; with `injector` or `port` it changes desired ownership and waits up to 30 seconds for reporting, naming the holder PID on timeout. Delivery requires the shared exclusive SQLite lock on both sides; the command never opens that lock. For a satellite node without a current ACP checkout, `just install-mail-delivery-on <ssh-host>` refuses a dirty `programs/mail-delivery`, stages the committed sources and the wrkq pin source on that node over ssh, and runs the same installer there with this checkout's commit (`install.py --commit`); `just mail-delivery-owner-on <ssh-host> [owner]` runs the owner command from that node's installed tree. Both were used for the hrcdev and svc cutover on 2026-11-11; neither has an automated test beyond the installer's unit test. Installation and real-node flips remain operator-authorized rollout actions. Tests stay outside `just verify` and prove source behavior with fixtures; isolated scenario and installed acceptance are separate. See [the program README](../../../../../programs/mail-delivery/README.md) for acting/shadow behavior and scoring limits.

## Gotchas

Owner controls install and service lifecycle. Do not run install, bootstrap/bootout, GUI launch, service restart or fleet promotion from this skill. Do not unset harness guards to force a daemon boot. No synthetic verify.upkeep facts or schedules.

## Proven when

Record exact gate exit and logs plus pushed source SHA. Installed SHA must be separately observed, or explicitly unknown/uninstalled. File coverage proves only documented reachability, not installed plist/restart/deployment correctness.
