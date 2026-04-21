import { describe, expect, test } from 'bun:test'

import { createRecordingMockLauncher } from './fixtures/mock-launcher.js'
import { type SeedStack, withSeedStack } from './fixtures/seed-stack.js'

type SessionRefPayload = {
  scopeRef: string
  laneRef: string
}

type InterfaceBindingPayload = {
  bindingId: string
  gatewayId: string
  conversationRef: string
  threadRef?: string | undefined
  sessionRef: SessionRefPayload
  projectId?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
}

type InterfaceMessageResponse = {
  inputAttemptId: string
  runId: string
}

type DeliveryPayload = {
  deliveryRequestId: string
  gatewayId: string
  bindingId: string
  sessionRef: SessionRefPayload
  runId?: string | undefined
  inputAttemptId?: string | undefined
  conversationRef: string
  threadRef?: string | undefined
  replyToMessageRef?: string | undefined
  body: {
    kind: string
    text: string
  }
  status: string
  createdAt: string
  deliveredAt?: string | undefined
  failure?:
    | {
        code: string
        message: string
      }
    | undefined
}

type ErrorPayload = {
  error: {
    code: string
    message: string
  }
}

type RequestOptions = {
  method: string
  path: string
  body?: unknown
}

function projectSessionRef(
  projectId: string,
  agentId = 'curly',
  laneRef = 'main'
): SessionRefPayload {
  return {
    scopeRef: `agent:${agentId}:project:${projectId}`,
    laneRef,
  }
}

async function requestJson<T>(stack: SeedStack, options: RequestOptions) {
  const response = await stack.cli.request(options)
  const payload = (await response.json()) as T
  return { response, payload }
}

