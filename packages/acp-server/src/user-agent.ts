import { firstPartyUserAgent } from 'acp-core'

/**
 * `acp-server/<version>`: names this server in HRC's request log. The SDK's
 * own default names the entry module's package, which under launchd's
 * `acp server serve` is acp-cli, not the server making the calls.
 */
export const ACP_SERVER_USER_AGENT = firstPartyUserAgent(
  new URL('../package.json', import.meta.url)
)
