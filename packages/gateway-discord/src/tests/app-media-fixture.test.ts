import { expect } from 'bun:test'

import { GatewayDiscordApp } from '../app.js'
import { type CapturedInterfaceMessage, createFetch } from './app-acp-fixture.test.js'
import { FakeChannel, createClient } from './app-discord-fixture.test.js'

export function createAttachment(
  id: string,
  input: Record<string, unknown>
): [string, Record<string, unknown>] {
  return [id, input]
}

export function createInboundMessage(input: {
  id: string
  content: string
  attachments?: Map<string, Record<string, unknown>> | undefined
}) {
  return {
    guildId: 'guild_1',
    author: { id: 'user_1', bot: false },
    content: input.content,
    attachments: input.attachments ?? new Map(),
    channelId: 'chan_media',
    id: input.id,
    channel: {
      isThread: () => false,
    },
    reply: async () => undefined,
  } as never
}

export async function captureIngressPostForMessage(
  message: ReturnType<typeof createInboundMessage>
): Promise<CapturedInterfaceMessage> {
  const channel = new FakeChannel('chan_media')
  const client = createClient(channel)

  const captured: CapturedInterfaceMessage[] = []
  const fetchImpl = createFetch(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/v1/interface/bindings') {
      return Response.json({
        bindings: [
          {
            bindingId: 'ifb_media',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:chan_media',
            scopeRef: 'agent:curly:project:project_media',
            laneRef: 'main',
            projectId: 'project_media',
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          },
        ],
      })
    }

    if (url.pathname === '/v1/interface/messages') {
      captured.push((await request.json()) as CapturedInterfaceMessage)
      return Response.json({ inputAttemptId: 'ia_media', runId: 'run_media' }, { status: 201 })
    }

    return new Response('not found', { status: 404 })
  })

  const app = new GatewayDiscordApp({
    acpBaseUrl: 'http://acp.test',
    gatewayId: 'discord_prod',
    client: client as never,
    fetchImpl,
  })

  await app.refreshBindings()
  await app.handleMessageCreate(message)

  expect(captured).toHaveLength(1)
  return captured[0] as CapturedInterfaceMessage
}
