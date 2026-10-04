import { isTerminalRuntimeStatus } from 'hrc-core'

/** Is this runtime, by its own status column, no longer live? */
export function isRuntimeTerminal(status: string): boolean {
  return isTerminalRuntimeStatus(status)
}
