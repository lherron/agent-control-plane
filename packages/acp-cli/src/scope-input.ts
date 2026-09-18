import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
/**
 * ACP CLI scope/session normalizer.
 *
 * Thin compatibility adapter over `agent-scope`'s `resolveQualifiedScopeInput`.
 * Preserves the ACP-facing API contract:
 *   - Output `laneRef` is omitted unless the user explicitly supplied
 *     `~lane` in the handle or `--lane-ref` to the CLI.
 *   - Conflicting lane inputs (session-handle lane and `--lane-ref` disagree)
 *     are surfaced as a thrown error.
 *   - Missing task qualifier defaults to canonical `"primary"` when a project
 *     can be determined (ASP_PROJECT or cwd inference) so ACP cannot drift
 *     from HRC / hrcchat behavior.
 */
import { normalizeLaneRef, resolveQualifiedScopeInput } from 'agent-scope'

/**
 * Project marker discovery vendored from spaces-config `runtime-placement`
 * (`findProjectMarker` / `findGitRoot` / `inferProjectIdFromCwd`) under
 * T-08598. Marker discovery is HRC placement policy — a filename convention
 * (`asp-targets.toml`) walked up from cwd, bounded by the containing git repo
 * root with an implicit git-repo fallback and an agent-home guard — not ASP
 * declaration interpretation, so acp-cli carries this ~30-line walk instead
 * of the spaces-config dependency. Two deliberate deltas from the origin:
 * the agents-root guard reads `ASP_AGENTS_ROOT` (with `~/` expansion) or the
 * `~/praesidium/var/agents` convention only — the aspHome `config.toml`
 * lookup stays the daemon's business; and the walk takes explicit
 * cwd/env options (defaulting to the process values the old import used) so
 * tests can pin fixtures.
 */
const PROJECT_MARKER_FILENAME = 'asp-targets.toml'

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function defaultAgentsRoot(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env['ASP_AGENTS_ROOT']
  if (explicit !== undefined && explicit.length > 0) {
    return explicit.startsWith('~/') && env['HOME'] !== undefined
      ? join(env['HOME'], explicit.slice(2))
      : explicit
  }
  const home = env['HOME']
  if (home === undefined || home.length === 0) return undefined
  const convention = join(home, 'praesidium', 'var', 'agents')
  return existsSync(convention) ? convention : undefined
}

export function inferProjectIdFromCwd(
  input: { cwd?: string | undefined; env?: NodeJS.ProcessEnv | undefined } = {}
): string | undefined {
  const start = resolve(input.cwd ?? process.cwd())
  const agentsRoot = defaultAgentsRoot(input.env ?? process.env)
  const roots = agentsRoot !== undefined ? [resolve(agentsRoot)] : []
  const insideAgentsRoot = (dir: string): boolean => roots.some((root) => isSameOrInside(dir, root))
  const gitRoot = findGitRoot(start)
  let dir = start
  while (true) {
    if (insideAgentsRoot(dir)) return undefined
    if (existsSync(join(dir, PROJECT_MARKER_FILENAME))) return basename(dir)
    if (gitRoot !== undefined && dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  if (gitRoot !== undefined && !insideAgentsRoot(gitRoot)) return basename(gitRoot)
  return undefined
}

function detectExplicitLane(laneRef?: string): string | undefined {
  if (laneRef === undefined || laneRef === '') return undefined
  // Accept "main", bare laneId (e.g. "repair"), or canonical "lane:<id>".
  // Reuse agent-scope's normalizer after prepending the prefix for bare ids.
  if (laneRef === 'main') return 'main'
  const canonical = laneRef.startsWith('lane:') ? laneRef : `lane:${laneRef}`
  return normalizeLaneRef(canonical)
}

export function normalizeScopeInput(
  scopeInput: string,
  laneRef?: string
): { scopeRef: string; laneRef?: string } {
  const explicitFlagLane = detectExplicitLane(laneRef)
  const sessionHasLane = scopeInput.includes('~')

  const fallbackProjectId = process.env['ASP_PROJECT'] ?? inferProjectIdFromCwd()

  const resolved = resolveQualifiedScopeInput(scopeInput, {
    ...(fallbackProjectId !== undefined ? { projectId: fallbackProjectId } : {}),
  })

  // Detect conflict between session-handle lane and --lane-ref flag.
  if (sessionHasLane && explicitFlagLane !== undefined) {
    if (resolved.laneRef !== explicitFlagLane) {
      throw new Error(
        `Conflicting lane inputs: session handle lane "${resolved.laneRef}" does not match --lane-ref "${explicitFlagLane}"`
      )
    }
  }

  // Emit laneRef only when explicitly supplied by the user (preserves ACP
  // request shape — omit when defaulted).
  const effectiveLaneRef = sessionHasLane
    ? resolved.laneRef
    : explicitFlagLane !== undefined
      ? explicitFlagLane
      : undefined

  return {
    scopeRef: resolved.scopeRef,
    ...(effectiveLaneRef !== undefined ? { laneRef: effectiveLaneRef } : {}),
  }
}
