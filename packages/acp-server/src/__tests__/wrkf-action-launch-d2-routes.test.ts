/**
 * Route tests — Node D2 (contract C-0010): authorized HTTP transport for the
 * FROZEN action-launch adapter at `POST /v1/wrkf/actions/launch`.
 *
 * Unlike the Node F route (`/v1/workflow-action-runs`, see
 * wrkf-action-launch-routes.test.ts), this route is wrapped by the standard ACP
 * actor/authz middleware. The adapter logic is FROZEN; these tests pin only the
 * route's parse/dispatch/authz/error-mapping and the C-0010 strict guards:
 *   - happy path returns the WrkfActionLaunchResult ids + replay
 *   - idempotency: repeating the same idempotencyKey does NOT relaunch HRC
 *   - crash-window reconcile through HTTP: a discovered hrcRunId is re-bound,
 *     never relaunched
 *   - non-goals: client-supplied externalRunRef/hrcRunId are ignored; the route
 *     never forwards them to the adapter
 *   - authz: a denying authorizer yields 403 (actor flows through middleware)
 */

import { describe, expect, test } from 'bun:test'

import type { Actor } from 'acp-core'
import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { AuthorizeFn, LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { deriveRunId } from '../domain/run-store.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Shared fixture data ─────────────────────────────────────────────────────

const TASK_ID = 'T-09993'
const ACTION = 'implement'
const ROLE = 'implementer'
const SESSION_REF = 'agent:curly:project:acps-test:task:T-09993~main'

const CANNED_ACTION_RUN = {
  actionRunId: 'actrun-eee555',
  runId: 'actrun-eee555',
  task: TASK_ID,
  instanceId: 'wfi-fff666',
  workflow: { id: 'wrkq-simple-task', version: '1' },
  action: ACTION,
  role: ROLE,
  lane: 'implementation',
  status: 'active',
}

const CANNED_LAUNCHED = {
  runId: 'hrc-run-route-action-001',
  sessionId: 'host-session-route-action-001',
  hostSessionId: 'host-session-route-action-001',
  runtimeId: 'runtime-route-action-001',
  launchId: 'launch-route-action-001',
  generation: 1,
}

// ─── Fake port builder ───────────────────────────────────────────────────────

type FakeOverrides = {
  start?: (params: Record<string, unknown>) => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
}

type InstrumentedPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: Record<string, unknown> }>
}

