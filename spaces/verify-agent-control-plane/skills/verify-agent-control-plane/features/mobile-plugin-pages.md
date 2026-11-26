# Mobile plugin pages

## Sub-features

ACP serves plugin pages to HRC Mobile's drawer and relays the pages' kernel calls (T-14125; the manifest schema is Loggia's `schemas/plugin-mobile.schema.json`, and the plugin-page rulings, including the ordinary bearer class, are in hrc-ios `docs/ios-app.md` § Plugin pages). ACP is the transport only. Loggia owns the manifest's meaning, the phone builds whole cardo wire requests, and the installed `cardo` CLI carries them.

- Catalog (`GET /v1/mobile/plugins`):
  - Reads plugin roots from Loggia's `~/Library/Application Support/Loggia/config.json` key `plugins.roots` on every request. There is no cache.
  - Validates each page of each plugin.json `mobile` block against `~/praesidium/loggia/schemas/plugin-mobile.schema.json`, read live with ajv 2020. A bad page is refused alone and logs `plugin.page_refused`.
  - Each allowlisted op carries `{holds, timeout, deadlineSeconds}` from `registry.discover`.
- Bundle (`GET …/pages/:page`): `{schema: 1, files: {path: base64}, revision}`, from `<plugin directory>/mobile/pages/<name>/`.
  - The plugin directory is the one that holds plugin.json.
  - Symlinks are followed only inside the plugin directory and served under the link's path.
  - A page is at most 1 MiB, targets included.
- Call relay (`POST …/call`): checks the request against the allowlist, then runs `cardo <mount>[@owner][/graph] request -`, and the reply line passes through byte for byte.
  - The mount is taken from the front of the address. `ui` and `cardo-ui` are never addressable.
  - `graph.query`, `query.subscribe` and `registry.discover` are always allowed. Any other op needs the page's `ops`.
  - Exit 7, or a backstop kill at the CLI deadline plus 5 s, answers 504 `timeout` with `outcome: unknown`. Exit 3 answers 504 `timeout`. Exit 75 answers 503 `mount_unavailable`.
  - A write is never resent.
- Subscriptions: `plugin.subscribe` and `plugin.unsubscribe` frames on the dashboard socket (`/v1/mobile/dashboard` and `/v2/mobile/dashboard`; those socket paths are inventoried in the interfaces map).
  - Each subscription is one `cardo … watch --args - --raw --for 86400` child.
  - The child is killed on unsubscribe or socket close.
- Asset proxy (`GET|HEAD …/asset/*ref`): a streaming, Range-capable hop to the page's loopback `assets.origin` + `prefix`, through `loopback-upstream.ts`, the guard shared with Jobhunt.
  - A `ref` whose normalised path leaves the prefix is 400 `invalid_asset_ref`.
  - Only Range and the conditional headers are forwarded. The principal is `user:lance`.
  - No cookies or Authorization in either direction. Responses are `no-store`.
- Admission is the ordinary mobile `bearer` class (Lance's F1 ruling).

Source anchors (repo-relative): packages/acp-server/src/handlers/mobile-plugins.ts; packages/acp-server/src/handlers/mobile-plugin-ws.ts; packages/acp-server/src/plugin-pages; packages/acp-server/src/loopback-upstream.ts; packages/acp-server/test/plugin-pages. Exact tracked surface inventory follows; a mapping is not a behavioral assertion.

- Surface: `route:GET /v1/mobile/plugins @ packages/acp-server/src/routing/exact-routes.ts`
- Surface: `route:GET /v1/mobile/plugins/:plugin/pages/:page @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:GET /v1/mobile/plugins/:plugin/pages/:page/asset/*ref @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:HEAD /v1/mobile/plugins/:plugin/pages/:page/asset/*ref @ packages/acp-server/src/routing/param-routes.ts`
- Surface: `route:POST /v1/mobile/plugins/:plugin/pages/:page/call @ packages/acp-server/src/routing/param-routes.ts`

## How to get to it

Call the routes on ACP's listener from a loopback peer, or with a paired-device bearer when enforcement is on. Pages exist only where an installed plugin declares `mobile`. On max3 today those are `jobhunt:pipeline` (mount `jobhunt`) and `signal-pipeline:read-aloud` (mount `signal-pipeline`, assets on `http://127.0.0.1:18551`). ACP spawns `~/.cargo/bin/cardo` by fixed path, because launchd's PATH lacks it, and the CLI resolves mounts from `~/praesidium/var/run/cardo/kernels/<mount>.json`.

## Driving it

Source behaviour: `bun test packages/acp-server/test/plugin-pages` runs the real router and the dashboard-socket handler against a fake `cardo` executable, fixture plugin roots, a stand-in schema and a fake Range origin.

Installed, through jobhunt's real page: `bun ~/praesidium/var/wrkq-artifacts/T-14125/live-relay.ts --base http://127.0.0.1:18470` checks:
- the catalog and the bundle revision;
- the `hunt.pipeline` relay, byte-identical to `cardo jobhunt request`;
- `op_not_allowed` with no kernel call, and the mount refusals;
- a subscribe diff.

Its read steps make no write. The subscribe step makes one `tracker.touch {"job_id": null}` on jobhunt's singleton tracker, sanctioned by jobhunt's owner for at most 5 runs a day. Pass `--skip-subscribe` to stay read-only.

Isolated: `~/praesidium/var/wrkq-artifacts/T-14125/run-isolated.sh` boots acp-server on :18479. It uses a throwaway HOME whose Loggia config lists Lance's real roots plus a fixture `assets` page, symlinks `~/praesidium` and `~/.cargo`, and points wrkq and HRC at scratch paths. That covers the asset Range and `..` steps, but its relay steps still call the live jobhunt kernel (`hunt.pipeline`, a read). It is not a scratch-only drive.

Scratch, fail-closed only (T-14448): the catalog, schema and `cardo` resolve from HOME, not from an override. A dev-env acp-server therefore reads the real Loggia roots, and its relay reaches live kernels. Never call these routes on it. Boot a second source acp-server inside the owned root instead: `env -i` with a throwaway HOME holding a fixture-only Loggia config, a copy of the schema and a symlink to the real `cardo` binary only (`cardo ls --all` under that HOME prints `mounts: []`), the asset origin on refused `127.0.0.1:9`, every DB under the root and no HRC. Read its exec-time environment before calling. There, these answers were observed:
- the catalog lists only the fixture page, with its mount `available: false`;
- a schema-invalid page logs `plugin.page_refused` and its bundle is 404 `page_not_found`, the same as an unknown page;
- `graph.query` and a listed op on the absent mount answer 503 `mount_unavailable` with `sent: false` (real `cardo` exit 75);
- an unlisted op is 403 `op_not_allowed`; an unlisted mount, `ui` and `cardo-ui:ui` are 403 `mount_not_allowed`; a non-object body is 400 `invalid_request`;
- a `..%2F` asset ref is 400 `invalid_asset_ref`, and GET or HEAD on a refused origin is 503 `asset_unavailable`.

That proves admission, the allowlist and the refusal envelopes only. A relayed reply, a subscription and a served asset still need the owner-sanctioned paths above.

## Gotchas

- An isolated acp-server without HRC cannot host `plugin.subscribe`. Its dashboard stream fails with `hrcClient not configured` and the socket closes 1011, which also kills every subscription on it.
- Bun auto-loads the checkout's `.env.local` (live wrkq on mini). Override `WRKQ_DB` in any probe.
- `cardo watch` refuses to run without `--for`. A subscription that reaches 24 h closes with reason `exited`.
- A missing loggia checkout or schema file fails the catalog for every page.
- Each listed op's first call on a mount spawns one `registry.discover` to learn its deadline. After that, discovery is cached and refreshed by each catalog read.

## Proven when

The plugin-pages test files pass. On the installed server, `live-relay.ts` exits 0 against a live jobhunt kernel and jobhunt's installed Pipeline page. That proves the catalog, the bundle, the verbatim relay, the allowlist and the subscribe lifecycle for that page and mount only.

The asset proxy is proven by the isolated run against a fixture origin. Against the real read-aloud origin, only a pass-through 404 and the `..` refusal have been observed. Playing a ready item needs signal-pipeline's T-14121.

Phone-side behaviour (the shim mapping, CSP and drawer) is hrc-ios's to prove, not ACP's.
