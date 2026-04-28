import { describe, expect, test } from 'bun:test'

import { dispatchJobRunThroughInputs } from '../src/handlers/admin-jobs.js'
import { type AcpServerDeps, InMemoryInputAttemptStore } from '../src/index.js'
import { buildStepIdempotencyKey, dispatchStepThroughInputs } from '../src/jobs/dispatch-step.js'

import { withWiredServer } from './fixtures/wired-server.js'

// ---------------------------------------------------------------------------
// Recording store to inspect createAttempt calls
// ---------------------------------------------------------------------------

class RecordingInputAttemptStore extends InMemoryInputAttemptStore {
  readonly calls: Array<Parameters<InMemoryInputAttemptStore['createAttempt']>[0]> = []

  override createAttempt(input: Parameters<InMemoryInputAttemptStore['createAttempt']>[0]) {
    this.calls.push(input)
    return super.createAttempt(input)
  }
}

// ---------------------------------------------------------------------------
// Launch stub so dispatch completes without a real runtime
// ---------------------------------------------------------------------------

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function createLaunchOverrides(calls: LaunchCall[]): Partial<AcpServerDeps> {
  return {
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'agent-default' },
      harness: { provider: 'openai', interactive: true },
    }),
    launchRoleScopedRun: async (input) => {
      calls.push(input)
      return {
        runId: input.acpRunId ?? 'run-launch-fallback',
        sessionId: 'session-launch-001',
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Unit tests: buildStepIdempotencyKey
// ---------------------------------------------------------------------------

describe('buildStepIdempotencyKey', () => {
  test('produces the correct format for a sequence step', () => {
    const key = buildStepIdempotencyKey({
      jobRunId: 'jr_abc123',
      phase: 'sequence',
      stepId: 'lint',
      attempt: 1,
    })

    expect(key).toBe('jobrun:jr_abc123:phase:sequence:step:lint:attempt:1')
  })

  test('produces the correct format for an onFailure step', () => {
    const key = buildStepIdempotencyKey({
      jobRunId: 'jr_xyz',
      phase: 'onFailure',
      stepId: 'notify',
      attempt: 2,
    })

    expect(key).toBe('jobrun:jr_xyz:phase:onFailure:step:notify:attempt:2')
  })

  test('is deterministic (same inputs yield same key)', () => {
    const input = {
      jobRunId: 'jr_deterministic',
      phase: 'sequence' as const,
      stepId: 'build',
      attempt: 3,
    }

    expect(buildStepIdempotencyKey(input)).toBe(buildStepIdempotencyKey(input))
    expect(buildStepIdempotencyKey(input)).toBe(
      'jobrun:jr_deterministic:phase:sequence:step:build:attempt:3'
    )
  })

  test('different inputs yield different keys', () => {
    const base = {
      jobRunId: 'jr_same',
      phase: 'sequence' as const,
      stepId: 'deploy',
      attempt: 1,
    }

    const differentStep = buildStepIdempotencyKey({ ...base, stepId: 'test' })
    const differentAttempt = buildStepIdempotencyKey({ ...base, attempt: 2 })
    const differentPhase = buildStepIdempotencyKey({ ...base, phase: 'onFailure' })
    const differentRun = buildStepIdempotencyKey({ ...base, jobRunId: 'jr_other' })
    const original = buildStepIdempotencyKey(base)

    expect(differentStep).not.toBe(original)
    expect(differentAttempt).not.toBe(original)
    expect(differentPhase).not.toBe(original)
    expect(differentRun).not.toBe(original)
  })
})

// ---------------------------------------------------------------------------
// Integration tests: dispatchStepThroughInputs
// ---------------------------------------------------------------------------

describe('dispatchStepThroughInputs', () => {
  test('dispatches through /v1/inputs with step idempotency key and step meta', async () => {
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()
    const launchOverrides = createLaunchOverrides(launchCalls)

    await withWiredServer(
      async (fixture) => {
        const result = await dispatchStepThroughInputs(
          {
            ...fixture,
            inputAttemptStore,
            ...launchOverrides,
            defaultActor: { kind: 'system', id: 'test-actor' },
            authorize: () => 'allow',
            adminStore: undefined as never,
            interfaceStore: fixture.interfaceStore,
            presetRegistry: {
              getPreset: () => {
                throw new Error('not needed')
              },
            },
          },
          {
            jobId: 'job_flow1',
            jobRunId: 'jr_step_test',
            phase: 'sequence',
            stepId: 'lint',
            attempt: 1,
            scopeRef: 'agent:larry:project:proj1:task:T-001:role:implementer',
            laneRef: 'main',
            content: 'run lint step',
          }
        )

        // Returns inputAttemptId and runId
        expect(result).toEqual({
          inputAttemptId: expect.any(String),
          runId: expect.any(String),
        })

        // Verify the input attempt store received correct idempotency key
        expect(inputAttemptStore.calls).toHaveLength(1)
        const call = inputAttemptStore.calls[0]!
        expect(call.idempotencyKey).toBe('jobrun:jr_step_test:phase:sequence:step:lint:attempt:1')

        // Verify step metadata was recorded
        expect(call.metadata).toEqual(
          expect.objectContaining({
            source: {
              kind: 'job',
              jobId: 'job_flow1',
              jobRunId: 'jr_step_test',
              stepId: 'lint',
              phase: 'sequence',
              attempt: 1,
            },
          })
        )

        // Verify the launch was called
        expect(launchCalls).toHaveLength(1)
      },
      {
        inputAttemptStore,
        ...launchOverrides,
      }
    )
  })

  test('idempotent replay returns same result without re-dispatching', async () => {
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()
    const launchOverrides = createLaunchOverrides(launchCalls)

    await withWiredServer(
      async (fixture) => {
        const deps = {
          ...fixture,
          inputAttemptStore,
          ...launchOverrides,
          defaultActor: { kind: 'system' as const, id: 'test-actor' },
          authorize: () => 'allow' as const,
          adminStore: undefined as never,
          interfaceStore: fixture.interfaceStore,
          presetRegistry: {
            getPreset: () => {
              throw new Error('not needed')
            },
          },
        }

        const stepInput = {
          jobId: 'job_replay',
          jobRunId: 'jr_replay_test',
          phase: 'sequence' as const,
          stepId: 'build',
          attempt: 1,
          scopeRef: 'agent:larry:project:proj1:task:T-002:role:implementer',
          laneRef: 'main',
          content: 'run build step',
        }

        const first = await dispatchStepThroughInputs(deps, stepInput)
        const second = await dispatchStepThroughInputs(deps, stepInput)

        // Same result
        expect(second.inputAttemptId).toBe(first.inputAttemptId)
        expect(second.runId).toBe(first.runId)

        // Only one launch (idempotent replay skips dispatch)
        expect(launchCalls).toHaveLength(1)
      },
      {
        inputAttemptStore,
        ...launchOverrides,
      }
    )
  })
})

// ---------------------------------------------------------------------------
// Regression: legacy dispatchJobRunThroughInputs unchanged
// ---------------------------------------------------------------------------

describe('legacy dispatchJobRunThroughInputs (regression)', () => {
  test('uses jobRunId as idempotency key with legacy meta.source (no stepId/phase/attempt)', async () => {
    const launchCalls: LaunchCall[] = []
    const inputAttemptStore = new RecordingInputAttemptStore()
    const launchOverrides = createLaunchOverrides(launchCalls)

    await withWiredServer(
      async (fixture) => {
        const result = await dispatchJobRunThroughInputs(
          {
            ...fixture,
            inputAttemptStore,
            ...launchOverrides,
            defaultActor: { kind: 'system', id: 'test-actor' },
            authorize: () => 'allow',
            adminStore: undefined as never,
            interfaceStore: fixture.interfaceStore,
            presetRegistry: {
              getPreset: () => {
                throw new Error('not needed')
              },
            },
          },
          {
            jobId: 'job_legacy',
            jobRunId: 'jr_legacy_test',
            scopeRef: 'agent:larry:project:proj1:task:T-003:role:implementer',
            laneRef: 'main',
            content: 'legacy single-turn job',
          }
        )

        expect(result).toEqual({
          inputAttemptId: expect.any(String),
          runId: expect.any(String),
        })

        // Legacy uses jobRunId directly as idempotency key
        expect(inputAttemptStore.calls).toHaveLength(1)
        const call = inputAttemptStore.calls[0]!
        expect(call.idempotencyKey).toBe('jr_legacy_test')

        // Legacy meta.source has NO stepId, phase, or attempt
        expect(call.metadata).toEqual(
          expect.objectContaining({
            source: {
              kind: 'job',
              jobId: 'job_legacy',
              jobRunId: 'jr_legacy_test',
            },
          })
        )

        // Specifically assert no step fields leaked into legacy
        const source = (call.metadata as Record<string, unknown>)['source'] as Record<
          string,
          unknown
        >
        expect(source).not.toHaveProperty('stepId')
        expect(source).not.toHaveProperty('phase')
        expect(source).not.toHaveProperty('attempt')

        expect(launchCalls).toHaveLength(1)
      },
      {
        inputAttemptStore,
        ...launchOverrides,
      }
    )
  })
})
