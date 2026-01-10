Continuing the v2 relaunch spec: this iteration adds **formal file schemas**, the **exact resolution algorithm** (dist-tags + semver + pins + dependency closure), and **store/cache key derivations** (integrity + env hash) so implementation can start without inventing semantics later. I’m still using the v1 extraction only as a reference point for what existed, not as compatibility constraints.  [oai_citation:0‡AS2-SPEC.md](sediment://file_00000000d12871f88e7148e5b46d7e9d)

All runtime materialization is built around Claude Code’s plugin contract: `.claude-plugin/plugin.json` is required; component dirs (`commands/`, `agents/`, `skills/`, `hooks/`) must be at plugin root (not under `.claude-plugin/`); plugin `name` is required and is kebab-case/no spaces; paths must be relative and start with `./`; `${CLAUDE_PLUGIN_ROOT}` is the supported way to reference absolute plugin root from hooks/MCP/scripts.  [oai_citation:1‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

---

# 1. File schemas

## 1.1 `spaces/<id>/space.toml`

A Space is the authored unit in the registry repo. The Space layout is intentionally near-isomorphic to a Claude plugin layout so materialization is mostly “copy + generate plugin.json.” (Claude default discovery loads default dirs; custom paths supplement defaults.  [oai_citation:2‡Claude Code](https://code.claude.com/docs/en/plugins-reference))

### `space.toml` schema (JSON Schema over parsed TOML object)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-spaces/spec/v2/space.schema.json",
  "title": "Agent Spaces v2 - space.toml",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "id"],
  "properties": {
    "schema": { "type": "integer", "const": 1 },

    "id": {
      "type": "string",
      "description": "Space identifier; also default plugin name unless overridden",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
      "minLength": 1,
      "maxLength": 64
    },

    "version": {
      "type": "string",
      "description": "Semantic version for the Space/plugin; used for semver resolution and plugin.json version when present",
      "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
    },

    "description": { "type": "string", "maxLength": 500 },

    "plugin": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "description": "Claude plugin name override; must be kebab-case, no spaces",
          "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          "minLength": 1,
          "maxLength": 64
        },
        "version": {
          "type": "string",
          "description": "Override for plugin.json version; semver recommended",
          "pattern": "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
        },
        "description": { "type": "string", "maxLength": 500 },

        "author": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "name": { "type": "string", "maxLength": 120 },
            "email": { "type": "string", "format": "email", "maxLength": 254 },
            "url": { "type": "string", "format": "uri" }
          }
        },

        "homepage": { "type": "string", "format": "uri" },
        "repository": { "type": "string", "format": "uri" },
        "license": { "type": "string", "maxLength": 100 },
        "keywords": {
          "type": "array",
          "items": { "type": "string", "maxLength": 50 },
          "maxItems": 30
        }
      }
    },

    "deps": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "spaces": {
          "type": "array",
          "description": "Transitive deps (spaces only). Each entry is a space ref string.",
          "items": { "$ref": "#/$defs/spaceRef" },
          "default": []
        }
      }
    }
  },

  "$defs": {
    "spaceRef": {
      "type": "string",
      "description": "space:<id>@<selector>",
      "pattern": "^space:[a-z0-9]+(?:-[a-z0-9]+)*@.+$"
    }
  }
}
```

Notes:
- `plugin.*` is an optional metadata overlay mapped into Claude’s plugin manifest schema fields (name required; version/description/etc optional).  [oai_citation:3‡Claude Code](https://code.claude.com/docs/en/plugins-reference)  
- The actual plugin component discovery is file-structure-driven; `space.toml` doesn’t enumerate commands/skills/hooks—those are discovered from directories that match Claude’s conventions.  [oai_citation:4‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

---

## 1.2 `asp-targets.toml` (project root)

This is the **project-level composition surface**. Run Targets compose Spaces (spaces only for now).

### `asp-targets.toml` schema (JSON Schema over parsed TOML object)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-spaces/spec/v2/targets.schema.json",
  "title": "Agent Spaces v2 - asp-targets.toml",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "targets"],
  "properties": {
    "schema": { "type": "integer", "const": 1 },

    "claude": {
      "type": "object",
      "description": "Default claude options applied to all targets unless overridden",
      "additionalProperties": false,
      "properties": {
        "model": { "type": "string" },
        "permission_mode": { "type": "string" },
        "args": {
          "type": "array",
          "description": "Pass-through CLI args to `claude` (stable escape hatch as Claude evolves)",
          "items": { "type": "string" }
        }
      }
    },

    "targets": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": { "$ref": "#/$defs/target" }
    }
  },

  "$defs": {
    "spaceRef": {
      "type": "string",
      "pattern": "^space:[a-z0-9]+(?:-[a-z0-9]+)*@.+$"
    },
    "target": {
      "type": "object",
      "additionalProperties": false,
      "required": ["compose"],
      "properties": {
        "description": { "type": "string", "maxLength": 300 },

        "compose": {
          "type": "array",
          "description": "Ordered list of space refs. Later entries are higher-precedence for collision warnings and load order.",
          "minItems": 1,
          "items": { "$ref": "#/$defs/spaceRef" }
        },

        "claude": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "model": { "type": "string" },
            "permission_mode": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } }
          }
        },

        "resolver": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "locked": { "type": "boolean", "default": true },
            "allow_dirty": { "type": "boolean", "default": true }
          }
        }
      }
    }
  }
}
```

