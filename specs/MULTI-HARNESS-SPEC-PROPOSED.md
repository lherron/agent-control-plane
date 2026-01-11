# Multi-Harness Support Specification

> **Status:** Proposal (Revised)
> **Author:** Claude
> **Date:** 2026-01-11
> **Target:** Agent Spaces v2
> **Revision:** 2 (incorporates architecture review feedback)

## Abstract

This specification extends Agent Spaces v2 to support multiple coding agent harnesses beyond Claude Code. The initial implementation adds support for the Pi coding agent, with an architecture designed to accommodate additional harnesses in the future.

This revision aligns with the shipped v2 architecture, ensuring multi-harness support is **additive** rather than a rewrite.

---

## Table of Contents

1. [Motivation](#motivation)
2. [Harness Analysis](#harness-analysis)
   - [Claude Code](#claude-code)
   - [Pi Coding Agent](#pi-coding-agent)
   - [Key Differences](#key-differences)
3. [Design Principles](#design-principles)
4. [Space Source Directory Structure](#space-source-directory-structure)
5. [Manifest Schema Changes](#manifest-schema-changes)
6. [Output Directory Structure](#output-directory-structure)
7. [Two-Phase Materialization](#two-phase-materialization)
8. [Harness Adapter Interface](#harness-adapter-interface)
9. [CLI Changes](#cli-changes)
10. [Target Configuration](#target-configuration)
11. [Permissions Model](#permissions-model)
12. [Hooks Unification](#hooks-unification)
13. [Pi Tool Namespacing](#pi-tool-namespacing)
14. [Pi Extension Building](#pi-extension-building)
15. [Edge Cases](#edge-cases)
16. [Migration Path](#migration-path)
17. [Open Questions](#open-questions)

---

## Motivation

Agent Spaces currently assumes Claude Code as the only harness. This limits:

1. **Portability** - Spaces can't be used with other coding agents
2. **Experimentation** - Teams can't compare agents on identical capability sets
3. **Resilience** - No fallback if one agent has issues

Adding Pi as a second harness validates the abstraction layer and establishes patterns for future harnesses.

---

## Harness Analysis

### Claude Code

**Binary:** `claude` (detected via `claude --version`)

**Plugin System (as exercised by Agent Spaces v2):**
- A plugin is a directory with `.claude-plugin/plugin.json`
- Component directories live at **plugin root** (siblings of `.claude-plugin/`):
  - `commands/` - Slash commands
  - `agents/` - Subagent definitions
  - `skills/` - Agent Skills standard (`skills/<skill-id>/SKILL.md`)
  - `hooks/` - Hook scripts + `hooks/hooks.json`
  - `scripts/` - Shared scripts
  - `mcp/` - MCP server configurations
- Hooks are configured via `hooks/hooks.json` (not inside `.claude-plugin/`)
- MCP servers are authored per-space under `mcp/` and **composed across spaces** into a single `mcp.json` passed via `--mcp-config`
- Settings are **composed across spaces/targets** into a single `settings.json` passed via `--settings`

**Tool Extension Mechanism:** MCP (Model Context Protocol)
- JSON-RPC 2.0 over stdio or SSE
- Servers expose: Resources, Tools, Prompts
- Configuration: JSON files specifying command, args, env
- Example MCP config:
  ```json
  {
    "mcpServers": {
      "sqlite": {
        "command": "npx",
        "args": ["-y", "@anthropic/mcp-sqlite", "database.db"]
      }
    }
  }
  ```

**CLI Invocation (v2 pattern):**
```bash
claude --plugin-dir /path/to/plugin-root-1 \
       --plugin-dir /path/to/plugin-root-2 \
       --mcp-config /path/to/composed-mcp.json \
       --settings /path/to/composed-settings.json \
       --setting-sources none \
       --model sonnet \
       /path/to/project
```

**Key Flags:**
- `--plugin-dir` - Load plugin from directory (repeatable for multi-plugin)
- `--mcp-config` - Composed MCP server config
- `--settings` - Composed settings JSON
- `--setting-sources` - Control settings inheritance (`none`, `project`, `user`, `all`)
- `--model` - Model selection
- `--permission-mode` - Permission handling mode

**Hooks Events:**
- `PreToolUse`, `PostToolUse`
- `Notification`
- `Stop`

**Settings Locations:**
- User: `~/.claude/settings.json`
- Project: `.claude/settings.json`
- Plugin: `.claude-plugin/settings.json` (not used by v2 - we compose instead)

---

### Pi Coding Agent

**Binary:** `pi` (located at `~/tools/pi-mono`)

**Plugin System:**
- No formal plugin directory structure (yet)
- Extensions loaded from paths specified via CLI or settings
- Skills loaded from SKILL.md files (Agent Skills standard - same as Claude)

**Tool Extension Mechanism:** TypeScript Extensions
- In-process execution (not separate process like MCP)
- Extensions are TypeScript modules exporting a function:
  ```typescript
  import { ExtensionAPI, ToolDefinition } from '@anthropic/coding-agent';
  import { Type } from '@sinclair/typebox';

  export default function(pi: ExtensionAPI) {
    pi.registerTool({
      name: "my_tool",
      label: "My Tool",
      description: "What this tool does",
      parameters: Type.Object({
        path: Type.String({ description: "File path" })
      }),
      async execute(toolCallId, params, onUpdate, ctx, signal) {
        // Implementation
        return {
          content: [{ type: "text", text: "Result" }],
          details: { success: true }
        };
      }
    });
  }
  ```

**Skill System:**
- SKILL.md files following Agent Skills standard (agentskills.io)
- Same format as Claude skills: `skills/<skill-id>/SKILL.md`
- Frontmatter with metadata:
  ```markdown
  ---
  name: code-review
  description: Reviews code for issues
  license: MIT
  compatibility: Node.js 18+
  ---
  # Code Review Skill
  Instructions for the agent...
  ```

**CLI Invocation:**
```bash
pi --extension /path/to/extension.js \
   --skills /path/to/skills/ \
   --model claude-sonnet \
   --tools "Bash,Read,Write" \
   /path/to/project
```

**Key Flags:**
- `--extension` - Load bundled extension (repeatable)
- `--skills` - Directory containing skill subdirectories
- `--tools` - Enabled built-in tools
- `--model` - Model selection (provider-prefixed)

**Event System:**
- `session_start`, `session_end`
- `before_agent_start`, `after_agent_turn`
- `tool_call`, `tool_result`
- `error`

**Settings Locations:**
- User: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

---

### Key Differences

| Aspect | Claude Code | Pi Coding Agent |
|--------|-------------|-----------------|
| **Tool Protocol** | MCP (JSON-RPC, separate process) | Extensions (TypeScript, in-process) |
| **Tool Definition** | JSON config pointing to binary | TypeScript module with schema |
| **Plugin Directory** | `.claude-plugin/` + component dirs | None (CLI flags) |
| **Skill System** | `skills/<id>/SKILL.md` | Same (Agent Skills standard) |
| **Hook Format** | JSON + shell scripts | TypeScript event handlers |
| **Model Naming** | `sonnet`, `opus`, `haiku` | `claude-sonnet`, `openai-gpt4`, etc. |
| **Settings Format** | JSON | JSON |
| **Permissions** | In settings.json or plugin.json | Via CLI flags |
| **Multi-space** | Multiple `--plugin-dir` flags | Composed extension bundle |

**Critical Insight:** MCP and Extensions solve the same problem differently. MCP tools run as separate processes. Extensions run in-process. There is no perfect abstraction that covers both—they must be handled separately, but the **skill system is shared**.

---

## Design Principles

1. **v2-Compatible Layout** - Source spaces are a superset of v2 Claude spaces
2. **Concept-Named Directories** - Use `mcp/`, `extensions/` rather than `claude/`, `pi/`
3. **Two-Phase Materialization** - Per-space artifacts (cacheable) + per-target composition
4. **Unified Manifest** - Single `space.toml` extended with harness sections
5. **Shared Where Possible** - Skills, hooks (shell scripts), instructions work for both
6. **Explicit Over Magic** - No automatic MCP↔Extension translation
7. **Auditable Translations** - `asp explain --harness X` shows exactly what gets generated

---

## Space Source Directory Structure

### Recommended Structure (v2-Compatible Superset)

```
my-space/
├── space.toml              # v2-compatible manifest (extended with harness sections)
├── AGENT.md                # Optional harness-agnostic instructions
├── permissions.toml        # Optional: granular permissions definition
│
├── commands/               # Claude: slash commands (v2-compatible)
│   └── review/
│       └── COMMAND.md
├── agents/                 # Claude: subagents (v2-compatible)
│   └── reviewer/
│       └── AGENT.md
├── scripts/                # Shared scripts (v2-compatible)
│   └── lint.sh
├── hooks/                  # Claude: hooks/hooks.json + scripts
│   ├── hooks.toml          # Preferred: harness-agnostic hook mapping
│   ├── hooks.json          # Legacy: Claude-specific (auto-generated if hooks.toml present)
│   ├── pre-tool-use.sh
│   └── post-tool-use.sh
├── mcp/                    # Claude: MCP servers (v2 mcp/mcp.json or fragments)
│   ├── mcp.json            # Single file form (preferred)
│   └── sqlite.json         # Or fragment form (merged during composition)
│
├── extensions/             # Pi: TypeScript extension modules
│   ├── database.ts
│   ├── api-client.ts
│   └── package.json        # Optional: dependencies for bundling
│
├── skills/                 # Agent Skills standard (SHARED by both harnesses)
│   ├── code-review/
│   │   └── SKILL.md
│   └── testing/
│       └── SKILL.md
│
├── settings/               # Harness-specific settings overrides
│   ├── claude.toml         # Claude-specific settings
│   └── pi.toml             # Pi-specific settings
│
└── shared/                 # Files copied to both outputs
    ├── templates/
    │   └── pr-template.md
    └── data/
        └── config.json
```

### Directory Semantics

| Directory | Claude Materializer | Pi Materializer |
|-----------|--------------------|-----------------|
| `commands/` | Copied to plugin root | Ignored |
| `agents/` | Copied to plugin root | Ignored |
| `scripts/` | Copied to plugin root | Copied to output |
| `hooks/` | → `hooks/hooks.json` | → Hook bridge extension |
| `mcp/` | → composed `mcp.json` | Ignored |
| `extensions/` | Ignored | → bundled JS |
| `skills/` | Copied to plugin root | Copied to output |
| `settings/claude.toml` | → composed `settings.json` | Ignored |
| `settings/pi.toml` | Ignored | → `settings.json` |
| `shared/` | Copied to plugin root | Copied to output |
| `AGENT.md` | Renamed to `CLAUDE.md` | Used as instructions |

### Single-Harness Spaces

For spaces targeting only one harness, unused directories are simply absent:

```
claude-only-space/
├── space.toml
├── commands/
├── mcp/
│   └── mcp.json
└── skills/
    └── code-review/
        └── SKILL.md
```

```
pi-only-space/
├── space.toml
├── extensions/
│   └── database.ts
└── skills/
    └── code-review/
        └── SKILL.md
```

---

## Manifest Schema Changes

### space.toml (v2-Compatible Extension)

```toml
# ============================================================================
# v2-COMPATIBLE FIELDS (unchanged)
# ============================================================================

schema = 1
id = "fullstack-dev"
version = "1.0.0"
description = "Full-stack development environment"

# Plugin metadata (v2-compatible)
[plugin]
name = "fullstack-dev"
author = { name = "Team", email = "team@example.com" }

# Dependencies (v2-compatible)
[deps]
spaces = [
  "space:base@^1.0.0",
  "space:testing@^2.0.0",
]

# Claude settings (v2-compatible)
[settings]
model = "sonnet"
[settings.permissions]
allow = ["Read", "Write", "Bash"]
deny = ["mcp__*"]
[settings.env]
NODE_ENV = "development"

# ============================================================================
# NEW: MULTI-HARNESS EXTENSIONS
# ============================================================================

## Optional: declare harness support/requirements.
## If omitted, inferred from directories (mcp/ → claude, extensions/ → pi)
[harness]
supports = ["claude", "pi"]
# optional: minimum harness versions/capabilities (used for lint)
# [harness.requires]
# claude = ">=0.9.0"
# pi = ">=0.3.0"

# Optional: harness-specific dependencies
# Only applied when composing for that harness
[deps.claude]
spaces = ["space:mcp-tools@^1.0.0"]

[deps.pi]
spaces = ["space:pi-extensions@^1.0.0"]

# Claude-specific configuration (supplements [settings])
[claude]
model = "sonnet"
# Optional: explicit MCP config paths (otherwise auto-discover mcp/)
mcp = ["mcp/mcp.json"]

# Pi-specific configuration
[pi]
model = "claude-sonnet"

# Optional: explicit extension list (otherwise auto-discover extensions/)
extensions = [
    "extensions/database.ts",
    "extensions/api-client.ts",
]

# Optional: build configuration for extensions
[pi.build]
bundle = true         # Bundle extensions to JS (default: true)
format = "esm"        # Output format: "esm" or "cjs"
target = "bun"        # Target runtime: "bun" or "node"
external = ["pg"]     # Dependencies to exclude from bundle
```

### hooks.toml (Harness-Agnostic Hook Mapping)

```toml
# hooks.toml - Canonical hook declaration
# Materializers translate this to harness-specific formats:
# - Claude: generates hooks/hooks.json
# - Pi: generates hook bridge extension

[[hook]]
event = "pre_tool_use"
script = "hooks/pre-tool-use.sh"
tools = ["Bash", "Write"]  # Optional: filter to specific tools
blocking = true            # Semantics: can this hook block tool execution?

[[hook]]
event = "post_tool_use"
script = "hooks/post-tool-use.sh"
blocking = false

[[hook]]
event = "session_end"
script = "hooks/cleanup.sh"

# Harness-specific hook (only runs on Pi)
[[hook]]
event = "before_agent_start"
harness = "pi"
script = "hooks/pi-init.sh"
```

### permissions.toml (Optional Granular Permissions)

```toml
# permissions.toml - Granular permission definitions
# Translated per-harness with explicit enforcement classification

[read]
paths = [
    ".",
    "~/.config/myapp",
    "/etc/hosts",
]

[write]
paths = [
    "./src",
    "./tests",
    "./dist",
]

[exec]
commands = [
    "npm",
    "bun",
    "git",
]
# Patterns for dynamic commands
patterns = [
    "npm run *",
    "bun test *",
]

[network]
hosts = [
    "api.example.com:443",
    "*.npmjs.org:443",
]

# Deny rules (override allows)
[deny]
read = [
    ".env",
    ".env.local",
    "**/*.pem",
]
write = [
    "package-lock.json",
]
exec = [
    "rm -rf /",
    "sudo *",
]
```

---

## Output Directory Structure

### Project Layout (v2-Compatible; Harness Subdirectories Are Additive)

```
project/
├── asp-targets.toml
├── asp-lock.json               # Unified lock file (project root, NOT in asp_modules)
├── asp_modules/
│   └── fullstack/              # Target name (from asp-targets.toml)
│       ├── claude/
│       │   ├── plugins/        # Ordered plugin directories
│       │   │   ├── 000-base/
│       │   │   │   ├── .claude-plugin/
│       │   │   │   │   └── plugin.json
│       │   │   │   ├── commands/
│       │   │   │   ├── hooks/
│       │   │   │   │   ├── hooks.json
│       │   │   │   │   └── *.sh
│       │   │   │   ├── mcp/
│       │   │   │   └── skills/
│       │   │   │       └── code-review/
│       │   │   │           └── SKILL.md
│       │   │   │
│       │   │   └── 001-fullstack-dev/
│       │   │       └── ...
│       │   │
│       │   ├── mcp.json        # Composed across all spaces
│       │   └── settings.json   # Composed across all spaces + target overrides
│       │
│       └── pi/
│           ├── extensions/     # Bundled extensions (composed)
│           │   ├── 000-base__database.js
│           │   └── 001-fullstack-dev__api.js
│           ├── skills/         # Merged skills directories
│           │   └── code-review/
│           │       └── SKILL.md
│           ├── hooks/          # Hook scripts
│           │   └── *.sh
│           ├── asp-hooks.bridge.js   # Generated hook bridge extension
│           ├── settings.json   # Composed settings
│           └── asp.pi.json     # Optional: run manifest for Pi
│
└── src/
    └── ...
```

### Lock File Structure (Extends v2 asp-lock.json)

The lock file remains at **project root** (`asp-lock.json`), not inside `asp_modules/`.

```json
{
  "lockfileVersion": 1,
  "resolverVersion": 1,
  "generatedAt": "2026-01-11T10:30:00Z",
  "registry": {
    "type": "git",
    "url": "/path/to/registry"
  },
  "spaces": {
    "base@abc1234": {
      "id": "base",
      "commit": "abc1234567890",
      "path": "spaces/base",
      "integrity": "sha256:...",
      "plugin": { "name": "base", "version": "1.0.0" },
      "deps": { "spaces": [] }
    },
    "fullstack-dev@def5678": {
      "id": "fullstack-dev",
      "commit": "def5678901234",
      "path": "spaces/fullstack-dev",
      "integrity": "sha256:...",
      "plugin": { "name": "fullstack-dev", "version": "2.0.0" },
      "deps": { "spaces": ["base@abc1234"] }
    }
  },
  "targets": {
    "fullstack": {
      "compose": ["space:fullstack-dev@^2.0.0"],
      "roots": ["fullstack-dev@def5678"],
      "loadOrder": ["base@abc1234", "fullstack-dev@def5678"],
      "envHash": "sha256:...",
      "harnesses": {
        "claude": {
          "envHash": "sha256:...",
          "warnings": []
        },
        "pi": {
          "envHash": "sha256:...",
          "warnings": ["W301: Hook 'pre_tool_use' marked blocking=true but Pi cannot block tool calls"]
        }
      }
    }
  }
}
```

---

## Two-Phase Materialization

Agent Spaces v2 already separates:
- Immutable content snapshots (by integrity hash)
- Reusable materialized artifacts (per space; cached)
- Per-target assembly (ordered plugins + composed mcp/settings)

Multi-harness preserves this separation and adds "harness" as a dimension.

### Phase 1: Space Artifact (Cacheable)

`materializeSpace()` produces a reusable, cacheable **space artifact** per harness.

```typescript
interface MaterializeSpaceResult {
  /** Path to the cached artifact */
  artifactPath: string;
  /** Files in the artifact */
  files: string[];
  /** Warnings from materialization */
  warnings: string[];
}
```

**Cache key:** `sha256(spaceIntegrity + harnessId + harnessVersion)`

For Pi, this phase also **bundles extensions** to JS for deterministic execution.

### Phase 2: Target Composition

`composeTarget()` assembles a **target bundle** from ordered space artifacts.

```typescript
interface ComposeTargetResult {
  bundle: ComposedTargetBundle;
  warnings: string[];
}

interface ComposedTargetBundle {
  harnessId: HarnessId;
  targetName: string;
  rootDir: string;               // asp_modules/<target>/<harness>

  // Claude-specific
  pluginDirs?: string[];         // Ordered plugin roots
  mcpConfigPath?: string;        // Composed mcp.json
  settingsPath?: string;         // Composed settings.json

  // Pi-specific
  pi?: {
    extensionsDir: string;       // Bundled extensions
    skillsDir?: string;          // Merged skills
    hookBridgePath?: string;     // Generated hook bridge
    runManifestPath?: string;    // asp.pi.json
  };
}
```

This gives determinism and reuse: space artifacts cache once; target assembly is just hardlinks/symlinks + small JSON.

---

## Harness Adapter Interface

```typescript
interface HarnessAdapter {
  /** Harness identifier */
  readonly id: HarnessId;  // "claude" | "pi"

  /** Human-readable name */
  readonly name: string;

  /** Detect if harness binary is available */
  detect(): Promise<HarnessDetection>;

  /** Validate space is compatible with this harness */
  validateSpace(space: ResolvedSpace): ValidationResult;

  /**
   * Materialize a single space into a reusable, cacheable harness artifact.
   * This is the harness analogue of v2's per-space plugin cache.
   */
  materializeSpace(
    space: ResolvedSpace,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult>;

  /**
   * Assemble a target bundle from ordered per-space artifacts.
   * Writes into asp_modules/<target>/<harness>/...
   */
  composeTarget(
    target: ResolvedTargetEnv,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult>;

  /** Build CLI arguments for running the harness from a composed target bundle */
  buildRunArgs(bundle: ComposedTargetBundle, options: RunOptions): string[];

  /** Get output directory path for a target bundle */
  getTargetOutputPath(aspModulesDir: string, targetName: string): string;
}

interface HarnessDetection {
  available: boolean;
  version?: string;
  path?: string;
  capabilities?: string[];  // e.g. ["settingsFlag", "multiExtension", "hookBlocking"]
  error?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
```

### Claude Adapter Implementation (Sketch)

```typescript
class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude" as const;
  readonly name = "Claude Code";

  async detect(): Promise<HarnessDetection> {
    // Execute: claude --version
    // Parse output for version and capabilities
    return {
      available: true,
      version: "1.0.0",
      path: "/usr/local/bin/claude",
      capabilities: ["multiPlugin", "settingsFlag", "mcpConfig", "hookBlocking"]
    };
  }

  async materializeSpace(
    space: ResolvedSpace,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    // This is essentially the existing v2 materializeSpace() logic
    const pluginDir = cacheDir;

    // Write .claude-plugin/plugin.json
    await writePluginJson(pluginDir, space);

    // Link component directories (commands/, agents/, skills/, hooks/, mcp/, scripts/)
    await linkComponents(space.snapshotPath, pluginDir);

    // Validate and fix hooks
    await ensureHooksExecutable(pluginDir);

    return {
      artifactPath: pluginDir,
      files: await listFiles(pluginDir),
      warnings: []
    };
  }

  async composeTarget(
    target: ResolvedTargetEnv,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const pluginsDir = join(outputDir, 'plugins');

    // Link/copy ordered space artifacts with numeric prefixes
    const pluginDirs: string[] = [];
    for (let i = 0; i < target.loadOrder.length; i++) {
      const artifact = target.artifacts[i];
      const prefixed = `${String(i).padStart(3, '0')}-${artifact.spaceId}`;
      const destPath = join(pluginsDir, prefixed);
      await linkOrCopy(artifact.path, destPath);
      pluginDirs.push(destPath);
    }

    // Compose MCP config
    const mcpConfigPath = join(outputDir, 'mcp.json');
    await composeMcpFromSpaces(pluginDirs, mcpConfigPath);

    // Compose settings
    const settingsPath = join(outputDir, 'settings.json');
    await composeSettingsFromSpaces(target.settingsInputs, settingsPath);

    return {
      bundle: {
        harnessId: 'claude',
        targetName: target.name,
        rootDir: outputDir,
        pluginDirs,
        mcpConfigPath,
        settingsPath
      },
      warnings: []
    };
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: RunOptions): string[] {
    const args: string[] = [];

    // Multiple plugin directories
    for (const dir of bundle.pluginDirs ?? []) {
      args.push('--plugin-dir', dir);
    }

    // Composed MCP config
    if (bundle.mcpConfigPath) {
      args.push('--mcp-config', bundle.mcpConfigPath);
    }

    // Composed settings
    if (bundle.settingsPath) {
      args.push('--settings', bundle.settingsPath);
    }

    // Isolation mode (default)
    if (options.settingSources !== null) {
      args.push('--setting-sources', options.settingSources ?? '');
    }

    // Model
    if (options.model) {
      args.push('--model', options.model);
    }

    return args;
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'claude');
  }
}
```

### Pi Adapter Implementation (Sketch)

```typescript
class PiAdapter implements HarnessAdapter {
  readonly id = "pi" as const;
  readonly name = "Pi Coding Agent";

  async detect(): Promise<HarnessDetection> {
    // Check for pi binary at ~/tools/pi-mono or in PATH
    return {
      available: true,
      version: "0.5.0",
      path: expandPath("~/tools/pi-mono/packages/cli/bin/pi.js"),
      capabilities: ["extensions", "skills", "toolNamespacing"]
    };
  }

  async materializeSpace(
    space: ResolvedSpace,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = [];

    // Bundle extensions to JS for deterministic execution
    const extDir = join(cacheDir, 'extensions');
    await mkdir(extDir, { recursive: true });

    for (const src of discoverExtensions(space)) {
      const bundleName = `${space.id}__${basename(src, '.ts')}.js`;
      await bunBuildExtension(src, join(extDir, bundleName), {
        format: space.manifest.pi?.build?.format ?? 'esm',
        target: space.manifest.pi?.build?.target ?? 'bun',
        external: space.manifest.pi?.build?.external ?? []
      });
    }

    // Copy skills (same format as Claude)
    const skillsDir = join(cacheDir, 'skills');
    await copyDirectory(space.getDirectory('skills'), skillsDir);

    // Copy hooks scripts (to be used by hook bridge)
    const hooksDir = join(cacheDir, 'hooks');
    await copyDirectory(space.getDirectory('hooks'), hooksDir);

    // Copy shared files
    await copyDirectory(space.getDirectory('shared'), cacheDir);

    return {
      artifactPath: cacheDir,
      files: await listFiles(cacheDir),
      warnings
    };
  }

  async composeTarget(
    target: ResolvedTargetEnv,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const warnings: string[] = [];

    // Merge extensions from all spaces
    const extensionsDir = join(outputDir, 'extensions');
    await mkdir(extensionsDir, { recursive: true });

    for (const artifact of target.artifacts) {
      const srcExtDir = join(artifact.path, 'extensions');
      if (await exists(srcExtDir)) {
        for (const file of await readdir(srcExtDir)) {
          // Files are already namespaced: spaceId__name.js
          await link(join(srcExtDir, file), join(extensionsDir, file));
        }
      }
    }

    // Merge skills directories
    const skillsDir = join(outputDir, 'skills');
    await mkdir(skillsDir, { recursive: true });
    for (const artifact of target.artifacts) {
      const srcSkillsDir = join(artifact.path, 'skills');
      if (await exists(srcSkillsDir)) {
        await mergeDirectory(srcSkillsDir, skillsDir);
      }
    }

    // Merge hooks scripts
    const hooksDir = join(outputDir, 'hooks');
    await mkdir(hooksDir, { recursive: true });
    for (const artifact of target.artifacts) {
      const srcHooksDir = join(artifact.path, 'hooks');
      if (await exists(srcHooksDir)) {
        await mergeDirectory(srcHooksDir, hooksDir);
      }
    }

    // Generate hook bridge extension
    const hookBridgePath = join(outputDir, 'asp-hooks.bridge.js');
    const hooksConfig = await loadComposedHooksConfig(target);
    await generateHookBridge(hooksConfig, hookBridgePath);

    // Check for blocking hooks that Pi can't enforce
    for (const hook of hooksConfig.hooks) {
      if (hook.blocking && !PI_BLOCKING_EVENTS.includes(hook.event)) {
        warnings.push(`W301: Hook '${hook.event}' marked blocking=true but Pi cannot block this event`);
      }
    }

    // Compose settings
    const settingsPath = join(outputDir, 'settings.json');
    await composeSettingsFromSpaces(target.piSettingsInputs, settingsPath);

    return {
      bundle: {
        harnessId: 'pi',
        targetName: target.name,
        rootDir: outputDir,
        pi: {
          extensionsDir,
          skillsDir,
          hookBridgePath,
        },
        settingsPath
      },
      warnings
    };
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: RunOptions): string[] {
    const args: string[] = [];

    // Extensions (including hook bridge)
    const extensionFiles = await glob(join(bundle.pi!.extensionsDir, '*.js'));
    for (const ext of extensionFiles) {
      args.push('--extension', ext);
    }

    // Hook bridge extension
    if (bundle.pi!.hookBridgePath) {
      args.push('--extension', bundle.pi!.hookBridgePath);
    }

    // Skills directory
    if (bundle.pi!.skillsDir) {
      args.push('--skills', bundle.pi!.skillsDir);
    }

    // Model (translate naming)
    if (options.model) {
      args.push('--model', this.translateModel(options.model));
    }

    return args;
  }

  private translateModel(model: string): string {
    const map: Record<string, string> = {
      "sonnet": "claude-sonnet",
      "opus": "claude-opus",
      "haiku": "claude-haiku",
    };
    return map[model] ?? model;
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'pi');
  }
}
```

### Adapter Registry

```typescript
class HarnessRegistry {
  private adapters = new Map<HarnessId, HarnessAdapter>();

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: HarnessId): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  getAll(): HarnessAdapter[] {
    return Array.from(this.adapters.values());
  }

  async detectAvailable(): Promise<Map<HarnessId, HarnessDetection>> {
    const results = new Map();
    for (const [id, adapter] of this.adapters) {
      results.set(id, await adapter.detect());
    }
    return results;
  }
}

export const harnessRegistry = new HarnessRegistry();
harnessRegistry.register(new ClaudeAdapter());
harnessRegistry.register(new PiAdapter());
```

---

## CLI Changes

### Primary Commands (Scales to N Harnesses)

```bash
# Run with specific harness (default: claude for backwards compatibility)
asp run <target> [project-path] --harness claude
asp run <target> [project-path] --harness pi

# Install for specific harnesses
asp install                      # All harnesses in asp-targets.toml
asp install --harness claude     # Only claude
asp install --harness pi         # Only pi

# List available harnesses with versions and capabilities
asp harnesses

# Detailed per-harness diagnostics
asp doctor --harness pi

# Explain what would be built (auditable translations)
asp explain <target> --harness claude
asp explain <target> --harness pi

# Lint with harness-specific checks
asp lint --harness pi

# Optional convenience aliases (thin wrappers)
asp run-claude <target> [project-path]   # equivalent to --harness claude
asp run-pi <target> [project-path]       # equivalent to --harness pi
```

### asp explain Output (Auditable)

```
$ asp explain fullstack --harness pi

Target: fullstack
Harness: pi (v0.5.0)

Load Order:
  1. base@abc1234 (base v1.0.0)
  2. fullstack-dev@def5678 (fullstack-dev v2.0.0)

Extensions (bundled):
  - extensions/base__database.js (from base)
  - extensions/fullstack-dev__api.js (from fullstack-dev)
  - asp-hooks.bridge.js (generated)

Skills:
  - skills/code-review/SKILL.md (from base)
  - skills/testing/SKILL.md (from fullstack-dev)

Hooks:
  - pre_tool_use → hooks/pre-tool-use.sh [BEST_EFFORT: Pi cannot block tool calls]
  - post_tool_use → hooks/post-tool-use.sh [OK]

Permissions (translated):
  - read: ["."] → [LINT_ONLY: Pi has no read restrictions]
  - exec: ["npm", "bun"] → tools: ["Bash"] [BEST_EFFORT]

Pi Command:
  pi --extension extensions/base__database.js \
     --extension extensions/fullstack-dev__api.js \
     --extension asp-hooks.bridge.js \
     --skills skills/ \
     --model claude-sonnet \
     /path/to/project
```

---

## Target Configuration

### asp-targets.toml

```toml
[target.fullstack]
space = "space:fullstack-dev@^2.0.0"

# Which harnesses to materialize for this target (default: ["claude"])
harnesses = ["claude", "pi"]

# Harness-specific overrides
[target.fullstack.claude]
model = "opus"
inherit_project = true

[target.fullstack.pi]
model = "claude-opus"

# Target that only uses Pi
[target.data-science]
space = "space:data-science@^2.0.0"
harnesses = ["pi"]

[target.data-science.pi]
extensions = ["./local-extensions/pandas-helper.ts"]  # Additional local extensions
```

### Schema

```typescript
interface TargetConfig {
  space: SpaceRef;
  harnesses?: HarnessId[];  // Default: ["claude"]

  // Harness-specific overrides
  claude?: ClaudeTargetOptions;
  pi?: PiTargetOptions;
}

interface ClaudeTargetOptions {
  model?: string;
  inherit_project?: boolean;
  inherit_user?: boolean;
  args?: string[];
}

interface PiTargetOptions {
  model?: string;
  extensions?: string[];  // Additional local extensions
  skills?: string[];      // Additional local skills
}
```

---

## Permissions Model

### Permission Model Goals

Permissions are declared once as **policy intent** and translated per harness.
Because harnesses differ in enforcement capabilities, translations MUST be explicit, auditable, and linted.

### Abstract Permission Types (Policy Intent)

```typescript
interface SpacePermissions {
  read?: PathPattern[];
  write?: PathPattern[];
  exec?: CommandPattern[];
  network?: HostPattern[];
  deny?: {
    read?: PathPattern[];
    write?: PathPattern[];
    exec?: CommandPattern[];
    network?: HostPattern[];
  };
}
```

### Enforcement Semantics

For each harness, ASP classifies each permission facet as:
- `enforced`: the harness can enforce it directly
- `best_effort`: ASP can approximate (e.g., via wrapper scripts) but not guarantee
- `lint_only`: ASP can only warn; no runtime enforcement

| Permission | Claude | Pi |
|------------|--------|-----|
| read paths | `enforced` (via settings) | `lint_only` |
| write paths | `enforced` (via settings) | `lint_only` |
| exec commands | `enforced` (via allowedTools) | `best_effort` (via tools flag) |
| network hosts | `lint_only` (MCP-dependent) | `lint_only` |
| deny rules | `enforced` (via settings) | `lint_only` |

`asp explain --harness <id>` MUST print the classification and resulting runtime knobs.

### Translation Functions

```typescript
function translateToClaude(permissions: SpacePermissions): ClaudePermissions {
  return {
    allow_read: normalizePaths(permissions.read),
    allow_write: normalizePaths(permissions.write),
    allow: normalizeExec(permissions.exec),  // ["Bash(npm *)", "Bash(bun *)"]
    deny: normalizeDeny(permissions.deny),
  };
}

function translateToPi(permissions: SpacePermissions): PiPermissions {
  // Most permissions are lint_only for Pi
  return {
    tools: buildToolList(permissions),  // best_effort
    // Read/write/network not enforceable at runtime
  };
}
```

---

## Hooks Unification

### Canonical Hook Declaration

`hooks.toml` is the canonical representation. Harness adapters translate it:
- **Claude:** generate `hooks/hooks.json` invoking `hooks/*.sh`
- **Pi:** generate a "hook bridge" extension that registers handlers and executes the same `hooks/*.sh` scripts with the same env vars

### Event Mapping

| Abstract Event | Claude Event | Pi Event | Blocking Support |
|---------------|--------------|----------|------------------|
| `pre_tool_use` | `PreToolUse` | `tool_call` | Claude: yes, Pi: no |
| `post_tool_use` | `PostToolUse` | `tool_result` | Neither |
| `session_start` | (none) | `session_start` | N/A |
| `session_end` | `Stop` | `session_end` | N/A |
| `error` | (none) | `error` | N/A |

### hooks.toml Syntax

```toml
[[hook]]
event = "pre_tool_use"
script = "hooks/validate-tool.sh"
tools = ["Bash", "Write"]  # Optional: filter to specific tools
blocking = true            # Attempt to block if harness supports it

[[hook]]
event = "post_tool_use"
script = "hooks/log-tool.sh"
blocking = false

# Harness-specific hook (only runs on Pi)
[[hook]]
event = "before_agent_start"
harness = "pi"
script = "hooks/pi-init.sh"
```

### Hook Script Interface

Scripts receive context via environment variables:

```bash
#!/bin/bash
# hooks/validate-tool.sh

# Common variables (both harnesses)
echo "Tool: $ASP_TOOL_NAME"
echo "Arguments: $ASP_TOOL_ARGS"
echo "Harness: $ASP_HARNESS"

# Harness-specific (set by materializer)
echo "Claude plugin: $CLAUDE_PLUGIN_DIR"
echo "Pi extension: $PI_EXTENSION_DIR"

# Exit 0 to allow, non-zero to block (PreToolUse only, Claude only)
exit 0
```

### Pi Hook Bridge Extension

When composing a Pi target, ASP generates an extension (`asp-hooks.bridge.js`) that:
- Reads the composed hooks config
- Registers Pi event handlers for each mapped event
- For each matching event, shells out to the configured script
- Sets the same `ASP_*` env vars as Claude hooks

```typescript
// Generated asp-hooks.bridge.js (conceptual)
export default function(pi) {
  // Pre-tool-use hook (best-effort, cannot actually block)
  pi.registerHook('tool_call', async (ctx) => {
    const result = await execScript('hooks/validate-tool.sh', {
      ASP_TOOL_NAME: ctx.toolName,
      ASP_TOOL_ARGS: JSON.stringify(ctx.args),
      ASP_HARNESS: 'pi',
    });
    if (result.exitCode !== 0) {
      console.warn(`Hook script exited with ${result.exitCode} but Pi cannot block tool calls`);
    }
  });

  // Post-tool-use hook
  pi.registerHook('tool_result', async (ctx) => {
    await execScript('hooks/log-tool.sh', {
      ASP_TOOL_NAME: ctx.toolName,
      ASP_TOOL_RESULT: JSON.stringify(ctx.result),
      ASP_HARNESS: 'pi',
    });
  });
}
```

If Pi cannot block a tool call at the protocol level, `blocking=true` hooks MUST be treated as "best-effort" and a lint warning (W301) should be emitted.

---

## Pi Tool Namespacing

### The Problem

Pi tool names are global. When composing multiple spaces, collisions are likely (e.g., "read", "db_query", "fetch").

### Policy (Default)

Tools contributed via space extensions MUST be namespaced at registration time:
```
<spaceId>__<toolName>
```

Examples:
- `base__database_query`
- `fullstack-dev__api_fetch`

### Implementation

During `materializeSpace()` for Pi, extensions are bundled with a transform that:
1. Wraps the extension's `registerTool` calls
2. Prefixes tool names with the space ID

```typescript
// Transform applied during bundling
function wrapRegisterTool(spaceId: string) {
  return {
    registerTool(tool: ToolDefinition) {
      const namespacedTool = {
        ...tool,
        name: `${spaceId}__${tool.name}`,
        // Optionally keep original name as alias if unambiguous
      };
      return originalRegisterTool(namespacedTool);
    }
  };
}
```

### Short Aliases

Optionally, during `composeTarget()`, generate short aliases for tools that are unambiguous (no collision with other spaces):

```typescript
// If only one space provides "database_query", alias it
registerToolAlias('database_query', 'base__database_query');
```

### Validation/Lint

Emit warnings when:
- A space tries to register an un-namespaced tool name (W302)
- Two tools would map to the same final tool name after namespacing/aliasing (W303)

---

## Pi Extension Building

### The Problem

Copying `.ts` files to output and hoping Pi can execute them is fragile across environments (TypeScript support, module resolution, node/bun differences).

### Solution: Bundle During Materialization

During `materializeSpace()` for Pi, **bundle each extension to JS** using Bun:

```typescript
async function bunBuildExtension(
  srcPath: string,
  outPath: string,
  options: BuildOptions
): Promise<void> {
  await $`bun build ${srcPath} \
    --outfile ${outPath} \
    --format ${options.format ?? 'esm'} \
    --target ${options.target ?? 'bun'} \
    ${options.external?.map(e => `--external ${e}`).join(' ')}`;
}
```

### Cache Key

Include bundler version in cache key for determinism:
```
sha256(spaceIntegrity + harnessId + bunVersion)
```

### Build Options

Spaces can specify build configuration:

```toml
[pi.build]
bundle = true         # Bundle extensions to JS (default: true)
format = "esm"        # Output format: "esm" or "cjs"
target = "bun"        # Target runtime: "bun" or "node"
external = ["pg"]     # Dependencies to exclude from bundle
```

If a space has `extensions/package.json`, dependencies are installed before bundling.

---

## Edge Cases

### 1. Space Depends on Harness-Specific Space

```toml
[deps]
spaces = ["space:mcp-tools@^1.0.0"]  # Has only mcp/, no extensions/
```

**Resolution (normative):**
- If a user explicitly installs/runs with `--harness pi`, resolution MUST fail if any required dependency is incompatible with `pi`.
- Provide an escape hatch: `asp install --harness pi --skip-unsupported` which skips incompatible deps and emits explicit warnings listing missing capabilities.

### 2. MCP Server Not Available on Pi

If a space has `mcp/` but no `extensions/`, the Pi materializer ignores MCP configs. The space author should provide equivalent extensions if Pi support is needed.

**Validation:** Warn if space declares `harness.supports = ["claude", "pi"]` but only has `mcp/` (no `extensions/`).

### 3. Extension Uses Node APIs Not in Bun

Pi uses Bun, but extensions might use Node-specific APIs.

**Resolution:**
- Document that extensions must be Bun-compatible
- Add `[pi.build] target = "node"` option for Node-only extensions
- Lint warns if extension imports known Node-only modules

### 4. Different Model Capabilities

Claude Code and Pi may have different tool availability or model capabilities.

**Resolution:** Document that spaces should test with each target harness. Validation warnings for harness-specific features.

### 5. Hooks With Different Semantics

Claude's `PreToolUse` can block tool execution; Pi's `tool_call` is informational only.

**Resolution:**
- `blocking = true` in hooks.toml is semantics metadata
- Materializers check if harness supports blocking for that event
- Emit W301 warning when blocking is requested but not supported

### 6. Circular Harness Support

Space A (claude-only) → Space B (pi-only) → Space A would create an impossible constraint.

**Resolution:** Dependency resolution tracks harness compatibility. Fail early with clear error showing the incompatible chain.

### 7. Pi Tool Name Collisions

Two spaces register tools with the same name (after namespacing fails or is disabled).

**Resolution:**
- Default namespacing prevents most collisions
- W303 warning for remaining collisions
- Last space in load order wins (deterministic but possibly wrong)

---

## Migration Path

### Phase 1: Prepare (No Breaking Changes)

1. Add `HarnessAdapter` interface
2. Refactor Claude-specific code into `ClaudeAdapter`
3. Add `[harness]` section to `space.toml` schema (optional, defaults inferred)
4. Add `asp harnesses` command
5. Add `--harness` flag to existing commands (no-op for now)

### Phase 2: Two-Phase Materialization

1. Split `materializeSpace()` and `composeTarget()`
2. Update cache key to include harness ID
3. Add harness dimension to lock file (per-target `harnesses` field)
4. Update `asp_modules` layout to `<target>/<harness>/`

### Phase 3: Pi Support

1. Add `PiAdapter` implementation
2. Add Pi extension bundling
3. Add hook bridge generation
4. Add tool namespacing transform
5. Add Pi-specific validation rules (W301-W303)

### Phase 4: Full Multi-Harness

1. Support `AGENT.md` → `CLAUDE.md` renaming (keep both during transition)
2. Add `hooks.toml` as preferred hook declaration
3. Add `permissions.toml` support with enforcement classification
4. Add `[deps.claude]` and `[deps.pi]` support

### Backwards Compatibility

- Existing v2 spaces with only Claude artifacts continue to work unchanged
- `CLAUDE.md` is still preferred over `AGENT.md` for Claude materializer
- `hooks/hooks.json` is still accepted (generated from `hooks.toml` if present)
- Lock file at project root is unchanged
- Old `asp_modules` structure auto-migrates on `asp install`

---

## Open Questions

### 1. Should `AGENT.md` replace `CLAUDE.md`?

**Options:**
- A) Rename to `AGENT.md`, Claude materializer creates `CLAUDE.md` in output
- B) Keep `CLAUDE.md`, Pi reads it anyway (it's just markdown)
- C) Support both, prefer `AGENT.md` for new spaces, warn about dual presence

**Recommendation:** Option C. New multi-harness spaces should use `AGENT.md`. Existing Claude-only spaces continue using `CLAUDE.md`.

### 2. How to handle MCP-to-Extension translation?

**Options:**
- A) No translation - space author provides both
- B) Generate MCP bridge extension for Pi that proxies MCP servers
- C) Defer until stable MCP tool schemas exist

**Recommendation:** Option A initially. Option B as future enhancement only if MCP server configurations become sufficiently standardized to auto-generate TypeScript clients.

### 3. Where should Pi binary path be configured?

**Options:**
- A) Environment variable `PI_PATH`
- B) In user settings `~/.asp/config.toml` under `[harness.pi]`
- C) Auto-detect from PATH, with `PI_PATH` as override

**Recommendation:** Option C. Auto-detect is most ergonomic; environment variable provides escape hatch.

### 4. What happens when hook bridge cannot block?

**Options:**
- A) Silent best-effort (run script, ignore exit code)
- B) Log warning at runtime
- C) Fail the ASP install/build with error

**Recommendation:** Option B. Runtime log warning plus W301 lint warning at build time. Users can suppress with `blocking = false`.

### 5. How to handle harness-specific dependencies failure?

**Options:**
- A) Always fail when harness is explicitly requested and dep is incompatible
- B) Skip with warning (silent degradation)
- C) Fail by default, `--skip-unsupported` flag for exploration

**Recommendation:** Option C. Fail-fast for production use; escape hatch for experimentation.

---

## Appendix A: MCP Config Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "mcpServers": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "properties": {
          "command": { "type": "string" },
          "args": { "type": "array", "items": { "type": "string" } },
          "env": { "type": "object", "additionalProperties": { "type": "string" } }
        },
        "required": ["command"]
      }
    }
  }
}
```

## Appendix B: Pi Extension Schema

```typescript
// Minimal extension structure
export default function(pi: ExtensionAPI): void | Promise<void>;

interface ExtensionAPI {
  registerTool(tool: ToolDefinition): void;
  registerHook(event: string, handler: HookHandler): void;
  getContext(): ExtensionContext;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;  // TypeBox schema
  execute: ToolExecutor;
}
```

## Appendix C: SKILL.md Frontmatter Schema

Skills use the Agent Skills standard (agentskills.io), compatible with both Claude and Pi:

```yaml
---
name: string          # Required: URL-safe identifier
description: string   # Required: max 1024 chars
version: string       # Optional: semver
license: string       # Optional: SPDX identifier
author: string        # Optional
compatibility: string # Optional: runtime requirements
---
```

## Appendix D: Warning Codes

| Code | Harness | Description |
|------|---------|-------------|
| W201 | Claude | Command collision in composed plugins |
| W202 | Claude | Agent command namespace conflict |
| W203 | Claude | Hook path escapes plugin root |
| W204 | Claude | Invalid hooks configuration |
| W205 | Claude | Plugin name collision |
| W206 | Claude | Non-executable hook script |
| W207 | Claude | Invalid plugin structure |
| W301 | Pi | Hook marked blocking but event cannot block |
| W302 | Pi | Extension registers un-namespaced tool |
| W303 | Pi | Tool name collision after namespacing |
| W304 | Pi | Extension uses Node-only APIs |
| W305 | Pi | Missing extensions for multi-harness space |
| W401 | Multi | Harness-specific dependency incompatible |
| W402 | Multi | Permission not enforceable on harness |
| W403 | Multi | Space declares harness support but missing artifacts |
