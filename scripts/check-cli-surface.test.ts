import { describe, expect, test } from 'bun:test'

import {
  type CliEntry,
  collectFindings,
  compareSurfaces,
  parseDocumentedSurface,
  renderSurfaceBlock,
} from './check-cli-surface.ts'

const actual: CliEntry[] = [
  { path: 'acp', flags: ['--json', '--server'] },
  { path: 'acp task', flags: [] },
  { path: 'acp task show', flags: ['--json', '--task'] },
]

describe('check-cli-surface', () => {
  test('the live acp README surface is conformant', async () => {
    expect(await collectFindings()).toHaveLength(0)
  })

  test('parses the generated README inventory block', () => {
    const readme = renderSurfaceBlock(actual)
    expect(parseDocumentedSurface('README.md', readme)).toEqual(actual)
  })

  test('fires on documented-but-absent command drift', () => {
    const documented = [...actual, { path: 'acp task removed', flags: [] }]
    const findings = compareSurfaces(actual, documented, 'test')
    expect(findings.map((finding) => finding.kind)).toContain('documented-command-absent')
  })

  test('fires on present-but-undocumented command drift', () => {
    const documented = actual.filter((entry) => entry.path !== 'acp task show')
    const findings = compareSurfaces(actual, documented, 'test')
    expect(findings.map((finding) => finding.kind)).toContain('present-command-undocumented')
  })

  test('fires on documented-but-absent flag drift', () => {
    const documented = actual.map((entry) =>
      entry.path === 'acp task show' ? { ...entry, flags: [...entry.flags, '--gone'] } : entry
    )
    const findings = compareSurfaces(actual, documented, 'test')
    expect(findings.map((finding) => finding.kind)).toContain('documented-flag-absent')
  })

  test('fires on present-but-undocumented flag drift', () => {
    const documented = actual.map((entry) =>
      entry.path === 'acp task show'
        ? { ...entry, flags: entry.flags.filter((flag) => flag !== '--task') }
        : entry
    )
    const findings = compareSurfaces(actual, documented, 'test')
    expect(findings.map((finding) => finding.kind)).toContain('present-flag-undocumented')
  })
})
