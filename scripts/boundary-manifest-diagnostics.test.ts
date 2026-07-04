import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { renderBoundaryDiagnostics, runBoundaryCheck } from './check-boundaries'
import { renderManifestDiagnostics, runManifestEdgeCheck } from './check-manifest-edges'

const tmpRoots: string[] = []

function tmpRoot(): string {
  const root = join(tmpdir(), `acp-check-diagnostics-${crypto.randomUUID()}`)
  mkdirSync(root, { recursive: true })
  tmpRoots.push(root)
  return root
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('boundary and manifest diagnostics', () => {
  test('boundary check explains planted forbidden imports', async () => {
    const root = tmpRoot()
    writeText(
      join(root, 'packages/acp-server/src/bad.ts'),
      "import type { InternalRuntime } from 'hrc-server/src/runtime'\nexport type Bad = InternalRuntime\n"
    )

    const rendered = renderBoundaryDiagnostics(await runBoundaryCheck({ rootDir: root }))

    expect(rendered.exitCode).toBe(1)
    expect(rendered.stderr).toContain('What failed:')
    expect(rendered.stderr).toContain('Why it matters:')
    expect(rendered.stderr).toContain('How to fix:')
    expect(rendered.stderr).toContain('Exception path:')
    expect(rendered.stderr).toContain(
      "packages/acp-server/src/bad.ts: forbidden 'hrc-server/src/runtime'"
    )
  })

  test('manifest check explains planted missing workspace dependencies', async () => {
    const root = tmpRoot()
    writeText(
      join(root, 'packages/importer/package.json'),
      JSON.stringify({ name: '@acp/importer', version: '0.0.0' })
    )
    writeText(
      join(root, 'packages/dependency/package.json'),
      JSON.stringify({ name: '@acp/dependency', version: '0.0.0' })
    )
    writeText(
      join(root, 'packages/importer/src/index.ts'),
      "import { value } from '@acp/dependency'\nexport const imported = value\n"
    )

    const rendered = renderManifestDiagnostics(await runManifestEdgeCheck({ rootDir: root }))

    expect(rendered.exitCode).toBe(1)
    expect(rendered.stderr).toContain('What failed:')
    expect(rendered.stderr).toContain('Why it matters:')
    expect(rendered.stderr).toContain('How to fix:')
    expect(rendered.stderr).toContain('Exception path:')
    expect(rendered.stderr).toContain("missing dependency '@acp/dependency'")
    expect(rendered.stderr).toContain('packages/importer/src/index.ts')
  })
})
