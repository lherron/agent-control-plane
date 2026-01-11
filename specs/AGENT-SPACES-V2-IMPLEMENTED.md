# Agent Spaces v2 - Implementation Specification

> **Status**: This document reflects the implemented system as of January 2026. It serves as both documentation and a complete specification for rebuilding the system from scratch.

## Overview

Agent Spaces v2 is a ground-up relaunch that treats **Spaces as the unit of reusable capability** and **Run Targets as the project-local composition surface**. At runtime, `asp run` materializes Spaces into Claude Code plugin directories and launches Claude with one or more `--plugin-dir` flags.

The core architecture shift from v1:
- Removed catalog/local item split and `.aspk` files
- Replaced "last wins" merge semantics with **multi-plugin loading**
- Shifted composition to `asp-targets.toml` + lock file

---

# 1. Goals and Non-Goals

## Goals

- **Reproducible environments**: Projects run the same Spaces deterministically from a lock file with explicit pinning and verifiable resolution closure
- **Fast iteration**: Local changes runnable with minimal friction; cached build artifacts reused aggressively
- **Registry maintenance**: Git-backed registry is first-class, including version/tagging and Space validation workflows
- **Project-level composability**: Users compose at Run Target level in `asp-targets.toml` without context-switching
- **Conflicts surfaced**: Naming collisions produce explicit warnings with actionable disambiguation suggestions
- **CLI-enabled management**: UI (TUI/web) optional for maintenance workflows, not required

## Non-Goals (MVP)

- Backwards compatibility with v1 catalogs, `.aspk`, and v1 merge rules
- Direct Run Target composition of non-Space artifacts (e.g., `claude-plugin:` refs)
- Perfect cross-platform tool runtime guarantees (especially MCP/tooling)

---

# 2. Glossary and Key Concepts

**Space**: A versioned, reusable capability module stored in the git-backed registry. Contains Claude Code plugin components (commands/agents/skills/hooks) and optionally MCP configs. A Space is the unit you publish, pin, and compose.

**Run Target**: A named project-local execution profile in `asp-targets.toml`. Defines which Spaces are composed for this project context (e.g., `architect`, `frontend`, `backend`) and optional Claude run options.

**Resolved Environment**: The fully expanded, pinned closure of a Run Target: concrete Space versions (and transitive deps) used for execution.

**Lock File**: `asp-lock.json` in project root. Stores resolved environments for one or more Run Targets (pins + integrity + source).

**Materialization**: The process of turning a Space into an on-disk Claude Code plugin directory structure with `.claude-plugin/plugin.json` and component directories at plugin root.

**Runtime Bundle**: The set of one or more materialized plugin directories for a run. `asp run` launches Claude with `claude --plugin-dir <dir> [--plugin-dir <dir> ...]`.

**ASP Home**: Global directory root for registry clone, snapshots, and caches (default `~/.asp`). Overridable with `ASP_HOME` environment variable.

**Registry**: The git repository containing Spaces (monorepo). Versioning via git tags + commit hashes (semver tags supported).

**Space Key**: Unique identifier for a resolved space version in format `<id>@<commit-prefix>` (e.g., `frontend@abc1234`).

**Integrity Hash**: SHA-256 content hash of a Space's files, format `sha256:<64-hex-chars>`. Used for content-addressable storage.

---

# 3. Claude Code Plugin Contract

Agent Spaces v2 targets Claude Code's plugin system as the runtime interface.

## Canonical Plugin Structure

A plugin is a directory where:
- `.claude-plugin/plugin.json` exists (manifest; `name` required; kebab-case)
- Component directories (`commands/`, `agents/`, `skills/`, `hooks/`, `scripts/`) live at plugin root (not inside `.claude-plugin/`)

Hooks are configured in `hooks/hooks.json` with event matchers and actions; paths should use `${CLAUDE_PLUGIN_ROOT}`.

## Namespacing and Collision Behavior

Plugin commands are namespaced and invoked as `/plugin-name:command-name`. Plugin prefix may be optional unless there are collisions.

**Known caveat**: Agents may fail to resolve plugin-scoped commands unless the fully-qualified `/plugin:command` is used. Generated subagent instructions should always use fully-qualified command names.

## MCP/Tooling Caveat

