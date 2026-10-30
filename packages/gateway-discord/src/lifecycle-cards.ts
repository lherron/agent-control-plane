import {
  type JobLifecycleSystemEvent,
  type JobRunFailureCardLimiter,
  buildJobRunCard,
} from './job-runs.js'
import type { WebhookPayload, createWebhookManager } from './webhooks.js'
import { buildWorkActivityCard, isWorkActivityKind } from './work-activity.js'

import type { GatewayAcpClient } from './acp-client.js'
import type { DiscordOutput } from './discord-output.js'
import { log } from './gateway-log.js'

/** Shape of GET /v1/admin/system-events. */
type SystemEventsResponse = {
  events: JobLifecycleSystemEvent[]
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export class LifecycleCards {
  systemEventsLoopStopped = false
  systemEventsLoopPromise = undefined as Promise<void> | undefined
  systemEventsCursor = undefined as string | undefined
  constructor(
    private readonly options: {
      acp: Pick<GatewayAcpClient, 'fetchJson'>
      deliveryIdleMs: number
      gatewayId: string
      jobRunFailureCardLimiter: JobRunFailureCardLimiter
      jobRunsChannelId: string | undefined
      jobRunsPollMs: number
      output: Pick<DiscordOutput, 'avatarForAgent'>
      webhooks: ReturnType<typeof createWebhookManager>
      workActivityChannelId: string | undefined
    }
  ) {}

  async primeSystemEventsCursor(): Promise<string> {
    try {
      const payload =
        await this.options.acp.fetchJson<SystemEventsResponse>('/v1/admin/system-events')
      let max = 0
      for (const event of payload.events) {
        const id = Number(event.eventId)
        if (Number.isFinite(id) && id > max) {
          max = id
        }
      }
      return String(max)
    } catch (error) {
      log.warn('gw.jobruns.prime_failed', {
        message: 'Failed to prime job-runs cursor; starting from 0',
        trace: { gatewayId: this.options.gatewayId },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
      return '0'
    }
  }

  private resolveCardTarget(
    event: JobLifecycleSystemEvent
  ): { channelId: string; card: WebhookPayload } | undefined {
    if (event.kind.startsWith('job.')) {
      if (this.options.jobRunsChannelId === undefined) {
        return undefined
      }
      const card = buildJobRunCard(event, this.options.output.avatarForAgent)
      if (card === undefined || !this.options.jobRunFailureCardLimiter.admit(event)) {
        return undefined
      }
      return { channelId: this.options.jobRunsChannelId, card }
    }
    if (isWorkActivityKind(event.kind)) {
      if (this.options.workActivityChannelId === undefined) {
        return undefined
      }
      const card = buildWorkActivityCard(event)
      return card === undefined
        ? undefined
        : { channelId: this.options.workActivityChannelId, card }
    }
    return undefined
  }

  async pollSystemEventsOnce(): Promise<number> {
    if (
      this.options.jobRunsChannelId === undefined &&
      this.options.workActivityChannelId === undefined
    ) {
      return 0
    }
    const cursor = this.systemEventsCursor ?? '0'
    const payload = await this.options.acp.fetchJson<SystemEventsResponse>(
      `/v1/admin/system-events?afterEventId=${encodeURIComponent(cursor)}&limit=200`
    )

    // Failure summaries for job windows that ended before this batch (flushed every poll, so a
    // summary never waits for the job's next failure).
    if (this.options.jobRunsChannelId !== undefined) {
      for (const card of this.options.jobRunFailureCardLimiter.takeSummaries(
        this.options.output.avatarForAgent
      )) {
        await this.postLifecycleCard(this.options.jobRunsChannelId, card, {
          kind: 'job.failure_summary',
        })
      }
    }

    for (const event of payload.events) {
      // Advance the cursor first so a card that fails to render/send is not
      // retried forever (best-effort egress; the stores remain the record).
      const id = Number(event.eventId)
      if (Number.isFinite(id) && id > Number(this.systemEventsCursor ?? '0')) {
        this.systemEventsCursor = String(id)
      }
      const target = this.resolveCardTarget(event)
      if (target === undefined) {
        continue
      }
      await this.postLifecycleCard(target.channelId, target.card, {
        eventId: event.eventId,
        kind: event.kind,
      })
    }

    return payload.events.length
  }

  private async postLifecycleCard(
    channelId: string,
    card: WebhookPayload,
    data: { eventId?: string; kind: string }
  ): Promise<void> {
    try {
      await this.options.webhooks.send(channelId, card)
    } catch (error) {
      log.warn('gw.system_events.post_failed', {
        message: 'Failed to post lifecycle card',
        trace: { gatewayId: this.options.gatewayId },
        data: { ...data, channelId },
        err: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async runSystemEventsLoop(): Promise<void> {
    while (!this.systemEventsLoopStopped) {
      try {
        const count = await this.pollSystemEventsOnce()
        await sleep(count > 0 ? this.options.jobRunsPollMs : this.options.deliveryIdleMs)
      } catch (error) {
        log.error('gw.jobruns.loop_error', {
          message: 'job-runs loop iteration failed',
          trace: { gatewayId: this.options.gatewayId },
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        })
        await sleep(this.options.deliveryIdleMs)
      }
    }
  }
}