async function createBinding(
  stack: SeedStack,
  input: {
    gatewayId?: string | undefined
    conversationRef?: string | undefined
    threadRef?: string | undefined
    sessionRef?: SessionRefPayload | undefined
    projectId?: string | undefined
    status?: 'active' | 'disabled' | undefined
  } = {}
) {
  return requestJson<{ binding: InterfaceBindingPayload }>(stack, {
    method: 'POST',
    path: '/v1/interface/bindings',
    body: {
      gatewayId: input.gatewayId ?? 'discord_prod',
      conversationRef: input.conversationRef ?? 'channel:123',
      ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
      sessionRef: input.sessionRef ?? projectSessionRef(stack.seed.projectId),
      projectId: input.projectId ?? stack.seed.projectId,
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  })
}

async function postInterfaceMessage(
  stack: SeedStack,
  input: {
    gatewayId?: string | undefined
    conversationRef?: string | undefined
    threadRef?: string | undefined
    messageRef?: string | undefined
    authorRef?: string | undefined
    content?: string | undefined
  } = {}
) {
  return requestJson<InterfaceMessageResponse | ErrorPayload>(stack, {
    method: 'POST',
    path: '/v1/interface/messages',
    body: {
      source: {
        gatewayId: input.gatewayId ?? 'discord_prod',
        conversationRef: input.conversationRef ?? 'channel:123',
        ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
        messageRef: input.messageRef ?? 'discord:message:123',
        authorRef: input.authorRef ?? 'discord:user:999',
      },
      content: input.content ?? 'Need a reply.',
    },
  })
}

async function queueAssistantDelivery(
  stack: SeedStack,
  launcher: ReturnType<typeof createRecordingMockLauncher>,
  input: {
    conversationRef?: string | undefined
    threadRef?: string | undefined
    sessionRef?: SessionRefPayload | undefined
    messageRef?: string | undefined
    content?: string | undefined
    assistantText?: string | undefined
  } = {}
) {
  const binding = await createBinding(stack, {
    conversationRef: input.conversationRef,
    ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
    sessionRef: input.sessionRef,
  })

  expect(binding.response.status).toBe(201)

  const ingress = await postInterfaceMessage(stack, {
    conversationRef: input.conversationRef,
    ...(input.threadRef !== undefined ? { threadRef: input.threadRef } : {}),
    messageRef: input.messageRef,
    content: input.content,
  })

  expect(ingress.response.status).toBe(201)
  expect(launcher.launches).toHaveLength(1)

  const launch = launcher.last()
  expect(launch).toBeDefined()

  await launcher.completeRunWithAssistantMessage(
    launch?.runId as string,
    input.assistantText ?? 'Hello from mock launcher.'
  )

  const ingressPayload = ingress.payload as InterfaceMessageResponse
  const delivery = stack.interfaceStore.deliveries
    .listQueuedForGateway('discord_prod')
    .find((entry) => entry.runId === ingressPayload.runId)

  expect(delivery).toBeDefined()

  return {
    binding: binding.payload.binding,
    ingress: ingressPayload,
    delivery: delivery!,
  }
}

describe('ACP interface e2e', () => {
  test('POST /v1/interface/bindings returns 201 and GET /v1/interface/bindings lists the binding', async () => {
    await withSeedStack(async (stack) => {
      const created = await createBinding(stack)

      expect(created.response.status).toBe(201)
      expect(created.payload.binding).toMatchObject({
        gatewayId: 'discord_prod',
        conversationRef: 'channel:123',
        projectId: stack.seed.projectId,
        sessionRef: projectSessionRef(stack.seed.projectId),
        status: 'active',
      })

      const listed = await requestJson<{ bindings: InterfaceBindingPayload[] }>(stack, {
        method: 'GET',
        path: `/v1/interface/bindings?gatewayId=discord_prod&projectId=${stack.seed.projectId}`,
      })

      expect(listed.response.status).toBe(200)
      expect(listed.payload.bindings).toHaveLength(1)
      expect(listed.payload.bindings[0]).toEqual(created.payload.binding)
    })
  })

  test('thread-specific binding overrides the channel binding during interface ingress', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const channelSession = projectSessionRef(stack.seed.projectId, 'curly', 'main')
        const threadSession = projectSessionRef(stack.seed.projectId, 'larry', 'lane:thread')

        expect((await createBinding(stack, { sessionRef: channelSession })).response.status).toBe(
          201
        )
        expect(
          (
            await createBinding(stack, {
              threadRef: 'thread:456',
              sessionRef: threadSession,
            })
          ).response.status
        ).toBe(201)

        const ingress = await postInterfaceMessage(stack, {
          threadRef: 'thread:456',
          messageRef: 'discord:message:thread-override',
          content: 'Resolve to the thread binding.',
        })

        expect(ingress.response.status).toBe(201)
        expect(launcher.launches).toHaveLength(1)
        expect(launcher.last()).toMatchObject({
          sessionRef: threadSession,
          intent: { initialPrompt: 'Resolve to the thread binding.' },
        })
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })

  test('POST /v1/interface/messages returns 404 interface_binding_not_found when no active binding exists', async () => {
    await withSeedStack(async (stack) => {
      expect((await createBinding(stack, { status: 'disabled' })).response.status).toBe(201)

      const ingress = await postInterfaceMessage(stack, {
        messageRef: 'discord:message:no-binding',
      })

      expect(ingress.response.status).toBe(404)
      expect((ingress.payload as ErrorPayload).error.code).toBe('interface_binding_not_found')
    })
  })

  test('POST /v1/interface/messages with a binding creates an InputAttempt + Run and dispatches once', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const binding = await createBinding(stack)

        expect(binding.response.status).toBe(201)

        const ingress = await postInterfaceMessage(stack, {
          messageRef: 'discord:message:dispatch',
          content: 'Please summarize task status.',
        })

        expect(ingress.response.status).toBe(201)
        expect(ingress.payload).toMatchObject({
          inputAttemptId: expect.stringMatching(/^ia_/),
          runId: expect.stringMatching(/^run_/),
        })
        expect(launcher.launches).toHaveLength(1)
        expect(launcher.last()).toMatchObject({
          sessionRef: binding.payload.binding.sessionRef,
          intent: { initialPrompt: 'Please summarize task status.' },
        })
        expect(
          stack.interfaceStore.messageSources.getByMessageRef(
            'discord_prod',
            'discord:message:dispatch'
          )
        ).toEqual({
          gatewayId: 'discord_prod',
          bindingId: binding.payload.binding.bindingId,
          conversationRef: 'channel:123',
          messageRef: 'discord:message:dispatch',
          authorRef: 'discord:user:999',
          receivedAt: expect.any(String),
        })
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })

  test('a completed assistant message enqueues exactly one queued delivery request in interface.db', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const queued = await queueAssistantDelivery(stack, launcher, {
          messageRef: 'discord:message:captured',
          assistantText: 'Hello from mock launcher.',
        })

        const deliveries = stack.interfaceStore.deliveries.listQueuedForGateway('discord_prod')

        expect(deliveries).toHaveLength(1)
        expect(deliveries[0]).toMatchObject({
          gatewayId: 'discord_prod',
          bindingId: queued.binding.bindingId,
          runId: queued.ingress.runId,
          inputAttemptId: queued.ingress.inputAttemptId,
          conversationRef: 'channel:123',
          replyToMessageRef: 'discord:message:captured',
          bodyText: 'Hello from mock launcher.',
          status: 'queued',
        })
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })

  test('GET /v1/gateway/{gatewayId}/deliveries/stream returns the queued delivery with correct targeting', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const threadSession = projectSessionRef(stack.seed.projectId, 'larry', 'lane:thread')
        const queued = await queueAssistantDelivery(stack, launcher, {
          sessionRef: threadSession,
          threadRef: 'thread:456',
          messageRef: 'discord:message:stream',
          content: 'Send the queued stream reply.',
          assistantText: 'Thread-targeted reply.',
        })

        const stream = await requestJson<{
          deliveries: DeliveryPayload[]
          nextCursor: string | null
        }>(stack, {
          method: 'GET',
          path: '/v1/gateway/discord_prod/deliveries/stream',
        })

        expect(stream.response.status).toBe(200)
        expect(stream.payload.deliveries).toHaveLength(1)
        expect(stream.payload.deliveries[0]).toMatchObject({
          deliveryRequestId: queued.delivery.deliveryRequestId,
          gatewayId: 'discord_prod',
          bindingId: queued.binding.bindingId,
          sessionRef: threadSession,
          runId: queued.ingress.runId,
          inputAttemptId: queued.ingress.inputAttemptId,
          conversationRef: 'channel:123',
          threadRef: 'thread:456',
          replyToMessageRef: 'discord:message:stream',
          body: {
            kind: 'text/markdown',
            text: 'Thread-targeted reply.',
          },
          status: 'queued',
        })
        expect(stream.payload.nextCursor).toEqual(expect.any(String))
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })

  test('POST /v1/gateway/deliveries/{id}/ack transitions the delivery to delivered', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const queued = await queueAssistantDelivery(stack, launcher, {
          messageRef: 'discord:message:ack',
          assistantText: 'Ack this delivery.',
        })

        const ack = await requestJson<{ delivery: DeliveryPayload }>(stack, {
          method: 'POST',
          path: `/v1/gateway/deliveries/${queued.delivery.deliveryRequestId}/ack`,
        })

        expect(ack.response.status).toBe(200)
        expect(ack.payload.delivery).toMatchObject({
          deliveryRequestId: queued.delivery.deliveryRequestId,
          status: 'delivered',
          deliveredAt: expect.any(String),
        })
        expect(
          stack.interfaceStore.deliveries.get(queued.delivery.deliveryRequestId)
        ).toMatchObject({
          deliveryRequestId: queued.delivery.deliveryRequestId,
          status: 'delivered',
          deliveredAt: expect.any(String),
        })
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })

  test('POST /v1/gateway/deliveries/{id}/fail transitions the delivery to failed and preserves code + message', async () => {
    const launcher = createRecordingMockLauncher()

    await withSeedStack(
      async (stack) => {
        const queued = await queueAssistantDelivery(stack, launcher, {
          messageRef: 'discord:message:fail',
          assistantText: 'Fail this delivery.',
        })

        const failed = await requestJson<{ delivery: DeliveryPayload }>(stack, {
          method: 'POST',
          path: `/v1/gateway/deliveries/${queued.delivery.deliveryRequestId}/fail`,
          body: {
            code: 'discord_http_error',
            message: 'transport rejected the message',
          },
        })

        expect(failed.response.status).toBe(200)
        expect(failed.payload.delivery).toMatchObject({
          deliveryRequestId: queued.delivery.deliveryRequestId,
          status: 'failed',
          failure: {
            code: 'discord_http_error',
            message: 'transport rejected the message',
          },
        })
        expect(
          stack.interfaceStore.deliveries.get(queued.delivery.deliveryRequestId)
        ).toMatchObject({
          deliveryRequestId: queued.delivery.deliveryRequestId,
          status: 'failed',
          failureCode: 'discord_http_error',
          failureMessage: 'transport rejected the message',
        })
      },
      { launchRoleScopedRun: launcher.launchRoleScopedRun }
    )
  })
})
