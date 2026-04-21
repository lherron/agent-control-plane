import { DiscordAPIError } from 'discord.js'

import { createLogger } from './logger.js'

const log = createLogger({ component: 'gateway-discord' })

export function classifyDiscordError(
  error: unknown,
  route: string,
  context: { channelId?: string; uiId?: string }
): void {
  if (error instanceof DiscordAPIError) {
    const baseData = {
      httpStatus: error.status,
      discordCode: error.code,
      route,
      ...context,
    }

    if (error.status === 403) {
      log.warn('gw.discord.forbidden', {
        message: `Discord API forbidden: ${error.message}`,
        data: baseData,
      })
    } else if (error.status === 404) {
      log.info('gw.discord.not_found', {
        message: `Discord resource not found: ${error.message}`,
        data: baseData,
      })
    } else if (error.status === 429) {
      log.warn('gw.discord.rate_limited', {
        message: `Discord rate limited: ${error.message}`,
        data: baseData,
      })
    } else if (error.status >= 400 && error.status < 500) {
      log.warn('gw.discord.invalid_request', {
        message: `Discord invalid request: ${error.message}`,
        data: baseData,
      })
    } else if (error.status >= 500) {
      log.error('gw.discord.server_error', {
        message: `Discord server error: ${error.message}`,
        data: baseData,
      })
    }
  }
}
