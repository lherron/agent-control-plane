import { expect, test } from 'bun:test'
import type { DeliveryRequest } from 'acp-core'
import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'
import {
  CODY_PROFILE,
  codyDelivery,
  codyTaskBinding,
  createAcpFetch,
  createFetch,
  inboundChannelMessage,
} from './app-acp-fixture.test.js'
import { FakeChannel, createClient } from './app-discord-fixture.test.js'

/** Register in the parent suite to retain the original test identities and order. */
export function registerWebhookDeliveryTests(): void {
  test('sends a fresh webhook message without Discord reply references when no placeholder exists', async () => {
    await withWiredServer(async (fixture) => {
      fixture.interfaceStore.bindings.create({
        bindingId: 'ifb_234',
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_2',
        scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
        laneRef: 'main',
        projectId: fixture.seed.projectId,
        status: 'active',
        createdAt: '2026-04-20T15:00:00.000Z',
        updatedAt: '2026-04-20T15:00:00.000Z',
      })

      const channel = new FakeChannel('chan_2')
      const client = createClient(channel)

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: createFetch(fixture.handler),
      })

      await app.refreshBindings()

      const delivery: DeliveryRequest = {
        deliveryRequestId: 'dr_234',
        gatewayId: 'discord_prod',
        bindingId: 'ifb_234',
        sessionRef: {
          scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
          laneRef: 'main',
        },
        conversationRef: 'channel:chan_2',
        replyToMessageRef: 'discord:message:orig_1',
        body: {
          kind: 'text/markdown',
          text: 'Fresh reply',
        },
        status: 'queued',
        createdAt: '2026-04-20T15:01:00.000Z',
      }

      fixture.interfaceStore.deliveries.enqueue({
        deliveryRequestId: delivery.deliveryRequestId,
        gatewayId: delivery.gatewayId,
        bindingId: delivery.bindingId,
        scopeRef: delivery.sessionRef.scopeRef,
        laneRef: delivery.sessionRef.laneRef,
        conversationRef: delivery.conversationRef,
        replyToMessageRef: delivery.replyToMessageRef,
        bodyKind: delivery.body.kind,
        bodyText: delivery.body.text,
        createdAt: delivery.createdAt,
      })

      await app.pollDeliveriesOnce()

      expect(channel.sent).toHaveLength(0)
      const webhook = [...channel.webhooks.values()].find(
        (candidate) => candidate.name === 'agent-pulpit'
      )
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toBe(`-# curly@${fixture.seed.projectId}~main\nFresh reply`)
      expect(webhook?.sent[0]?.reply).toBeUndefined()
      expect(webhook?.sent[0]?.username).toBe('curly')
      expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
        'https://api.dicebear.com/7.x/bottts/png?seed=curly'
      )
      expect(fixture.interfaceStore.deliveries.get('dr_234')?.status).toBe('delivered')
    })
  })

  test('uses the agent profile avatar for fresh webhook deliveries', async () => {
    const channel = new FakeChannel('chan_profile_avatar')
    const client = createClient(channel)
    const acp = createAcpFetch({
      agents: [CODY_PROFILE],
      deliveries: [
        codyDelivery(channel.id, {
          sessionRef: { scopeRef: 'agent:cody:project:agent-spaces', laneRef: 'main' },
          body: { kind: 'text/markdown', text: 'Profile avatar delivery.' },
        }),
      ],
    })

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: acp.fetchImpl,
    })

    await app.refreshBindings()
    await app.pollDeliveriesOnce()

    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook).toBeDefined()
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.username).toBe('cody')
    expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
      'https://example.com/cody.png'
    )
    expect(webhook?.avatarEdits).toHaveLength(0)
    expect(acp.paths).toContain(`/v1/gateway/deliveries/dr_${channel.id}/ack`)
  })

  test('sends delivery body attachments through the agent webhook without reply references', async () => {
    const priorFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('delivered-bytes', {
        headers: {
          'content-length': '15',
          'content-type': 'image/png',
        },
      })) as typeof fetch

    try {
      const channel = new FakeChannel('chan_delivery_files')
      const client = createClient(channel)
      const acp = createAcpFetch({
        deliveries: [
          codyDelivery(channel.id, {
            sessionRef: { scopeRef: 'agent:curly:project:project_media', laneRef: 'main' },
            replyToMessageRef: 'discord:message:origin',
            body: {
              kind: 'text/markdown',
              text: 'Here is the generated image.',
              attachments: [
                {
                  kind: 'url',
                  url: 'https://media.acp.test/generated.png',
                  filename: 'generated.png',
                  contentType: 'image/png',
                  alt: 'Generated image alt text',
                },
              ],
            },
          }),
        ],
      })

      const app = new GatewayDiscordApp({
        acpBaseUrl: 'http://acp.test',
        gatewayId: 'discord_prod',
        client: client as never,
        fetchImpl: acp.fetchImpl,
      })

      await app.pollDeliveriesOnce()

      expect(channel.sent).toHaveLength(0)
      const webhook = [...channel.webhooks.values()].find(
        (candidate) => candidate.name === 'agent-pulpit'
      )
      expect(webhook).toBeDefined()
      expect(webhook?.sent).toHaveLength(1)
      expect(webhook?.sent[0]?.content).toContain(
        '-# curly@project_media~main\nHere is the generated image.'
      )
      expect(webhook?.sent[0]?.reply).toBeUndefined()
      expect(webhook?.sent[0]?.username).toBe('curly')
      expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
        'https://api.dicebear.com/7.x/bottts/png?seed=curly'
      )
      expect(webhook?.sent[0]?.files?.map((file) => file.name)).toEqual(['generated.png'])
      expect(webhook?.sent[0]?.files?.[0]?.description).toBe('Generated image alt text')
    } finally {
      globalThis.fetch = priorFetch
    }
  })

  test('creates placeholders through the agent webhook with the profile avatar', async () => {
    const channel = new FakeChannel('chan_placeholder_identity')
    const client = createClient(channel)
    const acp = createAcpFetch({
      bindings: [codyTaskBinding(channel.id)],
      agents: [CODY_PROFILE],
      interfaceMessageResponse: { inputAttemptId: 'ia_placeholder', runId: 'run_placeholder' },
    })

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: acp.fetchImpl,
      dashboardSnapshotImpl: async () => ({ type: 'dashboard_snapshot', sessions: [] }),
    })

    await app.refreshBindings()
    await app.handleMessageCreate(
      inboundChannelMessage({
        id: 'incoming_placeholder',
        channelId: channel.id,
        content: 'Please do the work',
      })
    )

    expect(channel.sent).toHaveLength(0)
    const webhook = [...channel.webhooks.values()].find(
      (candidate) => candidate.name === 'agent-pulpit'
    )
    expect(webhook).toBeDefined()
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.username).toBe('cody')
    expect(webhook?.sent[0]?.avatar_url ?? webhook?.sent[0]?.avatarURL).toBe(
      'https://example.com/cody.png'
    )
    expect(webhook?.avatarEdits).toHaveLength(0)
    expect(webhook?.sent[0]?.content).toBe(
      '-# cody@agent-spaces:T-04321~main\n⏳ **Processing:** Please do the work'
    )
    await app.stop()
  })

  test('finalizes webhook placeholders by editing via the same webhook identity', async () => {
    const channel = new FakeChannel('chan_placeholder_final')
    const client = createClient(channel)
    const acp = createAcpFetch({
      bindings: [codyTaskBinding(channel.id)],
      interfaceMessageResponse: { inputAttemptId: 'ia_final', runId: 'run_webhook_final' },
      deliveries: [
        codyDelivery(channel.id, {
          runId: 'run_webhook_final',
          body: {
            kind: 'text/markdown',
            text: `Final answer\n\n${'overflow '.repeat(30)}`,
          },
        }),
      ],
    })

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: acp.fetchImpl,
      dashboardSnapshotImpl: async () => ({ type: 'dashboard_snapshot', sessions: [] }),
      maxChars: 80,
    })

    await app.refreshBindings()
    await app.handleMessageCreate(
      inboundChannelMessage({ id: 'msg_final', channelId: channel.id, content: 'Do the work' })
    )
    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook?.sent).toHaveLength(1)
    const placeholderId = webhook?.sent[0]?.message.id

    await app.pollDeliveriesOnce()

    expect(channel.sent).toHaveLength(0)
    expect(webhook?.edits).toHaveLength(1)
    expect(webhook?.edits[0]?.messageId).toBe(placeholderId)
    expect(webhook?.edits[0]?.payload.username).toBeUndefined()
    expect(webhook?.edits[0]?.payload.avatar_url).toBeUndefined()
    expect(webhook?.edits[0]?.payload.avatarURL).toBeUndefined()
    expect(webhook?.edits[0]?.payload.content).toContain(
      '-# cody@agent-spaces:T-04321~main\nFinal answer'
    )
    const overflow = webhook?.sent.slice(1) ?? []
    expect(overflow.length).toBeGreaterThan(0)
    expect(overflow.every((payload) => payload.username === 'cody')).toBe(true)
    expect(
      overflow.every(
        (payload) =>
          (payload.avatar_url ?? payload.avatarURL) ===
          'https://api.dicebear.com/7.x/bottts/png?seed=cody'
      )
    ).toBe(true)
    await app.stop()
  })

  test('webhook placeholder without webhookId falls through to fresh webhook send (never Rex)', async () => {
    // Restart-fallback / legacy-state regression guard. If a placeholder entry
    // somehow has no `webhookId` (e.g. created by a pre-refactor process before
    // restart, or legacy/test entry), deliverToDiscord MUST NOT fall back to
    // `renderToDiscord` (bot/Rex). It must send the final via the agent
    // webhook so the visible identity stays correct.
    const channel = new FakeChannel('chan_no_webhook_id')
    await channel.createWebhook({ name: 'agent-pulpit' })
    const client = createClient(channel)

    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: createFetch(async () => Response.json({ bindings: [] })),
    })
    ;(
      app as unknown as {
        pending: { placeholdersByRunId: Map<string, unknown> }
      }
    ).pending.placeholdersByRunId.set('run_legacy_no_webhook', {
      ui: {
        gatewayId: 'discord_prod',
        kind: 'message',
        id: 'legacy_placeholder_msg',
        channelId: channel.id,
        // webhookId intentionally omitted
      },
      // identity intentionally omitted; deliverToDiscord must derive from sessionRef
    })

    const delivery: DeliveryRequest = {
      deliveryRequestId: 'dr_legacy_no_webhook',
      gatewayId: 'discord_prod',
      bindingId: 'ifb_legacy',
      sessionRef: {
        scopeRef: 'agent:cody:project:agent-spaces:task:T-04321',
        laneRef: 'main',
      },
      runId: 'run_legacy_no_webhook',
      conversationRef: `channel:${channel.id}`,
      body: { kind: 'text/markdown', text: 'Legacy fallback final.' },
      status: 'queued',
      createdAt: '2026-05-06T15:00:00.000Z',
    }

    await (
      app as unknown as {
        output: { deliverToDiscord(delivery: DeliveryRequest): Promise<void> }
      }
    ).output.deliverToDiscord(delivery)

    // Bot path must not be used — channel.sent contains no agent finals.
    expect(channel.sent).toHaveLength(0)

    // Fresh webhook send must have happened with cody identity + subtext.
    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook).toBeDefined()
    expect(webhook?.sent).toHaveLength(1)
    expect(webhook?.sent[0]?.content).toContain('-# cody@agent-spaces:T-04321~main\n')
    expect(webhook?.sent[0]?.content).toContain('Legacy fallback final.')
    expect(webhook?.sent[0]?.username).toBe('cody')
  })

  test('agent webhook chunks never exceed maxChars even with subtext prefix', async () => {
    // Smoke issue 4 regression guard: the `-# {subtext}\n` prefix must be
    // budgeted into the chunk size. Previously, a body at exactly maxChars
    // produced a first chunk of `2000 + prefix.length` and Discord rejected
    // it with BASE_TYPE_MAX_LENGTH.
    const channel = new FakeChannel('chan_chunk_budget')
    await channel.createWebhook({ name: 'agent-pulpit' })
    const client = createClient(channel)

    // Body sized so that subtext + body would push the first chunk over
    // maxChars unless the prefix is budgeted in.
    const maxChars = 100
    const acp = createAcpFetch({
      deliveries: [
        codyDelivery(channel.id, { body: { kind: 'text/markdown', text: 'x '.repeat(150) } }),
      ],
    })
    const app = new GatewayDiscordApp({
      acpBaseUrl: 'http://acp.test',
      gatewayId: 'discord_prod',
      client: client as never,
      fetchImpl: acp.fetchImpl,
      maxChars,
    })

    await app.pollDeliveriesOnce()

    const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
    expect(webhook).toBeDefined()
    expect(webhook?.sent.length).toBeGreaterThan(1)
    for (const sent of webhook?.sent ?? []) {
      expect(sent.content.length).toBeLessThanOrEqual(maxChars)
    }
  })
}
