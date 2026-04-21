import { describe, expect, test } from 'bun:test'

import { canAck, canFail, isTerminal, resolveBinding } from '../src/index.js'

import type { InterfaceBinding } from '../src/index.js'

function createBinding(overrides: Partial<InterfaceBinding> = {}): InterfaceBinding {
  return {
    bindingId: overrides.bindingId ?? 'binding-001',
    gatewayId: overrides.gatewayId ?? 'discord',
    conversationRef: overrides.conversationRef ?? 'channel-001',
    sessionRef: overrides.sessionRef ?? { scopeRef: 'cody@agent-spaces', laneRef: 'main' },
    status: overrides.status ?? 'active',
    createdAt: overrides.createdAt ?? '2026-04-20T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-20T00:00:00.000Z',
    ...(overrides.threadRef !== undefined ? { threadRef: overrides.threadRef } : {}),
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
  }
}

describe('resolveBinding', () => {
  test('prefers an exact thread binding over a channel binding', () => {
    const channelBinding = createBinding({ bindingId: 'binding-channel' })
    const threadBinding = createBinding({
      bindingId: 'binding-thread',
      threadRef: 'thread-001',
      sessionRef: { scopeRef: 'cody@agent-spaces:T-01145', laneRef: 'repair' },
    })

    const resolved = resolveBinding([channelBinding, threadBinding], {
      gatewayId: 'discord',
      conversationRef: 'channel-001',
      threadRef: 'thread-001',
    })

    expect(resolved?.bindingId).toBe('binding-thread')
  })

  test('falls back to the channel binding when no thread binding exists', () => {
    const channelBinding = createBinding({ bindingId: 'binding-channel' })
    const otherThreadBinding = createBinding({
      bindingId: 'binding-thread-other',
      threadRef: 'thread-999',
    })

    const resolved = resolveBinding([otherThreadBinding, channelBinding], {
      gatewayId: 'discord',
      conversationRef: 'channel-001',
      threadRef: 'thread-001',
    })

    expect(resolved?.bindingId).toBe('binding-channel')
  })

  test('returns null when no matching binding exists', () => {
    const resolved = resolveBinding([createBinding()], {
      gatewayId: 'slack',
      conversationRef: 'channel-001',
      threadRef: 'thread-001',
    })

    expect(resolved).toBeNull()
  })

  test('skips disabled exact bindings and falls back to an active channel binding', () => {
    const disabledThreadBinding = createBinding({
      bindingId: 'binding-thread-disabled',
      threadRef: 'thread-001',
      status: 'disabled',
    })
    const channelBinding = createBinding({ bindingId: 'binding-channel' })

    const resolved = resolveBinding([disabledThreadBinding, channelBinding], {
      gatewayId: 'discord',
      conversationRef: 'channel-001',
      threadRef: 'thread-001',
    })

    expect(resolved?.bindingId).toBe('binding-channel')
  })

  test('returns null when the only channel match is disabled', () => {
    const resolved = resolveBinding(
      [createBinding({ bindingId: 'binding-channel-disabled', status: 'disabled' })],
      {
        gatewayId: 'discord',
        conversationRef: 'channel-001',
      }
    )

    expect(resolved).toBeNull()
  })
})

describe('delivery request predicates', () => {
  test('allow ack and fail for non-terminal statuses', () => {
    expect(canAck('queued')).toBe(true)
    expect(canAck('delivering')).toBe(true)
    expect(canFail('queued')).toBe(true)
    expect(canFail('delivering')).toBe(true)
  })

  test('treat delivered and failed as terminal statuses', () => {
    expect(isTerminal('delivered')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(canAck('delivered')).toBe(false)
    expect(canFail('failed')).toBe(false)
  })
})
