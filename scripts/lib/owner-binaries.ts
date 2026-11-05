import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const justfile = fileURLToPath(new URL('../../justfile', import.meta.url))
const paths = new Map<string, string>()

// Share the fixed justfile declarations with direct script/test invocations.
export function ownerBinary(name: string): string {
  if (!['hrc', 'wrkq', 'wrkc', 'wrkf'].includes(name)) return name
  let path = paths.get(name)
  if (path === undefined) {
    path = execFileSync(
      'just',
      ['--justfile', justfile, '--evaluate', `${name.toUpperCase()}_BIN`],
      {
        encoding: 'utf8',
      }
    ).trim()
    paths.set(name, path)
  }
  return path
}
