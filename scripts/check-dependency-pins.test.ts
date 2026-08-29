import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDependencyPinCheck } from './check-dependency-pins.ts'

const doctorScript = join(import.meta.dir, 'workspace-doctor.ts')

function manifest(content: Record<string, unknown>): string {
  return `${JSON.stringify(content, null, 2)}\n`
}

async function withPinFixture(
  root: Record<string, unknown>,
  member: Record<string, unknown>,
  assertion: (rootDir: string) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), 'dependency-pins-'))
  try {
    await mkdir(join(rootDir, 'packages/member'), { recursive: true })
    await writeFile(join(rootDir, 'package.json'), manifest(root), 'utf8')
    await writeFile(join(rootDir, 'packages/member/package.json'), manifest(member), 'utf8')
    await assertion(rootDir)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
}

describe('check-dependency-pins', () => {
  test('flags floating, ranged, and wrong exact declarations for a governed dependency', async () => {
    for (const specifier of ['latest', '^1.3.0', '1.4.0']) {
      await withPinFixture(
        { overrides: { '@types/bun': '1.3.14' } },
        { devDependencies: { '@types/bun': specifier } },
        async (rootDir) => {
          const report = await runDependencyPinCheck({ rootDir })
          expect(report.diagnostics).toHaveLength(1)
          expect(report.diagnostics[0]).toMatchObject({
            manifest: 'packages/member/package.json',
            dependency: '@types/bun',
            expected: '1.3.14',
            actual: specifier,
          })
        }
      )
    }
  })

  test('accepts an exact declaration matching the root pin', async () => {
    await withPinFixture(
      { overrides: { '@types/bun': '1.3.14' } },
      { devDependencies: { '@types/bun': '1.3.14' } },
      async (rootDir) => {
        expect((await runDependencyPinCheck({ rootDir })).diagnostics).toEqual([])
      }
    )
  })

  test('ignores floating declarations for ungoverned dependencies', async () => {
    await withPinFixture(
      { overrides: { '@types/bun': '1.3.14' } },
      { devDependencies: { marked: 'latest' } },
      async (rootDir) => {
        expect((await runDependencyPinCheck({ rootDir })).diagnostics).toEqual([])
      }
    )
  })

  test('ignores non-exact overrides and peer dependency ranges', async () => {
    await withPinFixture(
      { overrides: { marked: '^1.0.0', '@types/bun': '1.3.14' } },
      {
        devDependencies: { marked: 'latest' },
        peerDependencies: { '@types/bun': '^1.0.0' },
      },
      async (rootDir) => {
        expect((await runDependencyPinCheck({ rootDir })).diagnostics).toEqual([])
      }
    )
  })

  test('governs the root manifest declaration too', async () => {
    await withPinFixture(
      {
        overrides: { '@types/bun': '1.3.14' },
        devDependencies: { '@types/bun': 'latest' },
      },
      {},
      async (rootDir) => {
        const report = await runDependencyPinCheck({ rootDir })
        expect(report.diagnostics).toHaveLength(1)
        expect(report.diagnostics[0]?.manifest).toBe('package.json')
      }
    )
  })
})

type DoctorTree = {
  root: string
  run: (...args: string[]) => { exitCode: number; output: string }
}

async function makeDoctorTree(
  copies: { rel: string; version: string }[],
  overrides: Record<string, string> = { '@types/bun': '1.3.14' }
): Promise<DoctorTree> {
  const root = await mkdtemp(join(tmpdir(), 'workspace-doctor-'))
  await writeFile(join(root, 'package.json'), manifest({ overrides }), 'utf8')

  for (const copy of copies) {
    const dir = join(root, copy.rel)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'package.json'),
      manifest({ name: '@types/bun', version: copy.version }),
      'utf8'
    )
  }

  return {
    root,
    run(...args: string[]) {
      const result = Bun.spawnSync(['bun', doctorScript, '--root', root, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return {
        exitCode: result.exitCode,
        output: `${result.stdout.toString()}${result.stderr.toString()}`,
      }
    },
  }
}

describe('workspace-doctor', () => {
  test('reports and prunes a nested copy that differs from the root resolution', async () => {
    const tree = await makeDoctorTree([
      { rel: 'node_modules/@types/bun', version: '1.3.14' },
      { rel: 'packages/member/node_modules/@types/bun', version: '1.4.0' },
    ])

    try {
      const reported = tree.run('--check')
      expect(reported.exitCode).toBe(1)
      expect(reported.output).toContain('packages/member/node_modules/@types/bun@1.4.0')
      expect(
        await Bun.file(
          join(tree.root, 'packages/member/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()

      const pruned = tree.run()
      expect(pruned.exitCode).toBe(0)
      expect(pruned.output).toContain('pruned 1 stale nested copy')
      expect(
        await Bun.file(
          join(tree.root, 'packages/member/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeFalse()
      expect(
        await Bun.file(join(tree.root, 'node_modules/@types/bun/package.json')).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  test('keeps a nested copy matching the root resolution', async () => {
    const tree = await makeDoctorTree([
      { rel: 'node_modules/@types/bun', version: '1.3.14' },
      { rel: 'packages/member/node_modules/@types/bun', version: '1.3.14' },
    ])

    try {
      expect(tree.run().exitCode).toBe(0)
      expect(
        await Bun.file(
          join(tree.root, 'packages/member/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  test('keeps a nested copy when no root resolution exists', async () => {
    const tree = await makeDoctorTree([
      { rel: 'packages/member/node_modules/@types/bun', version: '1.4.0' },
    ])

    try {
      const result = tree.run()
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('no root resolution to compare against; kept')
      expect(
        await Bun.file(
          join(tree.root, 'packages/member/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })

  test('never touches dependencies without exact root pins', async () => {
    const tree = await makeDoctorTree(
      [
        { rel: 'node_modules/@types/bun', version: '1.3.14' },
        { rel: 'packages/member/node_modules/@types/bun', version: '1.4.0' },
      ],
      { '@types/bun': '^1.3.0' }
    )

    try {
      expect(tree.run().exitCode).toBe(0)
      expect(
        await Bun.file(
          join(tree.root, 'packages/member/node_modules/@types/bun/package.json')
        ).exists()
      ).toBeTrue()
    } finally {
      await rm(tree.root, { recursive: true, force: true })
    }
  })
})
