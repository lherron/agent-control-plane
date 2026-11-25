import type { AcpHrcClient, ResolvedAcpServerDeps } from '../deps.js'
import { badRequest } from '../http.js'
import { isRecord } from '../parsers/body.js'

export function requireHrcClient(deps: ResolvedAcpServerDeps): AcpHrcClient {
  if (deps.hrcClient === undefined) {
    badRequest('hrcClient not configured')
  }
  return deps.hrcClient
}

/**
 * T-10418: HRC declares that scope-keyed session, event and run reads route to
 * the scope's home. Read structurally so ACP keeps building against an HRC
 * tuple that predates the field; absence means remote reads stay refused.
 */
export function federatedSessionReadFromStatus(status: { capabilities?: unknown }): boolean {
  const capabilities = status.capabilities
  return (
    isRecord(capabilities) &&
    (capabilities as Record<string, unknown>)['federatedSessionRead'] === true
  )
}
