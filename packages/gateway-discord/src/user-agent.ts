import { firstPartyFetch, firstPartyUserAgent } from 'acp-core'

/** `gateway-discord/<version>`: names this gateway in acp-server's request log. */
export const GATEWAY_DISCORD_USER_AGENT = firstPartyUserAgent(
  new URL('../package.json', import.meta.url)
)

/** The default fetch for every gateway call into acp-server. */
export const gatewayDiscordFetch = firstPartyFetch(GATEWAY_DISCORD_USER_AGENT)