Claude Code supports MCP servers via `.mcp.json` and/or `plugin.json` `mcpServers`. However, `--plugin-dir` may not load MCP servers specified in `plugin.json`. The workaround is to pass `--mcp-config` alongside `--plugin-dir`. Agent Spaces implements this workaround automatically whenever spaces contribute MCP servers.

---

# 4. Directory Layouts

## 4.1 ASP Home Layout

Default: `~/.asp` (override with `ASP_HOME`)

```
~/.asp/
  repo/                   # Registry git clone (working copy)
    spaces/               # Space source directories
      <space-id>/
        space.toml
        commands/
        skills/
        ...
    registry/
      dist-tags.json      # Channel → version mappings
  snapshots/<hash>/       # Content-addressed space snapshots
    space.toml
    commands/
    .asp-snapshot.json    # Snapshot metadata
  cache/<cacheKey>/       # Materialized plugin directories
    .claude-plugin/
      plugin.json
    commands/
    .asp-cache.json       # Cache metadata
  tmp/                    # Temporary files during operations
  global-lock.json        # Pins for global-mode runs
  store.lock              # File-based lock for store operations
```

Notes:
- `repo/` is a working clone enabling fast authoring, publishing, and local-dev overlays
- `snapshots/` contains immutable content-addressed snapshots (keyed by integrity hash without `sha256:` prefix)
- `cache/` contains materialized plugin directories (keyed by plugin cache key, disposable, can be GC'd)

## 4.2 Project Layout

Project root is defined by presence of `asp-targets.toml`.

```
my-project/
  asp-targets.toml        # Project manifest (required)
  asp-lock.json           # Lock file (generated)
  .asp.lock               # Project-level file lock (runtime)
  asp_modules/            # Materialized artifacts (generated)
    <target>/
      plugins/            # Plugin directories (ordered)
        000-<space>/
          .claude-plugin/plugin.json
          commands/
          ...
        001-<space>/
          ...
      mcp.json            # Composed MCP config
      settings.json       # Composed Claude settings
  .gitignore              # Should include asp_modules/
```

You can run from any subdirectory; `asp` discovers project root by walking up to `asp-targets.toml`.

## 4.3 Space Source Layout

A Space is authored in the registry repo under `spaces/<space-id>/`.

```
spaces/todo-frontend/
  space.toml              # Space manifest (required)
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
    hooks.json            # Hook definitions
    setup.sh              # Hook scripts
  scripts/
    validate.sh
  mcp/
    mcp.json              # MCP server definitions
```

---

# 5. Configuration Files

## 5.1 `space.toml` (Space Manifest)

Single-file metadata + deps to minimize config sprawl.

### Full Schema

```toml
schema = 1                              # Required, must be 1
id = "todo-frontend"                    # Required, kebab-case, 1-64 chars
version = "1.2.0"                       # Optional, semver
description = "Frontend dev workflows"  # Optional, max 500 chars

[plugin]
name = "todo-frontend"                  # Optional, defaults to id
version = "1.2.0"                       # Optional, defaults to space version
description = "Frontend plugin"         # Optional, max 500 chars

[plugin.author]
name = "Author Name"                    # Optional, max 120 chars
email = "author@example.com"            # Optional, email format
url = "https://example.com"             # Optional, URI format

# Optional plugin metadata
# homepage = "https://..."              # URI format
# repository = "https://..."            # URI format
# license = "MIT"                       # Max 100 chars
# keywords = ["react", "frontend"]      # Max 30 items, each max 50 chars

[deps]
spaces = [                              # Optional, defaults to []
  "space:shared-base@^1.0.0"
]

[settings]
model = "claude-3-opus"                 # Optional, Claude model override

[settings.permissions]
allow = ["bash", "read", "write"]       # Optional, permission allow rules
deny = ["dangerous_tool"]               # Optional, permission deny rules

[settings.env]
NODE_ENV = "development"                # Optional, environment variables
```

### Field Details

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `schema` | Yes | `1` | Manifest format version |
| `id` | Yes | string | Space identifier (kebab-case, 1-64 chars) |
| `version` | No | semver | Space version |
| `description` | No | string | Human-readable description (max 500 chars) |
| `plugin` | No | object | Plugin.json overrides |
| `deps.spaces` | No | array | Space reference strings |
| `settings` | No | object | Claude settings to apply |

### Plugin Identity Derivation

The plugin name and version are derived as:
- `plugin.name` → `plugin.name` if set, else `id`
- `plugin.version` → `plugin.version` if set, else `version`

## 5.2 `asp-targets.toml` (Project Manifest)

Defines project-level composition of Spaces into Run Targets.

### Full Schema

```toml
schema = 1                              # Required, must be 1

[claude]                                # Optional, defaults for all targets
model = "sonnet"
permission_mode = "default"
args = ["--verbose"]                    # Pass-through CLI args to claude

[targets.architect]
description = "High-level design"       # Optional, max 300 chars
compose = [                             # Required, min 1 item
  "space:todo-architect@stable"
]

[targets.architect.claude]              # Optional, target-specific overrides
model = "opus"

[targets.architect.resolver]            # Optional
locked = true                           # Default: true
allow_dirty = true                      # Default: true

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

[targets.backend.claude]
model = "opus"
```

### Space Reference Syntax

Format: `space:<id>@<selector>`

Selector forms:
| Selector | Example | Description |
|----------|---------|-------------|
| Dist-tag | `@stable`, `@latest`, `@beta` | Resolved via `registry/dist-tags.json` |
| Semver exact | `@1.2.3` | Exact version match |
| Semver range | `@^1.2.0`, `@~1.2.3` | Highest matching version |
| Git pin | `@git:abc1234` | Direct commit SHA (escape hatch) |
| HEAD | `@HEAD` | Current registry HEAD commit |
| Dev | `@dev` | Local filesystem (mutable, no git) |

Note: When no selector is provided (e.g., `space:frontend`), the default is `@dev`.

## 5.3 `asp-lock.json` (Lock File)

The lock file enables reproducible builds on fresh machines.

### Full Schema

```json
{
  "lockfileVersion": 1,
  "resolverVersion": 1,
  "generatedAt": "2026-01-09T00:00:00Z",
  "registry": {
    "type": "git",
    "url": "ssh://git.example.com/agent-spaces-registry.git",
    "defaultBranch": "main"
  },
  "spaces": {
    "todo-frontend@abcdef1": {
      "id": "todo-frontend",
      "commit": "abcdef1234567890abcdef1234567890abcdef12",
      "path": "spaces/todo-frontend",
      "integrity": "sha256:abc123...",
      "plugin": {
        "name": "todo-frontend",
        "version": "1.2.0"
      },
      "deps": {
        "spaces": ["shared-base@xyz789"]
      },
      "resolvedFrom": {
        "selector": "stable",
        "tag": "space/todo-frontend/v1.2.0",
        "semver": "1.2.0"
      }
    }
  },
  "targets": {
    "frontend": {
      "compose": ["space:todo-frontend@stable", "space:shared-quality@^1.3.0"],
      "roots": ["todo-frontend@abcdef1", "shared-quality@0123dead"],
      "loadOrder": ["shared-base@xyz789", "todo-frontend@abcdef1", "shared-quality@0123dead"],
      "envHash": "sha256:def456...",
      "warnings": [
        {
          "code": "W201",
          "message": "Command collision: /build",
          "details": { "command": "build", "spaces": ["todo-frontend", "shared-quality"] }
        }
      ]
    }
  }
}
```

### Space Key Format

Space keys uniquely identify resolved space versions: `<id>@<commit-prefix>`

- `id`: Space identifier
- `commit-prefix`: First 7-12 characters of commit SHA

Special case: `@dev` refs use the literal commit `dev` (e.g., `frontend@dev`).

## 5.4 `registry/dist-tags.json`

Maps space IDs to channel→version mappings. Stored in the registry repo for PR-reviewable channel promotions.

```json
{
  "todo-frontend": {
    "stable": "v1.2.0",
    "latest": "v1.3.0-beta.1"
  },
  "shared-base": {
    "stable": "v1.0.0",
    "latest": "v1.0.0"
  }
}
```

---

# 6. Resolution Algorithm

## 6.1 Selector Resolution

Each selector type resolves to a commit SHA:

1. **`@dev`**: Uses filesystem working directory (special marker commit `dev`)
2. **`@HEAD`**: Resolves to current registry HEAD via `git rev-parse HEAD`
3. **`@<dist-tag>`**:
   - Read `registry/dist-tags.json` at HEAD
   - Look up space ID → tag name → version string
   - Convert version to git tag: `space/<id>/<version>`
   - Resolve tag to commit
4. **`@<semver-exact>`**:
   - Build tag name: `space/<id>/v<version>`
   - Resolve tag to commit
5. **`@^<range>` or `@~<range>`**:
   - List all tags matching `space/<id>/v*`
   - Parse versions and sort descending
   - Find highest version satisfying range
   - Resolve matching tag to commit
6. **`@git:<sha>`**: Use SHA directly

## 6.2 Dependency Closure Computation

The resolver computes transitive dependencies using DFS postorder traversal:

```
function computeClosure(rootRefs):
  spaces = Map<SpaceKey, ResolvedSpace>()
  loadOrder = []
  visitState = Map<SpaceKey, 'visiting' | 'visited'>()

  function visit(ref):
    resolved = resolveSelector(ref)
    key = makeSpaceKey(resolved.id, resolved.commit)

    if visitState[key] == 'visiting':
      throw CyclicDependencyError
    if visitState[key] == 'visited':
      return key

    visitState[key] = 'visiting'
    manifest = readManifest(resolved)

    for depRef in manifest.deps.spaces:
      visit(depRef)

    spaces[key] = resolved
    loadOrder.push(key)
    visitState[key] = 'visited'
    return key

  roots = []
  for ref in rootRefs:
    roots.push(visit(ref))

  return { spaces, loadOrder, roots }
```

Key properties:
- **Postorder**: Dependencies appear in `loadOrder` before dependents
- **Cycle detection**: Throws `CyclicDependencyError` with cycle path
- **Diamond handling**: Visited spaces processed once, deps satisfied

## 6.3 Integrity Hash Computation

Content hash for a space at a specific commit:

```
function computeIntegrity(spaceId, commit):
  entries = listTree(commit, "spaces/<spaceId>/")
  entries = filterIgnored(entries)  // Exclude node_modules, .git, etc.
  entries = sortByPath(entries)

  content = "v1\0"
  for entry in entries:
    content += entry.path + "\0" + entry.type + "\0" + entry.oid + "\0" + entry.mode + "\n"

  return "sha256:" + sha256(content)
```

Special case: `@dev` refs return `sha256:dev` (filesystem is mutable).

## 6.4 Environment Hash Computation

Hash for a resolved target environment (used for cache keying):

```
function computeEnvHash(loadOrder, spaces):
  content = "env-v1\0"
  for spaceKey in loadOrder:
    space = spaces[spaceKey]
    content += spaceKey + "\0" + space.integrity + "\0" + space.plugin.name + "\n"

  return "sha256:" + sha256(content)
```

---

# 7. Materialization

## 7.1 Space → Plugin Directory

For each Space, materialize a plugin directory.

### Cache Key Computation

```
pluginCacheKey = sha256("materializer-v1\0" + integrity + "\0" + pluginName + "\0" + pluginVersion + "\n")
```

Result is a 64-character hex string.

### Output Structure

```
$ASP_HOME/cache/<pluginCacheKey>/
  .claude-plugin/
    plugin.json           # Generated from space manifest
  commands/               # Hardlinked from snapshot
  agents/
  skills/
  hooks/
  scripts/
  mcp/
  .asp-cache.json         # Cache metadata
```

### Plugin.json Generation

Generated from space manifest:
- `name`: `plugin.name` → `id`
- `version`: `plugin.version` → `space.version`
- `description`: `plugin.description` → `space.description`
- `author`: from `plugin.author` if present
- `homepage`, `repository`, `license`, `keywords`: from `plugin` section

Only defined fields are included (no null values).

### Cache Metadata (`.asp-cache.json`)

```json
{
  "spaceKey": "frontend@abc1234",
  "integrity": "sha256:...",
  "pluginName": "frontend",
  "pluginVersion": "1.0.0",
  "createdAt": "2026-01-09T00:00:00Z"
}
```

## 7.2 Hooks

Claude's hooks format is adopted verbatim (`hooks/hooks.json`).

Materializer responsibilities:
- Ensure hook scripts referenced in `hooks.json` exist
- Check scripts are executable (warn via W206 if not)
- Automatically set executable permission during materialization
- Warn if hook paths use `..` (relative parent references)

Note: Full `${CLAUDE_PLUGIN_ROOT}` validation is not currently enforced; only `..` path checking is implemented.

## 7.3 MCP Server Composition

Each Space may provide MCP server definitions in `mcp/mcp.json`:

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

At runtime, all MCP servers are composed into a single file:
- Later spaces override earlier spaces for same server name
- Collision warnings generated for duplicate server names
- Output written to `asp_modules/<target>/mcp.json` (project mode) or temp directory (global/dev mode)

`asp run` passes `--mcp-config <path>` to Claude when MCP servers are present.

## 7.4 Settings Composition

Each Space may define Claude settings in `space.toml`:

```toml
[settings]
model = "claude-3-opus"

[settings.permissions]
allow = ["bash", "read"]
deny = ["dangerous_tool"]

[settings.env]
NODE_ENV = "development"
```

Settings are composed across all spaces in load order:
- `permissions.allow`: Arrays concatenated
- `permissions.deny`: Arrays concatenated
- `env`: Later values override earlier values
- `model`: Last defined model wins

Output written to `asp_modules/<target>/settings.json`.

---

# 8. Core Workflows

## 8.1 `asp install` (Project)

Reads `asp-targets.toml`, resolves each target's composed spaces, writes/updates `asp-lock.json`, and populates snapshots.

Resolution policy:
- If lock exists: do not change versions unless `--update` or explicit flags
- If lock missing: generate it (locked-by-default behavior)
- If resolution requires tags (stable/latest): fetch registry as needed

Post-resolution:
- Create snapshots for all resolved spaces
- Materialize plugins to `asp_modules/<target>/`
- Compose MCP config and settings

## 8.2 `asp run` (Project + Global + Dev)

### Project Mode

`asp run <target>` where target matches a Run Target in `asp-targets.toml`:
1. Auto-install if `asp_modules/<target>/` doesn't exist
2. Load plugin directories from `asp_modules/<target>/plugins/` (sorted alphabetically)
3. Load MCP config from `asp_modules/<target>/mcp.json` if present
4. Load settings from `asp_modules/<target>/settings.json`
5. Run lint checks
6. Execute Claude with composed options

### Global Mode

`asp run space:<id>@<selector>`:
1. Resolve space reference from registry
2. Compute dependency closure
3. Create snapshots in `$ASP_HOME/snapshots/`
4. Generate synthetic lock file
5. **Persist to `$ASP_HOME/global-lock.json`** (merge with existing)
6. Create temp directory for materialization
7. Materialize plugins
8. Execute Claude
9. Clean up temp directory

### Dev Mode

`asp run <path-to-space-directory>`:
1. Read space manifest from local filesystem
2. Create temp directory
3. Materialize directly from filesystem (no git)
4. Execute Claude
5. Clean up (does NOT update global lock)

### Runtime Contract

`asp run` always:
1. Resolves → snapshots → materializes plugin directories
2. Launches:
   ```
   claude --plugin-dir <plugin1> --plugin-dir <plugin2> ... \
          --mcp-config <mcp.json> \
          --setting-sources "" \
          --settings <settings.json>
   ```

Settings isolation:
- Default: `--setting-sources ""` (isolated, only space settings apply)
- `--inherit-all`: No `--setting-sources` flag (inherit all)
- `--inherit-project`: `--setting-sources "project"`
- `--inherit-user`: `--setting-sources "user"`
- `--inherit-local`: `--setting-sources "local"`
- Combinations allowed: `--inherit-project --inherit-user` → `"project,user"`

## 8.3 `asp repo init`

Creates or clones the global registry repo into `$ASP_HOME/repo`.

Flow:
1. Create repo skeleton (git init or clone)
2. Create `spaces/` and `registry/` directories
3. Install `agent-spaces-manager` space (unless `--no-manager`)
4. Create initial tag: `space/agent-spaces-manager/v1.0.0`
5. Update `registry/dist-tags.json` with manager channels
6. Make initial commit

---

# 9. Diagnostics and Lint

## 9.1 `asp lint`

Runs in two modes:
- **Project mode**: Validate targets + lock coherence + conflicts
- **Space mode**: Validate individual Spaces

Always emits explicit warnings with codes and explanations.

## 9.2 Warning Codes

### Space Composition Warnings (W2xx)

| Code | Name | Severity | Description |
|------|------|----------|-------------|
| W201 | `command-name-collision` | warning | Two composed Spaces export same command basename |
| W202 | `agent-command-namespace` | warning | Agent doc references unqualified `/command` |
| W203 | `hook-path-no-plugin-root` | warning | Hook path uses `..` (relative parent) |
| W204 | `invalid-hooks-config` | error | hooks/ exists but hooks.json missing/invalid |
| W205 | `plugin-name-collision` | warning | Two Spaces resolve to same plugin name |
| W206 | `non-executable-hook-script` | warning | Hook script missing +x permission |
| W207 | `invalid-plugin-structure` | warning | Components nested inside `.claude-plugin/` |

### Project Warnings (W3xx)

| Code | Name | Severity | Description |
|------|------|----------|-------------|
| W301 | `lock-missing` | info | Project has targets but no lock file |

W201 example message:
```
W201: Command collision: /build
  Used by: frontend (todo-frontend), backend (todo-backend)
  Use fully-qualified names: /frontend:build, /backend:build
```

---

# 10. CLI Surface

## Core Commands

| Command | Description |
|---------|-------------|
| `asp run <target\|spaceRef\|path> [prompt]` | Execute a Run Target, Space, or local path |
| `asp install` | Generate/update lock file, populate snapshots, materialize |
| `asp build [target] --output <dir>` | Materialize plugins without launching Claude |

### `asp run` Options

| Option | Description |
|--------|-------------|
| `--dry-run` | Print Claude command without executing |
| `--no-interactive` | Run non-interactively (requires prompt) |
| `--no-warnings` | Suppress lint warnings |
| `--inherit-all` | Inherit all Claude settings |
| `--inherit-project` | Inherit project-level settings |
| `--inherit-user` | Inherit user-level settings |
| `--inherit-local` | Inherit local settings |
| `--settings <file\|json>` | Settings JSON file or inline JSON |
| `--extra-args <args...>` | Additional Claude CLI arguments |
| `--project <path>` | Project directory override |
| `--registry <path>` | Registry path override |
| `--asp-home <path>` | ASP_HOME override |

## Management Commands

| Command | Description |
|---------|-------------|
| `asp add <spaceRef> --target <name>` | Add space ref to target |
| `asp remove <spaceId> --target <name>` | Remove space from target |
| `asp upgrade [spaceIds...]` | Update lock pins per selectors |
| `asp diff [--target <name>] [--json]` | Show pending lock changes |

## Diagnostic Commands

| Command | Description |
|---------|-------------|
| `asp explain [target] [--json]` | Print resolved graph, pins, load order, warnings |
| `asp lint [target] [--json]` | Validate project + spaces, emit warnings |
| `asp list [--json]` | Show targets, resolved spaces |
| `asp doctor [--json]` | Check Claude binary, registry, cache permissions |
| `asp gc [--dry-run]` | Garbage collect unreferenced snapshots and cache |

## Repository Commands

| Command | Description |
|---------|-------------|
| `asp repo init [--clone <url>] [--no-manager]` | Create/clone registry |
| `asp repo status [--json]` | Show registry repo status |
| `asp repo publish <spaceId> --tag <vX.Y.Z> [--dist-tag <name>]` | Create tag, update dist-tags |
| `asp repo tags <spaceId> [--json]` | List tags for a space |
| `asp repo gc [--dry-run]` | Repository-level garbage collection |

## Utility Commands (Beyond Original Spec)

| Command | Description |
|---------|-------------|
| `asp init <spaceId>` | Create new space in registry with scaffolding |
| `asp path <spaceId>` | Print filesystem path to a space |

---

# 11. The Shipped Manager Space

Space: `agent-spaces-manager` (bundled with CLI)

## Commands

| Command | Description |
|---------|-------------|
| `/agent-spaces-manager:help` | Show available asp commands and manager space commands |
| `/agent-spaces-manager:create-space` | Scaffold new space with correct layout |
| `/agent-spaces-manager:add-skill` | Add skill with best-practice template |
| `/agent-spaces-manager:add-command` | Add command with template |
| `/agent-spaces-manager:add-hook` | Add hook with validation and `${CLAUDE_PLUGIN_ROOT}` guidance |
| `/agent-spaces-manager:bump-version` | Update version in space.toml (major/minor/patch) |
| `/agent-spaces-manager:publish` | Run asp repo publish with dist-tag support |
| `/agent-spaces-manager:update-project-targets` | Help update project asp-targets.toml |

## Skills

- `space-authoring` - Comprehensive guide for creating and maintaining spaces

## Agents

- `manager` - Coordinator agent for repo + project workflows

Critical: Generated documentation should prefer fully-qualified `/space:command` forms to avoid agent namespace discovery issues.

---

# 12. Error Handling

## Error Hierarchy

```
Error (JavaScript native)
└── AspError (base class)
    ├── ConfigError
    │   ├── ConfigParseError (TOML/JSON parse failures)
    │   └── ConfigValidationError (schema validation failures)
    ├── ResolutionError
    │   ├── RefParseError (invalid space ref syntax)
    │   ├── SelectorResolutionError (selector cannot be resolved)
    │   ├── CyclicDependencyError (circular deps detected)
    │   └── MissingDependencyError (dep not found)
    ├── StoreError
    │   ├── IntegrityError (hash mismatch)
    │   └── SnapshotError (extraction failed)
    ├── MaterializationError
    ├── LockError
    │   └── LockTimeoutError
    ├── GitError
    └── ClaudeError
        ├── ClaudeNotFoundError
        └── ClaudeInvocationError
```

## Error Codes

| Error Class | Code | Context |
|------------|------|---------|
| `ConfigParseError` | `CONFIG_PARSE_ERROR` | TOML/JSON parsing |
| `ConfigValidationError` | `CONFIG_VALIDATION_ERROR` | Schema validation |
| `RefParseError` | `REF_PARSE_ERROR` | Space reference syntax |
| `SelectorResolutionError` | `SELECTOR_RESOLUTION_ERROR` | Version not found |
| `CyclicDependencyError` | `CYCLIC_DEPENDENCY_ERROR` | Circular dependency |
| `MissingDependencyError` | `MISSING_DEPENDENCY_ERROR` | Dependency not found |
| `IntegrityError` | `INTEGRITY_ERROR` | Hash mismatch |
| `SnapshotError` | `SNAPSHOT_ERROR` | Extraction failure |
| `MaterializationError` | `MATERIALIZATION_ERROR` | Plugin generation |
| `LockError` | `LOCK_ERROR` | File locking |
| `GitError` | `GIT_ERROR` | Git operations |
| `ClaudeNotFoundError` | `CLAUDE_NOT_FOUND_ERROR` | Claude binary |
| `ClaudeInvocationError` | `CLAUDE_INVOCATION_ERROR` | Claude execution |

---

# 13. Package Architecture

## Monorepo Structure

```
packages/
├── core/           # Types, schemas, config parsing, errors, locks
├── git/            # Git operations (shell-out wrapper)
├── claude/         # Claude CLI wrapper
├── resolver/       # Resolution engine, closure computation
├── store/          # Content-addressed storage, snapshots, cache
├── materializer/   # Plugin directory generation
├── engine/         # Orchestration layer
├── lint/           # Linting rules
└── cli/            # CLI entry point
```

## Package Responsibilities

### `@agent-spaces/core`
- TypeScript types and branded types (`SpaceId`, `CommitSha`, etc.)
- JSON schemas for `space.toml`, `asp-targets.toml`, `asp-lock.json`
- TOML/JSON parsing with validation
- Error classes and type guards
- File locking primitives
- ASP modules path utilities

### `@agent-spaces/git`
- Git command execution (argv arrays, no shell)
- Repository operations (init, clone, fetch, pull, commit)
- Tag operations (create, list, resolve)
- File content operations (show at commit)
- Tree operations (list, extract)

### `@agent-spaces/claude`
- Claude binary detection
- Claude invocation (interactive and capture modes)
- Plugin validation
- Command argument building

### `@agent-spaces/resolver`
- Space reference parsing
- Selector resolution (dist-tag, semver, git-pin, HEAD, dev)
- Dependency closure computation (DFS postorder)
- Integrity hash computation
- Lock file generation

### `@agent-spaces/store`
- ASP Home path management
- Content-addressed snapshot storage
- Plugin cache management
- Garbage collection

### `@agent-spaces/materializer`
- Plugin directory generation
- plugin.json creation
- Component linking (hardlinks)
- Hooks validation
- MCP composition
- Settings composition

### `@agent-spaces/engine`
- High-level orchestration
- Install workflow
- Build workflow
- Run workflow (project, global, dev modes)
- Explain workflow

### `@agent-spaces/lint`
- Warning rules (W201-W207)
- Warning reporter
- Space validation

### `@agent-spaces/cli`
- Commander.js CLI setup
- Command implementations
- User interaction
- Error formatting

---

# 14. Build and Test

## Commands

```bash
bun install       # Install dependencies
bun run build     # Build all packages
bun run test      # Run tests
bun run typecheck # Type check
bun run lint      # Lint code
bun run lint:fix  # Auto-fix lint issues
```

## Test Fixtures

Located in `integration-tests/fixtures/`:
- `sample-registry/` - Git repo with test spaces
- `sample-project/` - Project with asp-targets.toml
- `claude-shim/` - Mock Claude binary for tests

## Smoke Testing

```bash
# Test CLI directly (no build needed)
bun packages/cli/bin/asp.js <command>

# Test with dry-run
ASP_HOME=/tmp/asp-test bun packages/cli/bin/asp.js run \
  integration-tests/fixtures/sample-registry/spaces/base --dry-run

# Test inherit flags
bun packages/cli/bin/asp.js run <space-path> --dry-run --inherit-all
```

---

# 15. Versioning Model

## Git Tags

Format: `space/<id>/vX.Y.Z`

Examples:
- `space/frontend/v1.0.0`
- `space/backend/v2.1.0-beta.1`

Created via `asp repo publish <spaceId> --tag vX.Y.Z`.

## Dist-Tags

Mutable channel pointers stored in `registry/dist-tags.json`:
- `stable` - Production-ready version
- `latest` - Most recent version (may be prerelease)
- `beta` - Beta channel
- Custom tags supported

Updated via `asp repo publish <spaceId> --tag vX.Y.Z --dist-tag stable`.

## Lock File Versioning

- `lockfileVersion: 1` - Lock file format version
- `resolverVersion: 1` - Resolution algorithm version

Both must be `1` for current implementation.

---

# Appendix A: Type Definitions

## Core Types

```typescript
// Space identifier (kebab-case, 1-64 chars)
type SpaceId = string & { readonly __brand: 'SpaceId' }

// Git commit SHA (7-64 hex chars)
type CommitSha = string & { readonly __brand: 'CommitSha' }

// SHA256 integrity hash
type Sha256Integrity = `sha256:${string}`

// Space key: <id>@<commit-prefix>
type SpaceKey = `${string}@${string}`

// Space reference string: space:<id>@<selector>
type SpaceRefString = `space:${string}@${string}`

// Selector types
type Selector =
  | { kind: 'dev' }
  | { kind: 'head' }
  | { kind: 'dist-tag'; tag: string }
  | { kind: 'semver'; range: string; exact: boolean }
  | { kind: 'git-pin'; sha: CommitSha }
```

## Validation Patterns

```javascript
// Space ID
/^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Commit SHA
/^[0-9a-f]{7,64}$/

// Integrity hash
/^sha256:([0-9a-f]{64}|dev)$/

// Space reference
/^space:[a-z0-9]+(?:-[a-z0-9]+)*@.+$/
```

---

# Appendix B: Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ASP_HOME` | `~/.asp` | ASP home directory |
| `ASP_CLAUDE_PATH` | (auto-detect) | Path to Claude binary |

---

# Appendix C: File Locking

The system uses file-based locking to prevent concurrent modifications:

- **Project lock**: `.asp.lock` in project root
- **Store lock**: `store.lock` in ASP_HOME

Lock acquisition uses exponential backoff with configurable timeout.

---

# Appendix D: Garbage Collection

`asp gc` removes unreferenced entries based on lock file reachability:

1. Compute reachable sets from project lock and global lock
2. Delete snapshots not in reachable integrities
3. Delete cache entries not in reachable cache keys
4. Report statistics (items deleted, bytes freed)

Use `--dry-run` to preview without deleting.
