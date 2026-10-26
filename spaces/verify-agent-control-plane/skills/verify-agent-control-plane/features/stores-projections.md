# Stores and projections

## Sub-features

Admin, conversation, interface, jobs, state and coordination SQLite stores; operator reducer/projection, dashboard and HRC terminal viewer.

Source anchors (repo-relative): packages/acp-state-store/src; packages/acp-ops-projection/src; packages/acp-ops-reducer/src; packages/acp-viewer; packages/hrc-viewer. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `cli:acp render [--actor --json --lane-ref --project --scope-ref --server --session --source --table]`
- Surface: `cli:acp tail [--actor --from-seq --json --lane-ref --project --scope-ref --server --session --table]`
- Surface: `package:acp-admin-store`
- Surface: `package:acp-jobs-store`
- Surface: `package:acp-ops-projection`
- Surface: `package:acp-ops-reducer`
- Surface: `package:acp-state-store`
- Surface: `package:acp-viewer`
- Surface: `package:coordination-substrate`
- Surface: `package:hrc-viewer`
- Surface: `package:wrkq-lib`
- Surface: `route:GET /v1/ops/session-dashboard/events @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/ops/session-dashboard/snapshot @ packages/acp-server/src/routing/exact-routes.ts`

## How to get to it

Use `bun scripts/discover-acp.ts packages --json`; source discovery does not open live stores. For adoption, always set ACP_JOBS_DB_PATH, ACP_STATE_DB_PATH and ACP_INTERFACE_DB_PATH to owned scratch paths.

## Driving it

Scratch helper project create/show crosses real admin SQLite persistence and reopens the DB read-only to verify the row. Use `just verify` for other store migrations/reducer/redaction suites. GUI/terminal viewer rendering requires an owner-approved isolated preview; do not launch a naked viewer command.

## Gotchas

Never run adoption with defaults: it opens production DBs read-only and would mix scratch evidence with live state. Ops empty events do not imply rendering failure. Source projections are not a browser or terminal render proof.

## Proven when

Admin row and source helper records prove the project persistence slice. Other stores, dashboards/redaction and viewer rendering remain manually undriven; capture migration state, ordered projection and a real preview artifact for future proof.