function makeFakeWrkfPort(overrides: FakeOverrides = {}): InstrumentedPort {
  const _calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    _calls,
    action: {
      start: async (params: unknown) => {
        _calls.push({ method: 'action.start', params: params as Record<string, unknown> })
        return overrides.start !== undefined
          ? overrides.start(params as Record<string, unknown>)
          : CANNED_ACTION_RUN
      },
      bindExternal: async (params: unknown) => {
        _calls.push({ method: 'action.bindExternal', params: params as Record<string, unknown> })
        if (overrides.bindExternal !== undefined) {
          return overrides.bindExternal(params as Record<string, unknown>)
        }
        return {
          ...CANNED_ACTION_RUN,
          externalRunRef: (params as Record<string, unknown>)['externalRunRef'],
        }
      },
    },
  } as unknown as InstrumentedPort
}

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/curly',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/wrkf/actions/launch — happy path + result shape
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — wrkf-action source-tagged response', () => {
  test('returns 201 with the full WrkfActionLaunchResult on successful launch', async () => {
    const wrkf = makeFakeWrkfPort()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            actor: { kind: 'agent', id: 'curly' },
            idempotencyKey: 'd2-route-launch-001',
            sessionRef: SESSION_REF,
          },
        })

        expect(response.status).toBe(201)
        const body = await fixture.json<{
          source: string
          taskId: string
          actionRunId: string
          wrkfRunId: string
          hrcRunId?: string
          externalRunRef?: string
          launch: unknown
          replay: boolean
        }>(response)

        expect(body.source).toBe('wrkf-action')
        expect(body.taskId).toBe(TASK_ID)
        expect(body.actionRunId).toBe(CANNED_ACTION_RUN.actionRunId)
        expect(body.wrkfRunId).toBe(CANNED_ACTION_RUN.runId)
        expect(body.hrcRunId).toBe(CANNED_LAUNCHED.runId)
        expect(body.externalRunRef).toBe(`hrc:${CANNED_LAUNCHED.runId}`)
        expect(body.launch).toBeDefined()
        expect(body.replay).toBe(false)
        expect(launchCalls).toHaveLength(1)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('forwards optional lane and string actor to action.start', async () => {
    const wrkf = makeFakeWrkfPort()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            lane: 'implementation',
            actor: { kind: 'agent', id: 'curly' },
            idempotencyKey: 'd2-route-lane-001',
            sessionRef: SESSION_REF,
          },
        })

        expect(response.status).toBe(201)
        const startCall = wrkf._calls.find((c) => c.method === 'action.start')
        expect(startCall).toBeDefined()
        const p = startCall!.params
        expect(p['task']).toBe(TASK_ID)
        expect(p['action']).toBe(ACTION)
        expect(p['lane']).toBe('implementation')
        // action surface takes a STRING principal_ref (`<kind>:<id>`)
        expect(p['principal_ref']).toBe('agent:curly')
        expect(p['idempotencyKey']).toBe('d2-route-lane-001')
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('requires action field → 400 when absent (no action.start)', async () => {
    const wrkf = makeFakeWrkfPort()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            idempotencyKey: 'd2-route-noaction-001',
            sessionRef: SESSION_REF,
          },
        })

        expect(response.status).toBe(400)
        expect(wrkf._calls.find((c) => c.method === 'action.start')).toBeUndefined()
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('returns 503 WRKF_UNAVAILABLE when deps.wrkf is not configured', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/wrkf/actions/launch',
        body: {
          taskId: TASK_ID,
          action: ACTION,
          idempotencyKey: 'd2-route-no-wrkf-001',
          sessionRef: SESSION_REF,
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-05039 — no launchable triager target → typed 422 BEFORE action.start
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — unresolvable launch target', () => {
  test('no sessionRef + non-agent (system/default) actor → 422 launch_target_required, no action.start', async () => {
    // The visible Taskboard button used to send neither sessionRef nor an agent
    // actor; the route then silently defaulted the worker scope to the kind:'system'
    // identity `agent:acp-local` (no agent-profile.toml) → HTTP 500 on launch and a
    // stranded active action. Per daedalus ruling (DM #9631): reject a missing/
    // unlaunchable target with a typed 422 BEFORE wrkf.action.start; never default a
    // launchable worker to system:acp-local.
    const wrkf = makeFakeWrkfPort()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            idempotencyKey: 'd2-route-no-target-001',
            // NO sessionRef, NO scopeRef, NO agent actor → resolves to defaultActor
            // (system:acp-local) which is not a launchable agent.
          },
        })

        expect(response.status).toBe(422)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('launch_target_required')
        // The action ledger must NOT be touched for an unresolvable target.
        expect(wrkf._calls.find((c) => c.method === 'action.start')).toBeUndefined()
        expect(launchCalls).toHaveLength(0)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('explicit sessionRef launches even when no agent actor is supplied (UI launch-intent path)', async () => {
    // Taskboard passes the concrete launch target sessionRef for the clicked
    // provider button; that is launch intent, not action-state mutation. With an
    // explicit sessionRef the launch proceeds regardless of the (system) actor.
    const wrkf = makeFakeWrkfPort()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            idempotencyKey: 'd2-route-uitarget-001',
            sessionRef: SESSION_REF,
            // No agent actor — the UI does not pass one; sessionRef is authority.
          },
        })

        expect(response.status).toBe(201)
        const startCall = wrkf._calls.find((c) => c.method === 'action.start')
        expect(startCall).toBeDefined()
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — repeating the same idempotencyKey does NOT relaunch HRC
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — idempotency', () => {
  test('repeat with same idempotencyKey replays without a second HRC launch', async () => {
    // wrkf is idempotent on idempotencyKey: after the first launch+bind, a repeat
    // action.start returns the run already carrying its externalRunRef → replay.
    let started = 0
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        started += 1
        return started === 1
          ? CANNED_ACTION_RUN
          : { ...CANNED_ACTION_RUN, externalRunRef: `hrc:${CANNED_LAUNCHED.runId}` }
      },
    })
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount += 1
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        const body = {
          taskId: TASK_ID,
          action: ACTION,
          idempotencyKey: 'd2-route-idem-001',
          sessionRef: SESSION_REF,
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body,
        })
        expect(first.status).toBe(201)
        const firstBody = await fixture.json<{ replay: boolean; hrcRunId?: string }>(first)
        expect(firstBody.replay).toBe(false)
        expect(firstBody.hrcRunId).toBe(CANNED_LAUNCHED.runId)

        const second = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body,
        })
        expect(second.status).toBe(200)
        const secondBody = await fixture.json<{ replay: boolean; hrcRunId?: string }>(second)
        expect(secondBody.replay).toBe(true)
        expect(secondBody.hrcRunId).toBe(CANNED_LAUNCHED.runId)

        // Exactly one HRC launch across both requests; replay does not re-bind.
        expect(launchCount).toBe(1)
        const bindCalls = wrkf._calls.filter((c) => c.method === 'action.bindExternal')
        expect(bindCalls).toHaveLength(1)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Crash-window reconcile through the HTTP route
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — crash-window reconcile', () => {
  test('existing ACP run with hrcRunId but no bind re-binds that exact hrc:<id>, no relaunch', async () => {
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN })
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount += 1
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        // Seed the durable ACP run as if a prior attempt launched HRC (hrcRunId
        // committed) then crashed before action.bindExternal completed.
        const { run: seed } = fixture.runStore.createOrGetRun({
          sessionRef: { scopeRef: 'agent:curly:project:acps-test:task:T-09993', laneRef: 'main' },
          wrkfTaskId: TASK_ID,
          wrkfInstanceId: CANNED_ACTION_RUN.instanceId,
          wrkfRunId: CANNED_ACTION_RUN.runId,
          workflowRef: 'wrkq-simple-task@1',
          role: ROLE,
        })
        expect(seed.runId).toBe(deriveRunId(CANNED_ACTION_RUN.runId))
        fixture.runStore.updateRun(seed.runId, { hrcRunId: CANNED_LAUNCHED.runId })

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            idempotencyKey: 'd2-route-crash-001',
            sessionRef: SESSION_REF,
          },
        })

        expect(response.status).toBe(201)
        const body = await fixture.json<{ hrcRunId?: string; externalRunRef?: string }>(response)
        expect(body.hrcRunId).toBe(CANNED_LAUNCHED.runId)
        expect(body.externalRunRef).toBe(`hrc:${CANNED_LAUNCHED.runId}`)

        // No relaunch; the discovered ref is re-bound exactly.
        expect(launchCount).toBe(0)
        const bindCall = wrkf._calls.find((c) => c.method === 'action.bindExternal')
        expect(bindCall).toBeDefined()
        expect(bindCall!.params['externalRunRef']).toBe(`hrc:${CANNED_LAUNCHED.runId}`)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Non-goal guards — client-supplied externalRunRef/hrcRunId are ignored
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — non-goal guards', () => {
  test('client-supplied externalRunRef/hrcRunId are ignored, not forwarded to the adapter', async () => {
    const wrkf = makeFakeWrkfPort()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            idempotencyKey: 'd2-route-nongoal-001',
            sessionRef: SESSION_REF,
            // UI authority injection attempt — these MUST be ignored.
            externalRunRef: 'hrc:attacker-supplied-ref',
            hrcRunId: 'attacker-supplied-hrc',
          },
        })

        expect(response.status).toBe(201)
        const body = await fixture.json<{ hrcRunId?: string; externalRunRef?: string }>(response)
        // Result ids come from the adapter, never from the client body.
        expect(body.hrcRunId).toBe(CANNED_LAUNCHED.runId)
        expect(body.externalRunRef).toBe(`hrc:${CANNED_LAUNCHED.runId}`)

        // The adapter was never handed the client-supplied ref on any call.
        for (const call of wrkf._calls) {
          expect(call.params['externalRunRef']).not.toBe('hrc:attacker-supplied-ref')
          expect(call.params['hrcRunId']).toBeUndefined()
        }
        const bindCall = wrkf._calls.find((c) => c.method === 'action.bindExternal')
        expect(bindCall!.params['externalRunRef']).toBe(`hrc:${CANNED_LAUNCHED.runId}`)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Authz — the route is wrapped by the standard actor/authz middleware
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/wrkf/actions/launch — actor authorization', () => {
  test('denying authorizer yields 403 and never launches', async () => {
    const wrkf = makeFakeWrkfPort()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount += 1
      return CANNED_LAUNCHED
    }
    const seenAuthz: Array<{ actor: Actor; operation: string; resource: unknown }> = []
    const authorize: AuthorizeFn = (actor, operation, resource) => {
      seenAuthz.push({ actor, operation, resource })
      return 'deny'
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          body: {
            taskId: TASK_ID,
            action: ACTION,
            actor: { kind: 'agent', id: 'curly' },
            idempotencyKey: 'd2-route-authz-001',
            sessionRef: SESSION_REF,
          },
        })

        expect(response.status).toBe(403)
        expect(launchCount).toBe(0)
        expect(wrkf._calls).toHaveLength(0)
        // The authorizer saw this route's operation and the task as the resource.
        expect(seenAuthz).toHaveLength(1)
        expect(seenAuthz[0]!.operation).toBe('wrkf.actions.launch')
        expect(seenAuthz[0]!.resource).toEqual({ kind: 'wrkf-task', id: TASK_ID })
        expect(seenAuthz[0]!.actor).toEqual({ kind: 'agent', id: 'curly' })
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
        authorize,
      }
    )
  })
})
