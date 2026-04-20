# acp-cli

User-facing ACP CLI for creating tasks, promoting wrkq tasks, rendering task context, attaching evidence, and applying transitions through `acp-server`.

Start `acp-server` locally first, then point the CLI at it (or rely on the default URL).

## Commands

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
bun run packages/acp-cli/src/cli.ts task create --help
bun run packages/acp-cli/src/cli.ts task promote --help
```

## Notes

- `--json` prints the parsed response body as JSON. For `evidence add`, the server currently returns `204 No Content`, so `--json` prints `null`.
- `acp task evidence add --meta <json>` maps the JSON object into the evidence item's `details` field.
