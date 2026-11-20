/**
 * The relay's allowlist (IOS_PLUGIN_PAGES.md §1, §2). ACP is the only enforcer: the
 * phone does not re-check, and the Mac host ignores `mounts`. The mount is the front of
 * every address, `<mount>[@<owner>][:<graph>]`, so `jobhunt:hunt` matches `jobhunt`.
 */
import type { CardoAddress } from './cardo.js'
import type { PageMounts } from './manifest.js'

const ADDRESS =
  /^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:@([A-Za-z0-9][A-Za-z0-9_.-]*))?(?::([A-Za-z0-9][A-Za-z0-9_.-]*))?$/

/** Loggia's per-host UI trees: never addressable from a page. */
const NEVER_ADDRESSABLE = new Set(['ui', 'cardo-ui'])

/** Allowed on every mount a page names; `op` names beyond these need the page's `ops`. */
const ALWAYS_ALLOWED = new Set(['graph.query', 'query.subscribe', 'registry.discover'])

export function parseAddress(raw: unknown): CardoAddress | undefined {
  if (typeof raw !== 'string') return undefined
  const match = ADDRESS.exec(raw)
  if (match === null) return undefined
  return {
    mount: match[1] as string,
    ...(match[2] !== undefined ? { owner: match[2] } : {}),
    ...(match[3] !== undefined ? { graph: match[3] } : {}),
  }
}

export type AllowlistRefusal = 'mount_not_allowed' | 'op_not_allowed'

export function mountRefusal(mounts: PageMounts, mount: string): AllowlistRefusal | undefined {
  return NEVER_ADDRESSABLE.has(mount) || !Object.hasOwn(mounts, mount)
    ? 'mount_not_allowed'
    : undefined
}

export function opRefusal(
  mounts: PageMounts,
  mount: string,
  op: string
): AllowlistRefusal | undefined {
  return (
    mountRefusal(mounts, mount) ??
    (ALWAYS_ALLOWED.has(op) || (mounts[mount]?.ops ?? []).includes(op)
      ? undefined
      : 'op_not_allowed')
  )
}
