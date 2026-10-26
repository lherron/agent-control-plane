---
name: verify-agent-control-plane
description: Verify ACP capabilities using the project feature map, owned scratch services and explicit evidence limits. Use for ACP feature verification and coverage upkeep; service installation and activation remain owner controlled.
---

# Verify agent-control-plane

## Launch

Work from the agent-control-plane checkout. Read its AGENTS.md and `~/praesidium/build_deploy_guide.md` before building. Select the relevant [feature map](features/README.md); read only the families under test. The resident owns workflow/config/measurement/completion and install/service lifecycle. This skill grants no production mutation or external messaging authority.

For an owned scratch session, use `ACP_DEV_ENV_ROOT=/tmp/acpv-<unique-id> bash scripts/dev-env.sh run -- <command>` from the repository root. Use a fresh short root, never an existing/shared root. The wrapper provisions scratch HRC, ACP, agents, DBs and port, then reaps them. It runs source ACP with installed HRC/wrkq substrate; it does not prove a deployed ACP revision. Never bypass a harness boot guard; report the exact refusal and use an authorized runner.

## Doctor

Inspect `acp --help`, `hrc server status --json` (retain only release sourceCommit/version fields), `bun --version`, `just --list` and `git rev-parse HEAD`. Keep installed version/SHA separate from source SHA; unknown installed provenance stays unknown. Do not print credentials or whole environment dumps.

Check that all DBs, sockets, assets, agents and catalog state resolve beneath the fresh scratch root and ACP uses its allocated loopback port, never 18470. dev-env's scratch `hrc server serve` posts `server.started`/`server.stopped` to the `hrc-runtime` timeline of whatever wrkq it resolves: `HRC_WRKQ_DB`, else `WRKQ_DB`, which Bun auto-loads from the checkout's untracked `.env.local` (live) when the real env lacks it. Unsetting is therefore not enough. Launch every wrapper, including `just verify`, as `env -u HRC_WRKQ_DB -u HRC_WRKQD_TOKEN_FILE WRKQ_DB=<fresh /tmp scratch dir>/wrkq.db …`, and afterwards confirm no new `server.started` for your scratch HRC pid in `wrkp log hrc-runtime --type server.started`. Without that redirect T-11918 posted three false max3 start facts. Review inherited config before boot: no production bot credentials, enabled schedules, reconciler node, hooks, recipients or primary ledger scope. If the requested path lacks a proven scratch override, block that drive and state the missing isolation boundary. Do not substitute a live server or ledger to make a gate pass.

## Drive

Run `just verify-feature-map` for structural coverage and `bun scripts/verify-feature-map.ts --self-test` for isolated rejection cases. These checks do not drive features.

Use `ACP_DEV_ENV_ROOT=/tmp/acpv-<unique-id> bash scripts/dev-env.sh run -- bun scripts/verify-acp-scratch.ts` for the narrow real HTTP/CLI/admin SQLite drive. The helper refuses absent/non-scratch state and production port; it records project create/read/conflict/missing plus HTTP health/unknown route. It uses source CLI and explicit scratch actor/project. Keep all fixtures and generated evidence outside this skill directory. The helper writes evidence under the scratch root; copy the report to an artifact directory outside the checkout before wrapper teardown, for example by running a small shell command that invokes the helper then copies `$ACP_DEV_ENV_ROOT/verify-evidence.json` to a preselected artifact path.

Run `ASP_PROJECT=agent-control-plane just verify` for the canonical owned gate. Do not weaken or reorder gates, put verify back in hooks, or bypass normal hooks. Other family drives and failure cases are documented in [features](features/README.md). Discord/mobile/auth/jobs/mail/viewers require their own real-path evidence; the helper's health response cannot stand in for it.

## Evidence

Retain exact command, exit code, timestamp, source SHA, separately observed installed SHA/version, scratch root/port and response shape/status. Correlate feature assertions with durable scratch records or rendered artifacts. Label each result **proven** (name the narrow behavior), **undriven** (name the prerequisite), or **source-only** (structural/static/suite evidence). A green aggregate gate never upgrades undriven maps to proven.

Return the pushed installation commit SHA and zero-exit gate evidence to the resident. Say explicitly if the installation commit has not been installed; only the owner performs that lifecycle. Do not fabricate verify.upkeep facts or author schedules; upkeep standup is separately approved.

## Cleanup

Prefer the owning `dev-env.sh run` wrapper, whose EXIT trap reaps its registered processes and root. Copy evidence out before exit. On interrupted manual provisioning, use the same explicitly owned root with `bash scripts/dev-env.sh down` only after verifying its process registry belongs to this run. Never kill a live daemon or manipulate launchd. Report cleanup failure rather than claiming isolation.

## Helpers

Repo-relative executable helpers used here:

- `scripts/verify-feature-map.ts`: source inventory, map/index/link checks; `--inventory`, `--self-test`, and `--map-root <scratch-copy>` for isolated map validation. Reuse existing route/CLI/package discovery; does not read live DBs.
- `scripts/verify-acp-scratch.ts`: narrow real source CLI/HTTP/admin SQLite drive inside an already owned dev-env; refuses unsafe/missing overrides and writes scratch evidence.
- `packages/acp-cli/src/cli.ts`: source CLI used by the scratch helper; explicit server/actor/project overrides.
- `packages/wlearn/src/cli.ts`: local draft construction commands from the capabilities/learning map; no activation.
- `scripts/dev-env.sh`: existing owned scratch provisioning/teardown; use `run --` instead of leaving daemons running.
- `scripts/discover-acp.ts`: source surface lookup (`packages`, `cli`, `routes`, `all`). `adoption` requires explicit scratch DB path overrides for all three stores; defaults address live data.

The documented gate is `just verify-feature-map`; [map index](features/README.md) explains the inventory boundary and manual coverage limits.
