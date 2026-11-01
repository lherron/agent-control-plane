/**
 * The C2 scope row (C2 rev 4 D5): one seat-scoped HRC annotation on the Vesta
 * seat, `{subject: seat, ns: c2, kind: config, id: scope}`, body `{v: 1,
 * allow: string[]}`. An absent row allows nothing. `acp c2 scope show|set`
 * reads and writes it through hrc-sdk on the local HRC socket, as Lance.
 */
import { PRODUCTION_VESTA } from '@praesidium/c2-core'
import { resolveControlSocketPath } from 'hrc-core'
import { HrcClient } from 'hrc-sdk'

import type { AcpHrcClient } from '../deps.js'
import { ACP_SERVER_USER_AGENT } from '../user-agent.js'
import { C2_PHONE_PRINCIPAL } from './controller-host.js'

export type C2ScopeClient = Pick<AcpHrcClient, 'listSessionAnnotations' | 'putSessionAnnotation'>

export type C2ScopeRow = {
  vestaSeat: string
  present: boolean
  allow: string[]
  updatedAt: string | null
  updatedBy: string | null
}

const SCOPE_KEY = { subject: 'seat', ns: 'c2', kind: 'config', id: 'scope' } as const

export function resolveVestaSeat(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const chosen = explicit?.trim() || env['ACP_C2_VESTA_SEAT']?.trim()
  return chosen !== undefined && chosen !== '' ? chosen : PRODUCTION_VESTA
}

export function createC2ScopeClient(): C2ScopeClient {
  return new HrcClient({
    socketPath: resolveControlSocketPath(),
    userAgent: ACP_SERVER_USER_AGENT,
  })
}

export async function readC2Scope(client: C2ScopeClient, vestaSeat: string): Promise<C2ScopeRow> {
  const { annotations } = await client.listSessionAnnotations({
    scopeRef: vestaSeat,
    laneRef: 'main',
    subject: 'seat',
    ns: 'c2',
    kind: 'config',
  })
  const row = annotations.find((candidate) => candidate.id === SCOPE_KEY.id)
  const allow = Array.isArray(row?.body['allow'])
    ? (row.body['allow'] as unknown[]).filter((value): value is string => typeof value === 'string')
    : []
  return {
    vestaSeat,
    present: row !== undefined && Array.isArray(row.body['allow']),
    allow,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  }
}

/** Every pattern must compile; the complete list replaces the row. */
export function validateScopeAllow(allow: readonly string[]): string | undefined {
  for (const pattern of allow) {
    if (pattern.trim() === '') return 'an allow pattern is empty'
    try {
      new RegExp(pattern)
    } catch (error) {
      return `invalid allow pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return undefined
}

export async function writeC2Scope(
  client: C2ScopeClient,
  vestaSeat: string,
  allow: readonly string[]
): Promise<C2ScopeRow> {
  const invalid = validateScopeAllow(allow)
  if (invalid !== undefined) throw new Error(invalid)
  await client.putSessionAnnotation(
    { scopeRef: vestaSeat, laneRef: 'main', ...SCOPE_KEY, body: { v: 1, allow: [...allow] } },
    { principalRef: C2_PHONE_PRINCIPAL }
  )
  return readC2Scope(client, vestaSeat)
}
