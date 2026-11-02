import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withWiredServer } from '../../../acp-server/test/fixtures/wired-server.js'
import { GatewayDiscordApp } from '../app.js'
import { createFetch } from './app-acp-fixture.test.js'
import { FakeChannel, createClient } from './app-discord-fixture.test.js'
import {
  captureIngressPostForMessage,
  createAttachment,
  createInboundMessage,
} from './app-media-fixture.test.js'

/** Register in the parent suite to retain the original test identities and order. */
export function registerMediaIngressTests(): void {
  test('ingresses image-only Discord message through ACP and dispatches local image attachment', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'gateway-discord-image-ingress-'))
    const launches: Array<{
      intent: {
        initialPrompt?: string | undefined
        attachments?: Array<Record<string, unknown>> | undefined
      }
    }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_image_only',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:chan_media',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          })

          const channel = new FakeChannel('chan_media')
          const client = createClient(channel)

          const app = new GatewayDiscordApp({
            acpBaseUrl: 'http://acp.test',
            gatewayId: 'discord_prod',
            client: client as never,
            fetchImpl: createFetch(fixture.handler),
          })

          await app.refreshBindings()
          await app.handleMessageCreate(
            createInboundMessage({
              id: 'msg_image_only_e2e',
              content: '',
              attachments: new Map([
                createAttachment('att_photo', {
                  url: 'https://cdn.discordapp.test/attachments/photo.jpg',
                  name: 'photo.jpg',
                  contentType: 'image/jpeg',
                  size: 10,
                }),
              ]),
            })
          )

          // Placeholder now routes through the agent webhook
          expect(channel.sent).toHaveLength(0)
          const webhook = [...channel.webhooks.values()].find((w) => w.name === 'agent-pulpit')
          expect(webhook).toBeDefined()
          expect(webhook?.sent[0]?.content).toContain('⏳ **Processing:**')
          expect(launches).toHaveLength(1)
          const attachment = launches[0]?.intent.attachments?.[0]
          expect(attachment).toMatchObject({
            kind: 'file',
            filename: 'photo.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 10,
          })
          expect(String(attachment?.['path'])).toContain(
            join(mediaStateDir, 'media', 'attachments')
          )
          // ACP renders the durable node-local spool path into prompt text for
          // non-image-aware harnesses without persisting an expiring CDN URL.
          expect(launches[0]?.intent.initialPrompt).toBe(
            `<media:image> (1 image)\n\nAttachment: ${attachment?.['path']} (image/jpeg, discord message msg_image_only_e2e)`
          )
          expect(String(attachment?.['path'])).toContain(
            join(mediaStateDir, 'media', 'attachments', 'msg_image_only_e2e', 'photo.jpg')
          )
          expect(readFileSync(String(attachment?.['path']), 'utf8')).toBe('jpeg-bytes')

          const run = fixture.runStore.listRuns()[0]
          expect(run?.metadata.content).toBe(launches[0]?.intent.initialPrompt)
          expect(run?.metadata.meta).toMatchObject({
            attachments: [
              {
                kind: 'url',
                url: 'https://cdn.discordapp.test/attachments/photo.jpg',
                filename: 'photo.jpg',
                contentType: 'image/jpeg',
                sizeBytes: 10,
              },
            ],
            resolvedAttachments: [
              {
                kind: 'file',
                filename: 'photo.jpg',
                contentType: 'image/jpeg',
                sizeBytes: 10,
              },
            ],
          })
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () =>
            new Response('jpeg-bytes', {
              headers: {
                'content-type': 'image/jpeg',
                'content-length': '10',
              },
            }),
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return {
              runId: 'launch-run-image-only',
              sessionId: 'session-image-only',
            }
          },
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('posts text plus image attachments to ACP ingress', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_text_image',
        content: 'Please inspect this screenshot.',
        attachments: new Map([
          createAttachment('att_image', {
            url: 'https://cdn.discordapp.test/attachments/screenshot.png',
            name: 'screenshot.png',
            contentType: 'image/png',
            size: 12345,
          }),
        ]),
      })
    )

    expect(body).toMatchObject({
      idempotencyKey: 'discord:message:msg_text_image',
      source: {
        gatewayId: 'discord_prod',
        conversationRef: 'channel:chan_media',
        messageRef: 'discord:message:msg_text_image',
        authorRef: 'discord:user:user_1',
      },
      content: 'Please inspect this screenshot.',
      attachments: [
        {
          kind: 'url',
          url: 'https://cdn.discordapp.test/attachments/screenshot.png',
          filename: 'screenshot.png',
          contentType: 'image/png',
          sizeBytes: 12345,
        },
      ],
    })
  })

  test('posts multiple image attachments with a count-aware placeholder', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_many_images',
        content: '   ',
        attachments: new Map([
          createAttachment('att_a', {
            url: 'https://cdn.discordapp.test/attachments/a.png',
            name: 'a.png',
            contentType: 'image/png',
            size: 100,
          }),
          createAttachment('att_b', {
            url: 'https://cdn.discordapp.test/attachments/b.webp',
            name: 'b.webp',
            contentType: 'image/webp',
            size: 200,
          }),
        ]),
      })
    )

    expect(body.content).toBe('<media:image> (2 images)')
    expect(body.attachments).toHaveLength(2)
  })

  test('posts non-image attachments with a document placeholder', async () => {
    const body = await captureIngressPostForMessage(
      createInboundMessage({
        id: 'msg_document',
        content: '',
        attachments: new Map([
          createAttachment('att_pdf', {
            url: 'https://cdn.discordapp.test/attachments/report.pdf',
            name: 'report.pdf',
            contentType: 'application/pdf',
            size: 8192,
          }),
        ]),
      })
    )

    expect(body.content).toBe('<media:document> (1 file)')
    expect(body.attachments).toEqual([
      {
        kind: 'url',
        url: 'https://cdn.discordapp.test/attachments/report.pdf',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 8192,
      },
    ])
  })

  test('appends Discord embed titles and URLs to the ingress content', async () => {
    const body = await captureIngressPostForMessage({
      ...(createInboundMessage({ id: 'msg_embed', content: 'Find this episode.' }) as object),
      embeds: [
        {
          title: 'Deep Questions with Cal Newport',
          url: 'https://www.youtube.com/watch?v=episode-id',
        },
      ],
    } as never)

    expect(body.content).toBe(
      'Find this episode.\n\n[Discord embed 1]\ntitle: Deep Questions with Cal Newport\nurl: https://www.youtube.com/watch?v=episode-id'
    )
  })
}
