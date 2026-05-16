# GBrain Runtime Integration Plan

## Current Cody Setup

GBrain is installed from source at:

```text
/Users/lherron/tools/gbrain
```

The linked CLI resolves as:

```text
/Users/lherron/.bun/bin/gbrain
```

Cody's current brain paths are:

```text
GBRAIN_HOME=/Users/lherron/praesidium/var/state/gbrain/cody/home
BRAIN_REPO=/Users/lherron/praesidium/var/agents/cody/brain
```

`BRAIN_REPO` is a normal directory under the shared `var/agents` repo. It is not a
nested Git repo.

Current smoke status:

- `gbrain init` completed for Cody's `GBRAIN_HOME`.
- GBrain source `cody` points at `/Users/lherron/praesidium/var/agents/cody/brain`.
- `gbrain import /Users/lherron/praesidium/var/agents/cody/brain --no-embed` succeeds
  with 0 pages, as expected for an empty brain.
- `gbrain doctor --json` completed with warnings: empty brain, no embeddings yet, and
  OpenAI embedding quota exceeded.
- GBrain auto-selected `search.mode=tokenmax`; choose and set a different mode before
  real use if desired.

## Goal

Every agent launch should have a working, agent-specific brain runtime. Brain setup
must fail loudly if it cannot be prepared. All GBrain-specific behavior should live
behind one function so the brain provider can be replaced later without spreading
GBrain assumptions across launch code.

## Integration Boundary

Add a dedicated function:

```ts
prepareAgentBrainRuntime()
```

All GBrain-specific behavior belongs in this function.

Do not put GBrain logic in `prepareAgentToolRuntime()`. Tool runtime should remain
responsible only for `tools/bin`, `PATH`, and tool validation.

## Path Rules

For an agent root:

```text
<agentsRoot>/<agentName>
```

derive:

```text
BRAIN_REPO=<agentRoot>/brain
GBRAIN_HOME=<praesidiumRoot>/var/state/gbrain/<agentName>/home
```

For Cody:

```text
BRAIN_REPO=/Users/lherron/praesidium/var/agents/cody/brain
GBRAIN_HOME=/Users/lherron/praesidium/var/state/gbrain/cody/home
```

The Praesidium root can be derived from the conventional agents root layout:

```text
/Users/lherron/praesidium/var/agents/<agentName>
```

which maps to:

```text
/Users/lherron/praesidium/var/state/gbrain/<agentName>/home
```

For non-standard agent roots, fall back to:

```text
<agentRoot>/var/state/gbrain/home
```

## Runtime Behavior

`prepareAgentBrainRuntime()` should:

1. Accept `agentRoot`, optional `agentName`, and a base env/override env.
2. Preserve explicit env overrides:
   - If `GBRAIN_HOME` is provided, use it.
   - If `BRAIN_REPO` is provided, use it.
   - Still validate/create/init those explicit paths.
   - Never silently switch to the convention path when explicit values are present.
3. Create missing directories:
   - `BRAIN_REPO`
   - `GBRAIN_HOME`
4. Validate both paths are directories.
5. Detect whether GBrain is initialized by checking for:
   - `GBRAIN_HOME/.gbrain/config.json`
   - `GBRAIN_HOME/.gbrain/brain.pglite`
6. If uninitialized, run:

   ```bash
   GBRAIN_HOME=<home> gbrain init --pglite
   ```

7. Ensure the GBrain source named `<agentName>` points at `BRAIN_REPO`:

   ```bash
   GBRAIN_HOME=<home> gbrain sources add <agentName> --path <brainRepo>
   ```

   If the source exists but points elsewhere, remove and recreate it.

8. Return env to merge into the harness process:

   ```ts
   {
     GBRAIN_HOME: derivedOrExplicitHome,
     BRAIN_REPO: derivedOrExplicitBrainRepo,
   }
   ```

## Failure Policy

Fail loudly. Brain setup is not best-effort.

Throw if:

- `gbrain` is missing.
- `gbrain init --pglite` fails.
- source registration or source repair fails.
- `GBRAIN_HOME` is invalid.
- `BRAIN_REPO` is invalid.
- a path exists but is not a directory.

Do not silently continue with missing or broken brain state.

## Launch Wiring

Call `prepareAgentBrainRuntime()` anywhere an agent launch env is prepared:

- CLI run path:
  - `packages/execution/src/run/execute.ts`
- Agent Spaces client invocation path:
  - `packages/agent-spaces/src/client.ts`
- Agent Spaces SDK/session path:
  - `packages/agent-spaces/src/client.ts`
- HRC SDK adapter path:
  - `packages/hrc-server/src/agent-spaces-adapter/sdk-adapter.ts`

The launch flow should call both:

```ts
const brainRuntime = await prepareAgentBrainRuntime(...)
const toolRuntime = await prepareAgentToolRuntime(...)
```

and merge the returned env values into the harness env.

## Test Coverage

Add tests for:

- Creates missing `BRAIN_REPO`.
- Creates missing `GBRAIN_HOME`.
- Runs `gbrain init --pglite` when uninitialized.
- Skips init when already initialized.
- Registers source when absent.
- Repairs source when it points at a stale path.
- Respects explicit `GBRAIN_HOME`.
- Respects explicit `BRAIN_REPO`.
- Throws when `gbrain` is missing.
- Throws when `gbrain init --pglite` fails.
- Throws when source registration/repair fails.
- Existing `prepareAgentToolRuntime()` PATH behavior remains unchanged.

## Search Mode Note

GBrain currently auto-selects `tokenmax` during init. The install manual requires
operator confirmation of search mode before real use.

Available modes:

```text
conservative
balanced
tokenmax
```

If a cheaper default is preferred for Cody, run:

```bash
GBRAIN_HOME=/Users/lherron/praesidium/var/state/gbrain/cody/home \
  gbrain config set search.mode balanced
```
