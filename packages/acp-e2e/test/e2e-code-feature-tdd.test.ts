import { describe, expect, test } from 'bun:test'

import type { LoggedTransitionRecord, Task } from 'acp-core'

import { withSeedStack } from './fixtures/seed-stack.js'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
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

async function addEvidence(
  run: (args: string[]) => Promise<CliResult>,
  input: {
    taskId: string
    kind: string
    ref: string
    actor: string
    producerRole: string
  }
): Promise<void> {
  expectSuccess(
    await run([
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
    ])
  )
}

async function transitionTask(
  run: (args: string[]) => Promise<CliResult>,
  input: {
    taskId: string
    to: string
    actor: string
    actorRole: string
    expectedVersion: number
    evidence?: string | undefined
  }
): Promise<{ task: Task; transition: LoggedTransitionRecord }> {
  const args = [
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
    '--json',
  ]

  if (input.evidence !== undefined) {
    args.push('--evidence', input.evidence)
  }

  return expectJsonSuccess<{ task: Task; transition: LoggedTransitionRecord }>(await run(args))
}

describe('ACP code_feature_tdd e2e', () => {
  test('happy path sweeps scoped -> released and closes lifecycle at released phase', async () => {
    await withSeedStack(async (stack) => {
      const created = await stack.cli.run([
        'task',
        'create',
        '--preset',
        'code_feature_tdd',
        '--preset-version',
        '1',
        '--risk-class',
        'medium',
        '--project',
        'demo',
        '--actor',
        'olivia',
        '--role',
        'owner:olivia',
        '--role',
        'implementer:larry',
        '--role',
        'tester:curly',
        '--role',
        'release_manager:rhea',
        '--json',
      ])
      const { task } = expectJsonSuccess<{ task: Task }>(created)
      const taskId = task.taskId

      expect(task.lifecycleState).toBe('open')
      expect(task.phase).toBe('scoped')
      expect(task.workflowPreset).toBe('code_feature_tdd')
      expect(task.presetVersion).toBe(1)

      const transitions = [
        {
          to: 'ready',
          actor: 'olivia',
          actorRole: 'owner',
          evidenceKind: 'scope_bundle',
          evidenceRef: 'artifact://scope',
          producerRole: 'owner',
        },
        {
          to: 'red',
          actor: 'larry',
          actorRole: 'implementer',
          evidenceKind: 'tdd_red_bundle',
          evidenceRef: 'artifact://red',
          producerRole: 'implementer',
        },
        {
          to: 'green',
          actor: 'larry',
          actorRole: 'implementer',
          evidenceKind: 'tdd_green_bundle',
          evidenceRef: 'artifact://green',
          producerRole: 'implementer',
        },
        {
          to: 'refactor',
          actor: 'larry',
          actorRole: 'implementer',
          evidenceKind: 'refactor_bundle',
          evidenceRef: 'artifact://refactor',
          producerRole: 'implementer',
        },
        {
          to: 'tested',
          actor: 'curly',
          actorRole: 'tester',
          evidenceKind: 'ci_report',
          evidenceRef: 'ci://feature-tdd-123',
          producerRole: 'tester',
        },
        {
          to: 'accepted',
          actor: 'olivia',
          actorRole: 'owner',
          evidenceKind: 'acceptance_signoff',
          evidenceRef: 'signoff://feature-tdd',
          producerRole: 'owner',
        },
        {
          to: 'released',
          actor: 'rhea',
          actorRole: 'release_manager',
          evidenceKind: 'deploy_ref',
          evidenceRef: 'deploy://feature-tdd',
          producerRole: 'release_manager',
        },
      ]

      let expectedVersion = 0
      for (const transition of transitions) {
        await addEvidence((args) => stack.cli.run(args), {
          taskId,
          kind: transition.evidenceKind,
          ref: transition.evidenceRef,
          actor: transition.actor,
          producerRole: transition.producerRole,
        })
        const payload = await transitionTask((args) => stack.cli.run(args), {
          taskId,
          to: transition.to,
          actor: transition.actor,
          actorRole: transition.actorRole,
          expectedVersion,
          evidence: transition.evidenceRef,
        })

        expectedVersion += 1
        expect(payload.task.phase).toBe(transition.to)
        expect(payload.task.version).toBe(expectedVersion)
      }

      const completionPayload = await transitionTask((args) => stack.cli.run(args), {
        taskId,
        to: 'completed',
        actor: 'olivia',
        actorRole: 'owner',
        expectedVersion,
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
      expect(completionPayload.task.phase).toBe('released')
      expect(transitionsPayload.transitions).toHaveLength(8)
      expect(
        transitionsPayload.transitions.map((entry) => ({
          from: entry.from.phase,
          to: entry.to.phase,
          lifecycleState: entry.to.lifecycleState,
        }))
      ).toEqual(
        expect.arrayContaining([
          { from: 'scoped', to: 'ready', lifecycleState: 'active' },
          { from: 'ready', to: 'red', lifecycleState: 'active' },
          { from: 'red', to: 'green', lifecycleState: 'active' },
          { from: 'green', to: 'refactor', lifecycleState: 'active' },
          { from: 'refactor', to: 'tested', lifecycleState: 'active' },
          { from: 'tested', to: 'accepted', lifecycleState: 'active' },
          { from: 'accepted', to: 'released', lifecycleState: 'active' },
          { from: 'released', to: 'released', lifecycleState: 'completed' },
        ])
      )
    })
  })
})
