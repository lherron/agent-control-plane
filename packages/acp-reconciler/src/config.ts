/**
 * Reconciler configuration, read from ACP_RECONCILER_* like every other ACP
 * knob. `ACP_RECONCILER_NODE` is the spec's designated node: when it is unset
 * the host does not construct the reconciler at all. Every other variable has
 * the spec default. Unknown or malformed ACP_RECONCILER_* input is refused at
 * startup rather than silently ignored.
 */
export type ReconcilerConfig = Readonly<{
  /** HRC node id this reconciler instance runs on. */
  node: string
  intervalMs: number
  globalCapacity: number
  agentCapacity: number
  claimWindowMs: number
  /** Service principal for facts, notices and HRC origin. */
  principalRef: string
}>

export const RECONCILER_ENV = {
  node: 'ACP_RECONCILER_NODE',
  intervalMs: 'ACP_RECONCILER_INTERVAL_MS',
  globalCapacity: 'ACP_RECONCILER_GLOBAL_CAPACITY',
  agentCapacity: 'ACP_RECONCILER_AGENT_CAPACITY',
  claimWindowMs: 'ACP_RECONCILER_CLAIM_WINDOW_MS',
  principalRef: 'ACP_RECONCILER_PRINCIPAL',
} as const

export const RECONCILER_DEFAULTS = {
  intervalMs: 45_000,
  globalCapacity: 4,
  agentCapacity: 2,
  claimWindowMs: 600_000,
  principalRef: 'agent:acp-reconciler',
} as const

const MIN_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 60_000
const AGENT_PRINCIPAL = /^agent:[a-z0-9][a-z0-9_-]*$/

export class ReconcilerConfigError extends Error {
  override readonly name = 'ReconcilerConfigError'
}

function positiveInteger(env: Readonly<Record<string, string | undefined>>, name: string) {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return undefined
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new ReconcilerConfigError(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}`
    )
  }
  return Number.parseInt(raw, 10)
}

/** Returns undefined when no designated node is configured. */
export function readReconcilerConfig(
  env: Readonly<Record<string, string | undefined>>
): ReconcilerConfig | undefined {
  const known = new Set<string>(Object.values(RECONCILER_ENV))
  for (const name of Object.keys(env)) {
    if (name.startsWith('ACP_RECONCILER_') && !known.has(name)) {
      throw new ReconcilerConfigError(`unknown reconciler setting ${name}`)
    }
  }
  const node = env[RECONCILER_ENV.node]?.trim()
  if (node === undefined || node === '') {
    for (const name of known) {
      if (name !== RECONCILER_ENV.node && env[name]?.trim()) {
        throw new ReconcilerConfigError(`${name} is set but ${RECONCILER_ENV.node} is not`)
      }
    }
    return undefined
  }

  const intervalMs =
    positiveInteger(env, RECONCILER_ENV.intervalMs) ?? RECONCILER_DEFAULTS.intervalMs
  if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new ReconcilerConfigError(
      `${RECONCILER_ENV.intervalMs} must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`
    )
  }
  const principalRef = env[RECONCILER_ENV.principalRef]?.trim() || RECONCILER_DEFAULTS.principalRef
  if (!AGENT_PRINCIPAL.test(principalRef)) {
    throw new ReconcilerConfigError(`${RECONCILER_ENV.principalRef} must be agent:<id>`)
  }
  return {
    node,
    intervalMs,
    globalCapacity:
      positiveInteger(env, RECONCILER_ENV.globalCapacity) ?? RECONCILER_DEFAULTS.globalCapacity,
    agentCapacity:
      positiveInteger(env, RECONCILER_ENV.agentCapacity) ?? RECONCILER_DEFAULTS.agentCapacity,
    claimWindowMs:
      positiveInteger(env, RECONCILER_ENV.claimWindowMs) ?? RECONCILER_DEFAULTS.claimWindowMs,
    principalRef,
  }
}
