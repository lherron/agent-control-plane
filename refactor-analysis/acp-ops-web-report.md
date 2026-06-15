# Refactor Analysis: `packages/acp-ops-web`

## Summary

**There is no source to refactor.** The package directory `packages/acp-ops-web/`
contains only an untracked `node_modules/` directory. It has:

- **Zero git-tracked files** (`git ls-files packages/acp-ops-web/` → empty).
- **No `package.json`**, no `src/`, no `index.ts`, no exports, no config.
- Only a stale `node_modules/` with symlinks to sibling workspaces
  (`acp-ops-projection`, `acp-ops-reducer`) and hoisted deps (`react`,
  `pixi.js`, `zustand`, `vite`, etc.) plus an empty `.vite-temp/`.

The package's source was **ported out into `acp-viewer`**. Two files in
`acp-viewer` document this verbatim:

- `packages/acp-viewer/src/features/sessions/lib/empty-snapshot.ts:3`
  — "Ported from acp-ops-web/src/api/snapshot.ts."
- `packages/acp-viewer/src/features/sessions/store/use-reducer-store.ts:20`
  — "Ported verbatim from acp-ops-web/src/store/useReducerStore.ts".

What remains is a **dead package shell**: an empty directory whose `node_modules`
was never cleaned up after the code was moved.

This is therefore not a refactoring target. It is a cleanup / hygiene item, and
the only finding is the removal of the residue. No characterization tests
([T40]) are possible or warranted because there is no public surface and no
behavior to preserve.

## Public boundary (assessed first)

**Verdict: N/A — no public boundary exists.**

There is no `index.ts`, no `package.json` `exports`/`main` field, and nothing
git-tracked. The only thing in the tree is `node_modules/` (untracked,
build-time residue). There is no module surface for any consumer to import, and
indeed no consumer imports `acp-ops-web` — the live consumer (`acp-viewer`)
holds its own copies of the ported code.

The lone lingering reference is in tooling, not code:
`scripts/check-boundaries.ts:60` still lists the string `'acp-ops-web'` in its
allowed-packages set. That entry is now orphaned.

## Findings by mechanism

Because there is no source, none of the mechanism-first techniques (T01–T40)
apply to code inside this package. The package-type profile is effectively
**leaf with no consumers** — which under the rules means "drop M02" and, taken
to its conclusion here, drop the package.

### Finding 1 — Remove dead package residue (T16 collapse premature/dead structure)

- **Location:** `packages/acp-ops-web/` (entire directory; only
  `packages/acp-ops-web/node_modules/` and `node_modules/.vite-temp/` exist on
  disk, all untracked).
- **Technique:** [T16] collapse premature abstraction / de-abstract — here in
  its strongest form: remove structure (an entire package placeholder) whose
  reason to exist has already migrated elsewhere.
- **Mechanism repaired:** Eliminates a phantom workspace whose code was ported
  into `acp-viewer`. The leftover `node_modules` symlinks (e.g. to
  `acp-ops-projection`, `acp-ops-reducer`) imply a dependency-graph edge that no
  longer corresponds to any tracked module, which is misleading to humans and to
  workspace tooling.
- **Direction:** remove.
- **Preservation rung:** No observable behavior exists to preserve (no exports,
  no consumers, nothing tracked). Removal of an untracked, empty directory
  cannot change build/test output.
- **Falsifiable signal:** `git ls-files packages/acp-ops-web/` returns empty;
  `grep -r "acp-ops-web" --include='*.ts' --include='*.json' --exclude-dir=node_modules`
  finds only a tooling allow-list entry plus two "Ported from" comments — no
  `import` from the package. Therefore deleting the directory breaks no build.
- **Risk:** Low.
- **API-impact:** internal-only (in fact, no API at all).
- **Effort:** trivial (`rm -rf packages/acp-ops-web`).
- **Tests:** none required; a full workspace build/typecheck after removal
  confirms nothing referenced it.
- **Contraindication:** If repo policy intends to repopulate this package soon
  (i.e. the empty dir is a deliberate reservation), leave it. Confirm with the
  owner before deleting, since deletion of an untracked dir is not itself
  captured by git history. **This action exceeds behavior-preserving auto-apply
  (it deletes a workspace directory) and is flagged for human decision, not
  auto-applied.**

### Finding 2 — Orphaned allow-list entry in boundary tooling (T07 align interface to actual usage)

- **Location:** `scripts/check-boundaries.ts:60` (`'acp-ops-web'` in the
  allowed-packages list).
- **Technique:** [T07] align interface to actual usage — the allow-list still
  advertises a package that no longer exists as a tracked module.
- **Mechanism repaired:** Removes a stale name from a configuration set so the
  boundary checker's surface matches the actual set of packages.
- **Direction:** remove.
- **Preservation rung:** Changing this script's data set alters tooling
  behavior, not product behavior. It must be validated by running the boundary
  checker, because removing a name could change what the checker permits/flags.
- **Falsifiable signal:** After removal, `scripts/check-boundaries.ts` still
  passes and no other file references `'acp-ops-web'`.
- **Risk:** Med (it edits live tooling logic/config, so it can change
  check-boundaries output; must be paired with Finding 1).
- **API-impact:** internal-only (build tooling).
- **Effort:** trivial.
- **Tests:** run the boundary check script before and after; confirm identical
  result modulo the now-absent package.
- **Contraindication:** Do not remove this entry while the directory still
  exists, or the checker may newly flag the residual `node_modules`. Sequence it
  after (or with) Finding 1. **Couples to a directory deletion that needs human
  sign-off; defer.**

## Deliberately left alone (where NOT to act)

- **`node_modules/` symlinks themselves** — not edited; they are regenerated
  build residue, irrelevant once the parent dir is removed.
- **The two `acp-viewer` "Ported from acp-ops-web" comments**
  (`empty-snapshot.ts:3`, `use-reducer-store.ts:20`) — these are accurate
  historical provenance notes in a *different* package. Rewriting them is a
  cosmetic edit outside this package's scope; the porting itself is the correct,
  already-completed state. Leave them as-is (or let the `acp-viewer` analyst
  decide).
- **No T15/T19/T12/T18/etc. findings** — there is no code in which a magic
  number, swallowed catch, growing switch, or illegal state could live. Any
  such "finding" would be fabricated.

## If applying: outside-in sequence

1. Confirm with the package owner that `acp-ops-web` is intentionally retired
   (the "Ported from" comments in `acp-viewer` are strong evidence it is).
2. Remove the residual `node_modules`/empty directory: `rm -rf packages/acp-ops-web`.
3. Remove the orphaned `'acp-ops-web'` entry at `scripts/check-boundaries.ts:60`.
4. Run the workspace install + full build/typecheck + the boundary checker to
   confirm nothing referenced the package.

## Safety checklist

- [ ] Verified zero git-tracked files in the package (`git ls-files`).
- [ ] Verified no `import` of `acp-ops-web` anywhere (grep, excluding
      node_modules) — only a tooling allow-list entry + provenance comments.
- [ ] Owner confirms the package is retired, not reserved for imminent reuse.
- [ ] Directory removal and `check-boundaries.ts` edit done together.
- [ ] Full workspace build/typecheck + boundary check green after removal.
- [ ] Note: directory is untracked, so its deletion will not appear in
      `git diff` — record the cleanup in the commit message manually.
