import type { DeliveryRequest } from 'acp-core'

export function createFetch(handler: (request: Request) => Promise<Response>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    return handler(request)
  }
}

export type CapturedInterfaceMessage = {
  idempotencyKey?: string
  source?: Record<string, unknown>
  content?: string
  attachments?: Array<Record<string, unknown>>
}

export const CODY_PROFILE = {
  agentId: 'cody',
  displayName: 'Cody',
  role: null,
  avatarUrl: 'https://example.com/cody.png',
  sourceAvailability: { profile: true, soul: true, contextTemplate: false },
  diagnostics: [],
  warningCount: 0,
  errorCount: 0,
}

/**
 * ACP boundary fake for the delivery and ingress paths: serves bindings, the
 * agent catalog, the delivery stream (drained once) with ack/fail, and a fixed
 * ingress response. Every outbound path is recorded.
 */
export function createAcpFetch(input: {
  bindings?: unknown[] | undefined
  agents?: unknown[] | undefined
  deliveries?: unknown[] | undefined
  interfaceMessageResponse?: Record<string, unknown> | undefined
}) {
  const deliveries = [...(input.deliveries ?? [])]
  const paths: string[] = []
  const fetchImpl = createFetch(async (request) => {
    const url = new URL(request.url)
    paths.push(url.pathname)
    if (url.pathname === '/v1/interface/bindings') {
      return Response.json({ bindings: input.bindings ?? [] })
    }
    if (url.pathname === '/admin/agents') {
      return Response.json({ projectId: null, contexts: {}, agents: input.agents ?? [] })
    }
    if (url.pathname === '/v1/gateway/discord_prod/deliveries/stream') {
      return Response.json({ deliveries: deliveries.splice(0), nextCursor: null })
    }
    if (/^\/v1\/gateway\/deliveries\/[^/]+\/(ack|fail)$/.test(url.pathname)) {
      return Response.json({})
    }
    if (url.pathname === '/v1/interface/messages' && input.interfaceMessageResponse) {
      return Response.json(input.interfaceMessageResponse, { status: 201 })
    }
    if (url.pathname === '/v1/session-refs/events') {
      return new Response(new ReadableStream())
    }
    return new Response('not found', { status: 404 })
  })
  return { fetchImpl, paths }
}

export function codyTaskBinding(channelId: string) {
  return {
    bindingId: `ifb_${channelId}`,
    gatewayId: 'discord_prod',
    conversationRef: `channel:${channelId}`,
    scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
    laneRef: 'main',
    projectId: 'agent-spaces',
    status: 'active',
    createdAt: '2026-05-06T14:00:00.000Z',
    updatedAt: '2026-05-06T14:00:00.000Z',
  }
}

export function codyDelivery(
  channelId: string,
  overrides: Partial<DeliveryRequest> & { body: DeliveryRequest['body'] }
): DeliveryRequest {
  return {
    deliveryRequestId: `dr_${channelId}`,
    gatewayId: 'discord_prod',
    bindingId: `ifb_${channelId}`,
    sessionRef: {
      scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
      laneRef: 'main',
    },
    conversationRef: `channel:${channelId}`,
    status: 'queued',
    createdAt: '2026-05-06T15:00:00.000Z',
    ...overrides,
  }
}

export function inboundChannelMessage(input: { id: string; channelId: string; content: string }) {
  return {
    guildId: 'guild_1',
    author: { id: 'user_1', bot: false },
    content: input.content,
    attachments: { size: 0 },
    channelId: input.channelId,
    id: input.id,
    channel: { isThread: () => false },
    reply: async () => undefined,
  } as never
}
