import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LoggedTransitionRecord, Task } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { BuildProcessInvocationSpecResponse } from 'agent-spaces'
import { listEvents, listOpenHandoffs, listPendingWakes } from 'coordination-substrate'
import type { HrcRuntimeIntent } from 'hrc-core'
import { buildCliInvocation } from 'hrc-server'
import { materializeSystemPrompt } from 'spaces-runtime'

import { createRecordingMockLauncher } from './fixtures/mock-launcher.js'
import { type SeedStack, withSeedStack } from './fixtures/seed-stack.js'
import { createBareWrkqBugTask } from './helpers/raw-wrkq-task.js'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type ErrorBody = {
  error: {
    code: string
    message: string
    details?: Record<string, unknown> | undefined
  }
}

function makeSpecBuilderResponse(): BuildProcessInvocationSpecResponse {
  return {
    spec: {
      provider: 'openai',
      frontend: 'codex-cli',
      argv: ['codex'],
      cwd: '/tmp/acp-e2e-project',
      env: { BASE_ENV: '1' },
      interactionMode: 'interactive',
      ioMode: 'pty',
    },
    warnings: [],
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T
}

function expectSuccess(result: CliResult): void {
  expect(result.exitCode).toBe(0)
  expect(result.stderr.trim()).toBe('')
}

function expectJsonSuccess<T>(result: CliResult): T {
  expectSuccess(result)
  return parseJson<T>(result.stdout)
}

function testerSessionRef(taskId: string, projectId: string): SessionRef {
  return {
    scopeRef: `agent:curly:project:${projectId}:task:${taskId}:role:tester`,
    laneRef: 'main',
  }
}

async function createDefectFastlaneTask(
  run: (args: string[]) => Promise<CliResult>
): Promise<{ task: Task; taskId: string }> {
  const result = await run([
    'task',
    'create',
    '--preset',
    'code_defect_fastlane',
    '--preset-version',
    '1',
    '--risk-class',
    'medium',
    '--project',
    'demo',
    '--actor',
    'larry',
    '--role',
    'implementer:larry',
    '--role',
    'tester:curly',
    '--kind',
    'bug',
    '--json',
  ])

  const payload = expectJsonSuccess<{ task: Task }>(result)
  return {
    task: payload.task,
    taskId: payload.task.taskId,
  }
}

async function promoteBareWrkqBugTask(
  stack: SeedStack,
  taskId = 'T-92001'
): Promise<{ task: Task; taskId: string }> {
  stack.wrkqStore.taskRepo.createTask(createBareWrkqBugTask(stack.seed.projectId, taskId))

  const result = await stack.cli.run([
    'task',
    'promote',
    '--task',
    taskId,
    '--preset',
    'code_defect_fastlane',
    '--preset-version',
    '1',
    '--risk-class',
    'medium',
    '--actor',
    'tracy',
    '--role',
    'triager:tracy',
    '--role',
    'implementer:larry',
    '--role',
    'tester:curly',
    '--json',
  ])

  const payload = expectJsonSuccess<{ task: Task }>(result)
  return {
    task: payload.task,
    taskId: payload.task.taskId,
  }
}

async function addEvidence(
  run: (args: string[]) => Promise<CliResult>,
  input: {
    taskId: string
    kind: string
    ref: string
    actor: string
    producerRole: string
    buildId?: string | undefined
    buildVersion?: string | undefined
    buildEnv?: string | undefined
  }
): Promise<void> {
  const args = [
    'task',
    'evidence',
    'add',
    '--task',
    input.taskId,
    '--kind',
    input.kind,
    '--ref',
    input.ref,
    '--actor',
    input.actor,
    '--producer-role',
    input.producerRole,
    '--json',
  ]

  if (input.buildId !== undefined) {
    args.push('--build-id', input.buildId)
  }

  if (input.buildVersion !== undefined) {
    args.push('--build-version', input.buildVersion)
  }

  if (input.buildEnv !== undefined) {
    args.push('--build-env', input.buildEnv)
  }

  expectSuccess(await run(args))
}

async function transitionTask(
  run: (args: string[]) => Promise<CliResult>,
  input: {
    taskId: string
    to: string
    actor: string
    actorRole: string
    expectedVersion: number
    evidence: string
  }
): Promise<{ task: Task; transition: LoggedTransitionRecord }> {
  const result = await run([
    'task',
    'transition',
    '--task',
    input.taskId,
    '--to',
    input.to,
    '--actor',
    input.actor,
    '--actor-role',
    input.actorRole,
    '--expected-version',
    String(input.expectedVersion),
    '--evidence',
    input.evidence,
    '--json',
  ])

  return expectJsonSuccess<{ task: Task; transition: LoggedTransitionRecord }>(result)
}

async function createTaskAtRed(
  run: (args: string[]) => Promise<CliResult>
): Promise<{ taskId: string }> {
  const { taskId } = await createDefectFastlaneTask(run)
  await addEvidence(run, {
    taskId,
    kind: 'tdd_red_bundle',
    ref: 'artifact://repro',
    actor: 'larry',
    producerRole: 'implementer',
    buildId: 'b1',
    buildVersion: '1.0',
    buildEnv: 'staging',
  })
  await transitionTask(run, {
    taskId,
    to: 'red',
    actor: 'larry',
    actorRole: 'implementer',
    expectedVersion: 0,
    evidence: 'artifact://repro',
  })

  return { taskId }
}

async function createTaskAtGreen(
  run: (args: string[]) => Promise<CliResult>
): Promise<{ taskId: string }> {
  const { taskId } = await createTaskAtRed(run)
  await addEvidence(run, {
    taskId,
    kind: 'tdd_green_bundle',
    ref: 'pr:42',
    actor: 'larry',
    producerRole: 'implementer',
    buildId: 'b2',
    buildVersion: '1.1',
    buildEnv: 'staging',
  })
  await transitionTask(run, {
    taskId,
    to: 'green',
    actor: 'larry',
    actorRole: 'implementer',
    expectedVersion: 1,
    evidence: 'pr:42',
  })

  return { taskId }
}

async function attachQaEvidence(
  run: (args: string[]) => Promise<CliResult>,
  taskId: string
): Promise<void> {
  await addEvidence(run, {
    taskId,
    kind: 'qa_bundle',
    ref: 'recording://qa-1',
    actor: 'larry',
    producerRole: 'tester',
    buildId: 'b2',
    buildVersion: '1.1',
    buildEnv: 'staging',
  })
}

async function createTaskAtVerified(
  run: (args: string[]) => Promise<CliResult>
): Promise<{ taskId: string }> {
  const { taskId } = await createTaskAtGreen(run)
  await attachQaEvidence(run, taskId)
  await transitionTask(run, {
    taskId,
    to: 'verified',
    actor: 'curly',
    actorRole: 'tester',
    expectedVersion: 2,
    evidence: 'recording://qa-1',
  })

  return { taskId }
}

function withTaskEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const originals = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    originals.set(key, process.env[key])
    process.env[key] = value
  }

  return run().finally(() => {
    for (const [key, value] of originals.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })
}

