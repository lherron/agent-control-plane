import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type WorkClient, createClient } from '@wrkq/client'
import { createLedgerAgentDispatch } from '../../src/jobs/ledger-agent-dispatch.js'
import { advanceCreatedFlow, withFlowHarness } from '../fixtures/flow-engine.js'

// T-10378: the dispatch_timeout health flow dropped every incident. Its
// wrkq-task create carried no principal (over rpc:// the wrkq stdio proxy did
// not forward the client's launch principal), and its agent-dispatch used ACP's
// local launch, which refuses ledger-owned seats. Both run here against REAL
// wrkq: a `wrkq rpc --stdio` child launched with no principal, over a throwaway
// DB, never the live ledger.
describe('advanceJobFlow native steps against real wrkq (T-10378)', () => {
  const WRKQ_BIN = process.env['WRKQ_BIN'] ?? 'wrkq'
  const WRKQADM_BIN = process.env['WRKQADM_BIN'] ?? 'wrkqadm'
  const ACP_PRINCIPAL = 'agent:acp-server'

  const KEPT_ENV = new Set(['PATH', 'TMPDIR'])

  // Allowlist env with HOME at the temp dir: no ambient WRKQ_DB locator (the
  // live ledger), no WRKQ_PRINCIPAL_REF, and no runtime scope (AGENT_SCOPE_REF,
  // HRC_SESSION_REF, ...) wrkq could derive a principal from. Keys are set to
  // undefined rather than omitted because the client merges over process.env.
  function isolatedWrkqEnv(home: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { HOME: home }
    for (const key of Object.keys(process.env)) {
      if (key !== 'HOME') env[key] = KEPT_ENV.has(key) ? process.env[key] : undefined
    }
    return env
  }

  let tmpDir: string
  let dbPath: string
  let env: Record<string, string | undefined>
  let client: WorkClient

  function wrkq(args: string[]): string {
    const result = Bun.spawnSync([WRKQ_BIN, '--db', dbPath, ...args], { cwd: tmpDir, env })
    if (result.exitCode !== 0) {
      throw new Error(`wrkq ${args.join(' ')} failed: ${result.stderr.toString()}`)
    }
    return result.stdout.toString()
  }

  beforeAll(async () => {
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'acp-flow-wrkq-principal-')))
    dbPath = join(tmpDir, 'wrkq.db')
    env = isolatedWrkqEnv(tmpDir)
    const init = Bun.spawnSync([WRKQADM_BIN, '--db', dbPath, 'init'], { cwd: tmpDir, env })
    if (init.exitCode !== 0) throw new Error(`wrkqadm init failed: ${init.stderr.toString()}`)
    wrkq(['--as', 'agent:fixture', 'mkdir', '/agent-control-plane', '--kind', 'project'])
    wrkq(['--as', 'agent:fixture', 'mkdir', '/agent-control-plane/inbox'])
    // No launch principal: the same caller identity the rpc:// proxy delivered.
    client = await createClient({
      command: WRKQ_BIN,
      dbPath,
      env,
      cwd: tmpDir,
      clientInfo: { name: 'flow-engine-t10378', version: '0' },
    })
  }, 30_000)

  afterAll(async () => {
    await client?.close().catch(() => undefined)
    if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  })

  test('the wrkq child is isolated and the real principal check refuses unattributed writes', async () => {
    // The child sees only the allowlist: nothing can reach ~/praesidium/var.
    const childEnv = Bun.spawnSync(['env'], { env }).stdout.toString()
    expect(
      childEnv
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')[0])
        .sort()
    ).toEqual(['HOME', ...KEPT_ENV].filter((key) => key === 'HOME' || process.env[key]).sort())

    await expect(
      client.wrkq.task.create({ project: 'agent-control-plane', title: 'unattributed' })
    ).rejects.toThrow('principalRef is required')
  })

  test('creates the incident task as the ACP principal and prompts the incident seat through the ledger', async () => {
    const workClient = client
    await withFlowHarness(async ({ deps, jobsStore, launchCalls }) => {
      const { jobRun, advanced } = await advanceCreatedFlow({
        deps: { ...deps, workClient, workClientPrincipalRef: ACP_PRINCIPAL } as never,
        jobsStore,
        flow: {
          sequence: [
            {
              id: 'create_task',
              kind: 'wrkq-task',
              title: 'ACP health: dispatch timeout',
              container: 'agent-control-plane/inbox',
            },
            {
              id: 'dispatch_fettle',
              kind: 'agent-dispatch',
              agentId: 'fettle',
              projectId: 'agent-control-plane',
              scopeRef: { $step: 'create_task', field: 'taskId' },
              laneRef: 'main',
              input: { content: 'Investigate {{create_task.taskId}}' },
            },
          ],
        },
      })

      const steps = jobsStore.jobStepRuns.listByJobRun(jobRun.jobRunId).jobStepRuns
      expect(steps.map((step) => [step.stepId, step.status, step.error])).toEqual([
        ['create_task', 'succeeded', undefined],
        ['dispatch_fettle', 'succeeded', undefined],
      ])
      expect(advanced.status).toBe('succeeded')
      // Never the ACP local launch that refuses ledger-owned seats.
      expect(launchCalls).toEqual([])

      const taskResult = steps[0]?.result as { taskId?: string; taskPath?: string } | undefined
      const taskId = taskResult?.taskId as string
      expect(taskId).toMatch(/^T-\d+$/)
      // No source event (manual-run shape): the task keys on the job run.
      expect(taskResult?.taskPath).toContain(`job-run-${jobRun.jobRunId}`.replaceAll('_', '-'))
      const shown = JSON.parse(wrkq(['cat', taskId, '--json', '--one'])) as Record<string, unknown>
      expect(shown['title']).toBe('ACP health: dispatch timeout')
      expect(shown['created_by_principal_ref']).toBe(ACP_PRINCIPAL)

      const seat = `fettle@agent-control-plane:${taskId}`
      const dispatched = steps[1]?.result as Record<string, unknown> | undefined
      expect(dispatched).toMatchObject({ to: seat, roomKey: taskId })
      const envelope = await client.wrkq.envelope.show({
        envelope: dispatched?.['envelopeId'] as string,
        principalRef: ACP_PRINCIPAL,
      })
      expect(envelope).toMatchObject({
        roomKey: taskId,
        obligation: 'reply_required',
        body: `Investigate ${taskId}`,
        from: { principalRef: ACP_PRINCIPAL },
        to: { principalRef: 'agent:fettle', scopeRef: seat },
        meta: { source: { kind: 'acp-health-incident', incidentTaskId: taskId } },
      })
    })
  }, 30_000)

  test('prompts a primary seat in a pair room and treats a replayed step key as delivered', async () => {
    const dispatch = createLedgerAgentDispatch(client, ACP_PRINCIPAL)
    const input = {
      scopeRef: 'agent:mable:project:arris:task:primary',
      laneRef: 'main',
      idempotencyKey: 'jobrun:jrun_t10378:phase:sequence:step:notify_infra:attempt:1',
      content: 'arris codex-release-check infrastructure failure',
    }

    const first = await dispatch(input)
    expect(first).toMatchObject({ to: 'mable@arris:primary' })
    expect(first.roomKey).toMatch(/^R-\d+$/)
    expect(first.envelopeId).toMatch(/^EN-\d+$/)

    expect(await dispatch(input)).toEqual({ to: 'mable@arris:primary', replayed: true })
    await expect(dispatch({ ...input, laneRef: 'side' })).rejects.toThrow('lane main')
  }, 30_000)
})
