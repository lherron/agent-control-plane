---
id: agent-control-plane/operations-runbook
title: ACP Operations Runbook
kind: runbook
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# ACP operations runbook

Operational doctrine for running, restarting, and inspecting the local
`acp-server` process and its embedded gateways.

## Server lifecycle

`acp-server` runs under launchd as `com.praesidium.acp-server` (source plist
`launchd/com.praesidium.acp-server.plist`, installed to
`~/Library/LaunchAgents/com.praesidium.acp-server.plist`). The `acp` binary
itself is `bun link`ed from `packages/acp-cli`; `just install` rebuilds,
republishes the ACP package set, and updates the main-checkout links — it
does **not** reload launchd on its own.

Standard restart doctrine:

```bash
just install
acp server restart
acp server status
```

`acp server restart` (`packages/acp-cli/src/server-runtime.ts`,
`runServerCommand`) detects whether the process is launchd-supervised. If it
is (the normal case here), it runs the equivalent of
`launchctl kickstart -k <serviceTarget>` and returns — launchd owns the
process lifecycle, so a plain `acp server stop` under launchd supervision is
refused with a pointer to `launchctl unload -w ~/Library/LaunchAgents/<label>.plist` for a real stop. If it is **not**
launchd-supervised (e.g. a manual foreground/daemon run for dev), `restart`
stops the tracked process by pid file and re-daemonizes it directly.

Other `acp server` subcommands:

- `acp server start [--foreground|--daemon]` — refuses to start if a daemon
  is already responsive at the configured endpoint; otherwise kickstarts the
  launchd service if supervised, else forks the process itself.
- `acp server stop [--timeout-ms <ms>] [--force]` — only meaningful when not
  launchd-supervised.
- `acp server status [--json]` — reports `running`, `pid`, `pidAlive`,
  `pidPath`, `endpoint`, `endpointResponsive`.
- `acp server health` — hits the endpoint and exits non-zero if unresponsive.
- `--no-discord` / env `ACP_DISABLE_DISCORD_GATEWAY=1` /
  `ACP_SERVER_NO_DISCORD=1` — start the HTTP server without the embedded
  Discord gateway.

Default endpoint `http://127.0.0.1:18470` (`ACP_HOST`/`ACP_PORT`; `ACP_HOST`
accepts a comma-separated bind-host list, e.g. `127.0.0.1,<tailnet-ip>` in
the shipped plist).

## Config and secrets

Most runtime config is plain environment variables baked into the launchd
plist's `EnvironmentVariables` dict (`ACP_HOST`, `ACP_PORT`,
`ACP_STATE_DB_PATH`, `ACP_INTERFACE_DB_PATH`, `ACP_COORD_DB_PATH`,
`ACP_RUNTIME_DIR`, `ACP_LOG_PATH`, `ACP_SCHEDULER_ENABLED`,
`ACP_REAL_HRC_LAUNCHER`, `HRC_RUNTIME_DIR`, `HRC_STATE_DIR`, `ASP_AGENTS_ROOT`,
`ASP_HOME`, `ASP_PROJECT`, job-flow-exec allowlist vars, etc.). These are
runtime contracts — do not rename them casually.

Discord secrets and channel routing come from **Consul KV**, with env always
taking precedence over Consul so a local override never needs a KV write:

- Bot token: `DISCORD_TOKEN` / `DISCORD_BLASTER_TOKEN` env, else Consul key
  named by `ACP_DISCORD_TOKEN_KV` (default
  `cfg/dev/_global/discord/master_token`), else
  `cfg/dev/_global/discord/blaster_token`. Missing both is a hard startup
  error for the Discord gateway.
- `#job-runs` channel: `ACP_DISCORD_JOB_RUNS_CHANNEL_ID` env, else Consul key
  named by `ACP_DISCORD_JOB_RUNS_CHANNEL_KV` (default
  `cfg/dev/_global/discord/job_runs_channel_id`). Unset disables the
  job-lifecycle Discord egress.
