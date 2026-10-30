import type { DeliveryRequest, InterfaceSessionRef } from 'acp-core'
import type { Client, Message } from 'discord.js'
import { agentCatalogResponseSchema } from 'spaces-aspc-protocol/agent-inspection'
import { createDiscordAttachments, fetchMediaAttachments } from './attachments.js'
import { type BindingIndex, conversationRefToChannelId, threadRefToThreadId } from './bindings.js'
import { classifyDiscordError, isDiscordRateLimit, isDiscordWebhookGone } from './discord-errors.js'
import {
  type DiscordAgentMessageIdentity,
  type DiscordWebhookAvatar,
  avatarFor,
  formatSessionSubtext,
  identityFromSessionRef,
} from './identity.js'
import { type RenderOptions, extractImagesFromFrame, extractMediaRefsFromFrame } from './render.js'
import type { SessionEventsManager } from './session-events-manager.js'
import type { RenderFrame, UiHandle } from './types.js'
import type { createWebhookManager } from './webhooks.js'
import {
  type FinalDeliveryWritePlan,
  buildProgressEditContent,
  planFinalDeliveryWrite,
} from './write-plan.js'

import type { GatewayAcpClient } from './acp-client.js'
import { canonicalSessionRefString } from './discord-session-ref.js'
import { log } from './gateway-log.js'
import type { PendingResponses } from './pending-responses.js'

async function buildFrameFilesPayload(frame: RenderFrame) {
  const imageAttachments = extractImagesFromFrame(frame)
  const mediaRefs = extractMediaRefsFromFrame(frame)
  const mediaFiles = await fetchMediaAttachments(mediaRefs, undefined)
  const discordFiles = [...createDiscordAttachments(imageAttachments), ...mediaFiles]
  return discordFiles.length > 0 ? { files: discordFiles } : {}
}

function defaultMessageIdentity(sessionRef: InterfaceSessionRef): DiscordAgentMessageIdentity {
  const identity = identityFromSessionRef(sessionRef)
  return {
    agentId: identity.agentId,
    subtext: formatSessionSubtext(sessionRef),
    avatarUrl: avatarFor(identity.agentId),
  }
}

function webhookIdentityPayload(identity: DiscordAgentMessageIdentity): {
  username: string
  avatarURL?: string | undefined
  webhookAvatar?: DiscordWebhookAvatar | undefined
} {
  return {
    username: identity.agentId,
    ...(identity.avatarUrl !== undefined ? { avatarURL: identity.avatarUrl } : {}),
    ...(identity.webhookAvatar !== undefined ? { webhookAvatar: identity.webhookAvatar } : {}),
  }
}

export class DiscordOutput {
  private readonly agentAvatarCache = new Map<string, string>()
  constructor(
    private readonly options: {
      acp: Pick<GatewayAcpClient, 'fetchJson'>
      bindings: BindingIndex
      client: Client
      gatewayId: string
      maxChars: number
      pending: Pick<PendingResponses, 'placeholdersByRunId' | 'removePendingPlaceholder'>
      renderOptions: RenderOptions
      webhooks: ReturnType<typeof createWebhookManager>
      getRunState: SessionEventsManager['getRunState']
    }
  ) {}

  avatarForAgent = (agentId: string): string =>
    avatarFor(agentId, this.agentAvatarCache.get(agentId))

