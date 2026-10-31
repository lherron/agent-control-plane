import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * ACP's durable state root, `~/praesidium/var/state/acp-server`. Every on-disk
 * default that is not a database (mobile auth, cap catalog, agent assets, the
 * interface media spool) lives under it, never under the working directory.
 */
export function acpStateDir(home: string = homedir()): string {
  return join(home, 'praesidium', 'var', 'state', 'acp-server')
}
