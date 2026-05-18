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
import { inferProjectIdFromCwd } from 'spaces-config'

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
