/**
 * Phase F R2 RED — LaneRef validator round-trip guard (closes Defect 1 escape).
 *
 * These tests use the REAL ACP LaneRef validator (normalizeSessionRef imported from
 * 'agent-scope') — the exact function that job dispatch calls — to assert the vendored
 * ASP plan fixture only contains laneRefs that ACP actually accepts.
 *
 * Full-plan assertion: FAILS NOW — the current vendored fixture carries OLD composed
 * laneRefs (e.g. "agent:smokey:project:agent-spaces:task:primary~main") which
 * normalizeSessionRef rejects.  After T-04889 re-vendors bare "main", this goes GREEN.
 *
 * Standalone assertions (composed rejected / bare accepted): pass BOTH now and after —
 * these prove the validator is the real guard that was missing.
 *
 * Do NOT weaken the full-plan assertion (e.g. skip all items) — if normalizeSessionRef
 * changes behaviour, that must surface here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeSessionRef } from 'agent-scope'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

// Path from packages/acp-core/src/__tests__/ up to repo root, then into tests/
const FIXTURE_PATH = join(import.meta.dir, '../../../../tests/fixtures/resources/asp-plan-v1.json')

type ResourceEntry = {
  resourceKind: string
  projectionId: string
  desiredJson: Record<string, unknown>
}

type Plan = {
  resources: ResourceEntry[]
}

function loadFixture(): Plan {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Plan
}

/**
 * Extract all LITERAL (non-template) laneRef+scopeRef pairs from the plan.
 * Skips entries containing Handlebars-style template markers ({{ }}) because
 * those are resolved at event-trigger time and are not statically validatable.
 */
function extractLiteralLaneRefs(plan: Plan): Array<{
  projectionId: string
  laneRef: string
  scopeRef: string
}> {
  const pairs: Array<{ projectionId: string; laneRef: string; scopeRef: string }> = []

  for (const resource of plan.resources) {
    const d = resource.desiredJson
    let laneRef: unknown
    let scopeRef: unknown

    if (resource.resourceKind === 'interface-binding') {
      // laneRef lives under desiredJson.routing for interface-binding resources
      const routing = d['routing'] as Record<string, unknown> | undefined
      laneRef = routing?.['laneRef']
      scopeRef = routing?.['scopeRef']
    } else {
      laneRef = d['laneRef']
      scopeRef = d['scopeRef']
    }

    if (
      typeof laneRef !== 'string' ||
      typeof scopeRef !== 'string' ||
      laneRef.includes('{{') ||
      scopeRef.includes('{{')
    ) {
      continue
    }

    pairs.push({ projectionId: resource.projectionId, laneRef, scopeRef })
  }

  return pairs
}

// ==================================================================
// Full-plan laneRef round-trip guard (RED until T-04889 re-vendors fixture)
// ==================================================================

describe('asp-plan-v1 LaneRef validator round-trip guard', () => {
  test('every literal laneRef in the vendored fixture is accepted by normalizeSessionRef', () => {
    const plan = loadFixture()
    const pairs = extractLiteralLaneRefs(plan)

    // Sanity: at least one literal laneRef pair must exist to make the test meaningful
    expect(pairs.length).toBeGreaterThan(0)

    const failures: string[] = []
    for (const { projectionId, laneRef, scopeRef } of pairs) {
      try {
        normalizeSessionRef({ scopeRef, laneRef })
      } catch (e) {
        failures.push(
          `${projectionId}: laneRef="${laneRef}" rejected — ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }

    // THIS FAILS NOW: current fixture has old composed laneRefs like
    // "agent:smokey:project:agent-spaces:task:primary~main" which normalizeSessionRef
    // rejects with "LaneRef must be 'main' or 'lane:<laneId>'".
    // After T-04889 re-vendors bare "main", all pairs pass and this goes GREEN.
    expect(failures).toEqual([])
  })
})

// ==================================================================
// Standalone validator assertions (always pass — prove the guard is the real one)
// ==================================================================

describe('normalizeSessionRef validator proof — OLD form rejected, bare form accepted', () => {
  const VALID_SCOPE_REF = 'agent:smokey:project:agent-spaces:task:primary'
  const OLD_COMPOSED_LANE = 'agent:smokey:project:agent-spaces:task:primary~main'

  test('OLD composed laneRef is REJECTED by normalizeSessionRef (guard is live)', () => {
    // This is the form the current fixture contains and that `acp job run` rejects.
    expect(() =>
      normalizeSessionRef({ scopeRef: VALID_SCOPE_REF, laneRef: OLD_COMPOSED_LANE })
    ).toThrow()
  })

  test('bare "main" laneRef is ACCEPTED by normalizeSessionRef (valid post-fix form)', () => {
    // This is the form that T-04889 will vendor into the fixture.
    expect(() => normalizeSessionRef({ scopeRef: VALID_SCOPE_REF, laneRef: 'main' })).not.toThrow()
  })
})
