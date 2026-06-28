/**
 * RED TESTS — T-05268 Phase 3b.
 *
 * These tests pin daedalus' adapter-only invariant for action:"triage":
 * ACP opens one wrkf action, launches the server-configured governed triage
 * runner through HRC command-run with structured WRKF_* binding, then binds the
 * returned HRC identity. ACP must not send a free-text task prompt to the runner,
 * import agent-loop code, accept client command material, or semantically
 * complete/fail after a successful bind.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createInMemoryAdminStore } from 'acp-admin-store'
import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import { type WrkfActionLaunchDeps, launchAction } from '../wrkf/action-launch.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

const TASK_ID = 'T-05268-red'
const ACTION = 'triage'
const ROLE = 'triager'
const IDEMPOTENCY_KEY = 't-05268-command-run-red'
const SESSION_REF = {
  scopeRef: 'agent:smokey:project:agent-control-plane:task:T-05268',
  laneRef: 'main',
}
const CONFIGURED_TRIAGE_TARGET_ID = 'configured:agent-loop-triage-runner'

const CANNED_ACTION_RUN = {
  actionRunId: 'actrun-t05268-red',
  runId: 'wrkf-run-t05268-red',
  task: TASK_ID,
  instanceId: 'wfi-t05268-red',
  workflow: { id: 'wrkq-simple-task', version: '1' },
  action: ACTION,
  role: ROLE,
  lane: 'triage',
  status: 'active',
}
const ACP_RUN_ID = `run_wrkf_${CANNED_ACTION_RUN.runId}`

const COMMAND_LAUNCHED = {
  runId: 'hrc-command-run-t05268',
  hostSessionId: 'host-session-t05268',
  runtimeId: 'runtime-t05268',
  generation: 7,
  transport: 'hrc-command',
  launchId: 'launch-t05268',
  replayed: false,
}

const LEGACY_LAUNCHED = {
  runId: 'legacy-role-run-t05268',
  sessionId: 'legacy-host-session-t05268',
  hostSessionId: 'legacy-host-session-t05268',
  runtimeId: 'legacy-runtime-t05268',
  generation: 1,
  launchId: 'legacy-launch-t05268',
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
  triageCommandTargetId: string
}

type FakeWrkfOverrides = {
  start?: (params: Record<string, unknown>) => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
  fail?: (params: Record<string, unknown>) => Promise<unknown>
}

type InstrumentedWrkfPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: Record<string, unknown> }>
}

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/smokey',
  projectRoot: '/tmp/agent-control-plane',
  cwd: '/tmp/agent-control-plane',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

function makeFakeWrkfPort(overrides: FakeWrkfOverrides = {}): InstrumentedWrkfPort {
  const _calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    _calls,
    action: {
      start: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.start', params })
        return overrides.start !== undefined ? overrides.start(params) : CANNED_ACTION_RUN
      },
      bindExternal: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.bindExternal', params })
        if (overrides.bindExternal !== undefined) {
          return overrides.bindExternal(params)
        }
        return { ...CANNED_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
      show: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.show', params })
        return CANNED_ACTION_RUN
      },
      fail: async (params: Record<string, unknown>) => {
        _calls.push({ method: 'action.fail', params })
        return overrides.fail !== undefined ? overrides.fail(params) : { status: 'failed' }
      },
    },
  } as unknown as InstrumentedWrkfPort
}

function makeCandidateDeps(args: {
  wrkf: InstrumentedWrkfPort
  events: string[]
  command?: LaunchCommandScopedRun | undefined
  legacy?: LaunchRoleScopedRun | undefined
  triageCommandLaunchTimeoutMs?: number | undefined
  adminStore?: WrkfActionLaunchDeps['adminStore'] | undefined
}): CandidateActionLaunchDeps {
  return {
    wrkf: args.wrkf,
    runStore: new InMemoryRunStore(),
    runtimeResolver: FAKE_RUNTIME_RESOLVER,
    triageCommandTargetId: CONFIGURED_TRIAGE_TARGET_ID,
    launchCommandScopedRun:
      args.command ??
      (async (request) => {
        args.events.push('launchCommandScopedRun')
        return { ...COMMAND_LAUNCHED, replayed: Boolean(request.binding['__never__']) }
      }),
    launchRoleScopedRun:
      args.legacy ??
      (async () => {
        args.events.push('launchRoleScopedRun')
        return LEGACY_LAUNCHED
      }),
    ...(args.triageCommandLaunchTimeoutMs !== undefined
      ? { triageCommandLaunchTimeoutMs: args.triageCommandLaunchTimeoutMs }
      : {}),
    ...(args.adminStore !== undefined ? { adminStore: args.adminStore } : {}),
  }
}

function baseInput() {
  return {
    taskId: TASK_ID,
    action: ACTION,
    role: ROLE,
    actor: { kind: 'agent' as const, id: 'smokey' },
    lane: 'triage',
    idempotencyKey: IDEMPOTENCY_KEY,
    sessionRef: SESSION_REF,
    initialPrompt: 'caller text must not become a free-text runner prompt',
  }
}

describe('action:"triage" command-run adapter contract', () => {
  test('performs exactly action.start -> launchCommandScopedRun -> action.bindExternal with structured WRKF binding', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async (params) => {
        events.push('action.start')
        return { ...CANNED_ACTION_RUN, role: String(params['role'] ?? ROLE) }
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...CANNED_ACTION_RUN, externalRunRef: params['externalRunRef'] }
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
      baseInput()
    )

    expect(events).toEqual(['action.start', 'launchCommandScopedRun', 'action.bindExternal'])
    expect(legacyCalls).toHaveLength(0)
    expect(commandCalls).toHaveLength(1)
    expect(commandCalls[0]).toMatchObject({
      configuredTargetId: CONFIGURED_TRIAGE_TARGET_ID,
      sessionRef: SESSION_REF,
      idempotencyKey: `${IDEMPOTENCY_KEY}:launchCommand`,
      binding: {
        WRKF_TASK_ID: TASK_ID,
        WRKF_ACTION_RUN_ID: CANNED_ACTION_RUN.actionRunId,
        WRKF_RUN_ID: CANNED_ACTION_RUN.runId,
        WRKF_ACTION: ACTION,
        WRKF_ROLE: ROLE,
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

    const bindCall = wrkf._calls.find((call) => call.method === 'action.bindExternal')
    expect(bindCall?.params['externalRunRef']).toBe(`hrc:${COMMAND_LAUNCHED.runId}`)
    expect(JSON.parse(String(bindCall?.params['deliveryRef']))).toMatchObject({
      kind: 'hrc',
      runId: COMMAND_LAUNCHED.runId,
      hostSessionId: COMMAND_LAUNCHED.hostSessionId,
      runtimeId: COMMAND_LAUNCHED.runtimeId,
      generation: COMMAND_LAUNCHED.generation,
      transport: COMMAND_LAUNCHED.transport,
    })
    expect(wrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(0)
    expect(result.hrcRunId).toBe(COMMAND_LAUNCHED.runId)
  })

  test('resolves canonical project id to filesystem slug for triage runner binding', async () => {
    const events: string[] = []
    const adminStore = createInMemoryAdminStore()
    const wrkf = makeFakeWrkfPort()
    const commandCalls: LaunchCommandScopedRunRequest[] = []

    try {
      adminStore.projects.create({
        projectId: 'P-00006',
        displayName: 'Taskboard',
        rootDir: '/Users/lherron/praesidium/taskboard',
        actor: { kind: 'agent', id: 'smokey' },
        now: '2026-06-28T21:30:00.000Z',
      })

      await launchAction(
        makeCandidateDeps({
          wrkf,
          events,
          adminStore,
          command: async (request) => {
            commandCalls.push(request)
            return COMMAND_LAUNCHED
          },
        }),
        {
          ...baseInput(),
          sessionRef: {
            scopeRef: 'agent:smokey:project:P-00006:task:T-05287',
            laneRef: 'main',
          },
        }
      )

      expect(commandCalls).toHaveLength(1)
      expect(commandCalls[0]?.binding).toMatchObject({
        WRKF_TASK_ID: TASK_ID,
        WRKF_ACTION_RUN_ID: CANNED_ACTION_RUN.actionRunId,
        WRKF_RUN_ID: CANNED_ACTION_RUN.runId,
        WRKF_ACTION: ACTION,
        WRKF_ROLE: ROLE,
        ASP_PROJECT: 'taskboard',
      })
      expect(commandCalls[0]?.stdinJson).toMatchObject({
        taskId: TASK_ID,
        actionRunId: CANNED_ACTION_RUN.actionRunId,
        wrkfRunId: CANNED_ACTION_RUN.runId,
        action: ACTION,
        role: ROLE,
        project: 'taskboard',
        sessionRef: 'agent:smokey:project:P-00006:task:T-05287',
        lane: 'main',
      })
    } finally {
      adminStore.close()
    }
  })

  test('acp-server source imports no agent-loop package for the governed triage runner', () => {
    const actionLaunchSource = readFileSync(
      join(import.meta.dir, '..', 'wrkf', 'action-launch.ts'),
      'utf8'
    )
    const routeSource = readFileSync(
      join(import.meta.dir, '..', 'handlers', 'wrkf-action-launch.ts'),
      'utf8'
    )

    expect(`${actionLaunchSource}\n${routeSource}`).not.toContain('@praesidium/agent-loop')
  })
})

describe('action:"triage" command-run rollback boundaries', () => {
  test('launchCommandScopedRun failure fails the wrkf action with launch evidence and never binds', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      fail: async (params) => {
        events.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })
    const launchError = new Error('configured triage runner target unavailable')

    await expect(
      launchAction(
        makeCandidateDeps({
          wrkf,
          events,
          command: async () => {
            events.push('launchCommandScopedRun')
            throw launchError
          },
        }),
        baseInput()
      )
    ).rejects.toThrow('configured triage runner target unavailable')

    expect(events).toEqual(['action.start', 'launchCommandScopedRun', 'action.fail'])
    expect(wrkf._calls.filter((call) => call.method === 'action.bindExternal')).toHaveLength(0)
    const failCall = wrkf._calls.find((call) => call.method === 'action.fail')
    expect(failCall?.params).toMatchObject({
      actionRunId: CANNED_ACTION_RUN.actionRunId,
      idempotencyKey: `${IDEMPOTENCY_KEY}:launchRollback`,
      failureResult: {
        wrkfRunId: CANNED_ACTION_RUN.runId,
        phase: 'launch',
        failedBy: 'acp-adapter-rollback',
      },
    })
  })

  test('launchCommandScopedRun timeout marks launch_failed and rolls back instead of leaving a claimed run', async () => {
    const events: string[] = []
    const runStore = new InMemoryRunStore()
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      fail: async (params) => {
        events.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })

    await expect(
      launchAction(
        {
          ...makeCandidateDeps({
            wrkf,
            events,
            triageCommandLaunchTimeoutMs: 1,
            command: async () => {
              events.push('launchCommandScopedRun')
              await new Promise(() => {})
              return COMMAND_LAUNCHED
            },
          }),
          runStore,
        },
        baseInput()
      )
    ).rejects.toThrow('timed out waiting for HRC command-run launch correlation')

    expect(events).toEqual(['action.start', 'launchCommandScopedRun', 'action.fail'])
    expect(wrkf._calls.filter((call) => call.method === 'action.bindExternal')).toHaveLength(0)
    const acpRun = runStore.getRun(ACP_RUN_ID)
    expect(acpRun?.status).toBe('failed')
    expect(acpRun?.hrcRunId).toBeUndefined()
    expect(acpRun?.errorCode).toBe('wrkf_launch_failed_ambiguous')
    expect(acpRun?.metadata?.['wrkfLaunchClaim']).toMatchObject({
      status: 'launch_failed',
      wrkfRunId: CANNED_ACTION_RUN.runId,
      errorCode: 'wrkf_launch_failed_ambiguous',
    })
    expect(wrkf._calls.find((call) => call.method === 'action.fail')?.params).toMatchObject({
      actionRunId: CANNED_ACTION_RUN.actionRunId,
      idempotencyKey: `${IDEMPOTENCY_KEY}:launchRollback`,
      failureResult: {
        wrkfRunId: CANNED_ACTION_RUN.runId,
        phase: 'launch',
        failedBy: 'acp-adapter-rollback',
      },
    })
  })

  test('late command launch correlation after timeout is recorded as an orphan', async () => {
    const events: string[] = []
    const runStore = new InMemoryRunStore()
    let resolveLaunch: (launched: typeof COMMAND_LAUNCHED) => void = () => {}
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      fail: async (params) => {
        events.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })

    await expect(
      launchAction(
        {
          ...makeCandidateDeps({
            wrkf,
            events,
            triageCommandLaunchTimeoutMs: 1,
            command: async () => {
              events.push('launchCommandScopedRun')
              return await new Promise<typeof COMMAND_LAUNCHED>((resolve) => {
                resolveLaunch = resolve
              })
            },
          }),
          runStore,
        },
        baseInput()
      )
    ).rejects.toThrow('timed out waiting for HRC command-run launch correlation')

    resolveLaunch(COMMAND_LAUNCHED)
    await Bun.sleep(1)

    const acpRun = runStore.getRun(ACP_RUN_ID)
    expect(acpRun).toMatchObject({
      status: 'failed',
      hrcRunId: COMMAND_LAUNCHED.runId,
      hostSessionId: COMMAND_LAUNCHED.hostSessionId,
      runtimeId: COMMAND_LAUNCHED.runtimeId,
      generation: COMMAND_LAUNCHED.generation,
      transport: COMMAND_LAUNCHED.transport,
    })
    expect(acpRun?.metadata?.['wrkfExternalBind']).toMatchObject({
      status: 'orphaned',
      hrcRunId: COMMAND_LAUNCHED.runId,
      wrkfRunId: CANNED_ACTION_RUN.runId,
      actionRunId: CANNED_ACTION_RUN.actionRunId,
      reason: 'late_command_launch_correlation_after_timeout',
    })
    expect(wrkf._calls.filter((call) => call.method === 'action.bindExternal')).toHaveLength(0)
  })

  test('bindExternal failure fails the wrkf action with orphaned HRC evidence', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      bindExternal: async () => {
        events.push('action.bindExternal')
        throw new Error('wrkf bindExternal conflict')
      },
      fail: async (params) => {
        events.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })
    const commandCalls: LaunchCommandScopedRunRequest[] = []

    await expect(
      launchAction(
        makeCandidateDeps({
          wrkf,
          events,
          command: async (request) => {
            commandCalls.push(request)
            events.push('launchCommandScopedRun')
            return COMMAND_LAUNCHED
          },
        }),
        baseInput()
      )
    ).rejects.toThrow('wrkf bindExternal conflict')

    expect(commandCalls).toHaveLength(1)
    expect(events).toEqual([
      'action.start',
      'launchCommandScopedRun',
      'action.bindExternal',
      'action.fail',
    ])
    const failCall = wrkf._calls.find((call) => call.method === 'action.fail')
    expect(failCall?.params).toMatchObject({
      actionRunId: CANNED_ACTION_RUN.actionRunId,
      idempotencyKey: `${IDEMPOTENCY_KEY}:bindRollback`,
      failureResult: {
        wrkfRunId: CANNED_ACTION_RUN.runId,
        hrcRunId: `hrc:${COMMAND_LAUNCHED.runId}`,
        phase: 'bind',
        failedBy: 'acp-adapter-rollback',
      },
    })
  })

  test('post-bind command failure is not treated as ACP semantic completion or failure', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...CANNED_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
      fail: async (params) => {
        events.push('action.fail')
        return { failed: params['failureResult'] }
      },
    })

    await launchAction(
      makeCandidateDeps({
        wrkf,
        events,
        command: async () => {
          events.push('launchCommandScopedRun')
          return {
            ...COMMAND_LAUNCHED,
            status: 'failed-after-dispatch',
            errorMessage: 'runner later failed; runner owns wrkf.action.fail',
          } as typeof COMMAND_LAUNCHED
        },
      }),
      baseInput()
    )

    expect(events).toEqual(['action.start', 'launchCommandScopedRun', 'action.bindExternal'])
    expect(wrkf._calls.filter((call) => call.method === 'action.fail')).toHaveLength(0)
  })
})

describe('POST /v1/wrkf/actions/launch action:"triage" command material security', () => {
  test('client command/argv/cwd/env cannot choose the runner; success uses only configuredTargetId, otherwise rejects before launch', async () => {
    const events: string[] = []
    const wrkf = makeFakeWrkfPort({
      start: async () => {
        events.push('action.start')
        return CANNED_ACTION_RUN
      },
      bindExternal: async (params) => {
        events.push('action.bindExternal')
        return { ...CANNED_ACTION_RUN, externalRunRef: params['externalRunRef'] }
      },
    })
    const commandCalls: LaunchCommandScopedRunRequest[] = []
    const legacyCalls: unknown[] = []
    const overrides = {
      wrkf,
      runtimeResolver: FAKE_RUNTIME_RESOLVER,
      triageCommandTargetId: CONFIGURED_TRIAGE_TARGET_ID,
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

    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/wrkf/actions/launch',
        body: {
          taskId: TASK_ID,
          action: ACTION,
          role: ROLE,
          lane: 'triage',
          actor: { kind: 'agent', id: 'smokey' },
          idempotencyKey: 't-05268-route-security',
          sessionRef: SESSION_REF,
          command: '/tmp/attacker-owned-runner',
          argv: ['--steal-task'],
          cwd: '/tmp/attacker-cwd',
          env: { WRKF_ACTION_RUN_ID: 'attacker-controlled' },
        },
      })

      if (response.status === 201 || response.status === 200) {
        expect(commandCalls).toHaveLength(1)
        expect(legacyCalls).toHaveLength(0)
        expect(commandCalls[0]?.configuredTargetId).toBe(CONFIGURED_TRIAGE_TARGET_ID)
        expect(commandCalls[0]).not.toHaveProperty('command')
        expect(commandCalls[0]).not.toHaveProperty('argv')
        expect(commandCalls[0]).not.toHaveProperty('cwd')
        expect(commandCalls[0]).not.toHaveProperty('env')
        expect(commandCalls[0]?.binding['WRKF_ACTION_RUN_ID']).toBe(CANNED_ACTION_RUN.actionRunId)
      } else {
        expect([400, 422]).toContain(response.status)
        expect(commandCalls).toHaveLength(0)
        expect(legacyCalls).toHaveLength(0)
        expect(wrkf._calls).toHaveLength(0)
      }
    }, overrides)
  })
})
