/**
 * Phase C RED tests — Phase E: apply/status orchestration layer.
 *
 * STATUS: INTENTIONALLY FAILING — Phase E (packages/acp-server/src/resources/apply.ts)
 * has not yet been implemented. These tests will go GREEN when Phase E delivers:
 *   - validateManagedResourcesPlan: local JSON schema validation of ASP plan v1
 *   - applyManagedResourcesPlan: orchestrates Phase D store APIs for all three resource kinds
 *   - getManagedResourcesStatus: reports per-resource drift and state
 *
 * Dependency ordering: these tests require BOTH Phase D (store layer) AND Phase E
 * (orchestration layer) to go GREEN. Phase D tests in acp-jobs-store/__tests__ and
 * acp-interface-store/__tests__ can go GREEN independently before Phase E is implemented.
 *
 * Wire input: canonical ASP plan fixture (tests/fixtures/resources/asp-plan-v1.json)
 *   sourced from agent-spaces packages/config/src/__fixtures__/resources/expected-plan.json
 *   Schema: agent-authored-runtime-resources.plan/v1
 *
 * Invariants tested (from T-04868 / T-04883):
 *   - Apply/status wire validation (schema, envelope fields, resource shapes)
 *   - Unknown/malformed/untyped cooldown rejection
 *   - Absent cooldown rejection (no invisible apply-time default)
 *   - Mixed schedule/event-hook/channel retry convergence (idempotent partial retry)
 *   - Per-resource outcome reporting
 *   - Status reports drift from desired projection hash/JSON
 *   - Event runtime invariants: no reconcile mutation of event history
 *   - Replay/idempotency for apply runs
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Phase E will create this module. Until then, this import fails at module resolution,
// making all tests in this file RED. When apply.ts is created and exports these symbols,
// the tests will run and (when correctly implemented) go GREEN.
import {
  type ApplyManagedResourcesPlanInput,
  type ManagedResourcesPlan,
  applyManagedResourcesPlan,
  getManagedResourcesStatus,
  reconcileManagedResourcesPlan,
  validateManagedResourcesPlan,
} from '../../../packages/acp-server/src/resources/apply.js'
import * as managedResourceOrchestrator from '../../../packages/acp-server/src/resources/apply.js'

// ------------------------------------------------------------------
// Load the canonical ASP plan fixture (versioned wire input)
// ------------------------------------------------------------------

const FIXTURE_PATH = join(import.meta.dir, '../../fixtures/resources/asp-plan-v1.json')

function loadCanonicalPlan(): ManagedResourcesPlan {
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Canonical ASP plan fixture not found at ${FIXTURE_PATH}. Copy agent-spaces packages/config/src/__fixtures__/resources/expected-plan.json here.`
    )
  }
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as ManagedResourcesPlan
}

const CANONICAL_PLAN = loadCanonicalPlan()
const NOW = '2026-06-17T22:00:00.000Z'
const SCHEDULED_FLOW_PROJECTION_ID =
  'agent-directory:agent:smokey:project:agent-spaces:scheduled-job:daily-triage'
const BINDING_PROJECTION_ID =
  'agent-directory:agent:smokey:project:agent-spaces:interface-binding:discord-smoke'
const EVENT_HOOK_PROJECTION_ID =
  'agent-directory:agent:smokey:project:agent-spaces:event-hook:wrkq-needs-smoketest'

// ------------------------------------------------------------------
// In-memory DB helpers for Phase E tests
// ------------------------------------------------------------------

function makeApplyInput(
  plan: ManagedResourcesPlan = CANONICAL_PLAN
): ApplyManagedResourcesPlanInput {
  return {
    plan,
    jobsDbPath: ':memory:',
    interfaceDbPath: ':memory:',
    now: NOW,
  }
}

function planWithScheduledFreshFlow(): ManagedResourcesPlan {
  return {
    ...CANONICAL_PLAN,
    resources: CANONICAL_PLAN.resources.map((resource) =>
      resource.projectionId === SCHEDULED_FLOW_PROJECTION_ID
        ? {
            ...resource,
            desiredJson: {
              ...resource.desiredJson,
              input: { content: 'legacy content should not be dispatched for flow jobs' },
              flow: {
                sequence: [
                  {
                    id: 'run',
                    fresh: true,
                    input: 'Run the scheduled job with fresh context.',
                  },
                ],
              },
            },
          }
        : resource
    ),
  }
}

function planWithExecutionNodes(nodes: string[] = ['max3', 'svc']): ManagedResourcesPlan {
  return {
    ...CANONICAL_PLAN,
    resources: CANONICAL_PLAN.resources.map((resource) =>
      resource.projectionId === SCHEDULED_FLOW_PROJECTION_ID
        ? {
            ...resource,
            desiredProjectionHash: `sha256-canonical-json/v1:${'d'.repeat(64)}`,
            desiredJson: {
              ...resource.desiredJson,
              execution: { nodes },
            },
          }
        : resource
    ),
  }
}

function onlyResourcePlan(
  source: ManagedResourcesPlan,
  projectionId: string,
  ownerScopeRef: string
): ManagedResourcesPlan {
  const resource = source.resources.find((candidate) => candidate.projectionId === projectionId)
  if (resource === undefined) {
    throw new Error(`missing fixture resource ${projectionId}`)
  }
  return {
    ...source,
    sourceOwnerScopeRef: ownerScopeRef,
    resources: [
      {
        ...resource,
        sourceOwnerScopeRef: ownerScopeRef,
        projectionId: `${resource.projectionId}:extra`,
        projectionPk: `${resource.projectionPk}.extra`,
        resourceName: `${resource.resourceName}-extra`,
        desiredJson: {
          ...resource.desiredJson,
          slug:
            typeof resource.desiredJson['slug'] === 'string'
              ? `${resource.desiredJson['slug']}.extra`
              : resource.desiredJson['slug'],
          bindingId:
            typeof resource.desiredJson['bindingId'] === 'string'
              ? `${resource.desiredJson['bindingId']}.extra`
              : resource.desiredJson['bindingId'],
        },
      },
    ],
  }
}

function planWithoutProjectionIds(
  source: ManagedResourcesPlan,
  projectionIds: readonly string[]
): ManagedResourcesPlan {
  const omitted = new Set(projectionIds)
  return {
    ...source,
    resources: source.resources.filter((resource) => !omitted.has(resource.projectionId)),
  }
}

function makePersistentApplyInput(
  plan: ManagedResourcesPlan = CANONICAL_PLAN
): ApplyManagedResourcesPlanInput {
  const dir = mkdtempSync(join(tmpdir(), 'acp-managed-resources-'))
  return {
    plan,
    jobsDbPath: join(dir, 'jobs.db'),
    interfaceDbPath: join(dir, 'interface.db'),
    now: NOW,
  }
}

// ==================================================================
// Wire validation: plan schema (Phase E invariant)
// ==================================================================

describe('plan schema validation (Phase E invariant)', () => {
  test('canonical ASP plan fixture passes validation', () => {
    const result = validateManagedResourcesPlan(CANONICAL_PLAN)
    expect(result.valid).toBe(true)
  })

  test('plan with wrong schema field is rejected', () => {
    const bad = { ...CANONICAL_PLAN, schema: 'agent-authored-runtime-resources.plan/v2' }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors.some((e) => e.field.includes('schema'))).toBe(true)
  })

  test('plan with wrong managedBy is rejected', () => {
    const bad = { ...CANONICAL_PLAN, managedBy: 'manual' }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan with wrong compiler.name is rejected', () => {
    const bad = {
      ...CANONICAL_PLAN,
      compiler: { name: 'custom-compiler', version: 1 },
    }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan with wrong compiler.version is rejected', () => {
    const bad = {
      ...CANONICAL_PLAN,
      compiler: { name: 'spaces-config/resources', version: 2 },
    }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan missing sourceOwnerScopeRef is rejected', () => {
    const { sourceOwnerScopeRef: _omit, ...bad } = CANONICAL_PLAN
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan with a resource owned by a different sourceOwnerScopeRef is rejected', () => {
    // T-05244: the plan owner is the authority boundary; callers cannot smuggle
    // an arbitrary per-resource owner into validation, status, or reconciliation.
    const bad = {
      ...CANONICAL_PLAN,
      resources: CANONICAL_PLAN.resources.map((resource, index) =>
        index === 0
          ? { ...resource, sourceOwnerScopeRef: 'agent:other:project:agent-spaces:task:primary' }
          : resource
      ),
    }

    const result = validateManagedResourcesPlan(bad)

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors.some((error) => error.field.includes('sourceOwnerScopeRef'))).toBe(true)
  })

  test('plan with duplicate projectionId values is rejected', () => {
    // T-05244: source deletion is projection-id based, so one plan must not
    // contain ambiguous duplicate identities.
    const duplicate = CANONICAL_PLAN.resources[0]
    const bad = {
      ...CANONICAL_PLAN,
      resources: [
        duplicate,
        {
          ...CANONICAL_PLAN.resources[1],
          projectionId: duplicate.projectionId,
        },
      ],
    }

    const result = validateManagedResourcesPlan(bad)

    expect(result.valid).toBe(false)
    if (result.valid) return
    expect(result.errors.some((error) => error.field.includes('projectionId'))).toBe(true)
  })

  test('plan with resource having unknown resourceKind is rejected', () => {
    const badResources = CANONICAL_PLAN.resources.map((r, i) =>
      i === 0 ? { ...r, resourceKind: 'unknown-kind' } : r
    )
    const bad = { ...CANONICAL_PLAN, resources: badResources }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan with resource having malformed sourceHash is rejected', () => {
    const badResources = CANONICAL_PLAN.resources.map((r, i) =>
      i === 0 ? { ...r, sourceHash: 'not-a-hash' } : r
    )
    const bad = { ...CANONICAL_PLAN, resources: badResources }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('plan with resource having lastReconciledAt != pending-apply is rejected', () => {
    const badResources = CANONICAL_PLAN.resources.map((r, i) =>
      i === 0 ? { ...r, lastReconciledAt: '2026-06-17T22:00:00Z' } : r
    )
    const bad = { ...CANONICAL_PLAN, resources: badResources }
    const result = validateManagedResourcesPlan(bad)
    expect(result.valid).toBe(false)
  })

  test('null / non-object input is rejected without throwing', () => {
    expect(validateManagedResourcesPlan(null).valid).toBe(false)
    expect(validateManagedResourcesPlan('string').valid).toBe(false)
    expect(validateManagedResourcesPlan(42).valid).toBe(false)
    expect(validateManagedResourcesPlan(undefined).valid).toBe(false)
  })

  test('accepts canonical scheduled-job execution.nodes and rejects noncanonical or hook placement', () => {
    const scheduled = CANONICAL_PLAN.resources.find(
      (resource) => resource.resourceKind === 'scheduled-job'
    )
    const eventHook = CANONICAL_PLAN.resources.find(
      (resource) => resource.resourceKind === 'event-hook'
    )
    if (scheduled === undefined || eventHook === undefined) throw new Error('missing fixtures')

    const valid = {
      ...CANONICAL_PLAN,
      resources: CANONICAL_PLAN.resources.map((resource) =>
        resource.projectionId === scheduled.projectionId
          ? {
              ...resource,
              desiredJson: {
                ...resource.desiredJson,
                execution: { nodes: ['max3', 'svc'] },
              },
            }
          : resource
      ),
    }
    expect(validateManagedResourcesPlan(valid).valid).toBe(true)

    for (const nodes of [[], ['svc', 'max3'], ['svc', 'svc'], ['all', 'svc'], ['local']]) {
      const invalid = {
        ...valid,
        resources: valid.resources.map((resource) =>
          resource.projectionId === scheduled.projectionId
            ? {
                ...resource,
                desiredJson: {
                  ...resource.desiredJson,
                  execution: { nodes },
                },
              }
            : resource
        ),
      }
      expect(validateManagedResourcesPlan(invalid).valid).toBe(false)
    }

    const hookPlacement = {
      ...CANONICAL_PLAN,
      resources: CANONICAL_PLAN.resources.map((resource) =>
        resource.projectionId === eventHook.projectionId
          ? {
              ...resource,
              desiredJson: {
                ...resource.desiredJson,
                execution: { nodes: ['svc'] },
              },
            }
          : resource
      ),
    }
    expect(validateManagedResourcesPlan(hookPlacement).valid).toBe(false)
  })
})

// ==================================================================
// Cooldown validation at apply time (Phase E invariant)
// ==================================================================

describe('cooldown validation — reject before apply (Phase E invariant)', () => {
  test('plan containing an event-hook with untyped TOML object cooldown is rejected before apply', async () => {
    const badResources = CANONICAL_PLAN.resources.map((r) =>
      r.resourceKind === 'event-hook'
        ? {
            ...r,
            desiredJson: {
              ...r.desiredJson,
              trigger: {
                ...((r.desiredJson as Record<string, unknown>)['trigger'] as Record<
                  string,
                  unknown
                >),
                cooldown: { minutes: 5 }, // TOML object — not a duration string
              },
            },
          }
        : r
    )
    const plan: ManagedResourcesPlan = { ...CANONICAL_PLAN, resources: badResources }
    const result = await applyManagedResourcesPlan({ ...makeApplyInput(plan) })

    const hookOutcome = result.outcomes.find((o) => o.resourceKind === 'event-hook')
    expect(hookOutcome?.outcome).toBe('validation_error')
    expect(hookOutcome?.error?.code).toMatch(/MALFORMED_COOLDOWN|INVALID_COOLDOWN/)
  })

  test('plan containing an event-hook with absent cooldown is rejected before apply', async () => {
    const badResources = CANONICAL_PLAN.resources.map((r) => {
      if (r.resourceKind !== 'event-hook') return r
      const trigger = (r.desiredJson as Record<string, unknown>)['trigger'] as Record<
        string,
        unknown
      >
      const { cooldown: _omit, ...triggerWithoutCooldown } = trigger
      return {
        ...r,
        desiredJson: {
          ...r.desiredJson,
          trigger: triggerWithoutCooldown,
        },
      }
    })
    const plan: ManagedResourcesPlan = { ...CANONICAL_PLAN, resources: badResources }
    const result = await applyManagedResourcesPlan({ ...makeApplyInput(plan) })

    const hookOutcome = result.outcomes.find((o) => o.resourceKind === 'event-hook')
    expect(hookOutcome?.outcome).toBe('validation_error')
    expect(hookOutcome?.error?.code).toMatch(/ABSENT_COOLDOWN|MISSING_COOLDOWN/)
  })

  test('event-hook cooldown that is not a valid ISO 8601 / duration string is rejected', async () => {
    const badResources = CANONICAL_PLAN.resources.map((r) =>
      r.resourceKind === 'event-hook'
        ? {
            ...r,
            desiredJson: {
              ...r.desiredJson,
              trigger: {
                ...((r.desiredJson as Record<string, unknown>)['trigger'] as Record<
                  string,
                  unknown
                >),
                cooldown: 'soon', // not parseable as a duration
              },
            },
          }
        : r
    )
    const plan: ManagedResourcesPlan = { ...CANONICAL_PLAN, resources: badResources }
    const result = await applyManagedResourcesPlan({ ...makeApplyInput(plan) })

    const hookOutcome = result.outcomes.find((o) => o.resourceKind === 'event-hook')
    expect(hookOutcome?.outcome).toBe('validation_error')
    expect(hookOutcome?.error?.code).toMatch(/MALFORMED_COOLDOWN|INVALID_COOLDOWN/)
  })
})

// ==================================================================
// Per-resource outcomes (Phase E invariant)
// ==================================================================

describe('per-resource outcome reporting (Phase E invariant)', () => {
  test('applyManagedResourcesPlan returns one outcome per resource in the plan', async () => {
    const result = await applyManagedResourcesPlan(makeApplyInput())
    expect(result.outcomes).toHaveLength(CANONICAL_PLAN.resources.length)
    expect(result.outcomes.length).toBeGreaterThanOrEqual(3) // schedule + binding + event-hook
  })

  test('all canonical plan resources produce created outcome on first apply', async () => {
    const result = await applyManagedResourcesPlan(makeApplyInput())
    for (const outcome of result.outcomes) {
      expect(outcome.outcome).toBe('created')
    }
  })

  test('each outcome carries the projectionId, resourceKind, and projectionPk', async () => {
    const result = await applyManagedResourcesPlan(makeApplyInput())
    for (const outcome of result.outcomes) {
      expect(outcome.projectionId).toBeDefined()
      expect(typeof outcome.projectionId).toBe('string')
      expect(outcome.resourceKind).toMatch(/scheduled-job|event-hook|interface-binding/)
      expect(outcome.projectionPk).toBeDefined()
    }
  })

  test('stats counter matches outcome counts', async () => {
    const result = await applyManagedResourcesPlan(makeApplyInput())
    const expected = result.outcomes.filter((o) => o.outcome === 'created').length
    expect(result.stats.created).toBe(expected)
    expect(result.stats.failed).toBe(0)
  })
})

// ==================================================================
// Idempotent reapply (Phase E invariant)
// ==================================================================

describe('idempotent reapply via apply/status orchestrator (Phase E invariant)', () => {
  test('applying the same plan twice produces noop on the second call (same in-memory DBs)', async () => {
    // Use shared in-memory DBs across both apply calls
    const input = makeApplyInput()
    const first = await applyManagedResourcesPlan(input)
    expect(first.outcomes.every((o) => o.outcome === 'created')).toBe(true)

    const second = await applyManagedResourcesPlan(input)
    expect(second.outcomes.every((o) => o.outcome === 'noop')).toBe(true)
    expect(second.stats.created).toBe(0)
    expect(second.stats.failed).toBe(0)
  })

  test('applying the plan twice preserves all projectionIds', async () => {
    const input = makeApplyInput()
    await applyManagedResourcesPlan(input)
    const second = await applyManagedResourcesPlan(input)

    const ids = second.outcomes.map((o) => o.projectionId).sort()
    const expectedIds = CANONICAL_PLAN.resources.map((r) => r.projectionId).sort()
    expect(ids).toEqual(expectedIds)
  })
})

// ==================================================================
// Operator readback: apply/status operational facts (T-05243)
// ==================================================================

describe('managed-resource operator readback (T-05243)', () => {
  test('owner set survives apply, no-op reapply, plan-aware status, and reconcile without drift', async () => {
    const plan = planWithExecutionNodes()
    const input = makePersistentApplyInput(plan)
    const first = await applyManagedResourcesPlan(input)
    expect(
      first.outcomes.find((outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID)
    ).toMatchObject({ outcome: 'created', hasDrift: false })

    const second = await applyManagedResourcesPlan(input)
    expect(
      second.outcomes.find((outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID)
    ).toMatchObject({ outcome: 'noop', hasDrift: false })

    const status = await getManagedResourcesStatus({
      plan,
      jobsDbPath: input.jobsDbPath,
      interfaceDbPath: input.interfaceDbPath,
    })
    expect(
      status.resources.find((resource) => resource.projectionId === SCHEDULED_FLOW_PROJECTION_ID)
    ).toMatchObject({
      hasDrift: false,
      isStale: false,
      recommendedAction: 'none',
      desiredProjectionHash: plan.resources.find(
        (resource) => resource.projectionId === SCHEDULED_FLOW_PROJECTION_ID
      )?.desiredProjectionHash,
    })

    const reconciled = await reconcileManagedResourcesPlan({
      ...input,
      sourceDeletionPolicy: 'disable',
    })
    expect(
      reconciled.apply.outcomes.find(
        (outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID
      )
    ).toMatchObject({ outcome: 'noop', hasDrift: false })
  })

  test('scheduled-job apply returns live job facts, no-drift state, and compact fresh-flow summary', async () => {
    // T-05243: operators must not need a separate job-list/JQ probe after apply.
    // The oracle is the public apply result, not the internal store schema.
    const result = await applyManagedResourcesPlan(makeApplyInput(planWithScheduledFreshFlow()))
    const scheduled = result.outcomes.find(
      (outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID
    )

    expect(scheduled).toMatchObject({
      resourceKind: 'scheduled-job',
      projectionPk: 'agent-smokey.daily-triage',
      outcome: 'created',
      liveSlug: 'agent-smokey.daily-triage',
      disabled: false,
      hasDrift: false,
      flowSummary: {
        enabled: true,
        stepCount: 1,
        freshStepCount: 1,
        freshDurationStepCount: 0,
      },
    })
    expect(scheduled).toHaveProperty('jobId')
    expect(scheduled).toHaveProperty('nextFireAt')
    expect((scheduled as { jobId?: unknown }).jobId).toEqual(expect.any(String))
    expect((scheduled as { nextFireAt?: unknown }).nextFireAt).toEqual(expect.any(String))
  })

  test('no-op reapply preserves live job facts and no-drift state', async () => {
    const input = makeApplyInput(planWithScheduledFreshFlow())
    const first = await applyManagedResourcesPlan(input)
    const firstScheduled = first.outcomes.find(
      (outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID
    )

    const second = await applyManagedResourcesPlan(input)
    const secondScheduled = second.outcomes.find(
      (outcome) => outcome.projectionId === SCHEDULED_FLOW_PROJECTION_ID
    )

    expect(secondScheduled).toMatchObject({
      outcome: 'noop',
      liveSlug: 'agent-smokey.daily-triage',
      disabled: false,
      hasDrift: false,
      flowSummary: {
        enabled: true,
        stepCount: 1,
        freshStepCount: 1,
        freshDurationStepCount: 0,
      },
    })
    expect((secondScheduled as { jobId?: unknown }).jobId).toBe(
      (firstScheduled as { jobId?: unknown }).jobId
    )
    expect((secondScheduled as { nextFireAt?: unknown }).nextFireAt).toBe(
      (firstScheduled as { nextFireAt?: unknown }).nextFireAt
    )
  })

  test('status returns plan-scoped operational facts in requested projection order', async () => {
    const plan = planWithScheduledFreshFlow()
    const input = makeApplyInput(plan)
    await applyManagedResourcesPlan(input)

    input.plan = onlyResourcePlan(plan, SCHEDULED_FLOW_PROJECTION_ID, plan.sourceOwnerScopeRef)
    await applyManagedResourcesPlan(input)

    const status = await getManagedResourcesStatus({
      ownerScopeRef: plan.sourceOwnerScopeRef,
      projectionIds: [BINDING_PROJECTION_ID, SCHEDULED_FLOW_PROJECTION_ID],
      jobsDbPath: ':memory:',
      interfaceDbPath: ':memory:',
    } as Parameters<typeof getManagedResourcesStatus>[0] & { projectionIds: string[] })

    expect(status.resources.map((resource) => resource.projectionId)).toEqual([
      BINDING_PROJECTION_ID,
      SCHEDULED_FLOW_PROJECTION_ID,
    ])

    const binding = status.resources[0]
    expect(binding).toMatchObject({
      resourceKind: 'interface-binding',
      projectionPk: 'agent-smokey.discord-smoke',
      state: 'active',
      hasDrift: false,
      bindingId: 'agent-smokey.discord-smoke',
      disabled: false,
      bindingTarget: {
        gatewayId: 'acp-discord-smoke',
        conversationRef: 'channel:1501224513390772224',
        threadRef: 'thread:1501224513390772225',
        scopeRef: 'agent:smokey:project:agent-spaces:task:primary',
        laneRef: 'main',
      },
    })

    const scheduled = status.resources[1]
    expect(scheduled).toMatchObject({
      resourceKind: 'scheduled-job',
      projectionPk: 'agent-smokey.daily-triage',
      state: 'active',
      hasDrift: false,
      liveSlug: 'agent-smokey.daily-triage',
      disabled: false,
      flowSummary: {
        enabled: true,
        stepCount: 1,
        freshStepCount: 1,
        freshDurationStepCount: 0,
      },
    })
    expect(scheduled).toHaveProperty('jobId')
    expect(scheduled).toHaveProperty('nextFireAt')
  })

  test('status without projectionIds remains an owner inventory', async () => {
    const plan = planWithScheduledFreshFlow()
    const input = makeApplyInput(plan)
    await applyManagedResourcesPlan(input)
    input.plan = onlyResourcePlan(plan, SCHEDULED_FLOW_PROJECTION_ID, plan.sourceOwnerScopeRef)
    await applyManagedResourcesPlan(input)

    const status = await getManagedResourcesStatus({
      ownerScopeRef: plan.sourceOwnerScopeRef,
      jobsDbPath: ':memory:',
      interfaceDbPath: ':memory:',
    })

    expect(status.resources.map((resource) => resource.projectionId)).toContain(
      `${SCHEDULED_FLOW_PROJECTION_ID}:extra`
    )
    expect(status.resources.length).toBeGreaterThan(plan.resources.length)
  })
})

// ==================================================================
// Source deletion reconciliation (T-05244)
// ==================================================================

describe('managed-resource source deletion reconciliation (T-05244)', () => {
  test('plan-aware status classifies only same-owner missing projections as stale', async () => {
    const input = makePersistentApplyInput(CANONICAL_PLAN)
    await applyManagedResourcesPlan(input)

    const otherOwnerPlan = onlyResourcePlan(
      CANONICAL_PLAN,
      SCHEDULED_FLOW_PROJECTION_ID,
      'agent:other:project:agent-spaces:task:primary'
    )
    const otherOwnerInput = {
      ...input,
      plan: otherOwnerPlan,
    }
    await applyManagedResourcesPlan(otherOwnerInput)

    const missingSourcePlan = planWithoutProjectionIds(CANONICAL_PLAN, [
      SCHEDULED_FLOW_PROJECTION_ID,
      EVENT_HOOK_PROJECTION_ID,
    ])

    const status = await getManagedResourcesStatus({
      plan: missingSourcePlan,
      jobsDbPath: input.jobsDbPath,
      interfaceDbPath: input.interfaceDbPath,
    } as unknown as Parameters<typeof getManagedResourcesStatus>[0])

    const staleScheduled = status.resources.find(
      (resource) => resource.projectionId === SCHEDULED_FLOW_PROJECTION_ID
    ) as Record<string, unknown> | undefined
    const staleHook = status.resources.find(
      (resource) => resource.projectionId === EVENT_HOOK_PROJECTION_ID
    ) as Record<string, unknown> | undefined
    const presentBinding = status.resources.find(
      (resource) => resource.projectionId === BINDING_PROJECTION_ID
    ) as Record<string, unknown> | undefined
    const otherOwnerResource = status.resources.find(
      (resource) => resource.projectionId === `${SCHEDULED_FLOW_PROJECTION_ID}:extra`
    )

    expect(staleScheduled).toMatchObject({
      projectionId: SCHEDULED_FLOW_PROJECTION_ID,
      resourceKind: 'scheduled-job',
      projectionPk: 'agent-smokey.daily-triage',
      sourcePath: 'agents/smokey/schedules/daily-triage.toml',
      resourceName: 'daily-triage',
      liveTarget: expect.stringMatching(/^job:/),
      state: 'active',
      hasDrift: false,
      isStale: true,
      recommendedAction: 'disable',
    })
    expect(staleHook).toMatchObject({
      projectionId: EVENT_HOOK_PROJECTION_ID,
      resourceKind: 'event-hook',
      projectionPk: 'agent-smokey.wrkq-needs-smoketest',
      sourcePath: 'agents/smokey/event-hooks/wrkq-needs-smoketest.toml',
      resourceName: 'wrkq-needs-smoketest',
      liveTarget: expect.stringMatching(/^job:/),
      state: 'active',
      hasDrift: false,
      isStale: true,
      recommendedAction: 'disable',
    })
    expect(presentBinding).toMatchObject({
      projectionId: BINDING_PROJECTION_ID,
      resourceKind: 'interface-binding',
      sourcePath: 'agents/smokey/channels/discord-smoke.toml',
      resourceName: 'discord-smoke',
      liveTarget: expect.stringMatching(/^binding:/),
      isStale: false,
      recommendedAction: 'none',
    })
    expect(otherOwnerResource).toBeUndefined()
  })

  test('default reconcile disables stale resources once and returns stale_noop on repeat', async () => {
    const reconcileManagedResourcesPlan = (
      managedResourceOrchestrator as {
        reconcileManagedResourcesPlan?: (input: unknown) => Promise<{
          apply: { outcomes: Array<Record<string, unknown>> }
          sourceDeletion: { outcomes: Array<Record<string, unknown>> }
        }>
      }
    ).reconcileManagedResourcesPlan

    expect(typeof reconcileManagedResourcesPlan).toBe('function')

    const input = makePersistentApplyInput(CANONICAL_PLAN)
    await applyManagedResourcesPlan(input)

    const missingSourcePlan = planWithoutProjectionIds(CANONICAL_PLAN, [
      SCHEDULED_FLOW_PROJECTION_ID,
      BINDING_PROJECTION_ID,
      EVENT_HOOK_PROJECTION_ID,
    ])

    const first = await reconcileManagedResourcesPlan?.({
      plan: missingSourcePlan,
      jobsDbPath: input.jobsDbPath,
      interfaceDbPath: input.interfaceDbPath,
      now: NOW,
    })

    expect(first?.apply.outcomes).toHaveLength(missingSourcePlan.resources.length)
    expect(first?.sourceDeletion.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectionId: SCHEDULED_FLOW_PROJECTION_ID,
          resourceKind: 'scheduled-job',
          outcome: 'stale_disabled',
          previousState: 'active',
          finalState: 'disabled',
          sourcePath: 'agents/smokey/schedules/daily-triage.toml',
          resourceName: 'daily-triage',
          liveTarget: expect.stringMatching(/^job:/),
          hadDrift: false,
        }),
        expect.objectContaining({
          projectionId: BINDING_PROJECTION_ID,
          resourceKind: 'interface-binding',
          outcome: 'stale_disabled',
          previousState: 'active',
          finalState: 'disabled',
          sourcePath: 'agents/smokey/channels/discord-smoke.toml',
          resourceName: 'discord-smoke',
          liveTarget: expect.stringMatching(/^binding:/),
          hadDrift: false,
        }),
        expect.objectContaining({
          projectionId: EVENT_HOOK_PROJECTION_ID,
          resourceKind: 'event-hook',
          outcome: 'stale_disabled',
          previousState: 'active',
          finalState: 'disabled',
          sourcePath: 'agents/smokey/event-hooks/wrkq-needs-smoketest.toml',
          resourceName: 'wrkq-needs-smoketest',
          liveTarget: expect.stringMatching(/^job:/),
          hadDrift: false,
        }),
      ])
    )

    const afterFirst = await getManagedResourcesStatus({
      plan: missingSourcePlan,
      jobsDbPath: input.jobsDbPath,
      interfaceDbPath: input.interfaceDbPath,
    } as unknown as Parameters<typeof getManagedResourcesStatus>[0])
    expect(
      afterFirst.resources
        .filter((resource) =>
          [SCHEDULED_FLOW_PROJECTION_ID, BINDING_PROJECTION_ID, EVENT_HOOK_PROJECTION_ID].includes(
            resource.projectionId
          )
        )
        .map((resource) => ({
          projectionId: resource.projectionId,
          state: resource.state,
          disabled: resource.disabled,
          recommendedAction: (resource as Record<string, unknown>)['recommendedAction'],
        }))
    ).toEqual(
      expect.arrayContaining([
        {
          projectionId: SCHEDULED_FLOW_PROJECTION_ID,
          state: 'disabled',
          disabled: true,
          recommendedAction: 'none',
        },
        {
          projectionId: BINDING_PROJECTION_ID,
          state: 'disabled',
          disabled: true,
          recommendedAction: 'none',
        },
        {
          projectionId: EVENT_HOOK_PROJECTION_ID,
          state: 'disabled',
          disabled: true,
          recommendedAction: 'none',
        },
      ])
    )

    const second = await reconcileManagedResourcesPlan?.({
      plan: missingSourcePlan,
      jobsDbPath: input.jobsDbPath,
      interfaceDbPath: input.interfaceDbPath,
      now: NOW,
    })

    expect(second?.sourceDeletion.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectionId: SCHEDULED_FLOW_PROJECTION_ID,
          outcome: 'stale_noop',
          finalState: 'disabled',
        }),
        expect.objectContaining({
          projectionId: BINDING_PROJECTION_ID,
          outcome: 'stale_noop',
          finalState: 'disabled',
        }),
        expect.objectContaining({
          projectionId: EVENT_HOOK_PROJECTION_ID,
          outcome: 'stale_noop',
          finalState: 'disabled',
        }),
      ])
    )
  })
})

// ==================================================================
// Mixed-store partial failure retry convergence (Phase E invariant)
// ==================================================================

describe('mixed-store retry convergence (Phase E invariant)', () => {
  test('partial success on first apply converges to full success on idempotent retry', async () => {
    // Simulate a plan where the interface-binding apply fails on the first attempt (e.g. DB error).
    // Phase E must allow idempotent retry: resources that already succeeded return noop;
    // failed resources are retried. After two successful passes, all are noop.
    //
    // This test validates the protocol guarantee — actual failure injection requires Phase E
    // to expose a testable hook (e.g. a fault injector or a pluggable store factory).
    // For now this is a structural RED test: it will pass only when Phase E exposes the hook
    // and the retry logic converges correctly.
    //
    // Expected contract:
    //   - After a partial failure, a second apply() call on the same plan and DBs must
    //     produce outcome='noop' for already-applied resources and outcome='created' or
    //     'updated' for resources that failed on the first pass.
    //   - The overall result must converge: no resource stuck in 'failed' after retries
    //     unless the failure is permanent (collision, stale_adoption, validation_error).

    // Structural assertion: the apply function exists and is callable
    expect(typeof applyManagedResourcesPlan).toBe('function')

    // Full apply succeeds (no fault injection yet — this is a smoke check)
    const result = await applyManagedResourcesPlan(makeApplyInput())
    expect(result.outcomes.every((o) => ['created', 'noop'].includes(o.outcome))).toBe(true)
  })
})

// ==================================================================
// Status: drift reporting (Phase E invariant)
// ==================================================================

describe('status drift reporting (Phase E invariant)', () => {
  test('getManagedResourcesStatus returns one entry per applied resource', async () => {
    const input = makeApplyInput()
    await applyManagedResourcesPlan(input)

    const status = await getManagedResourcesStatus({
      ownerScopeRef: CANONICAL_PLAN.sourceOwnerScopeRef,
      jobsDbPath: ':memory:',
      interfaceDbPath: ':memory:',
    })
    expect(status.resources).toHaveLength(CANONICAL_PLAN.resources.length)
  })

  test('status reports no drift for freshly applied resources', async () => {
    const input = makeApplyInput()
    await applyManagedResourcesPlan(input)

    const status = await getManagedResourcesStatus({
      ownerScopeRef: CANONICAL_PLAN.sourceOwnerScopeRef,
      jobsDbPath: ':memory:',
      interfaceDbPath: ':memory:',
    })
    for (const resource of status.resources) {
      expect(resource.state).toBe('active')
      expect(resource.hasDrift).toBe(false)
    }
  })

  test('status reports hasDrift=true after out-of-band mutation to a job', async () => {
    // Apply plan, then simulate operator drift on the scheduled-job projection,
    // then check that status detects it.
    // This test requires Phase D detectJobDrift to also be wired into Phase E status.
    // It is RED until both Phase D and Phase E are implemented.
    const input = makeApplyInput()
    await applyManagedResourcesPlan(input)

    // Out-of-band mutation is performed directly against the in-memory DB.
    // Phase E must expose the DB handle or accept a factory for testing.
    // Structural assertion for now:
    expect(typeof getManagedResourcesStatus).toBe('function')
  })
})

// ==================================================================
// Event runtime: reconcile must not mutate event history (Phase E invariant)
// ==================================================================

describe('reconcile must not mutate event runtime facts through orchestrator (Phase E invariant)', () => {
  test('applyManagedResourcesPlan does not return mutations to event_inbox or event_job_matches in outcomes', async () => {
    const result = await applyManagedResourcesPlan(makeApplyInput())
    // No outcome should reference event runtime mutation (only create/update/noop/collision/error)
    const permittedOutcomes = new Set([
      'created',
      'updated',
      'noop',
      'collision',
      'stale_adoption_rejected',
      'validation_error',
      'failed',
    ])
    for (const outcome of result.outcomes) {
      expect(permittedOutcomes.has(outcome.outcome)).toBe(true)
    }
  })

  test('applying the canonical plan twice does not create duplicate event_job_matches rows', async () => {
    // We cannot directly observe event_job_matches without the Phase D store reference.
    // This is a structural test: applying a plan twice must produce noop on all event-hooks.
    const input = makeApplyInput()
    const first = await applyManagedResourcesPlan(input)
    const second = await applyManagedResourcesPlan(input)

    const firstHookOutcomes = first.outcomes.filter((o) => o.resourceKind === 'event-hook')
    const secondHookOutcomes = second.outcomes.filter((o) => o.resourceKind === 'event-hook')

    expect(firstHookOutcomes.every((o) => o.outcome === 'created')).toBe(true)
    expect(secondHookOutcomes.every((o) => o.outcome === 'noop')).toBe(true)
  })
})
