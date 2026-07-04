# Local Git Hooks

ACP uses Lefthook as a local handoff gate for commits and pushes.

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
The committed `.githooks/pre-commit` and `.githooks/pre-push` wrappers invoke
`node_modules/.bin/lefthook` and exit non-zero if the local Lefthook binary is
missing. A fresh clone must not rely on Git's sample hooks or an unmaterialized
`lefthook.yml`.
