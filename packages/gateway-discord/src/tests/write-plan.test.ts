import { describe, expect, test } from 'bun:test'
import type { DeliveryRequest } from 'acp-core'

import type { DiscordAgentMessageIdentity } from '../identity.js'
import type { RunState } from '../session-events-manager.js'
import type { RenderFrame } from '../types.js'
import { buildProgressEditContent, planFinalDeliveryWrite } from '../write-plan.js'

const identity: DiscordAgentMessageIdentity = {
  agentId: 'cody',
  subtext: 'cody@agent-spaces',
  avatarUrl: 'https://example.test/cody.png',
}

function delivery(text: string): DeliveryRequest {
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
    const toolIndex = content.indexOf('command_execution')
    const afterIndex = content.indexOf('AFTER-LIVE')

    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(toolIndex).toBeGreaterThan(beforeIndex)
    expect(afterIndex).toBeGreaterThan(toolIndex)
    expect(content.match(/AFTER-LIVE/g)).toHaveLength(1)
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
