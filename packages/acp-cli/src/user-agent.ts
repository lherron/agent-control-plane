import { firstPartyFetch, firstPartyUserAgent } from 'acp-core'

/** `acp-cli/<version>`: names this CLI in acp-server's request log. */
export const ACP_CLI_USER_AGENT = firstPartyUserAgent(new URL('../package.json', import.meta.url))

/** The default fetch for every acp-cli call into acp-server. */
export const acpCliFetch = firstPartyFetch(ACP_CLI_USER_AGENT)
