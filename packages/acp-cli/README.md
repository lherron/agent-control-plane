# acp-cli

Installed operator CLI for ACP admin, runtime, coordination, task, job,
delivery, and conversation inspection through `acp-server`.

Start or verify the server first:

```bash
acp server status --json
```

The default server URL is `http://127.0.0.1:18470`; override it with
`ACP_SERVER_URL` or `--server`.

## Command Families

Use `acp --help` and subcommand help for full flag details. Current top-level
families include:

- `acp task show|timeline|transition|run|run-complete`
- `acp task evidence add`
- `acp task obligation waive|cancel`
- `acp admin interface binding list|set|disable|lint`
- `acp admin contributions reconcile`
- `acp agent create|list|show|patch`
- `acp project create|list|show|default-agent`
- `acp membership add|list`
- `acp interface identity register|list`
- `acp system-event push|list`
- `acp runtime resolve`
- `acp session resolve|list|show|runs|reset|interrupt|capture|attach-command`
- `acp run show|cancel`
- `acp run attachment add|list|clear`
- `acp send`, `acp tail`, `acp render`
- `acp message send|broadcast`
- `acp job validate|create|list|show|patch|run`
- `acp job-run list|show|wait`
- `acp heartbeat set|wake`
- `acp delivery retry|list-failed`
- `acp thread list|show|turns`
- `acp server ...`

The obsolete ACP-authoritative workflow commands were removed:
`acp task create`, `acp workflow publish|supervise|supervisor-context|interact|action`,
`acp workflow patch list|show`, and the `acp supervise` alias.

## Workflow Task Commands

The task lifecycle commands are wrappers over the running ACP server's
wrkf-backed task routes.

Show a task:

```bash
acp task show --task <taskId> --json
```

Apply a transition:

```bash
acp task transition \
  --task <taskId> \
  --transition <transitionId> \
  --role <role> \
  --idempotency-key <key> \
  --as agent:<agentId> \
  --json
```

Start a participant run:

```bash
acp task run \
  --task <taskId> \
  --role <role> \
  --agent <agentId> \
  --idempotency-key <key> \
  --scope-ref agent:<agentId>:project:<projectId>:task:<taskId> \
  --lane-ref main \
  --json
```

Complete a participant run:

```bash
acp task run-complete \
  --run <runId> \
  --outcome success \
  --summary "done" \
  --as agent:<agentId> \
  --json
```

Attach evidence:

```bash
acp task evidence add \
  --task <taskId> \
  --kind <kind> \
  --ref <ref> \
  --role <role> \
  --as agent:<agentId> \
  --idempotency-key <key> \
  --json
```

The CLI still accepts some compatibility flags from the old ACP-kernel era.
The server's current wrkf-backed evidence route only forwards wrkf evidence
fields (`task`, `kind`, `ref`, `actor`, optional `summary`, optional `facts`,
optional `role`).

Waive or cancel obligations:

```bash
acp task obligation waive \
  --task <taskId> \
  --obligation <obligationId> \
  --reason "covered by policy" \
  --idempotency-key <key> \
  --json

acp task obligation cancel \
  --task <taskId> \
  --obligation <obligationId> \
  --reason "superseded" \
  --idempotency-key <key> \
  --json
```

## Seed Agent Profiles

Run the one-shot profile seed directly with Bun:

```bash
bun run packages/acp-cli/src/seed/seed-agent-profiles.ts
```

The seed reads profile data from
`packages/acp-cli/src/seed/agent-profile-seed.ts`, patches existing admin
agents in `ACP_ADMIN_DB_PATH` (default:
`/Users/lherron/praesidium/var/db/acp-admin.db`), and copies available PFPs
from `packages/acp-viewer/public/pfp/` into
`<ACP_AGENT_ASSETS_DIR>/agents/<agentId>/pfp.png`.

After the first seed run, the admin DB is the runtime source of truth for agent
profiles.

## Environment

- `ACP_SERVER_URL`: overrides the server base URL.
- `ACP_ACTOR_AGENT_ID`: fallback actor id for write commands when `--actor`,
  `--as`, or `--agent` is omitted.

Commands return JSON by default where the command is JSON-native. Use `--table`
on supported inspection commands for compact tabular output.