describe('ACP MVP defect fastlane e2e', () => {
  test('create defect-fastlane task with distinct implementer + tester', async () => {
    await withSeedStack(async (stack) => {
      const { taskId, task } = await createDefectFastlaneTask((args) => stack.cli.run(args))
      const storedTask = stack.wrkqStore.taskRepo.getTask(taskId)

      expect(task.lifecycleState).toBe('open')
      expect(task.phase).toBe('open')
      expect(task.workflowPreset).toBe('code_defect_fastlane')
      expect(task.riskClass).toBe('medium')
      expect(storedTask).toMatchObject({
        taskId,
        lifecycleState: 'open',
        phase: 'open',
        workflowPreset: 'code_defect_fastlane',
        riskClass: 'medium',
      })
      expect(stack.wrkqStore.roleAssignmentRepo.getRoleMap(taskId)).toEqual({
        implementer: 'larry',
        tester: 'curly',
      })
    })
  })

  test('task show renders task-context for a role', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createDefectFastlaneTask((args) => stack.cli.run(args))
      const result = await stack.cli.run([
        'task',
        'show',
        '--task',
        taskId,
        '--role',
        'implementer',
        '--json',
      ])
      const payload = expectJsonSuccess<{
        task: Task
        context: { phase: string; requiredEvidenceKinds: string[]; hintsText: string }
      }>(result)

      expect(payload.context.phase).toBe('open')
      expect(payload.context.requiredEvidenceKinds).toContain('tdd_red_bundle')
      expect(payload.context.hintsText.length).toBeGreaterThan(0)
    })
  })

  test('open → red transition succeeds with tdd_red_bundle', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createDefectFastlaneTask((args) => stack.cli.run(args))

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'tdd_red_bundle',
        ref: 'artifact://repro',
        actor: 'larry',
        producerRole: 'implementer',
        buildId: 'b1',
        buildVersion: '1.0',
        buildEnv: 'staging',
      })

      const payload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'red',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 0,
        evidence: 'artifact://repro',
      })

      expect(payload.task.version).toBe(1)
      expect(payload.task.phase).toBe('red')
      expect(stack.wrkqStore.transitionLogRepo.listTransitions(taskId)).toMatchObject([
        {
          taskId,
          from: { phase: 'open' },
          to: { phase: 'red' },
          actor: { agentId: 'larry', role: 'implementer' },
        },
      ])
    })
  })

  test('promote bare wrkq bug task and complete the fastlane scenario', async () => {
    await withSeedStack(async (stack) => {
      const { taskId, task } = await promoteBareWrkqBugTask(stack, 'T-92002')

      expect(task).toMatchObject({
        taskId: 'T-92002',
        kind: 'bug',
        workflowPreset: 'code_defect_fastlane',
        presetVersion: 1,
        phase: 'open',
        riskClass: 'medium',
        version: 1,
      })

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'tdd_red_bundle',
        ref: 'artifact://repro-promoted',
        actor: 'larry',
        producerRole: 'implementer',
        buildId: 'pb1',
        buildVersion: '1.0',
        buildEnv: 'staging',
      })
      const redPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'red',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 1,
        evidence: 'artifact://repro-promoted',
      })
      expect(redPayload.task.version).toBe(2)

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'tdd_green_bundle',
        ref: 'artifact://green-promoted',
        actor: 'larry',
        producerRole: 'implementer',
      })
      const greenPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'green',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 2,
        evidence: 'artifact://green-promoted',
      })
      expect(greenPayload.task.version).toBe(3)

      await attachQaEvidence((args) => stack.cli.run(args), taskId)
      const verifiedPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'verified',
        actor: 'curly',
        actorRole: 'tester',
        expectedVersion: 3,
        evidence: 'recording://qa-1',
      })
      expect(verifiedPayload.task.version).toBe(4)

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'deploy_ref',
        ref: 'deploy:promoted-r-789',
        actor: 'larry',
        producerRole: 'implementer',
      })
      const completionPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'completed',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 4,
        evidence: 'deploy:promoted-r-789',
      })
      const transitionsResult = await stack.cli.run([
        'task',
        'transitions',
        '--task',
        taskId,
        '--json',
      ])
      const transitionsPayload = expectJsonSuccess<{ transitions: LoggedTransitionRecord[] }>(
        transitionsResult
      )

      expect(completionPayload.task.lifecycleState).toBe('completed')
      expect(completionPayload.task.phase).toBe('completed')
      expect(transitionsPayload.transitions).toHaveLength(5)
      expect(
        transitionsPayload.transitions.map((entry) => ({
          from: entry.from.phase,
          to: entry.to.phase,
          actor: entry.actor.agentId,
          role: entry.actor.role,
        }))
      ).toEqual(
        expect.arrayContaining([
          { from: '', to: 'open', actor: 'tracy', role: 'triager' },
          { from: 'open', to: 'red', actor: 'larry', role: 'implementer' },
          { from: 'red', to: 'green', actor: 'larry', role: 'implementer' },
          { from: 'green', to: 'verified', actor: 'curly', role: 'tester' },
          { from: 'verified', to: 'completed', actor: 'larry', role: 'implementer' },
        ])
      )
    })
  })

  test('red → green succeeds + writes event+handoff+wake atomically', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createTaskAtRed((args) => stack.cli.run(args))

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'tdd_green_bundle',
        ref: 'pr:42',
        actor: 'larry',
        producerRole: 'implementer',
        buildId: 'b2',
        buildVersion: '1.1',
        buildEnv: 'staging',
      })

      const greenPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'green',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 1,
        evidence: 'pr:42',
      })
      const task = stack.wrkqStore.taskRepo.getTask(taskId)
      const sessionRef = testerSessionRef(taskId, task?.projectId ?? stack.seed.projectId)
      const events = listEvents(stack.coordStore, {
        projectId: stack.seed.projectId,
        taskId,
      })
      const handoffs = listOpenHandoffs(stack.coordStore, {
        projectId: stack.seed.projectId,
        taskId,
        targetSession: sessionRef,
      })
      const wakes = listPendingWakes(stack.coordStore, {
        projectId: stack.seed.projectId,
        sessionRef,
      })

      expect(greenPayload.task.phase).toBe('green')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        kind: 'handoff.declared',
        links: { taskId },
      })
      expect(handoffs).toHaveLength(1)
      expect(handoffs[0]).toMatchObject({
        kind: 'review',
        state: 'open',
        targetSession: sessionRef,
      })
      expect(wakes).toHaveLength(1)
      expect(wakes[0]).toMatchObject({
        state: 'queued',
        sessionRef,
      })
      expect(handoffs[0]?.sourceEventId).toBe(events[0]?.eventId)
      expect(wakes[0]?.sourceEventId).toBe(events[0]?.eventId)
    })
  })

  test('SoD rejection — implementer cannot perform green → verified', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createTaskAtGreen((args) => stack.cli.run(args))
      await attachQaEvidence((args) => stack.cli.run(args), taskId)
      const transitionsBefore = stack.wrkqStore.transitionLogRepo.listTransitions(taskId)

      const result = await stack.cli.run([
        'task',
        'transition',
        '--task',
        taskId,
        '--to',
        'verified',
        '--actor',
        'larry',
        '--actor-role',
        'tester',
        '--expected-version',
        '2',
        '--evidence',
        'recording://qa-1',
        '--json',
      ])
      const errorBody = parseJson<ErrorBody>(result.stderr)
      const task = stack.wrkqStore.taskRepo.getTask(taskId)

      expect(result.exitCode).toBe(1)
      expect(errorBody.error.code).toBe('sod_violation')
      expect(errorBody.error.message).toContain('implementer')
      expect(task?.phase).toBe('green')
      expect(stack.wrkqStore.transitionLogRepo.listTransitions(taskId)).toHaveLength(
        transitionsBefore.length
      )
    })
  })

  test('tester (curly) drives green → verified successfully', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createTaskAtGreen((args) => stack.cli.run(args))
      await attachQaEvidence((args) => stack.cli.run(args), taskId)

      const payload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'verified',
        actor: 'curly',
        actorRole: 'tester',
        expectedVersion: 2,
        evidence: 'recording://qa-1',
      })

      expect(payload.task.version).toBe(3)
      expect(payload.task.phase).toBe('verified')
    })
  })

  test('verified → completed closes the task', async () => {
    await withSeedStack(async (stack) => {
      const { taskId } = await createTaskAtVerified((args) => stack.cli.run(args))

      await addEvidence((args) => stack.cli.run(args), {
        taskId,
        kind: 'deploy_ref',
        ref: 'deploy:r-789',
        actor: 'larry',
        producerRole: 'implementer',
      })

      const completionPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'completed',
        actor: 'larry',
        actorRole: 'implementer',
        expectedVersion: 3,
        evidence: 'deploy:r-789',
      })
      const transitionsResult = await stack.cli.run([
        'task',
        'transitions',
        '--task',
        taskId,
        '--json',
      ])
      const transitionsPayload = expectJsonSuccess<{ transitions: LoggedTransitionRecord[] }>(
        transitionsResult
      )
      const transitionSummary = transitionsPayload.transitions.map((entry) => ({
        from: entry.from.phase,
        to: entry.to.phase,
        actor: entry.actor.agentId,
        role: entry.actor.role,
      }))

      expect(completionPayload.task.lifecycleState).toBe('completed')
      expect(completionPayload.task.phase).toBe('completed')
      expect(transitionsPayload.transitions).toHaveLength(4)
      expect(transitionSummary).toEqual(
        expect.arrayContaining([
          { from: 'open', to: 'red', actor: 'larry', role: 'implementer' },
          { from: 'red', to: 'green', actor: 'larry', role: 'implementer' },
          { from: 'green', to: 'verified', actor: 'curly', role: 'tester' },
          { from: 'verified', to: 'completed', actor: 'larry', role: 'implementer' },
        ])
      )
    })
  })

  test('tester runtime intent gets HRC_TASK_* env vars threaded through', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const { taskId } = await createTaskAtGreen((args) => stack.cli.run(args))
        const task = stack.wrkqStore.taskRepo.getTask(taskId)
        const sessionRef = testerSessionRef(taskId, task?.projectId ?? stack.seed.projectId)

        const response = await stack.cli.request({
          method: 'POST',
          path: '/v1/sessions/launch',
          body: {
            sessionRef,
            taskId,
            role: 'tester',
          },
        })

        expect(response.status).toBe(200)
        expect(launcher.launches).toHaveLength(1)

        const launch = launcher.last()
        const taskContext = launch?.intent.taskContext
        expect(taskContext).toEqual({
          taskId,
          phase: 'green',
          role: 'tester',
          requiredEvidenceKinds: ['qa_bundle'],
          hintsText: expect.any(String),
        })
        expect(taskContext?.hintsText.length ?? 0).toBeGreaterThan(0)

        const invocation = await buildCliInvocation(launch?.intent as HrcRuntimeIntent, {
          specBuilder: async () => makeSpecBuilderResponse(),
        })

        expect(invocation.env).toMatchObject({
          HRC_TASK_ID: taskId,
          HRC_TASK_PHASE: 'green',
          HRC_TASK_ROLE: 'tester',
          HRC_TASK_REQUIRED_EVIDENCE: 'qa_bundle',
          HRC_TASK_HINTS: taskContext?.hintsText,
        })

        const agentRoot = createTempDir('acp-e2e-agent-')
        const agentsRoot = createTempDir('acp-e2e-agents-')
        const aspHome = createTempDir('acp-e2e-home-')
        const projectRoot = createTempDir('acp-e2e-project-')
        const outputRoot = createTempDir('acp-e2e-output-')
        writeFileSync(join(agentRoot, 'SOUL.md'), 'Soul', 'utf8')

        const rendered = await withTaskEnv(
          {
            HRC_TASK_ID: invocation.env['HRC_TASK_ID'] ?? '',
            HRC_TASK_PHASE: invocation.env['HRC_TASK_PHASE'] ?? '',
            HRC_TASK_ROLE: invocation.env['HRC_TASK_ROLE'] ?? '',
            HRC_TASK_REQUIRED_EVIDENCE: invocation.env['HRC_TASK_REQUIRED_EVIDENCE'] ?? '',
            HRC_TASK_HINTS: invocation.env['HRC_TASK_HINTS'] ?? '',
          },
          () =>
            materializeSystemPrompt(outputRoot, {
              agentRoot,
              agentsRoot,
              aspHome,
              projectRoot,
              runMode: 'task',
            })
        )

        expect(rendered?.content).toContain('## Current task context')
        expect(rendered?.content).toContain(`- Task ID: ${taskId}`)
        expect(rendered?.content).toContain('- Phase: green')
        expect(rendered?.content).toContain('- Role: tester')
      },
      {
        launchRoleScopedRun: launcher.launchRoleScopedRun,
      }
    )
  })
})