Rationale for `claude.args`: Claude CLI changes; we don’t want spec churn. `asp` will pass `claude.args` verbatim after validation (string list), and will always supply `--plugin-dir` flags it materializes. Claude’s docs explicitly support local testing via `--plugin-dir`, and loading multiple plugins by repeating the flag.  [oai_citation:5‡Claude Code](https://code.claude.com/docs/en/plugins)

---

## 1.3 `asp-lock.json` (project root)

The lock is the reproducibility anchor. It pins Space selection to concrete commits and content integrity, and records the deterministic plugin load order.

### `asp-lock.json` schema (JSON Schema)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-spaces/spec/v2/lock.schema.json",
  "title": "Agent Spaces v2 - asp-lock.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["lockfileVersion", "resolverVersion", "generatedAt", "registry", "spaces", "targets"],
  "properties": {
    "lockfileVersion": { "type": "integer", "const": 1 },
    "resolverVersion": { "type": "integer", "const": 1 },
    "generatedAt": { "type": "string", "format": "date-time" },

    "registry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["type", "url"],
      "properties": {
        "type": { "type": "string", "const": "git" },
        "url": { "type": "string" },
        "defaultBranch": { "type": "string" }
      }
    },

    "spaces": {
      "type": "object",
      "description": "Content-addressed space entries keyed by spaceKey = '<id>@<commit>'",
      "additionalProperties": { "$ref": "#/$defs/spaceEntry" }
    },

    "targets": {
      "type": "object",
      "description": "Per-run-target resolution results",
      "additionalProperties": { "$ref": "#/$defs/targetEntry" }
    }
  },

  "$defs": {
    "sha256Integrity": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },

    "spaceKey": {
      "type": "string",
      "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*@[0-9a-f]{7,64}$"
    },

    "spaceRef": {
      "type": "string",
      "pattern": "^space:[a-z0-9]+(?:-[a-z0-9]+)*@.+$"
    },

    "spaceEntry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id", "commit", "path", "integrity", "plugin", "deps"],
      "properties": {
        "id": { "type": "string" },
        "commit": { "type": "string", "pattern": "^[0-9a-f]{7,64}$" },
        "path": { "type": "string", "description": "Path in registry repo, e.g. 'spaces/todo-frontend'" },

        "integrity": { "$ref": "#/$defs/sha256Integrity" },

        "plugin": {
          "type": "object",
          "additionalProperties": false,
          "required": ["name"],
          "properties": {
            "name": { "type": "string" },
            "version": { "type": "string" }
          }
        },

        "deps": {
          "type": "object",
          "additionalProperties": false,
          "required": ["spaces"],
          "properties": {
            "spaces": {
              "type": "array",
              "items": { "$ref": "#/$defs/spaceKey" },
              "default": []
            }
          }
        },

        "resolvedFrom": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "selector": { "type": "string" },
            "tag": { "type": "string" },
            "semver": { "type": "string" }
          }
        }
      }
    },

    "targetEntry": {
      "type": "object",
      "additionalProperties": false,
      "required": ["compose", "roots", "loadOrder", "envHash"],
      "properties": {
        "compose": {
          "type": "array",
          "items": { "$ref": "#/$defs/spaceRef" },
          "minItems": 1
        },

        "roots": {
          "type": "array",
          "description": "Resolved root spaces corresponding to compose entries (one per compose entry)",
          "items": { "$ref": "#/$defs/spaceKey" },
          "minItems": 1
        },

        "loadOrder": {
          "type": "array",
          "description": "Deterministic plugin-dir order including transitive deps (deps before dependents)",
          "items": { "$ref": "#/$defs/spaceKey" },
          "minItems": 1
        },

        "envHash": { "$ref": "#/$defs/sha256Integrity" },

        "warnings": {
          "type": "array",
          "items": { "$ref": "#/$defs/warning" },
          "default": []
        }
      }
    },

    "warning": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message"],
      "properties": {
        "code": { "type": "string" },
        "message": { "type": "string" },
        "details": { "type": "object" }
      }
    }
  }
}
```

This intentionally mirrors "package-lock" conventions: the manifest expresses intent (`@stable`, ranges), the lock stores resolved commits + integrity and a normalized load order.

---

## 1.4 `registry/dist-tags.json`

Dist-tags are stored as committed metadata in the registry repository (not as moving git tags). This makes channel promotions PR-reviewable.

### `dist-tags.json` schema (JSON Schema)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-spaces/spec/v2/dist-tags.schema.json",
  "title": "Agent Spaces v2 - dist-tags.json",
  "type": "object",
  "description": "Maps space IDs to dist-tag → version mappings",
  "additionalProperties": {
    "type": "object",
    "description": "Dist-tag → version mapping for a space",
    "additionalProperties": {
      "type": "string",
      "description": "Version string (e.g., 'v1.2.0') corresponding to a git tag",
      "pattern": "^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$"
    }
  }
}
```

