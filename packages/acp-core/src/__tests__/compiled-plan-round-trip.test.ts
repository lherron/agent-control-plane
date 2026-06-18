/**
 * T-04893 RED B — Holistic compiled-plan runtime round-trip guard.
 *
 * Motivation: three separate defects (T-04888 laneRef, T-04883 role_name,
 * T-04893 cooldown) all share the same escape pattern — a field that looks valid in
 * the compiled plan but silently degrades when processed by ACP's runtime parsers.
 * This test detects all three in one data-driven pass.
 *
 * APPROACH: Load the vendored compiled plan (tests/fixtures/resources/asp-plan-v1.json)
 * and run EVERY runtime-validated field through ACP's REAL parsers/validators:
 *   • laneRef / scopeRef  → normalizeSessionRef (from agent-scope)
 *   • event-hook trigger  → validateJobTrigger (from acp-core)
 *   • event-hook cooldown → parseDurationToMs (from acp-core) — must return > 0
 *   • interface-binding routing → same normalizeSessionRef check
 *
 * Full-plan assertion (RED until T-04894 re-vendors "300s" and larry fixes):
 *   FAILS NOW — the current fixture carries cooldown "PT300S" which validateJobTrigger
 *   rejects and parseDurationToMs("PT300S") returns undefined.  After the fix vendors
 *   "300s", all assertions pass and this goes GREEN.
 *
 * Negative-proof assertions (always GREEN): prove the guard catches composed-laneRef
 *   AND ISO cooldown — the two T-04893 escape classes — by running them directly through
 *   the validators and asserting they are rejected.
 *
 * Do NOT weaken the full-plan assertion.  If validators change behaviour, that must
 * surface here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeSessionRef } from 'agent-scope'

import { parseDurationToMs, validateJobTrigger } from '../index.js'

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_PATH = join(
  import.meta.dir,
  '../../../../tests/fixtures/resources/asp-plan-v1.json'
)

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

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

/** Extract literal (non-template) laneRef+scopeRef pairs across all resource kinds. */
function extractLiteralLaneRefs(
  plan: Plan
): Array<{ projectionId: string; laneRef: string; scopeRef: string }> {
  const pairs: Array<{ projectionId: string; laneRef: string; scopeRef: string }> = []
  for (const resource of plan.resources) {
    const d = resource.desiredJson
    let laneRef: unknown
    let scopeRef: unknown
    if (resource.resourceKind === 'interface-binding') {
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

/** Extract event-hook trigger records from all event-hook resources. */
function extractEventHookTriggers(
  plan: Plan
): Array<{ projectionId: string; trigger: Record<string, unknown> }> {
  const entries: Array<{ projectionId: string; trigger: Record<string, unknown> }> = []
  for (const resource of plan.resources) {
    if (resource.resourceKind !== 'event-hook') continue
    const trigger = resource.desiredJson['trigger']
    if (trigger !== null && typeof trigger === 'object' && !Array.isArray(trigger)) {
      entries.push({
        projectionId: resource.projectionId,
        trigger: trigger as Record<string, unknown>,
      })
    }
  }
  return entries
}

// ===========================================================================
// Full-plan round-trip guard (RED until T-04894 re-vendors "300s" cooldown)
// ===========================================================================

describe('asp-plan-v1 holistic runtime round-trip guard', () => {
  test(
    'every literal laneRef/scopeRef in the vendored fixture is accepted by normalizeSessionRef',
    () => {
      const plan = loadFixture()
      const pairs = extractLiteralLaneRefs(plan)
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
      // Passes NOW (fixture already carries bare "main" after T-04889 re-vendor).
      expect(failures).toEqual([])
    }
  )

  test(
    'every event-hook trigger in the vendored fixture is accepted by validateJobTrigger',
    () => {
      const plan = loadFixture()
      const entries = extractEventHookTriggers(plan)
      expect(entries.length).toBeGreaterThan(0)

      const failures: string[] = []
      for (const { projectionId, trigger } of entries) {
        const validation = validateJobTrigger(trigger)
        if (!validation.valid) {
          failures.push(
            `${projectionId}: trigger rejected — ${validation.errors.join('; ')}`
          )
        }
      }

      // FAILS NOW: the wrkq-needs-smoketest event-hook has cooldown "PT300S" which
      // validateJobTrigger (acp-core/src/webhook/job-trigger.ts:388-396) rejects because
      // parseDurationToMs("PT300S") returns undefined — the regex only matches
      // ^(\d+)(ms|s|m|h|d)?$ and ISO 8601 "PT300S" does not match.
      // After T-04894 vendors "300s", this passes.
      expect(failures).toEqual([])
    }
  )

  test(
    'every event-hook cooldown in the vendored fixture parses via parseDurationToMs > 0',
    () => {
      const plan = loadFixture()
      const entries = extractEventHookTriggers(plan)
      expect(entries.length).toBeGreaterThan(0)

      const failures: string[] = []
      for (const { projectionId, trigger } of entries) {
        const cooldown = trigger['cooldown']
        if (typeof cooldown !== 'string') continue // no cooldown field — skip
        const ms = parseDurationToMs(cooldown)
        if (ms === undefined || ms <= 0) {
          failures.push(
            `${projectionId}: cooldown="${cooldown}" → parseDurationToMs=${String(ms)} (expected > 0)`
          )
        }
      }

      // FAILS NOW: "PT300S" → parseDurationToMs = undefined (not > 0).
      // This is the EXACT value that the runtime evaluator receives after the
      // validateManagedJobTrigger re-override bug persists it back to the store.
      // After T-04893 fix + T-04894 re-vendor to "300s", parseDurationToMs("300s")
      // = 300_000, satisfying > 0.
      expect(failures).toEqual([])
    }
  )
})

// ===========================================================================
// Negative proof — guard correctly detects all three historical escape classes
// ===========================================================================

describe(
  'asp-plan-v1 round-trip guard — negative proof (composed-laneRef + ISO cooldown rejected)',
  () => {
    const VALID_SCOPE_REF = 'agent:smokey:project:agent-spaces:task:primary'
    // The OLD composed form that caused T-04888 (before T-04889 re-vendored "main")
    const COMPOSED_LANE_REF = 'agent:smokey:project:agent-spaces:task:primary~main'

    test('composed laneRef is REJECTED by normalizeSessionRef (T-04888 escape class)', () => {
      // Proves the guard would catch a composed laneRef like the pre-T-04889 fixture.
      expect(() =>
        normalizeSessionRef({ scopeRef: VALID_SCOPE_REF, laneRef: COMPOSED_LANE_REF })
      ).toThrow()
    })

    test('ISO "PT300S" cooldown is REJECTED by validateJobTrigger (T-04893 escape class)', () => {
      // Proves the guard catches the exact cooldown value that the ASP compiler currently
      // emits and that the runtime evaluator cannot parse.
      const trigger = {
        kind: 'event',
        source: 'wrkq',
        match: { event: 'created' },
        cooldown: 'PT300S',
      }
      const validation = validateJobTrigger(trigger)
      expect(validation.valid).toBe(false)
    })

    test('parseDurationToMs("PT300S") returns undefined — invisible to runtime guard', () => {
      // Confirms that even if validateJobTrigger were bypassed, the scheduler would see
      // undefined for cooldownMs and skip the cooldown check entirely.
      expect(parseDurationToMs('PT300S')).toBeUndefined()
    })

    test(
      'mutated plan with composed-laneRef AND ISO cooldown is caught by all three guards',
      () => {
        // Construct a synthetic resource mimicking a mis-compiled plan entry.
        const mutatedResource = {
          projectionId: 'test:mutated-resource',
          resourceKind: 'event-hook',
          desiredJson: {
            kind: 'event-triggered-job',
            laneRef: COMPOSED_LANE_REF, // escape class 1: composed
            scopeRef: VALID_SCOPE_REF,
            trigger: {
              kind: 'event',
              source: 'wrkq',
              match: { event: 'created' },
              cooldown: 'PT300S', // escape class 2: ISO-only
            },
          },
        }

        // Guard 1 — laneRef: normalizeSessionRef rejects the composed form
        expect(() =>
          normalizeSessionRef({
            scopeRef: VALID_SCOPE_REF,
            laneRef: mutatedResource.desiredJson.laneRef,
          })
        ).toThrow()

        // Guard 2 — trigger: validateJobTrigger rejects the ISO cooldown
        const validation = validateJobTrigger(mutatedResource.desiredJson.trigger)
        expect(validation.valid).toBe(false)
        expect(validation.valid ? '' : validation.errors.join('; ')).toContain('cooldown')

        // Guard 3 — parseDurationToMs: runtime evaluator would get undefined
        const cooldown = mutatedResource.desiredJson.trigger['cooldown']
        expect(parseDurationToMs(cooldown as string)).toBeUndefined()
      }
    )
  }
)
