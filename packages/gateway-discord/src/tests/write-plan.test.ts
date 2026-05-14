import { describe, expect, test } from 'bun:test'
import type { DeliveryOutcome, DeliveryRequest } from 'acp-core'

import type { DiscordAgentMessageIdentity } from '../identity.js'
import type { RunState } from '../session-events-manager.js'
import type { RenderFrame } from '../types.js'
import { buildProgressEditContent, planFinalDeliveryWrite } from '../write-plan.js'

const identity: DiscordAgentMessageIdentity = {
  agentId: 'cody',
  subtext: 'cody@agent-spaces',
  avatarUrl: 'https://example.test/cody.png',
}

function delivery(text: string, outcome?: DeliveryOutcome): DeliveryRequest {
  return {
    deliveryRequestId: 'dr_write_plan',
    gatewayId: 'discord_prod',
    bindingId: 'ifb_write_plan',
    sessionRef: {
      scopeRef: 'agent:cody:project:agent-spaces',
      laneRef: 'main',
    },
    scopeRef: 'agent:cody:project:agent-spaces',
    laneRef: 'main',
    runId: 'run_write_plan',
    conversationRef: 'channel:chan_agent_spaces',
    body: {
      kind: 'text/markdown',
      text,
    },
    bodyKind: 'text/markdown',
    bodyText: text,
    ...(outcome !== undefined ? { outcome } : {}),
    createdAt: '2026-05-09T04:00:00.000Z',
  } as DeliveryRequest
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: 'hrc_run_write_plan',
    projectId: 'agent-spaces',
    lastSeq: 1,
    status: 'completed',
    inputContent: 'write plan prompt',
    assistantSegments: [],
    toolExecutions: [],
    noticeEntries: [],
    ...overrides,
  }
}

