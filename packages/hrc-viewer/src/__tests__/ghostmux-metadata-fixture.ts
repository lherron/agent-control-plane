/**
 * A metadata-modeling fake ghostmux (T-05237). Tracks live surfaces with both
 * surface-level and window-level metadata so the topology the code derives FROM
 * metadata (its only authority) is observable. `new`/`new-pane` allocate ids;
 * `kill-surface` removes them; `metadata set/get` round-trips per scope.
 */
export function makeFakeGhostmux(missingSurface: 'error' | 'empty') {
  type Surf = {
    surfaceMeta: Record<string, unknown>
    windowMeta: Record<string, unknown>
    title?: string | undefined
    columns: number
    rows: number
  }
  const surfaces = new Map<string, Surf>()
  const calls: string[][] = []
  let counter = 0
  const alloc = (title?: string | undefined): string => {
    counter += 1
    const id = `surf-${counter}`
    surfaces.set(id, { surfaceMeta: {}, windowMeta: {}, title, columns: 120, rows: 40 })
    return id
  }
  const runner = async (args: string[]) => {
    calls.push(args)
    const key = args.join(' ')
    // Pinned to a PRE-windows-API build (T-07121): this suite is the legacy
    // anchor-path regression, and the capability probe must fail closed onto it.
    if (args[0] === 'list-windows') {
      throw new Error('server does not support the windows API; update ScriptableGhostty')
    }
    if (key === 'list-surfaces --json') {
      return {
        stdout: JSON.stringify({
          terminals: [...surfaces.entries()].map(([id, s]) => ({
            id,
            title: s.title,
            columns: s.columns,
            rows: s.rows,
          })),
        }),
        stderr: '',
      }
    }
    if (args[0] === 'metadata' && args[1] === 'get') {
      const s = surfaces.get(args[3] ?? '')
      // Model the REAL binary (T-08115): a target ghostmux cannot resolve is an
      // exit-1 error, not empty metadata. A fake that answered `{}` here made
      // "the pane is gone" indistinguishable from "the pane is not ours".
      if (s === undefined && missingSurface === 'error') {
        throw new Error(`error: can't find terminal: ${args[3] ?? ''}`)
      }
      const meta = args.includes('--window') ? s?.windowMeta : s?.surfaceMeta
      return { stdout: JSON.stringify({ data: meta ?? {} }), stderr: '' }
    }
    if (args[0] === 'metadata' && args[1] === 'set') {
      const s = surfaces.get(args[3] ?? '')
      if (s) {
        const payload = JSON.parse(args[4] ?? '{}') as Record<string, unknown>
        if (args.includes('--window')) s.windowMeta = { ...s.windowMeta, ...payload }
        else s.surfaceMeta = { ...s.surfaceMeta, ...payload }
      }
      return { stdout: '{}', stderr: '' }
    }
    if (args[0] === 'new') {
      const titleIdx = args.indexOf('--title')
      return {
        stdout: JSON.stringify({ id: alloc(titleIdx >= 0 ? args[titleIdx + 1] : undefined) }),
        stderr: '',
      }
    }
    if (args[0] === 'new-pane') {
      return { stdout: JSON.stringify({ id: alloc() }), stderr: '' }
    }
    if (args[0] === 'set-title') {
      const s = surfaces.get(args[2] ?? '')
      if (s) s.title = args[3]
      return { stdout: '{}', stderr: '' }
    }
    if (args[0] === 'kill-surface') {
      surfaces.delete(args[2] ?? '')
      return { stdout: '{}', stderr: '' }
    }
    return { stdout: '{}', stderr: '' }
  }
  const surfaceMeta = (id: string) => surfaces.get(id)?.surfaceMeta
  const liveIds = () => [...surfaces.keys()]
  const agentPanes = () =>
    [...surfaces.entries()].filter(([, s]) => s.surfaceMeta['hrc_role'] === 'headless-agent-pane')
  const anchors = () =>
    [...surfaces.entries()].filter(
      ([, s]) => s.surfaceMeta['hrc_role'] === 'headless-window-anchor'
    )
  return { runner, calls, surfaces, surfaceMeta, liveIds, agentPanes, anchors }
}