- `#work-activity` channel: `ACP_DISCORD_WORK_ACTIVITY_CHANNEL_ID` env, else
  the equivalent `cfg/dev/_global/discord/work_activity_channel_id` Consul
  key. Unset disables only that egress.
- Virtu test-bot token (for scripted Discord testing, not production):
  `cfg/dev/_global/discord/virtu_bot_token`, read directly by
  `scripts/virtu-send.sh`.

Read any Consul value manually with `consul kv get <key>`.

## Logs

- Launchd-managed stdout/stderr: `/Users/lherron/praesidium/var/logs/acp-server.{log,err.log}`.
- `ACP_LOG_PATH` (plist default `/Users/lherron/praesidium/var/logs/acp-server.log`)
  is the daemon's own fallback log when not launchd-supervised.
- `ACP_ACCESS_LOG_PATH` — optional Apache-combined access log; unset disables
  it.

## State databases

Default paths, each overridable by its own `ACP_*_DB_PATH` env var:

```
/Users/lherron/praesidium/var/db/acp-state.db
/Users/lherron/praesidium/var/db/acp-admin.db
/Users/lherron/praesidium/var/db/acp-interface.db
/Users/lherron/praesidium/var/db/acp-coordination.db
/Users/lherron/praesidium/var/db/acp-jobs.db
/Users/lherron/praesidium/var/db/acp-conversation.db
```

The task/workflow store is **not** among these — wrkq/wrkf own their own
database, located via `ACP_WRKQ_DB`/`WRKQ_DB` (or the legacy
`ACP_WRKQ_DB_PATH`/`WRKQ_DB_PATH`), reached through the shared
`@wrkq/client` process, not a local ACP SQLite file.

## Validating a change before calling it done

- `bun test tests/conformance/acp-workflow` — canonical ACP workflow kernel
  conformance suite; run before declaring any ACP work done.
- `bun run typecheck`, `bun run lint` (`lint:fix` to autofix),
  `bun run check:boundaries`, `bun run check:manifests`.
- `ASP_PROJECT=agent-control-plane just verify` — the full repository gate
  (suppression, boundary, manifest, CLI-surface, public-surface,
  enablement-changelog, lint, typecheck, and test gates). Setting
  `ASP_PROJECT` explicitly prevents ambient project context from selecting a
  different repository mid cross-repo validation.
- `bun scripts/discover-acp.ts <area> [query] [--json]` — live discovery of
  current routes, packages, CLI commands, and public-surface facts directly
  from the checked-out tree (`areas`: `routes`, `packages`, `cli`,
  `adoption`, `all`). Prefer this over trusting stale docs for exact
  route/command shapes.

For any change to Discord gateway behavior specifically, a real-Discord
smoke test (not a mocked client) is mandatory — see
[gateway-discord message flow](/docs/agent-control-plane/gateway-discord-message-flow).

## Git hooks

ACP uses Lefthook as a local commit/push gate. `just install` (or, for a
dependency-only bootstrap, `bun install && bun run install:hooks`) sets the
clone-local `core.hooksPath=.githooks`; the committed `.githooks/pre-commit`
and `.githooks/pre-push` wrappers invoke the local Lefthook binary and fail
if it's missing, so a fresh clone never silently falls back to Git's sample
hooks or an unmaterialized `lefthook.yml`.

## Scheduled jobs and flows

Cron/event-driven automations (exec detectors, probe gates, agent dispatch,
pulpit notifications) run on the ACP job engine
(`packages/acp-jobs-store` + `packages/acp-server/src/jobs`), ticked every 5
seconds when `ACP_SCHEDULER_ENABLED=1`. Jobs are authored as
`var/agents/<agent>/schedules/*.toml`, compiled with `asp resources plan`,
and applied with `acp admin managed-resource apply`. Full authoring/step
reference: `docs/ACP_JOBS_TASKS_USAGE.md` in the repo.
