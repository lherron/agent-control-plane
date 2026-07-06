/**
 * RED TESTS -- T-05312.
 *
 * These tests pin the ACP effect-adapter contract for impl-loop Option A:
 * ACP is only the launch/bind/delivery adapter. It starts a wrkf action,
 * launches the trusted HRC command-run target with structured binding, binds the
 * HRC ref, and then stops. The runner owns semantic completion/failure.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import { type WrkfActionLaunchDeps, launchAction } from '../wrkf/action-launch.js'
import { reconcileActionHrcTerminal } from '../wrkf/action-reconciler.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

const TASK_ID = 'T-05312-red'
const IDEMPOTENCY_KEY = 't-05312-red'
const IMPLEMENT_ACTION = 'implement'
const VERIFY_ACTION = 'verify'
const IMPLEMENT_ROLE = 'implementer'
const VERIFY_ROLE = 'tester'
const SESSION_REF = {
  scopeRef: 'agent:cody:project:agent-control-plane:task:T-05312',
  laneRef: 'impl',
}
const CONFIGURED_IMPL_TARGET_ID = 'configured:agent-loop-impl-runner'
const CONFIGURED_VERIFY_TARGET_ID = 'configured:agent-loop-verify-runner'
const SOURCE_IMPLEMENT_ACTION_RUN_ID = 'actrun-implement-source-05312'

const IMPLEMENT_ACTION_RUN = {
  actionRunId: 'actrun-implement-05312',
  runId: 'wrkf-run-implement-05312',
  task: TASK_ID,
  instanceId: 'wfi-05312',
  workflow: { id: 'wrkq-simple-task', version: '1' },
  action: IMPLEMENT_ACTION,
  role: IMPLEMENT_ROLE,
  lane: 'impl',
  status: 'active',
}

const VERIFY_ACTION_RUN = {
  ...IMPLEMENT_ACTION_RUN,
  actionRunId: 'actrun-verify-05312',
  runId: 'wrkf-run-verify-05312',
  action: VERIFY_ACTION,
  role: VERIFY_ROLE,
  lane: 'verify',
}

const VERIFY_CLAIM_BINDING = {
  run: {
    id: 'actrun-verify-claimed-v2-05312',
    instanceId: 'wfi-05312',
    semanticActionKey: 'verify:actrun-implement-source-05312:commit-05312',
    action: VERIFY_ACTION,
    role: VERIFY_ROLE,
    attempt: 1,
    status: 'active',
    source: {
      sourceRunId: SOURCE_IMPLEMENT_ACTION_RUN_ID,
      sourceEvidenceId: 'ev-implement-05312',
      commitSha: 'commit-05312',
    },
  },
  authority: {
    runnerId: `acp-verify-launch:${TASK_ID}:${SOURCE_IMPLEMENT_ACTION_RUN_ID}`,
    ownerToken: 'owner-token-verify-05312',
    ownerGeneration: 1,
    leaseExpiresAt: '2026-07-01T04:30:00.000Z',
  },
  instance: {
    templateId: 'wrkq-simple-task',
    templateVersion: '2',
  },
}

const COMMAND_LAUNCHED = {
  runId: 'hrc-command-run-05312',
  hostSessionId: 'host-session-05312',
  runtimeId: 'runtime-05312',
  generation: 12,
  transport: 'hrc-command',
  launchId: 'launch-05312',
  replayed: false,
}

const LEGACY_LAUNCHED = {
  runId: 'legacy-role-run-05312',
  sessionId: 'legacy-session-05312',
  hostSessionId: 'legacy-session-05312',
  runtimeId: 'legacy-runtime-05312',
  generation: 1,
  launchId: 'legacy-launch-05312',
}

type LaunchCommandScopedRunRequest = {
  configuredTargetId: string
  sessionRef: typeof SESSION_REF
  idempotencyKey: string
  binding: Record<string, string>
  stdinJson?: unknown
  command?: unknown
  argv?: unknown
  cwd?: unknown
  env?: unknown
  prompt?: unknown
  initialPrompt?: unknown
}

type LaunchCommandScopedRun = (
  request: LaunchCommandScopedRunRequest
) => Promise<typeof COMMAND_LAUNCHED>

type CandidateActionLaunchDeps = WrkfActionLaunchDeps & {
  launchCommandScopedRun: LaunchCommandScopedRun
  implCommandTargetId: string
  verifyCommandTargetId: string
}

type FakeWrkfOverrides = {
  actionClaim?: (params: Record<string, unknown>) => Promise<unknown>
  start?: (params: Record<string, unknown>) => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
  fail?: (params: Record<string, unknown>) => Promise<unknown>
  claim?: (params: Record<string, unknown>) => Promise<unknown>
  ack?: (params: Record<string, unknown>) => Promise<unknown>
}

type InstrumentedWrkfPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: Record<string, unknown> }>
}

type VerifyLaunchConsumer = (
  deps: CandidateActionLaunchDeps & { wrkf: InstrumentedWrkfPort },
  input: { taskId: string; limit?: number }
) => Promise<unknown>

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/cody',
  projectRoot: '/tmp/agent-control-plane',
  cwd: '/tmp/agent-control-plane',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

const VERIFY_EFFECT = {
  effectId: 'effect-verify-launch-05312',
  id: 'effect-verify-launch-05312',
  kind: 'verify_launch_intent',
  status: 'pending',
  payload: {
    task: TASK_ID,
    action: VERIFY_ACTION,
    role: VERIFY_ROLE,
    sourceImplementActionRunId: SOURCE_IMPLEMENT_ACTION_RUN_ID,
    instanceId: 'wfi-05312',
  },
}

function makeFakeWrkfPort(overrides: FakeWrkfOverrides = {}): InstrumentedWrkfPort {
  const _calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    _calls,
    action: {
      ...(overrides.actionClaim !== undefined
        ? {
            claim: async (params: Record<string, unknown>) => {
              _calls.push({ method: 'action.claim', params })
              return overrides.actionClaim?.(params)
            },
          }
        : {}),
      start: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.start', params })
        if (overrides.start !== undefined) {
          return overrides.start(params)
        }
        return params['action'] === VERIFY_ACTION ? VERIFY_ACTION_RUN : IMPLEMENT_ACTION_RUN
      },
      bindExternal: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.bindExternal', params })
        if (overrides.bindExternal !== undefined) {
          return overrides.bindExternal(params)
        }
        return { ...IMPLEMENT_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
      show: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.show', params })
        return { ...IMPLEMENT_ACTION_RUN, status: 'active' }
      },
      fail: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.fail', params })
        if (overrides.fail !== undefined) {
          return overrides.fail(params)
        }
        return { status: 'failed' }
      },
    },
    effect: {
      claim: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'effect.claim', params })
        if (overrides.claim !== undefined) {
          return overrides.claim(params)
        }
        return {
          effects: [VERIFY_EFFECT],
          leaseToken: 'lease-verify-launch-05312',
          leaseExpiresAt: '2026-06-29T04:30:00.000Z',
        }
      },
      ack: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'effect.ack', params })
        if (overrides.ack !== undefined) {
          return overrides.ack(params)
        }
        return { effectId: params['effectId'], status: 'acked' }
      },
    },
  } as unknown as InstrumentedWrkfPort
}

function makeCandidateDeps(args: {
  wrkf: InstrumentedWrkfPort
  events: string[]
  runStore?: InMemoryRunStore | undefined
  command?: LaunchCommandScopedRun | undefined
  legacy?: LaunchRoleScopedRun | undefined
}): CandidateActionLaunchDeps {
  return {
    wrkf: args.wrkf,
    runStore: args.runStore ?? new InMemoryRunStore(),
    runtimeResolver: FAKE_RUNTIME_RESOLVER,
    implCommandTargetId: CONFIGURED_IMPL_TARGET_ID,
    verifyCommandTargetId: CONFIGURED_VERIFY_TARGET_ID,
    launchCommandScopedRun:
      args.command ??
      (async () => {
        args.events.push('launchCommandScopedRun')
        return COMMAND_LAUNCHED
      }),
    launchRoleScopedRun:
      args.legacy ??
      (async () => {
        args.events.push('launchRoleScopedRun')
        return LEGACY_LAUNCHED
      }),
  }
}

function implementInput() {
  return {
    taskId: TASK_ID,
    action: IMPLEMENT_ACTION,
    role: IMPLEMENT_ROLE,
    actor: { kind: 'agent' as const, id: 'cody' },
    lane: 'impl',
    idempotencyKey: IDEMPOTENCY_KEY,
    sessionRef: SESSION_REF,
    initialPrompt: 'client text must not be sent as a free-text runner prompt',
  }
}

async function loadVerifyLaunchConsumer(): Promise<VerifyLaunchConsumer> {
  const mod = await import('../wrkf/verify-launch-consumer.js').catch((error) => ({ error }))
  expect((mod as { error?: unknown }).error).toBeUndefined()
  const candidate = (mod as { consumeVerifyLaunchIntents?: unknown }).consumeVerifyLaunchIntents
  expect(typeof candidate).toBe('function')
  return candidate as VerifyLaunchConsumer
}

describe('action:"implement" command-run adapter contract', () => {
  test('performs exactly action.start -> launchCommandScopedRun -> action.bindExternal with structured binding', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async (params) => {
        events.push('action.start')
        return { ...IMPLEMENT_ACTION_RUN, role: params['role'] }
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...IMPLEMENT_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
    })
    const commandCalls: LaunchCommandScopedRunRequest[] = []
    const legacyCalls: unknown[] = []

    const result = await launchAction(
      makeCandidateDeps({
        wrkf,
        events,
        command: async (request) => {
          commandCalls.push(request)
          events.push('launchCommandScopedRun')
          return COMMAND_LAUNCHED
        },
        legacy: async (input) => {
          legacyCalls.push(input)
          events.push('launchRoleScopedRun')
          return LEGACY_LAUNCHED
        },
      }),
      implementInput()
    )

    expect(events).toEqual(['action.start', 'launchCommandScopedRun', 'action.bindExternal'])
    expect(legacyCalls).toHaveLength(0)
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]).toMatchObject({
      configuredTargetId: CONFIGURED_IMPL_TARGET_ID,
      sessionRef: SESSION_REF,
      idempotencyKey: `${IDEMPOTENCY_KEY}:launchCommand`,
      binding: {
        WRKF_TASK_ID: TASK_ID,
        WRKF_ACTION_RUN_ID: IMPLEMENT_ACTION_RUN.actionRunId,
        WRKF_RUN_ID: IMPLEMENT_ACTION_RUN.runId,
        WRKF_ACTION: IMPLEMENT_ACTION,
        WRKF_ROLE: IMPLEMENT_ROLE,
        ASP_PROJECT: 'agent-control-plane',
        HRC_SESSION_REF: SESSION_REF.scopeRef,
        HRC_LANE: SESSION_REF.laneRef,
      },
    })
    expect(commandCalls[0]).not.toHaveProperty('prompt')
    expect(commandCalls[0]).not.toHaveProperty('initialPrompt')
    expect(commandCalls[0]).not.toHaveProperty('command')
    expect(commandCalls[0]).not.toHaveProperty('argv')
    expect(commandCalls[0]).not.toHaveProperty('cwd')
    expect(commandCalls[0]).not.toHaveProperty('env')
    expect(wrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(0)
    expect(result.hrcRunId).toBe(COMMAND_LAUNCHED.runId)
  })

  test('acp-server source imports no agent-loop package for implement or verify runners', () => {
    const sources = [
      join(import.meta.dir, '..', 'wrkf', 'action-launch.ts'),
      join(import.meta.dir, '..', 'handlers', 'wrkf-action-launch.ts'),
    ]
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n')

    expect(sources).not.toContain('@praesidium/agent-loop')
  })

  test('launch failure and bind failure roll back only the started action; post-bind command failure is runner-owned', async () => {
    const launchEvents: string[] = []
    const launchWrkf = makeFakeWrkfPort({
      start: async () => {
        launchEvents.push('action.start')
        return IMPLEMENT_ACTION_RUN
      },
      fail: async (params) => {
        launchEvents.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })
    await expect(
      launchAction(
        makeCandidateDeps({
          wrkf: launchWrkf,
          events: launchEvents,
          command: async () => {
            launchEvents.push('launchCommandScopedRun')
            throw new Error('configured implement runner target unavailable')
          },
        }),
        implementInput()
      )
    ).rejects.toThrow('configured implement runner target unavailable')
    expect(launchEvents).toEqual(['action.start', 'launchCommandScopedRun', 'action.fail'])
    expect(launchWrkf._calls.find((call) => call.method === 'action.fail')?.params).toMatchObject({
      actionRunId: IMPLEMENT_ACTION_RUN.actionRunId,
      idempotencyKey: `${IDEMPOTENCY_KEY}:launchRollback`,
      failureResult: {
        phase: 'launch',
        failedBy: 'acp-adapter-rollback',
      },
    })

    const bindEvents: string[] = []
    const bindWrkf = makeFakeWrkfPort({
      start: async () => {
        bindEvents.push('action.start')
        return IMPLEMENT_ACTION_RUN
      },
      bindExternal: async () => {
        bindEvents.push('action.bindExternal')
        throw new Error('wrkf bindExternal conflict')
      },
      fail: async (params) => {
        bindEvents.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })
    await expect(
      launchAction(
        makeCandidateDeps({
          wrkf: bindWrkf,
          events: bindEvents,
          command: async () => {
            bindEvents.push('launchCommandScopedRun')
            return COMMAND_LAUNCHED
          },
        }),
        implementInput()
      )
    ).rejects.toThrow('wrkf bindExternal conflict')
    expect(bindEvents).toEqual([
      'action.start',
      'launchCommandScopedRun',
      'action.bindExternal',
      'action.fail',
    ])
    expect(bindWrkf._calls.find((call) => call.method === 'action.fail')?.params).toMatchObject({
      actionRunId: IMPLEMENT_ACTION_RUN.actionRunId,
      idempotencyKey: `${IDEMPOTENCY_KEY}:bindRollback`,
      failureResult: {
        hrcRunId: `hrc:${COMMAND_LAUNCHED.runId}`,
        phase: 'bind',
        failedBy: 'acp-adapter-rollback',
      },
    })

    const postBindEvents: string[] = []
    const postBindWrkf = makeFakeWrkfPort({
      start: async () => {
        postBindEvents.push('action.start')
        return IMPLEMENT_ACTION_RUN
      },
      bindExternal: async (params) => {
        postBindEvents.push('action.bindExternal')
        return { ...IMPLEMENT_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
    })
    await launchAction(
      makeCandidateDeps({
        wrkf: postBindWrkf,
        events: postBindEvents,
        command: async () => {
          postBindEvents.push('launchCommandScopedRun')
          return { ...COMMAND_LAUNCHED, status: 'failed-after-bind' } as typeof COMMAND_LAUNCHED
        },
      }),
      implementInput()
    )
    expect(postBindEvents).toEqual([
      'action.start',
      'launchCommandScopedRun',
      'action.bindExternal',
    ])
    expect(postBindWrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(0)
  })
})

describe('verify-launch-intent consumer', () => {
  const savedAspProject = process.env['ASP_PROJECT']

  beforeEach(() => {
    // T-05830 red: verify launches may be consumed from a drain-depth worktree
    // whose directory basename is not the project id. The explicit project
    // carried by the runner environment must win over cwd fallback.
    process.env['ASP_PROJECT'] = 'agent-control-plane'
  })

  afterEach(() => {
    if (savedAspProject !== undefined) {
      process.env['ASP_PROJECT'] = savedAspProject
    } else {
      Reflect.deleteProperty(process.env, 'ASP_PROJECT')
    }
  })

  test('v2 claim path claims exact verify candidate, launches once, binds once, and never action.start', async () => {
    const consumeVerifyLaunchIntents = await loadVerifyLaunchConsumer()
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      claim: async (params) => {
        events.push('effect.claim')
        expect(params).toMatchObject({
          adapter: 'acp',
          kind: 'verify_launch_intent',
          task: TASK_ID,
        })
        return { effects: [VERIFY_EFFECT], leaseToken: 'lease-05312' }
      },
      actionClaim: async (params) => {
        events.push('action.claim')
        expect(params).toMatchObject({
          task: TASK_ID,
          prefer: { action: VERIFY_ACTION },
          runnerId: `acp-verify-launch:${TASK_ID}:${SOURCE_IMPLEMENT_ACTION_RUN_ID}`,
          agentRef: 'agent:cody',
          scopeRef: SESSION_REF.scopeRef,
        })
        return { binding: VERIFY_CLAIM_BINDING }
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...VERIFY_CLAIM_BINDING.run, externalRunRef: params['externalRunRef'] }
      },
      ack: async (params) => {
        events.push('effect.ack')
        return { effectId: params['effectId'], status: 'acked' }
      },
    })
    const commandCalls: LaunchCommandScopedRunRequest[] = []

    await consumeVerifyLaunchIntents(
      makeCandidateDeps({
        wrkf,
        events,
        command: async (request) => {
          commandCalls.push(request)
          events.push('launchCommandScopedRun')
          return COMMAND_LAUNCHED
        },
      }),
      { taskId: TASK_ID, limit: 1 }
    )

    expect(events).toEqual([
      'effect.claim',
      'action.claim',
      'launchCommandScopedRun',
      'action.bindExternal',
      'effect.ack',
    ])
    expect(wrkf._calls.find((call) => call.method === 'action.start')).toBeUndefined()
    expect(wrkf._calls.find((call) => call.method === 'action.bindExternal')?.params).toMatchObject(
      {
        actionRunId: VERIFY_CLAIM_BINDING.run.id,
      }
    )
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]).toMatchObject({
      configuredTargetId: CONFIGURED_VERIFY_TARGET_ID,
      binding: {
        WRKF_ACTION_RUN_ID: VERIFY_CLAIM_BINDING.run.id,
        WRKF_RUN_ID: VERIFY_CLAIM_BINDING.run.id,
        WRKF_ACTION_OWNER_TOKEN: VERIFY_CLAIM_BINDING.authority.ownerToken,
        WRKF_ACTION_OWNER_GENERATION: String(VERIFY_CLAIM_BINDING.authority.ownerGeneration),
      },
      stdinJson: {
        actionAuthority: VERIFY_CLAIM_BINDING.authority,
      },
    })
  })

  test('claims one verify-launch effect, starts verify keyed by source implement action, launches once, binds once, then acks', async () => {
    const consumeVerifyLaunchIntents = await loadVerifyLaunchConsumer()
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      claim: async (params) => {
        events.push('effect.claim')
        expect(params).toMatchObject({
          adapter: 'acp',
          kind: 'verify_launch_intent',
          task: TASK_ID,
        })
        return { effects: [VERIFY_EFFECT], leaseToken: 'lease-05312' }
      },
      start: async (params) => {
        events.push('action.start')
        return { ...VERIFY_ACTION_RUN, role: params['role'] }
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...VERIFY_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
      ack: async (params) => {
        events.push('effect.ack')
        return { effectId: params['effectId'], status: 'acked' }
      },
    })
    const commandCalls: LaunchCommandScopedRunRequest[] = []

    await consumeVerifyLaunchIntents(
      makeCandidateDeps({
        wrkf,
        events,
        command: async (request) => {
          commandCalls.push(request)
          events.push('launchCommandScopedRun')
          return COMMAND_LAUNCHED
        },
      }),
      { taskId: TASK_ID, limit: 1 }
    )

    expect(events).toEqual([
      'effect.claim',
      'action.start',
      'launchCommandScopedRun',
      'action.bindExternal',
      'effect.ack',
    ])
    expect(wrkf._calls.find((call) => call.method === 'action.start')?.params).toMatchObject({
      task: TASK_ID,
      action: VERIFY_ACTION,
      role: VERIFY_ROLE,
    })
    expect(
      String(wrkf._calls.find((call) => call.method === 'action.start')?.params['idempotencyKey'])
    ).toContain(SOURCE_IMPLEMENT_ACTION_RUN_ID)
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]).toMatchObject({
      configuredTargetId: CONFIGURED_VERIFY_TARGET_ID,
      binding: {
        WRKF_TASK_ID: TASK_ID,
        WRKF_ACTION_RUN_ID: VERIFY_ACTION_RUN.actionRunId,
        WRKF_RUN_ID: VERIFY_ACTION_RUN.runId,
        WRKF_ACTION: VERIFY_ACTION,
        WRKF_ROLE: VERIFY_ROLE,
        ASP_PROJECT: 'agent-control-plane',
        HRC_SESSION_REF: SESSION_REF.scopeRef,
        HRC_LANE: SESSION_REF.laneRef,
      },
    })
    expect(commandCalls[0]?.stdinJson).toMatchObject({
      sourceImplementActionRunId: SOURCE_IMPLEMENT_ACTION_RUN_ID,
    })
    expect(wrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(0)
  })

  test('does not ack verify-launch effect before bindExternal succeeds', async () => {
    const consumeVerifyLaunchIntents = await loadVerifyLaunchConsumer()
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      bindExternal: async () => {
        events.push('action.bindExternal')
        throw new Error('bind failed before delivery became durable')
      },
      ack: async (params) => {
        events.push('effect.ack')
        return { effectId: params['effectId'], status: 'acked' }
      },
    })

    await expect(
      consumeVerifyLaunchIntents(
        makeCandidateDeps({
          wrkf,
          events,
          command: async () => {
            events.push('launchCommandScopedRun')
            return COMMAND_LAUNCHED
          },
        }),
        { taskId: TASK_ID, limit: 1 }
      )
    ).rejects.toThrow('bind failed before delivery became durable')

    expect(events).toContain('action.bindExternal')
    expect(events).not.toContain('effect.ack')
  })

  test('retry and duplicate delivery cannot create two verify actions or two HRC command runs for one source implement action', async () => {
    const consumeVerifyLaunchIntents = await loadVerifyLaunchConsumer()
    const events: string[] = []
    const runStore = new InMemoryRunStore()
    const wrkf = makeFakeWrkfPort()
    const commandCalls: LaunchCommandScopedRunRequest[] = []
    const deps = makeCandidateDeps({
      wrkf,
      events,
      runStore,
      command: async (request) => {
        commandCalls.push(request)
        events.push('launchCommandScopedRun')
        return COMMAND_LAUNCHED
      },
    })

    await consumeVerifyLaunchIntents(deps, { taskId: TASK_ID, limit: 1 })
    await consumeVerifyLaunchIntents(deps, { taskId: TASK_ID, limit: 1 })

    const verifyStarts = wrkf._calls.filter(
      (call) => call.method === 'action.start' && call.params['action'] === VERIFY_ACTION
    )
    expect(new Set(verifyStarts.map((call) => call.params['idempotencyKey']))).toHaveSize(1)
    expect(commandCalls).toHaveLength(1)
  })
})

describe('route security for implement/verify command-run launches', () => {
  test('client command material and arbitrary actor role cannot choose the implement runner', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort()
    const commandCalls: LaunchCommandScopedRunRequest[] = []
    const legacyCalls: unknown[] = []

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/wrkf/actions/launch',
          headers: { 'x-acp-actor': 'agent:cody' },
          body: {
            taskId: TASK_ID,
            action: IMPLEMENT_ACTION,
            role: 'attacker-supplied-role',
            lane: 'impl',
            idempotencyKey: 't-05312-route-security',
            sessionRef: { ...SESSION_REF, laneRef: 'main' },
            command: '/tmp/attacker-runner',
            argv: ['--claim-anything'],
            cwd: '/tmp/attacker-cwd',
            env: { WRKF_ACTION_RUN_ID: 'attacker-action-run' },
          },
        })

        // T-05312 security: client input must not be able to select command
        // material or arbitrary worker roles for impl/verify. The request should
        // be rejected before any wrkf action is opened or HRC runner launched.
        expect(response.status).toBe(400)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(JSON.stringify(body)).toContain('client_command_material')
        expect(commandCalls).toHaveLength(0)
        expect(legacyCalls).toHaveLength(0)
        expect(wrkf._calls).toHaveLength(0)
      },
      {
        wrkf,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
        implCommandTargetId: CONFIGURED_IMPL_TARGET_ID,
        launchCommandScopedRun: async (request: LaunchCommandScopedRunRequest) => {
          commandCalls.push(request)
          events.push('launchCommandScopedRun')
          return COMMAND_LAUNCHED
        },
        launchRoleScopedRun: (async (input) => {
          legacyCalls.push(input)
          events.push('launchRoleScopedRun')
          return LEGACY_LAUNCHED
        }) satisfies LaunchRoleScopedRun,
      }
    )
  })
})

describe('terminal HRC watchdog applies to implement and verify actions', () => {
  test.each([
    {
      action: IMPLEMENT_ACTION,
      role: IMPLEMENT_ROLE,
      actionRunId: IMPLEMENT_ACTION_RUN.actionRunId,
    },
    { action: VERIFY_ACTION, role: VERIFY_ROLE, actionRunId: VERIFY_ACTION_RUN.actionRunId },
  ])('fails a still-active $action action when its bound HRC run is terminal', async (input) => {
    const wrkf = makeFakeWrkfPort({
      start: async () => ({ ...IMPLEMENT_ACTION_RUN, action: input.action, role: input.role }),
    })

    await reconcileActionHrcTerminal(
      { wrkf },
      {
        actionRunId: input.actionRunId,
        wrkfRunId:
          input.action === VERIFY_ACTION ? VERIFY_ACTION_RUN.runId : IMPLEMENT_ACTION_RUN.runId,
        hrcRunId: COMMAND_LAUNCHED.runId,
        hrcTerminalStatus: 'failed',
        taskId: TASK_ID,
        idempotencyKey: `reconcile:${input.actionRunId}:${COMMAND_LAUNCHED.runId}`,
      }
    )

    expect(wrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(1)
    expect(wrkf._calls.find((call) => call.method === 'action.fail')?.params).toMatchObject({
      actionRunId: input.actionRunId,
      failureResult: {
        hrcRunId: `hrc:${COMMAND_LAUNCHED.runId}`,
        hrcStatus: 'failed',
        reconciledBy: 'acp-reconciler',
      },
    })
  })
})
