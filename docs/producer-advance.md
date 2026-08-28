# Advancing ACP producer tuples

ACP follows Verdaccio `latest` only for `@wrkq/client`. ASP and HRC packages are pinned as operator-managed producer tuples because a producer's `just install` publishes a node-local set and moves `latest`; that side effect is not a release signal for ACP.

Advance a producer tuple only when ACP needs a producer source commit and a coordinated deployment window is available:

```bash
just advance-producers set=hrc version=latest --dry-run
just advance-producers set=hrc version=0.1.0-dev.YYYYMMDDHHMMSS
```

The dry run reads the anchor manifest from Verdaccio, derives the complete installed ASP/HRC membership from `praesidiumBuild`, verifies that every current member was published at the requested version, and prints the planned table, manifest, override, and lock movement without writing. A publisher's tuple remote is informational because node-local SSH aliases vary. The command instead resolves and fetches `main` from ACP's fixed canonical remote in `EXPECTED_CONSUMER_PRODUCERS`, then refuses unless the published source commit is contained by that branch. An unreachable canonical remote is a hard failure.

The real command refuses a dirty tracked tree. It rewrites the selected tuple identity and exact pins, resolves through an isolated Bun configuration, confines `bun.lock` to the selected producer set and its required new dependency closure, then relinks with `--frozen-lockfile`. If a new tuple-bearing package appears, it adds that package's override and repeats to a bounded fixpoint. It leaves the resulting diff uncommitted for review and landing.

## Coordinated deployment window

Treat the advance as one deployment operation:

1. Run the dry run and review the derived membership and source commit.
2. Run the real advance, review the exact manifest/table/lock diff, validate, commit, and push it.
3. On each ACP node, land the commit, run `just install`, restart ACP, and read `/v1/admin/deployment-coherence` from that node.
4. Continue only when every node reports `ok: true` and the intended installed/running source identities.

Never use `just pull-deps`, routine `just install`, producer `sync-downstream`, or a moving `latest` tag to advance ASP/HRC. `just check-deps` and `just install` print `PRODUCER_PINNED` advisory lines so registry movement remains visible without changing the deployed tuple.
