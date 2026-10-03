import { parseScopeRef } from 'agent-scope'
import type { ViewerIdentity } from '../headless-viewer-status.js'

// Test inputs are human addresses; production consumes stored HRC identity.
export function fixtureIdentity(scopeRef: string): ViewerIdentity | undefined {
  try {
    return parseScopeRef(scopeRef)
  } catch {
    return undefined
  }
}
