import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { type CliEntry, buildCliSurface, renderSurfaceBlock } from './check-cli-surface.ts'

const roots: string[] = []
const script = join(import.meta.dir, 'check-cli-surface.ts')

function check(root: string) {
  return Bun.spawnSync([process.execPath, script, '--root', root], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch checkout whose acp-cli README documents `entries` in the generated block. */
function rootDocumenting(entries: CliEntry[]): string {
  const root = mkdtempSync(join(tmpdir(), 'acp-cli-surface-'))
  roots.push(root)
  mkdirSync(join(root, 'packages/acp-cli'), { recursive: true })
  writeFileSync(
    join(root, 'packages/acp-cli/README.md'),
    `# acp\n\n${renderSurfaceBlock(entries)}\n`
  )
  return root
}

const live = buildCliSurface()
const flagged = live.find((entry) => entry.flags.length > 0)
if (flagged === undefined) throw new Error('live acp CLI surface declares no flags')
const leaf = live[live.length - 1] as CliEntry

describe('check-cli-surface over a README in a scratch --root', () => {
  test('a README generated from the live Commander surface has no findings', async () => {
    const result = check(rootDocumenting(live))
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(result.stdout.toString()).toContain('matches Commander')
  })

  test.each([
    {
      kind: 'documented-command-absent',
      token: 'acp task removed',
      documented: () => [...live, { path: 'acp task removed', flags: [] }],
    },
    {
      kind: 'present-command-undocumented',
      token: leaf.path,
      documented: () => live.filter((entry) => entry !== leaf),
    },
    {
      kind: 'documented-flag-absent',
      token: `${flagged.path} --gone`,
      documented: () =>
        live.map((entry) =>
          entry === flagged ? { ...entry, flags: [...entry.flags, '--gone'] } : entry
        ),
    },
    {
      kind: 'present-flag-undocumented',
      token: `${flagged.path} ${flagged.flags[0]}`,
      documented: () =>
        live.map((entry) =>
          entry === flagged ? { ...entry, flags: entry.flags.slice(1) } : entry
        ),
    },
  ])('README drift $kind is reported naming the drifted token', ({ kind, token, documented }) => {
    const result = check(rootDocumenting(documented()))
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain(`[${kind}]`)
    expect(result.stderr.toString()).toContain(`token: ${token}`)
  })
})
