import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/interface/messages', () => {
  test('creates an input attempt, records the source, and dispatches once', async () => {
    const launches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: {
        initialPrompt?: string
        attachments?: Array<Record<string, unknown>>
      }
    }> = []

    await withWiredServer(
      async (fixture) => {
        fixture.interfaceStore.bindings.create({
          bindingId: 'ifb_123',
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
          laneRef: 'main',
          projectId: fixture.seed.projectId,
          status: 'active',
          createdAt: '2026-04-20T15:00:00.000Z',
          updatedAt: '2026-04-20T15:00:00.000Z',
        })

        const firstResponse = await fixture.request({
          method: 'POST',
          path: '/v1/interface/messages',
          body: {
            idempotencyKey: 'discord:message:123',
            source: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:123',
              authorRef: 'discord:user:999',
            },
            content: 'Please summarize the status of T-01144.',
          },
        })
        const firstPayload = await fixture.json<{ inputAttemptId: string; runId: string }>(
          firstResponse
        )

        expect(firstResponse.status).toBe(201)
        expect(firstPayload.inputAttemptId).toMatch(/^ia_/)
        expect(firstPayload.runId).toMatch(/^run_/)

        const run = fixture.runStore.getRun(firstPayload.runId)
        expect(run?.metadata).toMatchObject({
          content: 'Please summarize the status of T-01144.',
          meta: {
            interfaceSource: {
              authorRef: 'discord:user:999',
            },
          },
        })
        expect(
          (run?.metadata?.meta as Record<string, unknown> | undefined)?.['interfaceSource']
        ).toEqual({
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
          authorRef: 'discord:user:999',
          replyToMessageRef: 'discord:message:123',
          clientIdempotencyKey: 'discord:message:123',
        })
        expect(
          'attachments' in ((run?.metadata?.meta as Record<string, unknown> | undefined) ?? {})
        ).toBe(false)

        expect(
          fixture.interfaceStore.messageSources.getByMessageRef(
            'discord_prod',
            'discord:message:123'
          )
        ).toEqual({
          gatewayId: 'discord_prod',
          bindingId: 'ifb_123',
          conversationRef: 'channel:123',
          messageRef: 'discord:message:123',
          authorRef: 'discord:user:999',
          receivedAt: expect.any(String),
        })

        const secondResponse = await fixture.request({
          method: 'POST',
          path: '/v1/interface/messages',
          body: {
            idempotencyKey: 'discord:message:123',
            source: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:123',
              authorRef: 'discord:user:999',
            },
            content: 'Please summarize the status of T-01144.',
          },
        })
        const secondPayload = await fixture.json<{ inputAttemptId: string; runId: string }>(
          secondResponse
        )

        expect(secondResponse.status).toBe(200)
        expect(secondPayload).toEqual(firstPayload)
        expect(launches).toHaveLength(1)
        expect(launches[0]).toMatchObject({
          sessionRef: {
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
          },
          intent: {
            initialPrompt: 'Please summarize the status of T-01144.',
          },
        })
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/curly',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launches.push(input)
          return { runId: 'launch-run-001', sessionId: 'session-001' }
        },
      }
    )
  })

  test('accepts attachment refs, preserves metadata, and threads them into launch intent', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-media-'))
    const launches: Array<{
      sessionRef: { scopeRef: string; laneRef: string }
      intent: {
        initialPrompt?: string
        attachments?: Array<Record<string, unknown>>
      }
    }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_media',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:media',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:media',
                messageRef: 'discord:message:media',
                authorRef: 'discord:user:999',
              },
              content: '<media:image> (1 image)',
              attachments: [
                {
                  kind: 'url',
                  url: 'https://cdn.discordapp.test/image.png',
                  filename: '../../bad image',
                  contentType: 'image/png',
                  sizeBytes: 12345,
                },
              ],
            },
          })
          const payload = await fixture.json<{ inputAttemptId: string; runId: string }>(response)

          expect(response.status).toBe(201)
          const run = fixture.runStore.getRun(payload.runId)
          expect(run?.metadata).toMatchObject({
            content: '<media:image> (1 image)',
            meta: {
              attachments: [
                {
                  kind: 'url',
                  url: 'https://cdn.discordapp.test/image.png',
                  filename: '../../bad image',
                  contentType: 'image/png',
                  sizeBytes: 12345,
                },
              ],
              resolvedAttachments: [
                {
                  kind: 'file',
                  filename: 'bad_image.png',
                  contentType: 'image/png',
                  sizeBytes: 9,
                },
              ],
            },
          })
          const resolved = (
            (run?.metadata?.meta as Record<string, unknown>)?.['resolvedAttachments'] as Array<{
              path: string
            }>
          )[0]
          expect(resolved.path).toContain(
            join(mediaStateDir, 'media', 'attachments', payload.runId)
          )
          expect(readFileSync(resolved.path, 'utf8')).toBe('png-bytes')
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt: '<media:image> (1 image)',
            attachments: [
              {
                kind: 'file',
                path: resolved.path,
                filename: 'bad_image.png',
                contentType: 'image/png',
                sizeBytes: 9,
              },
            ],
          })
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () =>
            new Response('png-bytes', {
              headers: {
                'content-type': 'image/png',
                'content-length': '9',
              },
            }),
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return { runId: 'launch-run-media', sessionId: 'session-media' }
          },
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('validates file attachments and drops failed attachments without blocking launch', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-files-'))
    const existingPath = join(mediaStateDir, 'local image.png')
    writeFileSync(existingPath, 'local-bytes')
    const launches: Array<{
      intent: {
        initialPrompt?: string
        attachments?: Array<Record<string, unknown>>
      }
    }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_files',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:files',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:files',
                messageRef: 'discord:message:files',
                authorRef: 'discord:user:999',
              },
              content: 'files attached',
              attachments: [
                {
                  kind: 'file',
                  path: pathToFileURL(existingPath).href,
                  filename: 'local image.png',
                  contentType: 'image/png',
                },
                {
                  kind: 'url',
                  url: 'https://cdn.discordapp.test/missing.png',
                  filename: 'missing.png',
                },
              ],
            },
          })

          expect(response.status).toBe(201)
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt: 'files attached',
            attachments: [
              {
                kind: 'file',
                path: existingPath,
                filename: 'local_image.png',
                contentType: 'image/png',
                sizeBytes: 11,
              },
            ],
          })
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () => new Response('not found', { status: 404 }),
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return { runId: 'launch-run-files', sessionId: 'session-files' }
          },
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('enforces max bytes for downloaded attachments while preserving text-only dispatch', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-limit-'))
    const launches: Array<{
      intent: {
        initialPrompt?: string
        attachments?: Array<Record<string, unknown>>
      }
    }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          fixture.interfaceStore.bindings.create({
            bindingId: 'ifb_limit',
            gatewayId: 'discord_prod',
            conversationRef: 'channel:limit',
            scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
            laneRef: 'main',
            projectId: fixture.seed.projectId,
            status: 'active',
            createdAt: '2026-04-20T15:00:00.000Z',
            updatedAt: '2026-04-20T15:00:00.000Z',
          })

          const response = await fixture.request({
            method: 'POST',
            path: '/v1/interface/messages',
            body: {
              source: {
                gatewayId: 'discord_prod',
                conversationRef: 'channel:limit',
                messageRef: 'discord:message:limit',
                authorRef: 'discord:user:999',
              },
              content: 'oversized media but text remains',
              attachments: [
                {
                  kind: 'url',
                  url: 'https://cdn.discordapp.test/large.png',
                  filename: 'large.png',
                },
              ],
            },
          })

          expect(response.status).toBe(201)
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt: 'oversized media but text remains',
            placement: {
              agentRoot: '/tmp/agents/curly',
              projectRoot: '/tmp/project',
              cwd: '/tmp/project',
              runMode: 'task',
              bundle: { kind: 'agent-default' },
            },
          })
          expect(launches[0]?.intent.attachments).toBeUndefined()
        },
        {
          mediaStateDir,
          attachmentMaxBytes: 8,
          attachmentFetchImpl: async () =>
            new Response('too-large', {
              headers: {
                'content-type': 'image/png',
                'content-length': '9',
              },
            }),
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/curly',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launches.push(input)
            return { runId: 'launch-run-limit', sessionId: 'session-limit' }
          },
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('wires launch session events into outbound delivery capture', async () => {
    await withWiredServer(
      async (fixture) => {
        fixture.interfaceStore.bindings.create({
          bindingId: 'ifb_123',
          gatewayId: 'discord_prod',
          conversationRef: 'channel:123',
          scopeRef: `agent:curly:project:${fixture.seed.projectId}`,
          laneRef: 'main',
          projectId: fixture.seed.projectId,
          status: 'active',
          createdAt: '2026-04-20T15:00:00.000Z',
          updatedAt: '2026-04-20T15:00:00.000Z',
        })

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/interface/messages',
          body: {
            source: {
              gatewayId: 'discord_prod',
              conversationRef: 'channel:123',
              messageRef: 'discord:message:789',
              authorRef: 'discord:user:999',
            },
            content: 'Reply please.',
          },
        })

        expect(response.status).toBe(201)
        expect(
          fixture.interfaceStore.deliveries.listQueuedForGateway('discord_prod')
        ).toMatchObject([
          {
            bindingId: 'ifb_123',
            conversationRef: 'channel:123',
            replyToMessageRef: 'discord:message:789',
            bodyText: 'Visible response',
            status: 'queued',
          },
        ])
      },
      {
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/curly',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          await input.onEvent?.({
            type: 'message_end',
            messageId: 'assistant-1',
            message: { role: 'assistant', content: 'Visible response' },
          })

          return { runId: 'launch-run-002', sessionId: 'session-002' }
        },
      }
    )
  })

  test('returns interface_binding_not_found when no active binding exists', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/interface/messages',
        body: {
          source: {
            gatewayId: 'discord_prod',
            conversationRef: 'channel:404',
            messageRef: 'discord:message:404',
            authorRef: 'discord:user:404',
          },
          content: 'Anyone there?',
        },
      })
      const payload = await fixture.json<{ error: { code: string } }>(response)

      expect(response.status).toBe(404)
      expect(payload.error.code).toBe('interface_binding_not_found')
    })
  })
})