describe('Discord write planner', () => {
  test('preserves assistant/tool ordering and de-dupes delivery text from final segment', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('AFTER-LIVE\r\n'),
      run: runState({
        assistantSegments: [
          { id: 'msg-before', seq: 1, text: 'BEFORE-LIVE' },
          { id: 'msg-after', seq: 5, text: 'AFTER-LIVE\n' },
        ],
        toolExecutions: [
          {
            toolUseId: 'tool-live',
            toolName: 'command_execution',
            input: { command: 'sleep 20; printf TOOL-LIVE' },
            status: 'completed',
            seq: 3,
          },
        ],
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    const beforeIndex = content.indexOf('BEFORE-LIVE')
    const toolIndex = content.indexOf('shell: sleep 20; printf TOOL-LIVE')
    const afterIndex = content.indexOf('AFTER-LIVE')

    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(toolIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(toolIndex)
    expect(content.match(/AFTER-LIVE/g)).toHaveLength(1)
  })

  test('renders shell display label for wrapped command_execution in final delivery plan', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('done'),
      run: runState({
        toolExecutions: [
          {
            toolUseId: 'tool-shell',
            toolName: 'command_execution',
            input: { command: "/bin/zsh -lc 'printf X'" },
            status: 'completed',
            seq: 2,
          },
        ],
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('shell: printf X')
    expect(content).not.toContain('command_execution: /bin/zsh -lc')
  })

  test('caps tool and notice history while keeping assistant text outside the cap', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('closing text'),
      run: runState({
        assistantSegments: [
          { id: 'opening', seq: 1, text: 'opening text' },
          { id: 'closing', seq: 40, text: 'closing text' },
        ],
        toolExecutions: Array.from({ length: 14 }, (_, index) => ({
          toolUseId: `tool-${index}`,
          toolName: 'Read',
          input: { file_path: `/f${index}.ts` },
          status: 'completed' as const,
          seq: index + 2,
        })),
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    const toolLines = content.split('\n').filter((line) => line.includes('📖 Read:'))

    expect(content).toContain('opening text')
    expect(content).toContain('closing text')
    expect(content).toContain('_... +2 earlier tools_')
    expect(content).not.toContain('/f0.ts')
    expect(content).toContain('/f13.ts')
    expect(toolLines).toHaveLength(12)
  })

  test('keeps compact final tool history single-spaced after completion', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('closing text'),
      run: runState({
        assistantSegments: [{ id: 'closing', seq: 40, text: 'closing text' }],
        toolExecutions: Array.from({ length: 14 }, (_, index) => ({
          toolUseId: `tool-${index}`,
          toolName: 'command_execution',
          input: { command: `echo ${index}; printf done` },
          status: 'completed' as const,
          seq: index + 2,
        })),
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')

    expect(content).toContain('_... +2 earlier tools_')
    expect(content).toContain('shell: echo 13; printf done')
    expect(content).not.toMatch(/shell: echo \d+; printf done\n\n💻 shell:/)
  })

  test('chunks long final delivery text instead of truncating it', () => {
    const finalAnswer = `START ${'long final answer '.repeat(260)} END`
    const plan = planFinalDeliveryWrite({
      delivery: delivery(finalAnswer),
      identity,
      maxChars: 1900,
    })

    expect(plan.chunks.length).toBeGreaterThan(1)
    expect(plan.chunks.at(0)?.length).toBeLessThanOrEqual(1900)
    expect(plan.chunks.at(-1)?.length).toBeLessThanOrEqual(1900)
    expect(plan.chunks.join('\n')).toContain('START')
    expect(plan.chunks.join('\n')).toContain('END')
  })

  test('explicit normal outcome renders delivery body the same as omitted outcome', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('hello world', { state: 'normal' }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('hello world')
    expect(content).not.toContain('⚠️')
  })

  test('degraded no_assistant_content suppresses delivery body and renders a warning notice', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('', {
        state: 'degraded',
        reason: 'no_assistant_content',
        source: 'launch_exit_synthesized',
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('⚠️')
    expect(content).toContain('Agent finished without producing a reply')
    expect(content).toContain('launch_exit_synthesized')
  })

  test('degraded launch_signalled renders a cancellation notice with signal metadata', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('', {
        state: 'degraded',
        reason: 'launch_signalled',
        source: 'launch_exit_synthesized',
        signal: 'SIGTERM',
      } as unknown as DeliveryOutcome),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('⏹')
    expect(content).toContain('Run was cancelled or interrupted')
    expect(content).toContain('signal: SIGTERM')
    expect(content).not.toContain('Agent finished without producing a reply')
  })

  test('degraded launch_failed renders a crash notice with exit code metadata', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('', {
        state: 'degraded',
        reason: 'launch_failed',
        source: 'launch_exit_synthesized',
        exitCode: 42,
      } as unknown as DeliveryOutcome),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('❌')
    expect(content).toContain('Agent crashed')
    expect(content).toContain('exit code 42')
    expect(content).not.toContain('Agent finished without producing a reply')
  })

  test('degraded outcome keeps the tool/notice timeline but does not promote delivery body', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('PROMPT-AS-BODY', {
        state: 'degraded',
        reason: 'no_assistant_content',
        source: 'codex_app_server',
      }),
      run: runState({
        toolExecutions: [
          {
            toolUseId: 'tool-degraded',
            toolName: 'command_execution',
            input: { command: 'sleep 1; printf DONE' },
            status: 'completed',
            seq: 2,
          },
        ],
      }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('shell: sleep 1; printf DONE')
    expect(content).toContain('⚠️')
    expect(content).toContain('codex_app_server')
    expect(content).not.toContain('PROMPT-AS-BODY')
  })

  test('degraded outcome without a source omits the source clause from the notice', () => {
    const plan = planFinalDeliveryWrite({
      delivery: delivery('', { state: 'degraded', reason: 'no_assistant_content' }),
      identity,
      maxChars: 2000,
    })

    const content = plan.chunks.join('\n')
    expect(content).toContain('Agent finished without producing a reply.')
    expect(content).not.toContain('source:')
  })

  test('budgets progress edit header and bubble together', () => {
    const frame: RenderFrame = {
      runId: 'r1',
      projectId: 'agent-spaces',
      phase: 'progress',
      title: 'x'.repeat(200),
      blocks: [
        { t: 'markdown', md: 'before' },
        ...Array.from({ length: 30 }, (_, index) => ({
          t: 'tool' as const,
          toolName: 'Bash',
          summary: '',
          input: { command: `printf ${index} ${'x'.repeat(80)}` },
        })),
      ],
      updatedAt: Date.now(),
    }

    const content = buildProgressEditContent({
      frame,
      identity: { ...identity, subtext: `${identity.subtext}:${'lane'.repeat(20)}` },
      maxChars: 700,
    })

    expect(content.length).toBeLessThanOrEqual(700)
    expect(content).toContain('before')
    expect(content).toContain('earlier tools')
  })
})
