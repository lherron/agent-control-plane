import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  bindDiscordConversation,
  postDiscordMessage,
  resolveCurlyRuntime,
} from './fixtures/discord-interface-message.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('POST /v1/interface/messages attachments', () => {
  test('includes spooled attachment context in an active-run contribution', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-contribution-media-'))
    const contributions: Array<{ prompt?: string | undefined }> = []

    try {
      await withWiredServer(
        async (fixture) => {
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_contribution_attachment',
            conversationRef: 'channel:contribution-attachment',
            now: '2026-08-31T14:48:00.000Z',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:contribution-attachment',
            messageRef: 'discord:message:contribution-attachment',
            authorRef: 'discord:user:lance',
            content: 'Use this image as more context.',
            intent: {
              kind: 'contribute_to_active_run',
              fallback: 'reject',
            },
            attachments: [
              {
                kind: 'url',
                url: 'https://cdn.discordapp.test/contribution.png',
                filename: 'contribution.png',
                contentType: 'image/png',
              },
            ],
          })

          expect(response.status).toBe(201)
          expect(contributions).toHaveLength(1)
          const prompt = contributions[0]?.prompt
          expect(prompt).not.toContain('https://cdn.discordapp.test/contribution.png')
          expect(prompt).toContain('Use this image as more context.')
          expect(prompt).toContain(
            `Attachment: ${join(
              mediaStateDir,
              'media',
              'attachments',
              'contribution-attachment',
              'contribution.png'
            )} (image/png, discord message contribution-attachment)`
          )
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () =>
            new Response('contribution-image', {
              headers: { 'content-type': 'image/png', 'content-length': '18' },
            }),
          hrcClient: {
            submitActiveRunContribution: async (request: { prompt?: string | undefined }) => {
              contributions.push(request)
              return {
                status: 'accepted',
                inputApplicationId: 'iap_attachment_contribution',
                hostSessionId: 'hsid_attachment_contribution',
                generation: 1,
                runtimeId: 'rt_attachment_contribution',
                runId: 'hrc_attachment_contribution',
              }
            },
          } as never,
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
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
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_media',
            conversationRef: 'channel:media',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:media',
            messageRef: 'discord:message:media',
            authorRef: 'discord:user:999',
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
          })
          const payload = await fixture.json<{
            inputAttemptId: string
            runId: string
          }>(response)

          expect(response.status).toBe(201)
          const run = fixture.runStore.getRun(payload.runId)
          expect(run?.metadata).toMatchObject({
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
          expect(resolved.path).toContain(join(mediaStateDir, 'media', 'attachments'))
          expect(readFileSync(resolved.path, 'utf8')).toBe('png-bytes')
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt: `<media:image> (1 image)\n\nAttachment: ${resolved.path} (image/png, discord message media)`,
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
          runtimeResolver: resolveCurlyRuntime,
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
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_files',
            conversationRef: 'channel:files',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:files',
            messageRef: 'discord:message:files',
            authorRef: 'discord:user:999',
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
          })

          expect(response.status).toBe(201)
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt: `files attached\n\nAttachment: ${existingPath} (image/png, discord message files)\nAttachment unavailable: missing.png (application/octet-stream, discord message files)`,
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
          runtimeResolver: resolveCurlyRuntime,
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
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_limit',
            conversationRef: 'channel:limit',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:limit',
            messageRef: 'discord:message:limit',
            authorRef: 'discord:user:999',
            content: 'oversized media but text remains',
            attachments: [
              {
                kind: 'url',
                url: 'https://cdn.discordapp.test/large.png',
                filename: 'large.png',
              },
            ],
          })

          expect(response.status).toBe(201)
          expect(launches).toHaveLength(1)
          expect(launches[0]?.intent).toMatchObject({
            initialPrompt:
              'oversized media but text remains\n\nAttachment unavailable: large.png (application/octet-stream, discord message limit)',
            placement: {
              agentRoot: '/tmp/agents/curly',
              projectRoot: '/tmp/project',
              cwd: '/tmp/project',
              runMode: 'task',
              bundle: { kind: 'compose', compose: [] },
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
          runtimeResolver: resolveCurlyRuntime,
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
})
