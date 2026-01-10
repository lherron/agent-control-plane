## Agent Spaces v2 product spec draft

This is a ground-up relaunch. We’re using the v1 extraction only as a behavioral baseline to replace (not preserve) semantics like catalog refs and “last space wins” merges.  [oai_citation:0‡AS2-SPEC.md](sediment://file_00000000d12871f88e7148e5b46d7e9d)

The core v2 move: **treat a Space as the unit of reusable capability**, and **treat a Run Target as the project-local composition surface**. At runtime, `asp run` materializes Spaces into **Claude Code plugin directories** and launches `claude` with one or more `--plugin-dir` flags. `--plugin-dir` is repeatable.  [oai_citation:1‡Claude Code](https://code.claude.com/docs/en/cli-reference)

---

# 1. Goals and non-goals

## Goals

Reproducible environments: A project must be able to run the same set of Spaces deterministically from a lock file, with explicit pinning and a verifiable resolution closure.

Fast iteration: Local changes to Spaces (especially in the global repo) should be runnable with minimal friction; cached build artifacts should be reused aggressively.

Registry maintenance/management: A “global” git-backed registry is first-class, including workflows for version/tagging and validating Spaces.

Project-level composability: Users compose at **Run Target** level in `asp-targets.toml` (spaces only, for now), without “context switching” into ASP to build the perfect run.

Conflicts surfaced: naming collisions produce explicit warnings with actionable disambiguation suggestions.

Repo init de-emphasized: repo init is rare → under `asp repo init`, not a top-level day-to-day command.

Repo management is CLI-enabled: UI (TUI/web) is optional for maintenance workflows, not required.

## Non-goals for v2 MVP

Backwards compatibility with v1 catalogs, `.aspk`, and v1 merge rules.  [oai_citation:2‡AS2-SPEC.md](sediment://file_00000000d12871f88e7148e5b46d7e9d)

Direct Run Target composition of non-Space artifacts (e.g. “claude-plugin:” refs). (Spaces may import Claude plugin-formatted assets later, but Run Targets are spaces-only.)

Perfect cross-platform tool runtime guarantees (especially for MCP/tooling); we build defensively and degrade gracefully given upstream variability.

---

# 2. Glossary and key concepts

**Space**: A versioned, reusable capability module stored in the global git-backed registry. Contains Claude Code plugin components (commands/agents/skills/hooks and eventually MCP configs). A Space is the unit you publish, pin, and compose.

**Run Target**: A named project-local execution profile in `asp-targets.toml`. Defines which Spaces are composed for this project context (e.g. `architect`, `frontend`, `backend`) and optional Claude run options.

**Resolved Environment**: The fully expanded, pinned closure of a Run Target: the concrete Space versions (and transitive deps, if any) that will be used for execution.

**Lock file**: `asp-lock.json` in the project root. Stores the resolved environments for one or more Run Targets (pins + integrity + source).

**Materialization**: The process of turning a Space into an on-disk Claude Code plugin directory structure with `.claude-plugin/plugin.json` and component directories at plugin root. Official plugin layout rules apply.  [oai_citation:3‡Claude Code](https://code.claude.com/docs/en/plugins)

**Runtime Bundle**: The set of one or more materialized plugin directories for a run. `asp run` launches Claude with `claude --plugin-dir <dir> [--plugin-dir <dir> ...]`.  [oai_citation:4‡Claude Code](https://code.claude.com/docs/en/cli-reference)

**ASP Home**: The global directory root for registry clone, stores, and caches (default `~/.asp`). Overridable with `ASP_HOME`.

**Registry**: The git repository containing Spaces (monorepo). Versioning is via git tags + commit hashes (semver tags optional but supported).

---

# 3. Claude Code plugin contract

Agent Spaces v2 targets Claude Code’s plugin system as the runtime interface.

## Canonical plugin structure

A plugin is a directory where:

- `.claude-plugin/plugin.json` exists (manifest; `name` required; kebab-case, no spaces).
- Component directories (`commands/`, `agents/`, `skills/`, `hooks/`) live at plugin root (not inside `.claude-plugin/`).  [oai_citation:5‡Claude Code](https://code.claude.com/docs/en/plugins)

Hooks are configured in `hooks/hooks.json` (or inline in `plugin.json`) with event matchers and actions; paths should use `${CLAUDE_PLUGIN_ROOT}`.  [oai_citation:6‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

## Namespacing and collision behavior (critical for warnings)

Plugin commands are namespaced and can be invoked as `/plugin-name:command-name`; docs also note plugin prefix may be optional unless there are collisions.  [oai_citation:7‡Claude Code](https://code.claude.com/docs/en/slash-commands)

Known caveat: as of late 2025, there’s a reported Claude Code bug where agents fail to resolve plugin-scoped commands unless the fully-qualified `/plugin:command` is used. In practice, **agent-facing docs and any generated subagent instructions should always use fully-qualified command names**.  [oai_citation:8‡GitHub](https://github.com/anthropics/claude-code/issues/11328)

## MCP/tooling caveat (affects “tools” feature)

Claude Code supports MCP servers via `.mcp.json` and/or `plugin.json` `mcpServers`.  [oai_citation:9‡Claude Code](https://code.claude.com/docs/en/mcp)

There are recent reports that `--plugin-dir` may not load MCP servers specified in `plugin.json`, with a documented workaround: pass `--mcp-config` alongside `--plugin-dir`. V2 should implement that workaround by default whenever spaces contribute MCP servers.  [oai_citation:10‡GitHub](https://github.com/anthropics/claude-code/issues/15308)

---

# 4. Repository, project, and Space layouts

## 4.1 ASP Home layout

Default: `~/.asp` (override with `ASP_HOME`)

```
~/.asp/
  repo/                 # the registry git clone (mono repo)
  store/
    spaces/             # content-addressed space snapshots
    plugins/            # (future) imported plugin snapshots
  cache/
    materialized/       # plugin dirs built from snapshots (by env hash)
    mcp/                # generated mcp-config files (by env hash)
  logs/
  config.json           # optional global config (claude path, default registry remote)
```

Notes:
- `repo/` is a working clone to enable fast authoring, publishing, and local-dev overlays.
- `store/` is immutable content-addressed snapshots (safe for caching and verification).
- `cache/` is disposable; can be GC’d.

## 4.2 Project layout

Project root is defined by the presence of `asp-targets.toml`.

```
my-project/
  asp-targets.toml
  asp-lock.json
  .gitignore            # includes .asp/
  .asp/                 # optional local caches for debugging (gitignored)
```

You can run from any subdirectory; `asp` discovers project root by walking up to `asp-targets.toml`.

## 4.3 Space source layout

A Space is authored in the registry repo under `spaces/<space-id>/`.

We intentionally mirror Claude plugin conventions to reduce mental translation:

```
spaces/todo-frontend/
  space.toml
  commands/
    build.md
    test.md
  agents/
    reviewer.md
  skills/
    react-architecture/
      SKILL.md
      reference.md
  hooks/
    hooks.json
  scripts/
    validate.sh
  mcp/
    mcp.json            # ASP-side MCP def (see below)
```

### `space.toml` (Space manifest)

Single-file metadata + deps to minimize config sprawl.

```toml
schema = 1
id = "todo-frontend"
version = "1.2.0"
description = "Frontend dev workflows for the todo project"

[plugin]
name = "todo-frontend"   # defaults to id if omitted

[deps]
spaces = [
  "space:shared-base@^1.0.0"
]
```

Notes:
- `schema = 1` is required (version of manifest format)
- `[plugin]` section allows overriding plugin name, version, description, author, etc.
- Component discovery is file-structure-driven (Claude discovers from directories)

---

# 5. Project manifest and lockfile

## 5.1 `asp-targets.toml` (project manifest)

Spaces-only composition.

```toml
schema = 1

[targets.architect]
description = "High-level system design + coordination"
compose = [
  "space:todo-architect@stable"
]

[targets.frontend]
compose = [
  "space:todo-frontend@stable",
  "space:shared-quality@^1.3.0"
]

[targets.backend]
compose = [
  "space:todo-backend@stable",
  "space:shared-quality@^1.3.0"
]

[claude]
# optional defaults applied to all targets unless overridden
model = "sonnet"
permission_mode = "default"
```

### Space reference syntax

`space:<id>@<selector>`

Selector forms:
- Dist-tag: `stable`, `latest`, `beta`
- Semver: `1.2.3`, `^1.2.0`, `~1.2.3`
- Direct git pin: `git:<commitSha>` (escape hatch)

## 5.2 `asp-lock.json` (lock file)

The lock must be sufficient for a fresh machine to reproduce the same resolution without any additional configuration.

```json
{
  "lockfileVersion": 1,
  "resolverVersion": 1,
  "generatedAt": "2026-01-09T00:00:00Z",
  "registry": {
    "type": "git",
    "url": "ssh://git.example.com/agent-spaces-registry.git"
  },
  "spaces": {
    "todo-frontend@abcdef1": {
      "id": "todo-frontend",
      "commit": "abcdef1234567890",
      "path": "spaces/todo-frontend",
      "integrity": "sha256:...",
      "plugin": { "name": "todo-frontend", "version": "1.2.0" },
      "deps": { "spaces": [] },
      "resolvedFrom": { "selector": "stable", "tag": "space/todo-frontend/stable" }
    },
    "shared-quality@0123dead": {
      "id": "shared-quality",
      "commit": "0123deadbeef1234",
      "path": "spaces/shared-quality",
      "integrity": "sha256:...",
      "plugin": { "name": "shared-quality", "version": "1.3.2" },
      "deps": { "spaces": [] },
      "resolvedFrom": { "selector": "^1.3.0", "tag": "space/shared-quality/v1.3.2", "semver": "1.3.2" }
    }
  },
  "targets": {
    "frontend": {
      "compose": ["space:todo-frontend@stable", "space:shared-quality@^1.3.0"],
      "roots": ["todo-frontend@abcdef1", "shared-quality@0123dead"],
      "loadOrder": ["todo-frontend@abcdef1", "shared-quality@0123dead"],
      "envHash": "sha256:...",
      "warnings": []
    }
  }
}
```

### Versioning model in the registry

- Concrete pin is always a commit SHA.
- Human-readable versions are git tags with format `space/<id>/vX.Y.Z`.
- **Dist-tags** (stable, latest, beta, etc.) are stored in a committed `registry/dist-tags.json` file that maps space IDs to channel→version mappings:
  ```json
  {
    "todo-frontend": { "stable": "v1.2.0", "latest": "v1.3.0-beta.1" }
  }
  ```
  This approach makes channel promotions PR-reviewable (unlike moving git tags).
- `asp repo publish` is responsible for creating git tags and updating dist-tags.json consistently.

---

# 6. Core workflows

## 6.1 `asp repo init` (rare)

Creates or clones the global registry repo into `$ASP_HOME/repo`, sets up minimal structure, installs the built-in manager Space, then runs it.

Flow:

1. Create repo skeleton (git init, default remote optional).
2. Ensure `spaces/agent-spaces-manager/` exists (vendored template or fetched).
3. Final step: `asp run agent-spaces-manager` (from within the repo) to guide the user through initial setup, creation of first spaces, tagging conventions, etc.

This aligns with your requirement: ship an agent that builds skills/tools/hooks with the product and make it the last init step.

## 6.2 `asp install` (project)

Reads `asp-targets.toml`, resolves each target's composed spaces to commits, writes/updates `asp-lock.json`, and populates `$ASP_HOME/store`.

Resolution policy:
- If a lock exists: do not change versions unless `--update` or explicit flags.
- If lock missing: generate it (locked-by-default behavior).
- If resolution requires tags (stable/latest), `asp` consults the registry repo’s tags (fetch as needed).

## 6.3 `asp run` (project + global)

### In a project

`asp run <name>`:
- If `<name>` matches a Run Target in `asp-targets.toml`: run that target using `asp-lock.json` pins.
- Else: interpret as a Space reference (`space:<name>@stable` by default, unless explicit `@…`).

### Outside a project

`asp run <spaceRefOrPath>`:
- If argument is a filesystem path to a Space directory: run that Space (dev-mode).
- Else: resolve it from registry (`space:<id>@stable` default).

### Runtime contract

`asp run` always does:

1. Resolve → snapshot → materialize plugin dir(s) into cache keyed by env hash.
2. Launch:
   - `claude --plugin-dir <spaceAPluginDir> --plugin-dir <spaceBPluginDir> ...`
   - If MCP servers are present, also pass: `--mcp-config <generatedMcpConfig>` (workaround for current behavior).  [oai_citation:11‡GitHub](https://github.com/anthropics/claude-code/issues/15308)

`--plugin-dir` repeatability is documented.  [oai_citation:12‡Claude Code](https://code.claude.com/docs/en/cli-reference)

---

# 7. Materialization spec

## 7.1 Space → plugin directory

For each Space, materialize a plugin directory. The cache key is computed as:

```
pluginCacheKey = sha256("materializer-v1\0" + spaceIntegrity + "\0" + pluginName + "\0" + pluginVersion + "\n")
```

The cache path structure is:

```
$ASP_HOME/cache/<pluginCacheKey>/
  .claude-plugin/plugin.json
  commands/...
  agents/...
  skills/...
    hooks/...
    scripts/...
    .asp/cache-metadata.json
```

`plugin.json` generation:
- `name`: `space.toml` `plugin.name` else `space id`
- `version`: `space.toml` `version` (semver string)
- `description`: from space manifest
- `commands/agents/skills/hooks`: default directories if present, else omitted

Manifest schema requires `name`.  [oai_citation:13‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

Directory structure rules (component dirs at root, not inside `.claude-plugin/`) must be enforced by linter.  [oai_citation:14‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

## 7.2 Hooks

We adopt Claude’s hooks format verbatim (`hooks/hooks.json`). Events and hook types are as documented.  [oai_citation:15‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

Materializer responsibilities:
- Ensure hook scripts referenced in `hooks.json` exist and are executable (or warn).
- Enforce `${CLAUDE_PLUGIN_ROOT}` in any plugin-relative script paths (warn if not used).
- Optional future: support TS hook authoring and compile into `.asp/compiled/` + rewrite `hooks.json`.

## 7.3 MCP / tools

Because MCP loading via `--plugin-dir` is currently inconsistent, v2’s runtime path for tools is:

- Each Space may provide MCP server defs in `mcp/mcp.json` (ASP-owned schema).
- `asp run` composes all MCP servers from all Spaces into a single generated file in cache using **project `.mcp.json` format**:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@org/server"],
      "env": {}
    }
  }
}
```

Project `.mcp.json` format is documented with the `mcpServers` wrapper.  [oai_citation:16‡Claude Code](https://code.claude.com/docs/en/mcp)

Then `asp run` passes `--mcp-config <path>` (and optionally `--strict-mcp-config` depending on target policy) to Claude.  [oai_citation:17‡Claude Code](https://code.claude.com/docs/en/cli-reference)

---

# 8. Diagnostics and lint

## 8.1 `asp lint`

`asp lint` runs in two modes:
- project mode (validate targets + lock coherence + conflicts)
- repo/space mode (validate individual Spaces)

It always emits explicit warnings with codes and explanations. No silent conflict resolution.

## 8.2 Warning categories (initial set)

W201 `command-name-collision`: two composed Spaces export same command basename. Provide suggested invocations using fully-qualified namespace:

- `/space-a:deploy`
- `/space-b:deploy`

Namespacing is the intended mechanism for resolving conflicts.  [oai_citation:18‡Claude Code](https://code.claude.com/docs/en/slash-commands)

W202 `agent-command-namespace`: an agent doc references an unqualified `/command` that appears to be provided by a plugin Space; recommend using `/space:command` due to known agent discovery issues.  [oai_citation:19‡GitHub](https://github.com/anthropics/claude-code/issues/11328)

W203 `hook-path-no-plugin-root`: hook command path doesn't include `${CLAUDE_PLUGIN_ROOT}`.

W204 `invalid-hooks-config`: hooks/ directory exists but hooks.json is missing or invalid.

W205 `plugin-name-collision`: two Spaces resolve to same plugin `name` (will create ambiguous namespaces); advise changing `plugin.name` in space.toml.

W206 `non-executable-hook-script`: hook script file is not executable (missing +x permission).

W207 `invalid-plugin-structure`: component directories nested incorrectly (e.g. `commands/` inside `.claude-plugin/`).  [oai_citation:20‡Claude Code](https://code.claude.com/docs/en/plugins)

W301 `lock-missing`: project has targets but no lock; `asp run` will generate lock (or require `asp install` if we decide stricter).

## 8.3 Integration with Claude validation (optional but recommended)

If `claude plugin validate` exists, `asp lint` can call it against materialized outputs for an additional guardrail.  [oai_citation:21‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

---

# 9. CLI surface

Top-level commands optimized for day-to-day:

**Core Commands:**
- `asp run <target|spaceRef|path> [prompt]` - Execute a Run Target or Space
- `asp install` - Generate/update lock file and fetch into store
- `asp build <target> --output <path>` - Materialize plugins without launching Claude

**Management Commands:**
- `asp add <spaceRef> --target <name>` - Add space ref to target in asp-targets.toml
- `asp remove <spaceId> --target <name>` - Remove space from target
- `asp upgrade [spaceIds...]` - Update lock pins per selectors
- `asp diff` - Show pending lock changes without writing

**Diagnostic Commands:**
- `asp explain <target> [--json]` - Print resolved graph, pins, load order, warnings
- `asp lint` - Validate project + spaces, emit warnings
- `asp list` - Show targets, resolved spaces, cached envs
- `asp doctor` - Check claude binary, registry remote reachability, cache permissions
- `asp gc` - Garbage collect store and cache based on lock file reachability

**Lower-visibility repo management namespace:**
- `asp repo init [--clone <url>]` - Create/clone registry, install manager space
- `asp repo status` - Show registry repo status
- `asp repo publish <spaceId> --tag vX.Y.Z [--dist-tag stable]` - Create git tag, update dist-tags.json
- `asp repo tags <spaceId>` - List tags for a space
- `asp repo gc` - Repository-level garbage collection

Optional: `asp ui` (repo management UI), `asp space ...` (authoring helpers). The primary authoring flow is via the shipped `agent-spaces-manager` Space.

---

# 10. The shipped manager Space

Space: `agent-spaces-manager`

Responsibilities:
- Scaffold new Spaces in the registry repo with correct layout.
- Add skills/hooks/commands and ensure required files exist.
- Propose and apply tagging/version updates.
- Generate/modify `asp-targets.toml` in projects (the “capability surface”), keeping the user in Claude for composition rather than bouncing to ASP.

Critical: any documentation or instructions it generates that reference slash commands should prefer fully-qualified `/space:command` forms to avoid the known agent namespace discovery issue.  [oai_citation:22‡GitHub](https://github.com/anthropics/claude-code/issues/11328)

---

# 11. What this replaces from v1

V1’s model had:
- catalog vs local item split,
- space.json + catalog refs,
- materialization that merged spaces into a single plugin with “last wins” behavior,
- CLI surface largely around catalog refs + merges.  [oai_citation:23‡AS2-SPEC.md](sediment://file_00000000d12871f88e7148e5b46d7e9d)

V2 removes the catalog entirely (initially), replaces merge semantics with **multi-plugin loading**, and shifts composition into `asp-targets.toml` + lockfile.

---

If you want the next step to be actionable implementation-wise, I can convert this into:
- explicit JSON Schema / TOML schema blocks for `space.toml`, `asp-targets.toml`, `asp-lock.json`,
- the exact resolution algorithm (including tag/semver handling and store key derivation),
- and the cache key / env hash definition (what goes into the hash, what does not).
