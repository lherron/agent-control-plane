import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type Message } from 'discord.js'
import {
  type RenderOptions,
  renderActionsToCustomIds,
  renderFrameToDiscordContent,
  splitIntoChunks,
} from './render.js'
import type { RenderFrame, UiHandle } from './types.js'

interface RenderResult {
  chunks: number
  edited: boolean
  sentExtraCount: number
}

export async function renderToDiscord(
  client: Client,
  ui: UiHandle,
  frame: RenderFrame,
  maxChars: number,
  options: RenderOptions = {}
): Promise<RenderResult> {
  if (ui.kind !== 'message') return { chunks: 0, edited: false, sentExtraCount: 0 }
  if (!ui.channelId) return { chunks: 0, edited: false, sentExtraCount: 0 }
  const channel = await client.channels.fetch(ui.channelId)
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    return { chunks: 0, edited: false, sentExtraCount: 0 }
  }

  let message: Message | null = null
  try {
    message = (await channel.messages.fetch(ui.id)) as Message | null
  } catch {
    // Message doesn't exist - we'll send new messages instead
  }

  const actions = renderActionsToCustomIds(frame.projectId, frame.runId, frame.actions)

  const buildComponents = () =>
    actions.length > 0
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            actions.map(({ action, customId }) => {
              const style = action.kind === 'deny' ? ButtonStyle.Danger : ButtonStyle.Primary
              return new ButtonBuilder()
                .setCustomId(customId)
                .setLabel(action.label)
                .setStyle(style)
            })
          ),
        ]
      : []

  if (frame.phase === 'permission') {
    const content = renderFrameToDiscordContent(frame, maxChars)
    const truncatedContent =
      content.length > maxChars ? `${content.slice(0, maxChars - 3)}...` : content

    if (message) {
      // biome-ignore lint/suspicious/noExplicitAny: discord.js type incompatibility workaround
      await message.edit({ content: truncatedContent, components: buildComponents() as any })
      return { chunks: 1, edited: true, sentExtraCount: 0 }
    }
    // biome-ignore lint/suspicious/noExplicitAny: discord.js type incompatibility workaround
    await channel.send({ content: truncatedContent, components: buildComponents() as any })
    return { chunks: 1, edited: false, sentExtraCount: 0 }
  }

  const fullContent = renderFrameToDiscordContent(frame, maxChars)
  const chunks = splitIntoChunks(fullContent, maxChars, options)

  const buildChunkComponents = (isFirst: boolean) => (isFirst ? buildComponents() : [])

  if (message) {
    const firstChunk = chunks[0] || ''
    // biome-ignore lint/suspicious/noExplicitAny: discord.js type incompatibility workaround
    await message.edit({ content: firstChunk, components: buildChunkComponents(true) as any })

    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i]
      if (chunk) {
        await channel.send({ content: chunk })
      }
    }
    return { chunks: chunks.length, edited: true, sentExtraCount: chunks.length - 1 }
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (!chunk) continue
    // biome-ignore lint/suspicious/noExplicitAny: discord.js type incompatibility workaround
    await channel.send({ content: chunk, components: buildChunkComponents(i === 0) as any })
  }
  return { chunks: chunks.length, edited: false, sentExtraCount: chunks.length - 1 }
}
