# acp-cli

User-facing ACP CLI for ACP admin, runtime, coordination, tasks, jobs, deliveries, and conversation inspection through `acp-server`.

Start `acp-server` locally first, then point the CLI at it (or rely on the default URL).

## Commands

- `acp runtime resolve`
- `acp session resolve|list|show|runs|reset|interrupt|capture|attach-command`
- `acp run show|cancel`
- `acp send`
- `acp tail`
- `acp render`
- `acp message send|broadcast`
- `acp job create|list|show|patch|run`
- `acp job-run list|show`
- `acp heartbeat set|wake`
- `acp delivery retry|list-failed`
- `acp thread list|show|turns`
- `acp task create`
- `acp task promote`
- `acp task show`
- `acp task evidence add`
- `acp task transition`
- `acp task transitions`

## Environment

- `ACP_SERVER_URL` — overrides the server base URL. Default: `http://127.0.0.1:18470` (`acp-server`)
- `ACP_ACTOR_AGENT_ID` — fallback actor id for write commands when `--actor` is omitted

## Smoke test

```bash
bun run packages/acp-cli/src/cli.ts --help
bun run packages/acp-cli/src/cli.ts session attach-command --help
bun run packages/acp-cli/src/cli.ts message send --help
bun run packages/acp-cli/src/cli.ts job list --help
bun run packages/acp-cli/src/cli.ts task create --help
bun run packages/acp-cli/src/cli.ts task promote --help
```

## Notes

- Commands return JSON by default. Pass `--table` on the new runtime / coordination / jobs / thread commands for compact tabular output.
- `acp heartbeat set` upserts an agent heartbeat and `acp heartbeat wake` triggers the matching admin wake route.
- `--json` prints the parsed response body as JSON. For `evidence add`, the server currently returns `204 No Content`, so `--json` prints `null`.
- `acp task evidence add --meta <json>` maps the JSON object into the evidence item's `details` field.
