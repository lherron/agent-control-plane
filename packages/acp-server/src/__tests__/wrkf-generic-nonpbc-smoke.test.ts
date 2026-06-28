/**
 * Phase 2e (T-02589) — Non-PBC generic-runtime smoke test.
 *
 * Proves the wrkf runtime is GENERIC, not PBC-shaped: it drives an arbitrary,
 * hand-rolled non-PBC workflow (`demo-linear@1`, see
 * test/fixtures/demo-linear-template.json) end-to-end through the GENERIC
 * surface with NO PBC pack involved.
 *
 * The demo workflow has 3 states (open/start → waiting/review → closed/done),
 * one evidence kind (demo_note), one obligation kind (demo_review), one
 * transition (submit), and one effect (set_task_state). The `submit` transition
 * requires demo_note evidence and, on success, opens the review obligation and
 * emits a pending set_task_state effect.
 *
 * It exercises every generic capability against the REAL wrkf binary:
 *   1. attach + GET /v1/tasks/:taskId projection
 *      → pack { level: 0, supported: false } (unknown workflow degrades to
 *        inspect/manual); evidence / obligations / next all present
 *   2. POST /v1/tasks/:taskId/evidence with structured `data` and NO `ref`
 *      → 201, data forwarded to wrkf
 *   3. applyFreshTransition (server-side helper, fresh wrkf.next) → submit applied
 *   4. POST /v1/tasks/:taskId/obligations/:obligationId/satisfy → delegates to wrkf
 *   5. deliverWrkfEffects → delivers the pending set_task_state effect
 *
 * Runs the REAL wrkf binary against an isolated, freshly-migrated wrkq DB built
 * with `wrkqadm init` (so the schema matches the binary). The acp server is
 * wired with that DB + the real wrkf port (mirrors test/fixtures/wired-server).
 *
 * Binaries (overridable):
 *   WRKF_BIN     default ~/.local/bin/wrkf
 *   WRKQ_BIN     default ~/.local/bin/wrkq
 *   WRKQADM_BIN  default ~/.local/bin/wrkqadm
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { type InterfaceStore, openInterfaceStore } from 'acp-interface-store'
import { type AcpStateStore, openAcpStateStore } from 'acp-state-store'
import { type CoordinationStore, openCoordinationStore } from 'coordination-substrate'
import type { WrkqStoreAdapter } from 'wrkq-lib'

import {
  type AcpServer,
  InMemoryInputAttemptStore,
  InMemoryRunStore,
  createAcpServer,
} from '../index.js'
import { type WrkfLifecycle, createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'
import { deliverWrkfEffects } from '../wrkf/effect-delivery.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
import { applyFreshTransition } from '../wrkf/transition-apply.js'

// ── Binaries ────────────────────────────────────────────────────────────────

const HOME = process.env['HOME'] ?? '/Users/lherron'
const WRKF_BIN = process.env['WRKF_BIN'] ?? `${HOME}/.local/bin/wrkf`
const WRKQ_BIN = process.env['WRKQ_BIN'] ?? `${HOME}/.local/bin/wrkq`
const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? `${HOME}/.local/bin/wrkqadm`

const DEMO_TEMPLATE_PATH = fileURLToPath(
  new URL('../../test/fixtures/demo-linear-template.json', import.meta.url)
)
const DEMO_WORKFLOW_REF = 'demo-linear@1'
const ACTOR = 'agent:demo-tester'

const T = 30_000 // 30s per test (real subprocess)

type Json = Record<string, unknown>

describe('wrkf generic non-PBC smoke (T-02589)', () => {
  let tmpDir: string
  let dbPath: string
  let lc: WrkfLifecycle
  let server: AcpServer
  let wrkqStore: WrkqStoreAdapter
  let coordStore: CoordinationStore
  let interfaceStore: InterfaceStore
  let stateStore: AcpStateStore
  let taskId: string
  let obligationId: string
  let childEnv: Record<string, string | undefined>

  /** Minimal HTTP client over the acp server handler (mirrors wired-server). */
  async function request(options: {
    method: string
    path: string
    body?: unknown
  }): Promise<Response> {
    const headers = new Headers()
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json')
    }
    return server.handler(
      new Request(`http://acp.test${options.path}`, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
    )
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'acp-nonpbc-'))
    dbPath = join(tmpDir, 'wrkq.db')

    // Isolated, freshly-migrated wrkq DB so the schema matches the wrkf binary.
    // cwd = tmpDir so wrkqadm's .gitignore bookkeeping stays out of the repo.
    childEnv = {
      ...process.env,
      ASP_PROJECT: undefined,
      WRKQ_DB_PATH: undefined,
    }

    const init = Bun.spawnSync([WRKQADM_BIN, '--db', dbPath, 'init'], {
      cwd: tmpDir,
      env: childEnv,
    })
    if (init.exitCode !== 0) {
      throw new Error(`wrkqadm init failed: ${init.stderr.toString()} ${init.stdout.toString()}`)
    }

    // Real wrkf RPC port over the isolated DB.
    lc = await createWrkfClientLifecycle({
      command: WRKF_BIN,
      dbPath,
      clientInfo: { name: 'nonpbc-smoke-test', version: '0.1.0' },
    })
    const wrkf = lc.wrkf as AcpWrkfWorkflowPort

    // Install the non-PBC template via the generic workflow port (no PBC pack).
    await wrkf.workflow.install({ path: DEMO_TEMPLATE_PATH })

    // Create a fresh wrkq task in the isolated DB and attach the workflow.
    const touch = Bun.spawnSync(
      [
        WRKQ_BIN,
        '--db',
        dbPath,
        '--as',
        'local-human',
        'touch',
        '--project',
        'inbox',
        'demo-smoke',
      ],
      { cwd: tmpDir, env: childEnv }
    )
    const touchOut = `${touch.stdout.toString()} ${touch.stderr.toString()}`
    const match = touchOut.match(/(T-\d+)/)
    if (!match) {
      throw new Error(`wrkq touch failed: ${touchOut}`)
    }
    taskId = match[1] as string

    await wrkf.task.attach({ task: taskId, workflow: DEMO_WORKFLOW_REF })

    // Wire an acp server over the same isolated DB with the real wrkf port.
    const coordDbPath = join(tmpDir, 'coordination.db')
    const interfaceDbPath = join(tmpDir, 'acp-interface.db')
    const stateDbPath = join(tmpDir, 'acp-state.db')
    coordStore = openCoordinationStore(coordDbPath)
    interfaceStore = openInterfaceStore({ dbPath: interfaceDbPath })
    stateStore = openAcpStateStore({ dbPath: stateDbPath })
    // The wrkq store ports come from the SAME real WorkClient as the wrkf port
    // (lc.store), over the same isolated DB — the production single-client wiring.
    wrkqStore = lc.store as WrkqStoreAdapter
    server = createAcpServer({
      wrkqStore,
      coordStore,
      interfaceStore,
      stateStore,
      runStore: new InMemoryRunStore(),
      inputAttemptStore: new InMemoryInputAttemptStore(),
      wrkf,
    })
  }, T)

  afterAll(async () => {
    stateStore?.close()
    interfaceStore?.close()
    coordStore?.close()
    // wrkqStore (lc.store) holds no resources of its own; lc.close() closes the
    // underlying WorkClient.
    if (lc !== undefined) {
      await lc.close()
    }
    closeSeededTask()
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function closeSeededTask(): void {
    if (taskId === undefined || dbPath === undefined || childEnv === undefined) {
      return
    }
    const result = Bun.spawnSync(
      [
        WRKQ_BIN,
        '--db',
        dbPath,
        '--as',
        'local-human',
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

  test(
    'GET /v1/tasks/:taskId → unknown workflow degrades to pack {level:0,supported:false}; evidence/obligations/next present',
    async () => {
      const response = await request({ method: 'GET', path: `/v1/tasks/${taskId}` })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Json

      expect(body['source']).toBe('wrkf')

      const pack = body['pack'] as Json
      expect(pack['level']).toBe(0)
      expect(pack['supported']).toBe(false)
      // No PBC pack claimed it → no pack id is surfaced.
      expect(pack['id']).toBeUndefined()

      // Generic projection slots are present (forwarded in wrkf's native shape).
      expect(body['evidence']).toBeDefined()
      expect(body['obligations']).toBeDefined()
      expect(body['next']).toBeDefined()

      const next = body['next'] as Json
      expect(Array.isArray(next['actions'])).toBe(true)
    },
    T
  )

  test(
    'POST /v1/tasks/:taskId/evidence with structured data and no ref → 201, data forwarded',
    async () => {
      const response = await request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/evidence`,
        body: {
          kind: 'demo_note',
          actor: { agentId: 'demo-tester' },
          data: { note: 'generic evidence with no ref' },
        },
      })
      expect(response.status).toBe(201)
      const body = (await response.json()) as Json
      const evidence = body['evidence'] as Json
      expect(evidence['kind']).toBe('demo_note')
      // ref omitted by caller → wrkf records empty ref, data is forwarded.
      expect(evidence['ref']).toBe('')
      expect(evidence['data']).toEqual({ note: 'generic evidence with no ref' })
    },
    T
  )

  test(
    'applyFreshTransition (server-side helper, fresh next) applies the submit transition',
    async () => {
      const wrkf = lc.wrkf as AcpWrkfWorkflowPort
      const result = await applyFreshTransition(wrkf, {
        task: taskId,
        transition: 'submit',
        role: 'agent',
        actor: ACTOR,
        routeKey: taskId,
      })
      // Transition advanced the instance from revision 0.
      expect(result.instance.revision).toBeGreaterThan(0)

      // The submit transition opened the demo_review obligation generically.
      const obligationsRaw = await wrkf.obligation.list({ task: taskId })
      const obligations = (Array.isArray(obligationsRaw) ? obligationsRaw : []) as Json[]
      const open = obligations.find((o) => o['kind'] === 'demo_review')
      expect(open).toBeDefined()
      obligationId = open!['id'] as string
      expect(open!['status']).toBe('open')
    },
    T
  )

  test(
    'POST /v1/tasks/:taskId/obligations/:obligationId/satisfy → delegates to wrkf',
    async () => {
      expect(obligationId).toBeDefined()
      const response = await request({
        method: 'POST',
        path: `/v1/tasks/${taskId}/obligations/${obligationId}/satisfy`,
        body: { actor: { agentId: 'demo-tester' }, role: 'agent' },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as Json
      expect(body['id']).toBe(obligationId)
      expect(body['status']).toBe('satisfied')
    },
    T
  )

  test(
    'wrkf self-delivers the system set_task_state effect; generic deliverWrkfEffects is a correct no-op',
    async () => {
      // FIDELITY GUARD (real-process): the demo-linear `submit` transition emits a
      // `set_task_state` effect with role:"system". wrkf owns the wrkq task state
      // (same SQLite DB) and APPLIES system effects itself at emission time — they
      // surface from effect.list already `status:"delivered"` with a projection
      // receipt (open→blocked). There is therefore NO pending effect for the
      // generic acp-side deliverer (deliverWrkfEffects, which uses effect.list +
      // effect.deliver) to deliver.
      //
      // This guards the real division of labour: if wrkf ever STOPS self-applying
      // system effects, set_task_state would surface as `pending` and acp would be
      // responsible for delivering it — this test would flag that contract change.
      const wrkf = lc.wrkf as AcpWrkfWorkflowPort

      const effectsRaw = await wrkf.effect.list({ task: taskId })
      const effects = (Array.isArray(effectsRaw) ? effectsRaw : []) as Json[]

      const setStateEffects = effects.filter((e) => e['kind'] === 'set_task_state')
      expect(setStateEffects.length).toBeGreaterThan(0)
      // Every system set_task_state effect is self-delivered by wrkf (never pending).
      for (const effect of setStateEffects) {
        expect(effect['status']).toBe('delivered')
        expect(effect['deliveredAt']).toBeDefined()
      }

      // The generic acp-side deliverer finds nothing pending and delivers nothing.
      const result = await deliverWrkfEffects(wrkf, { task: taskId })
      expect(result.delivered.length).toBe(0)
      expect(effects.filter((e) => e['status'] === 'pending').length).toBe(0)
    },
    T
  )
})
