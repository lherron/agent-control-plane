import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import {
  mapDiscordMessageAttachments,
  resolveDiscordIngressContent,
} from '../attachment-ingress.js'

type RawDiscordAttachment = {
  id: string
  url: string
  filename: string
  content_type?: string | undefined
  size?: number | undefined
}

type RawMessageCreateFixture = {
  t: string
  d: {
    content: string
    attachments: RawDiscordAttachment[]
    embeds: Array<{ title?: string | undefined; url?: string | undefined }>
  }
}

function readRealMessageCreateFixture(): RawMessageCreateFixture {
  return JSON.parse(
    readFileSync(
      new URL('./fixtures/discord-message-create-with-attachment.json', import.meta.url),
      'utf8'
    )
  ) as RawMessageCreateFixture
}

function adaptRawMessageCreate(fixture: RawMessageCreateFixture) {
  return {
    content: fixture.d.content,
    attachments: new Map(
      fixture.d.attachments.map((attachment) => [
        attachment.id,
        {
          url: attachment.url,
          name: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
        },
      ])
    ),
    embeds: fixture.d.embeds,
  } as never
}

describe('Discord attachment ingress', () => {
  test('maps the captured real MESSAGE_CREATE attachment shape', () => {
    const fixture = readRealMessageCreateFixture()
    expect(fixture.t).toBe('MESSAGE_CREATE')

    const message = adaptRawMessageCreate(fixture)
    expect(mapDiscordMessageAttachments(message)).toEqual([
      {
        kind: 'url',
        url: fixture.d.attachments[0]?.url,
        filename: 'cody.png',
        contentType: 'image/png',
        sizeBytes: 1592152,
      },
    ])
    expect(resolveDiscordIngressContent(message)).toBe(fixture.d.content)
  })

  test('preserves Discord embed titles and URLs in the ingress text', () => {
    expect(
      resolveDiscordIngressContent({
        content: 'Find this episode.',
        attachments: new Map(),
        embeds: [
          {
            title: 'Deep Questions with Cal Newport',
            url: 'https://www.youtube.com/watch?v=episode-id',
          },
        ],
      } as never)
    ).toBe(
      'Find this episode.\n\n[Discord embed 1]\ntitle: Deep Questions with Cal Newport\nurl: https://www.youtube.com/watch?v=episode-id'
    )
  })
})
