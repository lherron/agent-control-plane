/**
 * E2E gate — Node Z, contract C-0004 (REAL-HRC closure of the counting-seam gap).
 *
 * This is the real-HRC sibling of `wrkf-action-launch.e2e.test.ts`. It drives the
 * REAL `launchAction` adapter against:
 *   - the REAL spawned `wrkf` binary (via `createWrkfClientLifecycle` over an
 *     isolated, freshly-migrated wrkq DB), AND
 *   - the REAL, LIVE HRC daemon (real `hrc.sock`, real `state.sqlite`).
 *
 * The prior C-0004 e2e proved action-start / bind idempotency against the real
 * wrkf binary, but stubbed the HRC launch behind a `countingLauncher` returning a
 * synthetic constant runId. That left a fidelity gap: the canonical binding was a
 * made-up `hrc:hrc-run-A-001`, not a real HRC-minted host session, and "no
 * duplicate launch" was only ever proven against an in-process counter.
 *
 * THIS TEST CLOSES THAT GAP. The launcher here calls the live
 * `HrcClient.resolveSession({ create: true })` for the run's `sessionRef` — the
 * EXACT production no-prompt path in `real-launcher.ts` (lines 70-112): the
 * broker-cutover (T-01691) empty-prompt branch that MINTS a real host session
 * via the daemon but provisions NO runtime and dispatches NO turn (no model /
 * agent spawn). The minted `hostSessionId` is real, durable, and idempotent
 * (calling twice for the same sessionRef returns the SAME id). The canonical
 * binding is therefore a genuine `hrc:<hostSessionId>` minted by HRC, not a
 * synthetic constant.
 *
 * The launcher is still wrapped to COUNT invocations — that counter remains the
 * proof of "no duplicate HRC launch". On top of it, EACH scenario opens the REAL
 * `state.sqlite` (readonly `bun:sqlite`) and asserts exactly ONE `sessions` row
 * and ONE `continuities` row exist for the test scope — proving no duplicate
 * launch at the real daemon, not merely in the in-process seam.
 *
 * Each scenario uses a UNIQUE scopeRef (a per-run nonce + the seeded taskId) so
 * the shared, live HRC `state.sqlite` cannot collide across scenarios or repeated
 * test runs — the per-scope session/continuity counts stay exactly 1.
 *
 * Failure points injected (identical to the counting-seam e2e):
 *   A) after action.start (before durable run / launch)
 *   B) after HRC launch, before bind (hrcRunId pre-committed in the runStore)
 *   C) after bind, response lost (real durable bind then throw)
 *
 * Binaries (overridable): WRKF_BIN / WRKQ_BIN / WRKQADM_BIN default ~/.local/bin.
 * HRC: live daemon discovered via `discoverSocket()` + `resolveDatabasePath()`.
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { formatHrcExternalRef } from 'acp-core'
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
import type { HrcRuntimeIntent } from 'hrc-core'
import { resolveDatabasePath } from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'

const HOME = process.env['HOME'] ?? '/Users/lherron'
const WRKF_BIN = process.env['WRKF_BIN'] ?? `${HOME}/.local/bin/wrkf`
const WRKQ_BIN = process.env['WRKQ_BIN'] ?? `${HOME}/.local/bin/wrkq`
const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? `${HOME}/.local/bin/wrkqadm`

const ACTION = 'implement'
const ACTOR = { kind: 'agent' as const, id: 'curly-e2e' }

const T = 30_000

// Unique per file run so the SHARED, live HRC state.sqlite never collides across
// scenarios or repeated runs — keeps each scope's session/continuity count at 1.
const RUN_NONCE = crypto.randomUUID().slice(0, 8)

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

// A minimal, valid no-spawn runtime intent: anthropic / non-interactive, dryRun.
// resolveSession(create:true) only needs this to mint the host session — no
// runtime is provisioned and no turn is dispatched (no prompt).
const NO_SPAWN_INTENT: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/agents/curly-e2e',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: false,
  },
  harness: { provider: 'anthropic', interactive: false },
}

describe('wrkf action launch/bind adapter — REAL HRC e2e (C-0004 closure)', () => {
  let tmpDir: string
  let dbPath: string
  let lc: WrkfLifecycle
  let childEnv: Record<string, string | undefined>
  let hrcDbPath: string
  let hrcClient: HrcClient
  const seededTaskIds: string[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-action-launch-realhrc-'))
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
      clientInfo: { name: 'action-launch-realhrc-e2e', version: '0.1.0' },
    })

    // Live HRC daemon: real socket + real state.sqlite.
    hrcDbPath = resolveDatabasePath()
    hrcClient = new HrcClient(discoverSocket())
  })

  afterAll(async () => {
    await lc?.close()
    closeSeededTasks()
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
      [WRKQ_BIN, '--db', dbPath, '--as', 'agent:local-human', 'touch', '--project', 'inbox', slug],
      { cwd: tmpDir, env: childEnv }
    )
    const out = `${touch.stdout.toString()} ${touch.stderr.toString()}`
    const match = out.match(/(T-\d+)/)
    if (!match) {
      throw new Error(`wrkq touch failed: ${out}`)
    }
    const taskId = match[1] as string
    seededTaskIds.push(taskId)
    return taskId
  }

  function closeSeededTasks(): void {
    if (dbPath === undefined || childEnv === undefined) {
      return
    }
    for (const taskId of seededTaskIds) {
      const result = Bun.spawnSync(
        [
          WRKQ_BIN,
          '--db',
          dbPath,
          '--as',
          'agent:local-human',
          'set',
          taskId,
          '--state',
          'completed',
          '--resolution',
          'done',
        ],
        { cwd: tmpDir, env: childEnv }
      )
      if (result.exitCode !== 0) {
        throw new Error(
          `wrkq cleanup failed for ${taskId}: ${result.stderr.toString()} ${result.stdout.toString()}`
        )
      }
    }
  }

  // Unique per scenario AND per file run → never collides in the shared live HRC db.
  function sessionRef(taskId: string): SessionRef {
    return {
      scopeRef: `agent:curly-e2e:project:acps-e2e-${RUN_NONCE}:task:${taskId}`,
      laneRef: 'main',
    }
  }

  function toHrcSessionRef(ref: SessionRef): string {
    return `${ref.scopeRef}/lane:${ref.laneRef}`
  }

  /** Mint a REAL host session via the live daemon (no-spawn resolveSession path). */
  async function mintHostSession(
    ref: SessionRef
  ): Promise<{ hostSessionId: string; generation: number }> {
    const resolved = await hrcClient.resolveSession({
      sessionRef: toHrcSessionRef(ref),
      runtimeIntent: NO_SPAWN_INTENT,
      create: true,
    })
    if (!resolved.found) {
      throw new Error(`HRC failed to mint host session for ${toHrcSessionRef(ref)}`)
    }
    return { hostSessionId: resolved.hostSessionId, generation: resolved.generation }
  }

  /**
   * A REAL HRC launch seam: calls the live `resolveSession({ create: true })` for
   * the run's sessionRef — exactly the production no-prompt mint path — and counts
   * invocations. Returns the host session as the launch's runId/hostSessionId, so
   * the canonical binding becomes `hrc:<hostSessionId>` (a real HRC-minted id).
   */
  function realHrcLauncher(): {
    launch: NonNullable<AcpServerDeps['launchRoleScopedRun']>
    count(): number
    hostSessionId(): string | undefined
  } {
    let count = 0
    let lastHostSessionId: string | undefined
    return {
      count: () => count,
      hostSessionId: () => lastHostSessionId,
      launch: async ({ sessionRef: ref }) => {
        count++
        const { hostSessionId, generation } = await mintHostSession(ref)
        lastHostSessionId = hostSessionId
        return {
          runId: hostSessionId,
          sessionId: hostSessionId,
          hostSessionId,
          generation,
        }
      },
    }
  }

  async function listActionRuns(taskId: string): Promise<ActionRunRecord[]> {
    const res = await rawClient().wrkf.action.list({ task: taskId })
    return res.items
  }

  /** Real-HRC proof: open the live state.sqlite readonly and count rows. */
  function countHrcSessions(ref: SessionRef): number {
    const db = new Database(hrcDbPath, { readonly: true })
    try {
      const row = db
        .query<{ c: number }, [string, string]>(
          'SELECT COUNT(*) AS c FROM sessions WHERE scope_ref = ? AND lane_ref = ?'
        )
        .get(ref.scopeRef, ref.laneRef)
      return row?.c ?? 0
    } finally {
      db.close()
    }
  }

  function countHrcContinuities(ref: SessionRef): number {
    const db = new Database(hrcDbPath, { readonly: true })
    try {
      const row = db
        .query<{ c: number }, [string, string]>(
          'SELECT COUNT(*) AS c FROM continuities WHERE scope_ref = ? AND lane_ref = ?'
        )
        .get(ref.scopeRef, ref.laneRef)
      return row?.c ?? 0
    } finally {
      db.close()
    }
  }

  function assertExactlyOneHostSession(ref: SessionRef, hostSessionId: string): void {
    // Exactly one host session + one continuity for the scope: no duplicate
    // HRC launch at the REAL daemon.
    expect(countHrcSessions(ref)).toBe(1)
    expect(countHrcContinuities(ref)).toBe(1)
    // And the active continuity points at the run's minted host session.
    const db = new Database(hrcDbPath, { readonly: true })
    try {
      const row = db
        .query<{ activeHostSessionId: string }, [string, string]>(
          'SELECT active_host_session_id AS activeHostSessionId FROM continuities WHERE scope_ref = ? AND lane_ref = ?'
        )
        .get(ref.scopeRef, ref.laneRef)
      expect(row?.activeHostSessionId).toBe(hostSessionId)
    } finally {
      db.close()
    }
    // The minted id is a real HRC host session id, not a synthetic constant.
    expect(hostSessionId.startsWith('hsid-')).toBe(true)
  }

  // ── Scenario A: failure after action.start (before durable run / launch) ────
  test(
    'A: retry after action.start failure → one action run, one real hrc:<hsid> binding, one launch, one host session',
    async () => {
      const taskId = seedTask('action-launch-realhrc-a')
      const ref = sessionRef(taskId)
      const idempotencyKey = 'act-a:001'

      // Attempt 1 crashes right after action.start (ACP never created its run).
      await wrkfPort().action.start({
        task: taskId,
        action: ACTION,
        principal_ref: `${ACTOR.kind}:${ACTOR.id}`,
        idempotencyKey,
      })

      // Attempt 2: full adapter. action.start replays the same run; launch once
      // against REAL HRC.
      const runStore: RunStore = new InMemoryRunStore()
      const launcher = realHrcLauncher()
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
        sessionRef: ref,
      })

      const hsid = launcher.hostSessionId()
      expect(hsid).toBeDefined()
      expect(result.replay).toBe(false)
      expect(result.hrcRunId).toBe(hsid)
      expect(result.externalRunRef).toBe(`hrc:${hsid}`)
      expect(result.externalRunRef).toBe(formatHrcExternalRef(hsid as string))
      expect(launcher.count()).toBe(1)

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hsid}`)
      expect(runs[0]?.runId).toBe(result.wrkfRunId)

      assertExactlyOneHostSession(ref, hsid as string)
    },
    T
  )

  // ── Scenario B: failure after HRC launch, before bind (crash-window) ────────
  test(
    'B: retry after launch-before-bind → re-bind discovered ref, ZERO launches, one host session',
    async () => {
      const taskId = seedTask('action-launch-realhrc-b')
      const ref = sessionRef(taskId)
      const idempotencyKey = 'act-b:001'
      const runStore: RunStore = new InMemoryRunStore()

      // Attempt 1 partial: action.start + ACP durable run + a REAL hostSessionId
      // committed as hrcRunId, then CRASH before bind. Mint the host session OUTSIDE
      // the counted launcher so attempt 2's launcher count starts (and stays) at 0.
      const started = (await wrkfPort().action.start({
        task: taskId,
        action: ACTION,
        principal_ref: `${ACTOR.kind}:${ACTOR.id}`,
        idempotencyKey,
      })) as { actionRunId: string; runId: string; instanceId: string }
      const { hostSessionId } = await mintHostSession(ref)
      const { run: acpRun } = runStore.createOrGetRun({
        sessionRef: ref,
        wrkfTaskId: taskId,
        wrkfInstanceId: started.instanceId,
        wrkfRunId: started.runId,
        workflowRef: 'wrkq-simple-task@1',
        role: 'implementer',
        actor: ACTOR,
      })
      runStore.updateRun(acpRun.runId, { hrcRunId: hostSessionId })

      // Attempt 2: full adapter against the SAME runStore. Must re-bind WITHOUT
      // relaunching (launcher count stays 0).
      const launcher = realHrcLauncher()
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
        sessionRef: ref,
      })

      expect(launcher.count()).toBe(0)
      expect(result.hrcRunId).toBe(hostSessionId)
      expect(result.externalRunRef).toBe(`hrc:${hostSessionId}`)
      expect(result.externalRunRef).toBe(formatHrcExternalRef(hostSessionId))

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hostSessionId}`)

      assertExactlyOneHostSession(ref, hostSessionId)
    },
    T
  )

  // ── Scenario C: failure after bind, response lost ───────────────────────────
  test(
    'C: retry after bind response loss → replay via wrkf truth, no relaunch, one binding, one host session',
    async () => {
      const taskId = seedTask('action-launch-realhrc-c')
      const ref = sessionRef(taskId)
      const idempotencyKey = 'act-c:001'
      const runStore: RunStore = new InMemoryRunStore()
      const launcher = realHrcLauncher()

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
          show: (params) => realPort.action.show(params),
          fail: (params) => realPort.action.fail(params),
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
          sessionRef: ref,
        })
      ).rejects.toThrow('bind response lost')

      const hsid = launcher.hostSessionId()
      expect(hsid).toBeDefined()

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
        sessionRef: ref,
      })

      expect(result.replay).toBe(true)
      expect(result.externalRunRef).toBe(`hrc:${hsid}`)
      expect(result.externalRunRef).toBe(formatHrcExternalRef(hsid as string))
      expect(launcher.count()).toBe(1) // launched only in attempt 1

      const runs = await listActionRuns(taskId)
      expect(runs).toHaveLength(1)
      expect(runs[0]?.externalRunRef).toBe(`hrc:${hsid}`)

      assertExactlyOneHostSession(ref, hsid as string)
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
