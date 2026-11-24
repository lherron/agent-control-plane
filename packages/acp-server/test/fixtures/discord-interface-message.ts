import type { InputIntent, InterfaceMessageAttachment } from 'acp-core'

import type { RuntimeResolver } from '../../src/deps.js'
import type { WiredServerFixture } from './wired-server.js'

const gatewayId = 'discord_prod'

export function bindDiscordConversation(
  fixture: WiredServerFixture,
  {
    bindingId,
    conversationRef,
    agent = 'curly',
    now = '2026-04-20T15:00:00.000Z',
  }: { bindingId: string; conversationRef: string; agent?: string; now?: string }
) {
  const { projectId } = fixture.seed
  fixture.interfaceStore.bindings.create({
    bindingId,
    gatewayId,
    conversationRef,
    scopeRef: `agent:${agent}:project:${projectId}`,
    laneRef: 'main',
    projectId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
}

type DiscordMessage = {
  conversationRef: string
  messageRef: string
  authorRef: string
  content: string
  idempotencyKey?: string
  intent?: InputIntent
  attachments?: InterfaceMessageAttachment[]
}

export function postDiscordMessage(
  fixture: WiredServerFixture,
  {
    conversationRef,
    messageRef,
    authorRef,
    idempotencyKey,
    content,
    intent,
    attachments,
  }: DiscordMessage
) {
  return fixture.request({
    method: 'POST',
    path: '/v1/interface/messages',
    body: {
      idempotencyKey,
      source: { gatewayId, conversationRef, messageRef, authorRef },
      content,
      intent,
      attachments,
    },
  })
}

export const resolveCurlyRuntime: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/curly',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
  harness: { provider: 'openai', interactive: true },
})
