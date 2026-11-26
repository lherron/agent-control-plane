# Advancing ACP producer tuples

ACP follows Verdaccio `latest` only for `@wrkq/client`. ASP and HRC packages are pinned as operator-managed producer tuples. ASP publication can move `latest` through its own publish lifecycle; HRC `latest` moves only when the canonical max3 release lane runs `just publish` after installing and reading back its selected release. Neither event is a release signal for ACP.

Advance a producer tuple only when ACP needs a producer source commit and a coordinated deployment window is available:

```bash
just advance-producers set=hrc version=latest --dry-run
just advance-producers set=hrc version=0.1.0-dev.YYYYMMDDHHMMSS
just advance-producers asp=latest hrc=latest --dry-run
```

Use the paired `asp=… hrc=…` form when both sets are stale: it rewrites both tuples before one confined install, whereas advancing one set alone leaves the other's dead pins in the graph.

Both the dry run and the real command refuse a dirty tracked tree. The dry run reads the anchor manifest (`agent-spaces` or `hrc-core`) from Verdaccio, derives the complete installed ASP/HRC membership from `praesidiumBuild`, verifies that every current member was published at the requested version with the anchor's tuple, and prints one `PRODUCER_MEMBERS` line per set and one `PRODUCER_PLAN` line per requested set (current and target version and source commit, tuple remote, members). It writes nothing and does not compute the manifest or lock diff. A publisher's tuple remote is informational because node-local SSH aliases vary. The command instead resolves and fetches `main` from ACP's fixed canonical remote in `EXPECTED_CONSUMER_PRODUCERS`, then refuses unless the published source commit is contained by that branch. An unreachable canonical remote is a hard failure.

The real command rewrites the selected tuple identity in `packages/acp-server/src/deployment-coherence.ts` and the exact pins and root overrides, resolves through an isolated Bun configuration, confines `bun.lock` to the selected producer sets and their required new dependency closure, then relinks with `--frozen-lockfile`. If a new tuple-bearing package appears, it adds that package's override and repeats, failing after three install passes without a fixpoint. It then prunes overrides for members no longer installed, refuses unrelated lock selection changes or edits outside `bun.lock`, the package manifests and the tuple table, and runs the consumer deployment coherence check. Any failure restores the snapshotted files and dependencies. On success it leaves the diff uncommitted for review and landing.

## Coordinated deployment window

Treat the advance as one deployment operation:

1. Run the dry run and review the derived membership and source commit.
2. Run the real advance, review the exact manifest/table/lock diff, validate, commit, and push it.
3. On each ACP node, land the commit, run `just install`, have Mable primary activate it with `acp server restart`, and read `/v1/admin/deployment-coherence` from that node.
4. Continue only when every node reports `ok: true` and the intended installed/running source identities.

Never use `just pull-deps`, routine `just install`, producer `sync-downstream`, or a moving `latest` tag to advance ASP/HRC. An HRC release selected locally but not published cannot be advanced, and HRC deploys to svc or hrcdev do not advance shared latest. `just check-deps` and `just install` print `PRODUCER_PINNED` advisory lines so registry movement remains visible without changing the deployed tuple.
