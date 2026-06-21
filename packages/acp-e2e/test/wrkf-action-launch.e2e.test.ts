/**
 * E2E gate — Node D, contract C-0004: ACP wrkf action launch/bind adapter.
 *
 * Drives the REAL `launchAction` adapter against the REAL spawned `wrkf` binary
 * (via `createWrkfClientLifecycle` over an isolated, freshly-migrated wrkq DB),
 * injecting a failure after each non-atomic step and retrying. After the retry,
 * each scenario asserts the frozen reconciliation predicate:
 *   - exactly ONE wrkf action run on the task (via `wrkf.action.list`)
 *   - ONE canonical HRC binding (`externalRunRef === 'hrc:<id>'`)
 *   - NO duplicate launch / action truth (HRC launch counter, single run)
 *
 * HRC SEAM (documented tradeoff): a fully real HRC run is impractical in this
 * harness, so the HRC launch is driven through a controllable
 * `launchRoleScopedRun` seam that returns a stable runId and COUNTS launches —
 * this is exactly what proves "no duplicate launch". The action-start / bind
 * idempotency under test lives in the REAL wrkf binary, which IS spawned here:
 * the adapter's `action.start` / `action.bindExternal` calls hit the real RPC
 * server and the real SQLite DB. (`resolveLaunchIntent` also runs for real
 * against a fake runtimeResolver, mirroring the participant-launch e2e style.)
 *
 * Failure points injected:
 *   A) after action.start (before the ACP durable run / launch): models ACP
 *      restarting right after action.start. Retry replays the same action run
 *      (wrkf idempotent), launches once, binds once.
 *   B) after HRC launch, before bind: models a crash with hrcRunId committed but
 *      bind never sent. Retry re-binds the discovered ref WITHOUT relaunching.
 *   C) after bind, response lost: the real wrkf bind committed but the client
 *      threw. Retry sees the bound externalRunRef from action.start and REPLAYS
 *      — no relaunch, no second bind. wrkf binding-truth wins over the ACP
 *      operational orphan marker.
 *
 * Binaries (overridable): WRKF_BIN / WRKQ_BIN / WRKQADM_BIN default ~/.local/bin.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  InMemoryRunStore,
  type RunStore,
  type WrkfActionLaunchDeps,
  type WrkfLifecycle,
  createWrkfClientLifecycle,
  launchAction,
} from 'acp-server'
import type { AcpServerDeps } from 'acp-server'
import type { SessionRef } from 'agent-scope'

const HOME = process.env['HOME'] ?? '/Users/lherron'
const WRKF_BIN = process.env['WRKF_BIN'] ?? `${HOME}/.local/bin/wrkf`
const WRKQ_BIN = process.env['WRKQ_BIN'] ?? `${HOME}/.local/bin/wrkq`
const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? `${HOME}/.local/bin/wrkqadm`

const ACTION = 'implement'
const ACTOR = { kind: 'agent' as const, id: 'curly-e2e' }

const T = 30_000

type RawActionClient = {
  wrkf: { action: { list(params: { task: string }): Promise<{ items: ActionRunRecord[] }> } }
}
type ActionRunRecord = {
  actionRunId: string
  runId: string
  externalRunRef?: string
  status: string
}

const FAKE_RUNTIME_RESOLVER: NonNullable<AcpServerDeps['runtimeResolver']> = async () => ({
  agentRoot: '/tmp/agents/curly-e2e',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

describe('wrkf action launch/bind adapter — real wrkf e2e (C-0004)', () => {
  let tmpDir: string
  let dbPath: string
  let lc: WrkfLifecycle
  let childEnv: Record<string, string | undefined>

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-action-launch-'))
    dbPath = join(tmpDir, 'wrkq.db')
    childEnv = { ...process.env, ASP_PROJECT: undefined, WRKQ_DB_PATH: undefined }

    const init = Bun.spawnSync([WRKQADM_BIN, '--db', dbPath, 'init'], {
      cwd: tmpDir,
      env: childEnv,
    })
    if (init.exitCode !== 0) {
      throw new Error(`wrkqadm init failed: ${init.stderr.toString()} ${init.stdout.toString()}`)
    }

    lc = await createWrkfClientLifecycle({
      command: WRKF_BIN,
      dbPath,
      clientInfo: { name: 'action-launch-e2e', version: '0.1.0' },
    })
  })

  afterAll(async () => {
    await lc?.close()
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function wrkfPort(): WrkfActionLaunchDeps['wrkf'] {
    const port = lc.wrkf
    if (port === undefined) {
      throw new Error('wrkf port not available')
    }
    return port
  }

  function rawClient(): RawActionClient {
    const client = lc.client as unknown as RawActionClient | undefined
    if (client === undefined) {
      throw new Error('wrkf client not available')
    }
    return client
  }

  function seedTask(slug: string): string {
    const touch = Bun.spawnSync(
      [WRKQ_BIN, '--db', dbPath, '--as', 'local-human', 'touch', '--project', 'inbox', slug],
      { cwd: tmpDir, env: childEnv }
    )
    const out = `${touch.stdout.toString()} ${touch.stderr.toString()}`
    const match = out.match(/(T-\d+)/)
    if (!match) {
      throw new Error(`wrkq touch failed: ${out}`)
    }
    return match[1] as string
  }

  function sessionRef(taskId: string): SessionRef {
    return { scopeRef: `agent:curly-e2e:project:acps-e2e:task:${taskId}`, laneRef: 'main' }
  }

  /** A counting HRC launch seam returning a stable runId. */
  function countingLauncher(hrcRunId: string): {
    launch: NonNullable<AcpServerDeps['launchRoleScopedRun']>
    count(): number
  } {
    let count = 0
    return {
      count: () => count,
      launch: async () => {
        count++
        return {
          runId: hrcRunId,
          sessionId: `host-${hrcRunId}`,
          hostSessionId: `host-${hrcRunId}`,
          runtimeId: `runtime-${hrcRunId}`,
          launchId: `launch-${hrcRunId}`,
          generation: 1,
        }
      },
    }
  }

  async function listActionRuns(taskId: string): Promise<ActionRunRecord[]> {
    const res = await rawClient().wrkf.action.list({ task: taskId })
    return res.items
  }

  // ── Scenario A: failure after action.start (before durable run / launch) ────
  test(
    'A: retry after action.start failure → one action run, one binding, one launch',
    async () => {
      const taskId = seedTask('action-launch-a')
      const idempotencyKey = 'act-a:001'
      const hrcRunId = 'hrc-run-A-001'

      // Attempt 1 crashes right after action.start (ACP never created its run).
      // Simulate by calling the real action.start directly, then "crashing".
      await wrkfPort().action.start({
        task: taskId,
        action: ACTION,
        actor: `${ACTOR.kind}:${ACTOR.id}`,
        idempotencyKey,
      })

      // Attempt 2: full adapter. action.start replays the same run; launch once.
      const runStore: RunStore = new InMemoryRunStore()
      const launcher = countingLauncher(hrcRunId)
      const deps: WrkfActionLaunchDeps = {
        wrkf: wrkfPort(),
        runStore,
        launchRoleScopedRun: launcher.launch,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
      const result = await launchAction(deps, {
        taskId,
        action: ACTION,
        actor: ACTOR,
        idempotencyKey,
        sessionRef: sessionRef(taskId),
      })

      expect(result.replay).toBe(false)
      expect(result.externalRunRef).toBe(`hrc:${hrcRunId}`)
      expect(launcher.count()).toBe(1)

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hrcRunId}`)
      expect(runs[0]?.runId).toBe(result.wrkfRunId)
    },
    T
  )

  // ── Scenario B: failure after HRC launch, before bind (crash-window) ────────
  test(
    'B: retry after launch-before-bind → re-bind discovered ref, no relaunch',
    async () => {
      const taskId = seedTask('action-launch-b')
      const idempotencyKey = 'act-b:001'
      const hrcRunId = 'hrc-run-B-001'
      const runStore: RunStore = new InMemoryRunStore()

      // Attempt 1 partial: action.start + ACP durable run + hrcRunId committed,
      // then CRASH before bind. Replicate that exact durable state.
      const started = (await wrkfPort().action.start({
        task: taskId,
        action: ACTION,
        actor: `${ACTOR.kind}:${ACTOR.id}`,
        idempotencyKey,
      })) as { actionRunId: string; runId: string; instanceId: string }
      const { run: acpRun } = runStore.createOrGetRun({
        sessionRef: sessionRef(taskId),
        wrkfTaskId: taskId,
        wrkfInstanceId: started.instanceId,
        wrkfRunId: started.runId,
        workflowRef: 'wrkq-simple-task@1',
        role: 'implementer',
        actor: ACTOR,
      })
      runStore.updateRun(acpRun.runId, { hrcRunId })

      // Attempt 2: full adapter against the SAME runStore. Must re-bind without
      // relaunching.
      const launcher = countingLauncher('hrc-run-B-SHOULD-NOT-LAUNCH')
      const deps: WrkfActionLaunchDeps = {
        wrkf: wrkfPort(),
        runStore,
        launchRoleScopedRun: launcher.launch,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
      const result = await launchAction(deps, {
        taskId,
        action: ACTION,
        actor: ACTOR,
        idempotencyKey,
        sessionRef: sessionRef(taskId),
      })

      expect(launcher.count()).toBe(0)
      expect(result.externalRunRef).toBe(`hrc:${hrcRunId}`)
      expect(result.hrcRunId).toBe(hrcRunId)

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hrcRunId}`)
    },
    T
  )

  // ── Scenario C: failure after bind, response lost ───────────────────────────
  test(
    'C: retry after bind response loss → replay via wrkf truth, no relaunch, one binding',
    async () => {
      const taskId = seedTask('action-launch-c')
      const idempotencyKey = 'act-c:001'
      const hrcRunId = 'hrc-run-C-001'
      const runStore: RunStore = new InMemoryRunStore()
      const launcher = countingLauncher(hrcRunId)

      // Wrap the port so bindExternal performs the REAL durable bind, then throws
      // to simulate the client losing the response (lost-ack).
      const realPort = wrkfPort()
      const lossyPort: WrkfActionLaunchDeps['wrkf'] = {
        ...realPort,
        action: {
          start: (params) => realPort.action.start(params),
          bindExternal: async (params) => {
            await realPort.action.bindExternal(params) // durably binds on wrkf
            throw Object.assign(new Error('bind response lost'), { code: 'NETWORK_LOST' })
          },
        },
      }

      const deps1: WrkfActionLaunchDeps = {
        wrkf: lossyPort,
        runStore,
        launchRoleScopedRun: launcher.launch,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
      await expect(
        launchAction(deps1, {
          taskId,
          action: ACTION,
          actor: ACTOR,
          idempotencyKey,
          sessionRef: sessionRef(taskId),
        })
      ).rejects.toThrow('bind response lost')

      // The ACP run is marked orphaned (operational), but wrkf already bound.
      const orphaned = runStore.getRun(`run_wrkf_${await firstRunId(taskId)}`)
      expect(orphaned?.metadata?.['wrkfExternalBind']).toMatchObject({ status: 'orphaned' })

      // Attempt 2: full adapter against the REAL port and SAME runStore. action.start
      // now reports the bound externalRunRef → REPLAY, no relaunch, no second bind.
      const deps2: WrkfActionLaunchDeps = {
        wrkf: realPort,
        runStore,
        launchRoleScopedRun: launcher.launch,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
      const result = await launchAction(deps2, {
        taskId,
        action: ACTION,
        actor: ACTOR,
        idempotencyKey,
        sessionRef: sessionRef(taskId),
      })

      expect(result.replay).toBe(true)
      expect(result.externalRunRef).toBe(`hrc:${hrcRunId}`)
      expect(launcher.count()).toBe(1) // launched only in attempt 1

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hrcRunId}`)
    },
    T
  )

  async function firstRunId(taskId: string): Promise<string> {
    const runs = await listActionRuns(taskId)
    const runId = runs[0]?.runId
    if (runId === undefined) {
      throw new Error('no action run found')
    }
    return runId
  }
})