  async refreshAgentAvatars(): Promise<void> {
    try {
      const catalog = agentCatalogResponseSchema.parse(
        await this.options.acp.fetchJson('/admin/agents')
      )
      this.agentAvatarCache.clear()
      for (const agent of catalog.agents) {
        if (agent.avatarUrl !== undefined) this.agentAvatarCache.set(agent.agentId, agent.avatarUrl)
      }
    } catch (error) {
      this.agentAvatarCache.clear()
      log.debug('gw.discord.agent_profile_avatar.unavailable', {
        message: 'Using generated avatars because the agent catalog was unavailable',
        trace: { gatewayId: this.options.gatewayId },
        err: { message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  private async resolveMessageIdentity(
    sessionRef: InterfaceSessionRef
  ): Promise<DiscordAgentMessageIdentity> {
    const identity = defaultMessageIdentity(sessionRef)
    return { ...identity, avatarUrl: this.avatarForAgent(identity.agentId) }
  }

  async deliverToDiscord(delivery: DeliveryRequest): Promise<void> {
    const binding = this.options.bindings.getBindingFor({
      conversationRef: delivery.conversationRef,
      ...(delivery.threadRef ? { threadRef: delivery.threadRef } : {}),
    })
    const deliverySessionRef = canonicalSessionRefString(delivery.sessionRef)
    const placeholder = delivery.runId
      ? this.options.pending.placeholdersByRunId.get(delivery.runId)
      : undefined
    const hrcRunId = placeholder?.claimedHrcRunId ?? delivery.runId
    const liveRunState =
      hrcRunId !== undefined ? this.options.getRunState(deliverySessionRef, hrcRunId) : undefined

    // Resolve agent identity from the delivery's sessionRef.
    const identity = await this.resolveMessageIdentity(delivery.sessionRef)
    const messageIdentity = placeholder?.identity ?? identity
    const plan = planFinalDeliveryWrite({
      delivery,
      binding,
      run: liveRunState,
      identity: messageIdentity,
      maxChars: this.options.maxChars,
      renderOptions: this.options.renderOptions,
    })

    if (placeholder) {
      try {
        if (placeholder.ui.webhookId) {
          // Webhook-created placeholder: edit + overflow via the same webhook
          await this.renderViaWebhook(placeholder.ui, plan, messageIdentity)
        } else {
          // Placeholder exists but has no webhookId (should not happen for agent-originated
          // content, but can occur if placeholder was created before webhook support).
          // NEVER fall back to Rex — best-effort delete the stale placeholder and fall
          // through to the fresh webhook delivery path below.
          log.warn('gw.delivery.placeholder_missing_webhook', {
            message:
              'Placeholder has no webhookId; deleting stale placeholder and sending fresh webhook message',
            trace: { gatewayId: this.options.gatewayId },
            data: {
              runId: delivery.runId,
              placeholderMessageId: placeholder.ui.id,
            },
          })
          await this.deletePlaceholder(placeholder.ui)
          // Fall through to fresh webhook delivery below
        }
      } finally {
        this.options.pending.removePendingPlaceholder(placeholder, 'final_delivery')
      }
      // If we edited via webhook, we're done. If we fell through (no webhookId),
      // continue to fresh delivery below.
      if (placeholder.ui.webhookId) {
        return
      }
    }

    // Fresh delivery (no placeholder) OR restart fallback (placeholder lost from
    // in-memory placeholdersByRunId after gateway restart, or placeholder had no
    // webhookId). In all cases, send via webhook with the agent's identity.
    // Accept degraded UX: the stale placeholder stays (if it existed) and a new
    // message appears. NEVER fall back to Rex for agent-originated content.
    const targetChannelId =
      threadRefToThreadId(delivery.threadRef) ??
      conversationRefToChannelId(delivery.conversationRef)
    if (!targetChannelId) {
      throw new Error(`Unsupported Discord conversationRef: ${delivery.conversationRef}`)
    }

    const filesPayload = await buildFrameFilesPayload(plan.frame)

    for (let index = 0; index < plan.chunks.length; index += 1) {
      const isLastChunk = index === plan.chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      const chunkContent = plan.chunks[index] ?? ''
      try {
        await this.options.webhooks.send(targetChannelId, {
          content: chunkContent,
          ...webhookIdentityPayload(messageIdentity),
          ...chunkFiles,
        })
      } catch (error) {
        classifyDiscordError(error, 'send', { channelId: targetChannelId })
        throw error
      }
    }
  }

  async editPlaceholderProgress(
    ui: UiHandle & { kind: 'message'; webhookId: string },
    frame: RenderFrame,
    identity: DiscordAgentMessageIdentity
  ): Promise<{ ok: boolean; rateLimited: boolean; webhookGone: boolean }> {
    if (!ui.channelId) {
      return { ok: false, rateLimited: false, webhookGone: false }
    }

    const content = buildProgressEditContent({
      frame,
      identity,
      maxChars: Math.min(this.options.maxChars, 2000),
      maxLines: 12,
    })

    try {
      await this.options.webhooks.editMessageOnce(ui.channelId, ui.id, ui.webhookId, {
        content,
      })
      return { ok: true, rateLimited: false, webhookGone: false }
    } catch (error) {
      classifyDiscordError(error, 'edit', {
        channelId: ui.channelId,
        uiId: ui.id,
      })
      return {
        ok: false,
        rateLimited: isDiscordRateLimit(error),
        webhookGone: isDiscordWebhookGone(error),
      }
    }
  }

  private async renderViaWebhook(
    ui: UiHandle & { kind: 'message' },
    plan: FinalDeliveryWritePlan,
    identity: DiscordAgentMessageIdentity
  ): Promise<void> {
    if (!ui.channelId) return

    const filesPayload = await buildFrameFilesPayload(plan.frame)

    // Edit the placeholder message with the first chunk (prefix already included).
    // Use the explicit 4-arg editMessage(channelId, messageId, webhookId, payload)
    // so the webhook manager resolves the exact webhook that created the placeholder.
    const firstChunk = plan.chunks[0] || ''
    const primaryFiles = plan.chunks.length === 1 ? filesPayload : {}
    await this.options.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId ?? '', {
      content: firstChunk,
      ...webhookIdentityPayload(identity),
      ...primaryFiles,
    })

    // Send overflow chunks via the same webhook with the same identity
    for (let i = 1; i < plan.chunks.length; i++) {
      const chunk = plan.chunks[i]
      if (!chunk) continue
      const isLastChunk = i === plan.chunks.length - 1
      const chunkFiles = isLastChunk ? filesPayload : {}
      await this.options.webhooks.send(ui.channelId, {
        content: chunk,
        ...webhookIdentityPayload(identity),
        ...chunkFiles,
      })
    }
  }

  async createPlaceholder(input: {
    message: Message
    channelId: string
    threadId?: string | undefined
    content: string
    sessionRef?: InterfaceSessionRef | undefined
  }): Promise<
    | (UiHandle & {
        kind: 'message'
        webhookId?: string
        identity?: DiscordAgentMessageIdentity
      })
    | undefined
  > {
    try {
      const promptPreview =
        input.content.length > 100 ? `${input.content.slice(0, 100)}…` : input.content

      if (input.sessionRef) {
        // Agent-originated: post via webhook with agent identity
        const identity = await this.resolveMessageIdentity(input.sessionRef)
        const sent = await this.options.webhooks.send(input.channelId, {
          content: `-# ${identity.subtext}\n⏳ **Processing:** ${promptPreview}`,
          ...webhookIdentityPayload(identity),
        })

        const webhook = await this.options.webhooks.getOrCreateWebhook(input.channelId)

        return {
          gatewayId: this.options.gatewayId,
          kind: 'message',
          id: sent.id,
          channelId: input.channelId,
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          webhookId: webhook.id,
          identity,
        }
      }

      // No sessionRef means no agent identity. For bound channels this should
      // never happen (handleMessageCreate always passes binding.sessionRef).
      // Do NOT fall back to Rex — log and skip so we never post agent content
      // under the bot identity.
      log.warn('gw.discord.placeholder.no_session_ref', {
        message: 'createPlaceholder called without sessionRef; skipping to avoid Rex identity leak',
        trace: { gatewayId: this.options.gatewayId },
        data: { channelId: input.channelId },
      })
      return undefined
    } catch (error) {
      log.warn('gw.discord.placeholder.failed', {
        message: 'Failed to send placeholder',
        trace: { gatewayId: this.options.gatewayId },
        data: { channelId: input.channelId },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
      return undefined
    }
  }

  async deletePlaceholder(
    ui: UiHandle & { kind: 'message'; webhookId?: string | undefined }
  ): Promise<void> {
    if (!ui.channelId) {
      return
    }

    try {
      if (ui.webhookId) {
        // Webhook-created placeholder: delete via the same webhook, which owns
        // the message; the bot user may lack Manage Messages for it.
        await this.options.webhooks.deleteMessage(ui.channelId, ui.id, ui.webhookId)
        return
      }
      const channel = await this.options.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) {
        return
      }
      const message = await channel.messages.fetch(ui.id)
      if (message) {
        await message.delete()
      }
    } catch {
      // best-effort cleanup only
    }
  }

  async replyIngressFailure(message: Message, reason: string): Promise<void> {
    try {
      await message.reply(`⚠️ ${reason}`)
    } catch {
      // best-effort: never surface a secondary failure
    }
  }

  async failPlaceholder(
    ui: UiHandle & { kind: 'message'; webhookId?: string | undefined },
    reason: string
  ): Promise<boolean> {
    return this.editPlaceholderContent(ui, `⚠️ ${reason}`)
  }

  async noticePlaceholder(
    ui: UiHandle & {
      kind: 'message'
      webhookId?: string | undefined
      identity?: DiscordAgentMessageIdentity | undefined
    },
    content: string
  ): Promise<void> {
    if (!ui.channelId) return
    const rendered = ui.identity !== undefined ? `-# ${ui.identity.subtext}\n${content}` : content
    await this.editPlaceholderContent(ui, rendered)
  }

  private async editPlaceholderContent(
    ui: UiHandle & { kind: 'message'; webhookId?: string | undefined },
    content: string
  ): Promise<boolean> {
    if (!ui.channelId) return false
    try {
      if (ui.webhookId) {
        await this.options.webhooks.editMessage(ui.channelId, ui.id, ui.webhookId, { content })
        return true
      }
      const channel = await this.options.client.channels.fetch(ui.channelId)
      if (!channel || !channel.isTextBased() || !('messages' in channel)) return false
      const message = await channel.messages.fetch(ui.id)
      if (!message) return false
      await message.edit({ content })
      return true
    } catch {
      // Best-effort notices must never surface a secondary failure.
      return false
    }
  }
}
