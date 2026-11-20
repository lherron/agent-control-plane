/**
 * Per-op deadlines from `registry.discover` (IOS_PLUGIN_PAGES.md §2, cardo T-14122).
 * The CLI's deadline is the op's declared `timeout` plus 10 s for a `holds: true` op,
 * `batch_seconds_max` plus 10 s for a batch, and the default otherwise. ACP's backstop
 * is that deadline plus a grace. The catalog refreshes the cache on every read; a call
 * on a mount nobody has discovered yet discovers it first.
 */
import { cardoRequest } from './cardo.js'
import type { ResolvedPluginPagesOptions } from './options.js'

export type OpDeclaration = { holds: boolean; timeout: number | null }
export type MountDiscovery = { ops: Map<string, OpDeclaration>; batchSecondsMax: number | null }

const HOLD_GRACE_SECONDS = 10
const cache = new Map<string, MountDiscovery>()

function parse(line: string): MountDiscovery | undefined {
  try {
    const reply = JSON.parse(line) as {
      ok?: unknown
      result?: { operations?: unknown; batch_seconds_max?: unknown }
    }
    if (reply.ok !== true || !Array.isArray(reply.result?.operations)) return undefined
    const ops = new Map<string, OpDeclaration>()
    for (const op of reply.result.operations as Record<string, unknown>[]) {
      if (typeof op['name'] !== 'string') continue
      ops.set(op['name'], {
        holds: op['holds'] === true,
        timeout: typeof op['timeout'] === 'number' ? op['timeout'] : null,
      })
    }
    const batch = reply.result.batch_seconds_max
    return { ops, batchSecondsMax: typeof batch === 'number' ? batch : null }
  } catch {
    return undefined
  }
}

/** The CLI's own deadline for `op`, in seconds. */
export function cliDeadlineSeconds(
  options: ResolvedPluginPagesOptions,
  discovery: MountDiscovery | undefined,
  op: string
): number {
  const declared = discovery?.ops.get(op)
  if (declared?.holds === true && declared.timeout !== null) {
    return declared.timeout + HOLD_GRACE_SECONDS
  }
  if (op === 'graph.batch' && discovery?.batchSecondsMax != null) {
    return discovery.batchSecondsMax + HOLD_GRACE_SECONDS
  }
  return options.defaultDeadlineSeconds
}

export function backstopMs(options: ResolvedPluginPagesOptions, cliSeconds: number): number {
  return cliSeconds * 1000 + options.backstopGraceMs
}

/** Fresh discovery of `mount`, or `undefined` when it has no live kernel or refused. */
export async function discoverMount(
  options: ResolvedPluginPagesOptions,
  mount: string
): Promise<MountDiscovery | undefined> {
  const outcome = await cardoRequest({
    bin: options.cardoBin,
    address: { mount },
    request: { op: 'registry.discover', args: {} },
    backstopMs: backstopMs(options, options.defaultDeadlineSeconds),
  })
  const discovery = outcome.kind === 'reply' ? parse(outcome.line) : undefined
  if (discovery === undefined) cache.delete(`${options.cardoBin}\0${mount}`)
  else cache.set(`${options.cardoBin}\0${mount}`, discovery)
  return discovery
}

export async function cachedDiscovery(
  options: ResolvedPluginPagesOptions,
  mount: string
): Promise<MountDiscovery | undefined> {
  return cache.get(`${options.cardoBin}\0${mount}`) ?? (await discoverMount(options, mount))
}