Example:
```json
{
  "todo-frontend": {
    "stable": "v1.2.0",
    "latest": "v1.3.0-beta.1",
    "beta": "v1.3.0-beta.1"
  },
  "shared-quality": {
    "stable": "v1.3.2",
    "latest": "v1.3.2"
  }
}
```

Notes:
- The file is committed to `registry/dist-tags.json` in the registry repository.
- Each key is a space ID (kebab-case).
- Each value is an object mapping dist-tag names to version strings.
- Version strings should correspond to existing git tags (e.g., `stable: "v1.2.0"` means there should be a tag `space/<id>/v1.2.0`).
- Common dist-tags: `stable`, `latest`, `beta`, `alpha`, `canary`.
- `asp repo publish` is responsible for updating this file atomically with git tag creation.

---

# 2. Resolution algorithm

## 2.1 Inputs and discovery

`asp run` / `asp install` starts by finding **project root**: walk up from CWD looking for `asp-targets.toml`.

- If found: project mode (use project `asp-lock.json`).
- If not found: global mode (see §2.7).

## 2.2 Parse + validate

Parse TOML, validate against schemas above. Fail fast on structural issues; do not attempt partial resolution.

## 2.3 Space reference semantics

A **Space ref** is: `space:<id>@<selector>`.

Selector support (v2.0):
- Dist-tags: `stable`, `latest`, `beta` (string tokens)
- Semver:
  - exact: `1.2.3`
  - ranges: `^1.2.0`, `~1.2.3`
- Direct pin:
  - `git:<sha>` (commit hash in registry repo)

Any selector that doesn’t parse into the above is an error.

## 2.4 Dist-tag + semver resolution against a git monorepo

Registry is a git repo clone under `$ASP_HOME/repo` (mono). Resolution uses committed metadata and git tags for mapping selectors to commits:

- Dist-tag: look up version from `registry/dist-tags.json`, then resolve git tag `space/<id>/<version>` → commit
  - Example: `stable` → read `dist-tags.json["my-space"]["stable"]` → `"v1.2.0"` → resolve tag `space/my-space/v1.2.0` → commit
- Semver:
  - enumerate tags `space/<id>/v*`
  - parse `vX.Y.Z`
  - choose highest satisfying the selector range
- `git:<sha>`: use that commit directly

`asp repo publish` is responsible for writing/updating these tags consistently; the runtime resolver assumes they exist.

Reliability caveat: if tags are missing or malformed, resolution errors; no fallback to “scan commits for space.toml versions” in v2.0 (too slow and ambiguous).

## 2.5 Dependency closure (Space-level deps)

Once a root Space resolves to a commit, we read `spaces/<id>/space.toml` at that commit, parse `deps.spaces`, and resolve each dep the same way. Repeat until closure is complete.

Cycle handling: if a cycle is detected, fail resolution (warning is insufficient; it’s non-executable).

Deterministic load order is computed via **ordered DFS postorder** over the graph, starting from the composed roots in order:

```
visit(space):
  if visited(space): return
  mark visited(space)
  for dep in deps(space) in declared order:
    visit(dep)
  append(space)  # postorder

for root in roots in compose order:
  visit(root)

loadOrder = appended list
```

