import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CollaborationLedger, CollaborationSayInput } from 'wrkq-lib'

import {
  bindDiscordConversation,
  postDiscordMessage,
  resolveCurlyRuntime,
} from './fixtures/discord-interface-message.js'
import { withWiredServer } from './fixtures/wired-server.js'

function recordLedgerSays(groupId: string) {
  const says: CollaborationSayInput[] = []
  const ledger: CollaborationLedger = {
    async listMessagesByMember() {
      return { messages: [] }
    },
    async listMessagesByRoom() {
      return { messages: [] }
    },
    async say(input) {
      says.push(input)
      return { roomKey: input.ref, groupId, envelopes: [] }
    },
  }
  return { ledger, says }
}

describe('POST /v1/interface/messages ledger ingress', () => {
  test('records Discord ingress as an exact-principal ledger-only human say', async () => {
    const principals: string[] = []
    const { ledger, says } = recordLedgerSays('EN-00001')
    let launchCalls = 0

    await withWiredServer(
      async (fixture) => {
        bindDiscordConversation(fixture, {
          bindingId: 'ifb_ledger',
          conversationRef: 'channel:ledger',
          now: '2026-08-27T17:00:00.000Z',
        })

        const response = await postDiscordMessage(fixture, {
          conversationRef: 'channel:ledger',
          messageRef: 'discord:message:ledger-1',
          authorRef: 'discord:user:lance',
          idempotencyKey: 'discord:message:ledger-1',
          content: 'Render this from the collaboration room.',
        })

        expect(response.status).toBe(201)
        expect(principals).toEqual(['agent:lance'])
        expect(says).toEqual([
          {
            ref: `curly@${fixture.seed.projectId}`,
            to: [`curly@${fixture.seed.projectId}`],
            body: 'Render this from the collaboration room.',
            idempotencyKey: 'interface:discord_prod:discord:message:ledger-1',
          },
        ])
        expect(launchCalls).toBe(0)
      },
      {
        collaborationLedgerForPrincipal: async (principalRef) => {
          principals.push(principalRef)
          return ledger
        },
        runtimeResolver: resolveCurlyRuntime,
        launchRoleScopedRun: async () => {
          launchCalls += 1
          return { runId: 'launch-ledger', sessionId: 'session-ledger' }
        },
      }
    )
  })

  test('spools Discord attachments before minting the ledger envelope body', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-ledger-media-'))
    const { ledger, says } = recordLedgerSays('EN-07794')

    try {
      await withWiredServer(
        async (fixture) => {
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_ledger_attachment',
            conversationRef: 'channel:ledger-attachment',
            now: '2026-08-31T14:48:00.000Z',
          })

          const sourceUrl =
            'https://cdn.discordapp.com/attachments/1165715502807658557/1543995780166066348/cody.png?ex=6a96e5a0&is=6a959420&hm=fixture&'
          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:ledger-attachment',
            messageRef: 'discord:message:1543995780468047953',
            authorRef: 'discord:user:1165644636807778414',
            content: 'What is in this image?',
            attachments: [
              {
                kind: 'url',
                url: sourceUrl,
                filename: 'cody.png',
                contentType: 'image/png',
                sizeBytes: 1592152,
              },
            ],
          })

          expect(response.status).toBe(201)
          expect(says).toHaveLength(1)
          expect(says[0]?.body).not.toContain(sourceUrl)
          const localPath = says[0]?.body.match(/^Attachment: (.+) \(image\/png,/m)?.[1]
          expect(localPath).toContain(
            join(mediaStateDir, 'media', 'attachments', '1543995780468047953', 'cody.png')
          )
          expect(says[0]?.body).toBe(
            `What is in this image?\n\nAttachment: ${localPath} (image/png, discord message 1543995780468047953)`
          )
          expect(readFileSync(String(localPath), 'utf8')).toBe('fixture-image-bytes')
        },
        {
          mediaStateDir,
          attachmentFetchImpl: async () =>
            new Response('fixture-image-bytes', {
              headers: { 'content-type': 'image/png', 'content-length': '19' },
            }),
          collaborationLedgerForPrincipal: async () => ledger,
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })

  test('announces a spooled Discord attachment at a URL a seat on another node can fetch (T-12176)', async () => {
    const mediaStateDir = mkdtempSync(join(tmpdir(), 'acp-interface-ledger-remote-'))
    const { ledger, says } = recordLedgerSays('EN-12176')
    // Files a traversal would reach if the route trusted its params.
    mkdirSync(join(mediaStateDir, 'media', 'attachments', '9001'), { recursive: true })
    writeFileSync(join(mediaStateDir, 'media', 'secret.txt'), 'OUTSIDE-SPOOL')
    writeFileSync(join(mediaStateDir, 'media', 'attachments', '9001', '.hidden'), 'HIDDEN')

    try {
      await withWiredServer(
        async (fixture) => {
          bindDiscordConversation(fixture, {
            bindingId: 'ifb_ledger_remote',
            conversationRef: 'channel:ledger-remote',
            agent: 'smokey',
            now: '2026-10-31T12:00:00.000Z',
          })

          const response = await postDiscordMessage(fixture, {
            conversationRef: 'channel:ledger-remote',
            messageRef: 'discord:message:9001',
            authorRef: 'discord:user:lance',
            content: 'Quote the marker line.',
            attachments: [
              {
                kind: 'url',
                url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt?ex=1',
                filename: 'notes.txt',
                contentType: 'text/plain',
              },
            ],
          })
          expect(response.status).toBe(201)

          const localPath = join(mediaStateDir, 'media', 'attachments', '9001', 'notes.txt')
          const url = 'http://100.64.0.9:18470/v1/media/attachments/9001/notes.txt'
          expect(says[0]?.body).toBe(
            `Quote the marker line.\n\nAttachment: ${localPath} (text/plain, discord message 9001)\n  from another node: curl -fsS '${url}' -o "\${TMPDIR:-/tmp}/notes.txt"`
          )

          const fetched = await fixture.request({
            method: 'GET',
            path: '/v1/media/attachments/9001/notes.txt',
          })
          expect(fetched.status).toBe(200)
          expect(fetched.headers.get('content-type')).toBe('text/plain')
          expect(await fetched.text()).toBe('MARKER line one\n')

          const missing = await fixture.request({
            method: 'GET',
            path: '/v1/media/attachments/9001/absent.txt',
          })
          expect(missing.status).toBe(404)

          for (const path of [
            '/v1/media/attachments/9001/..%2Fsecret.txt',
            '/v1/media/attachments/9001/..%2F..%2Fsecret.txt',
            '/v1/media/attachments/..%2F..%2Fmedia/secret.txt',
            '/v1/media/attachments/%2E%2E/secret.txt',
            '/v1/media/attachments/../secret.txt',
            '/v1/media/attachments/9001/.hidden',
            '/v1/media/attachments/.9001/notes.txt',
          ]) {
            const refused = await fixture.handler(new Request(`http://acp.test${path}`))
            expect([400, 404]).toContain(refused.status)
            const text = await refused.text()
            expect(text).not.toContain('OUTSIDE-SPOOL')
            expect(text).not.toContain('HIDDEN')
          }
        },
        {
          mediaStateDir,
          attachmentBaseUrl: 'http://100.64.0.9:18470',
          attachmentFetchImpl: async () =>
            new Response('MARKER line one\n', { headers: { 'content-type': 'text/plain' } }),
          collaborationLedgerForPrincipal: async () => ledger,
        }
      )
    } finally {
      rmSync(mediaStateDir, { recursive: true, force: true })
    }
  })
})
