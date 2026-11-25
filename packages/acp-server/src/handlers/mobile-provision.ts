import { HrcDomainError, HrcErrorCode } from 'hrc-core'
import { readOptionalTrimmedStringField } from '../parsers/body.js'

const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])

export type MobileProvision = { model?: string; reasoning_effort?: string }

/** The per-session model and reasoning-effort override, in HRC's provision shape. */
export function parseMobileProvision(body: Record<string, unknown>): MobileProvision | undefined {
  const model = readOptionalTrimmedStringField(body, 'model')
  const effort = readOptionalTrimmedStringField(body, 'reasoningEffort')
  if (effort !== undefined && !REASONING_EFFORTS.has(effort)) {
    throw new HrcDomainError(
      HrcErrorCode.MALFORMED_REQUEST,
      'reasoningEffort must be low, medium, high or xhigh',
      { field: 'reasoningEffort' }
    )
  }
  if (model === undefined && effort === undefined) return undefined
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
  }
}

/** The requested provision keys HRC's summonDirectives do not carry as asked. */
export function unpreservedProvision(
  requested: MobileProvision,
  applied: { model?: string | undefined; reasoning_effort?: string | undefined } | undefined
): Array<keyof MobileProvision> {
  return (Object.keys(requested) as Array<keyof MobileProvision>).filter(
    (key) => applied?.[key] !== requested[key]
  )
}