This guarantees dependencies appear before dependents and is stable if dep lists are stable.

## 2.6 Lockfile generation

Given `roots` and `loadOrder`:

- Create/refresh `spaces` entries:
  - `spaceKey = "<id>@<commit>"`
  - `integrity` computed per §3.1
  - record `deps.spaces` as `spaceKey`s
  - record `plugin.name` and optional `plugin.version` (derived from `space.toml`, see §3.2)
- Create/refresh `targets[targetName]`:
  - `compose`: verbatim list from `asp-targets.toml`
  - `roots`: list of `spaceKey`s corresponding to each compose entry
  - `loadOrder`: list of `spaceKey`s
  - `envHash`: computed per §3.3
  - `warnings`: computed by linter (collisions, etc.; warn-only per your requirement)

Locked-by-default policy:
- If `asp-lock.json` exists and matches the manifest (same `compose` strings), `asp run` uses it (no implicit updates).
- If manifest differs from lock, `asp run` warns and either:
  - requires `asp install` (strict mode), or
  - auto-regenerates lock (default mode).  
For v2.0 I recommend auto-regenerate with loud warning to keep workflow tight.

## 2.7 Global mode behavior (outside a project)

`asp run space:<id>@<selector>` outside a project still resolves and materializes exactly the same way, but stores pins in a **global lock cache** at `$ASP_HOME/global-lock.json` (same schema, but targets are synthetic). This satisfies “both” lock scopes and keeps “locked-by-default” even for ad-hoc runs.

---

# 3. Store keys, integrity, and env hashing

## 3.1 Space snapshot integrity (content hash)

Each resolved Space entry gets `integrity = sha256:<hex>` computed from the Space directory content at the resolved commit, excluding cache/build junk.

**Inclusions:** everything under the Space root (`spaces/<id>/…`) at that commit, including commands/agents/skills/hooks/scripts and `space.toml`.

**Exclusions (v2.0 fixed list):**
- `.git/`
- `.asp/`
- `node_modules/`
- `dist/`
- any file matched by an optional `.aspignore` in the space root (future; not required for v2.0)

**Canonical hash algorithm:**

The implementation uses **git-tree-based hashing** for performance (no file I/O required when computing from git). This leverages git's pre-computed blob OIDs.

- Use `git ls-tree -r <commit>:spaces/<id>` to list all entries.
- Filter out excluded paths (`.git/`, `.asp/`, `node_modules/`, `dist/`).
- Sort entries lexicographically by path.
- For each entry, use the **git blob OID** directly:
  - Git blob OID = SHA-1(`"blob " + contentLength + "\0" + contentBytes`)
  - This is what git stores internally for each file.
- Compute overall integrity as SHA-256 of the concatenation:

```
"v1\0" +
for each entry:
  path + "\0" + type + "\0" + gitBlobOid + "\0" + modeOctal + "\n"
```

Where `type` is "blob" for files.

**Note:** When verifying snapshots on disk (outside git), compute git-style blob OIDs from file contents to match. This ensures compatibility between registry-based computation and filesystem-based verification.

