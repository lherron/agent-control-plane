import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * True when this checkout's producer packages are symlinks to sibling repo
 * source rather than installed registry tarballs.
 *
 * The praesidium dev workspace links agent-spaces, hrc-runtime and
 * agent-control-plane together so a cross-repo edit needs no publish. Source-linked
 * packages carry their repo's own version and no `praesidiumBuild` stamp, so the
 * deployment-coherence readback correctly reports them as not a certifiable tuple —
 * that refusal is the safety property, not a defect, and it is why assertions about
 * a coherent INSTALLED tuple cannot hold here. Such assertions stay live for
 * standalone installs, which is what CI and every fleet node actually run.
 */
export function isSourceLinkedCheckout(): boolean {
  const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..')
  for (let directory = repoRoot; ; directory = dirname(directory)) {
    try {
      if (lstatSync(join(directory, 'node_modules', 'hrc-core')).isSymbolicLink()) return true
    } catch {
      // Not installed at this level; keep walking toward the workspace root.
    }
    if (dirname(directory) === directory) return false
  }
}