This avoids tar metadata nondeterminism and gives portable integrity while being fast (leverages git's existing hashes).

Store placement:
- `$ASP_HOME/store/<integrityHex>/...` contains an extracted snapshot directory plus a small metadata file (id, commit, path, generatedAt). The integrity hash (without the `sha256:` prefix) is used directly as the directory name for simplicity.

Verification:
- When reading from store, recompute integrity and require match before use.

## 3.2 Per-space materialization key

A Space’s materialized plugin dir is cacheable across targets/projects.

`pluginCacheKey = sha256("materializer-v1\0" + spaceIntegrity + "\0" + pluginName + "\0" + pluginVersion + "\n")`

Materialized dir path:
- `$ASP_HOME/cache/<pluginCacheKey>/...` contains the materialized plugin with `.claude-plugin/plugin.json` and component directories at root.

This avoids regenerating `.claude-plugin/plugin.json` and copying files on every run.

## 3.3 Environment hash (`envHash`)

`envHash` is used for:
- stable log keys
- composing MCP config aggregation (if needed)
- “resolved environment identity”

It MUST change if and only if the runtime-visible environment changes (plugins loaded and their content).

Definition:

```
envHash = sha256("env-v1\0" + for each spaceKey in loadOrder:
  spaceKey + "\0" + spaceIntegrity + "\0" + pluginName + "\n")
```

What is **included**:
- `loadOrder` (because plugin load order can affect user experience on collisions)
- each Space’s `integrity`
- each Space’s `plugin.name`

What is **excluded** (by design):
- absolute project paths
- timestamps
- user/machine identifiers
- `claude` runtime flags like model/permission mode (those affect session behavior, but not the *environment bundle*; if you want session reproducibility later, add a separate `sessionHash`)

---

# 4. Materialization into Claude plugins

## 4.1 Generated `plugin.json`

We generate `.claude-plugin/plugin.json` for each Space plugin dir. Minimal valid manifest requires `name` (kebab-case, no spaces). We also set `version`/`description` if available.  [oai_citation:6‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

We do **not** set `commands`/`agents`/`skills`/`hooks` paths unless we need non-default paths, because Claude loads default dirs and custom paths *supplement* them.  [oai_citation:7‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

If we ever set custom paths, we must enforce Claude’s rules: paths are relative to plugin root and must start with `./`.  [oai_citation:8‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

## 4.2 Hooks constraints enforced by linter/materializer

Claude plugin hooks can be in `hooks/hooks.json` or inline in `plugin.json`, with event matchers and hook actions; `${CLAUDE_PLUGIN_ROOT}` should be used for paths.  [oai_citation:9‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

We enforce:
- `hooks/hooks.json` must parse and match Claude format
- all `command` hook script paths should use `${CLAUDE_PLUGIN_ROOT}`
- hook event names must match Claude’s documented event set (case-sensitive)  [oai_citation:10‡Claude Code](https://code.claude.com/docs/en/plugins-reference)

## 4.3 Runtime invocation

For a target with `loadOrder = [S1, S2, ...]`, `asp run` executes:

- `claude --plugin-dir <pluginDir(S1)> --plugin-dir <pluginDir(S2)> ...`

Claude docs explicitly support local testing via `--plugin-dir` and loading multiple plugins by repeating the flag.  [oai_citation:11‡Claude Code](https://code.claude.com/docs/en/plugins)

---

# 5. Conflict warnings (warn-only policy)

Because collisions aren’t fatal by default, `asp` must always emit explicit warnings during `asp install` and before `asp run`.

Warning set for v2.0:
- `W201 command-name-collision`: same command name appears in multiple Spaces. Suggest disambiguated invocations using Claude's `/plugin-name:command` namespacing. (Claude supports plugin namespacing for commands.  [oai_citation:12‡Claude Code](https://code.claude.com/docs/en/plugins-reference))
- `W202 agent-command-namespace`: an agent doc references an unqualified `/command` that appears to be provided by a plugin Space; recommend using `/space:command` due to known agent discovery issues.
- `W203 hook-path-no-plugin-root`: hook command path doesn't include `${CLAUDE_PLUGIN_ROOT}`.
- `W204 invalid-hooks-config`: hooks/ directory exists but hooks.json is missing, invalid, or references missing scripts.
- `W205 plugin-name-collision`: two Spaces produce the same plugin `name` (bad because namespacing becomes ambiguous; user should override `plugin.name` in one Space).
- `W206 non-executable-hook-script`: hook script file is not executable (missing +x permission).
- `W207 invalid-plugin-structure`: component directories nested incorrectly (e.g. `commands/` inside `.claude-plugin/`).
- `W301 lock-missing` (info severity): project has targets but no lock; `asp run` will generate lock.

---

# 6. Manager Space

Agent Spaces v2 ships with a built-in `agent-spaces-manager` space that provides authoring commands and guidance. The manager space is automatically installed during `asp repo init` (unless `--no-manager` is passed).

**Components:**
- **Commands**: `create-space`, `add-command`, `add-skill`, `add-hook`, `bump-version`, `publish`, `update-project-targets`, `help`
- **Skills**: `space-authoring` - comprehensive guide for creating spaces
- **Agents**: `manager` - coordinator agent for repo + project workflows

**Key Design Decision**: All commands use fully-qualified names (`/agent-spaces-manager:command`) to avoid agent namespace discovery issues with unqualified `/command` references in agent documentation.

For full details on the manager space responsibilities and layout, see AGENT-SPACES-V2-SPEC.md section 9.

---

If you want the next iteration to be even more "drop into implementation," I can follow this with: (a) concrete `asp install`/`asp run` pseudocode (resolver + git tag lookup + dep closure + cache lookup), and (b) an explicit "registry tagging spec" for `asp repo publish` (tag naming, atomic updates, and what gets validated before tagging).  [oai_citation:13‡AS2-SPEC.md](sediment://file_00000000d12871f88e7148e5b46d7e9d)
