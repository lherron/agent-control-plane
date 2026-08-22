import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'rotate-praesidium-logs.sh')
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'praesidium-log-rotation-'))
  tempDirs.push(dir)
  return dir
}

function archivesFor(path: string): string[] {
  const prefix = `${basename(path)}.`
  return readdirSync(resolve(path, '..'))
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith('.gz'))
    .sort()
}

function rotate(path: string, lock: string, extraArgs: string[] = []) {
  return Bun.spawnSync([
    '/bin/bash',
    script,
    '--max-bytes',
    '32',
    '--keep',
    '7',
    '--lock-file',
    lock,
    ...extraArgs,
    '--',
    path,
  ])
}

describe('rotate-praesidium-logs', () => {
  test('leaves a below-threshold log untouched', () => {
    const dir = makeTempDir()
    const log = join(dir, 'service.log')
    const lock = join(dir, 'rotation.lock')
    writeFileSync(log, 'small\n')
    const before = statSync(log)

    const result = rotate(log, lock)

    expect(result.exitCode).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('small\n')
    expect(statSync(log).ino).toBe(before.ino)
    expect(archivesFor(log)).toEqual([])
  })

  test('archives content, compresses it, and preserves the active inode', () => {
    const dir = makeTempDir()
    const log = join(dir, 'service.err.log')
    const lock = join(dir, 'rotation.lock')
    const content = 'diagnostic line\n'.repeat(8)
    writeFileSync(log, content)
    const inode = statSync(log).ino

    const result = rotate(log, lock)

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe('')
    expect(statSync(log).ino).toBe(inode)
    expect(readFileSync(log, 'utf8')).toBe('')
    const archives = archivesFor(log)
    expect(archives).toHaveLength(1)
    expect(result.stdout.toString()).toContain(`archive=${join(dir, archives[0]!)}`)
    const expanded = Bun.spawnSync(['/usr/bin/gzip', '-dc', join(dir, archives[0]!)])
    expect(expanded.exitCode).toBe(0)
    expect(expanded.stdout.toString()).toBe(content)
  })

  test('retains only the configured number of newest archives', () => {
    const dir = makeTempDir()
    const log = join(dir, 'service.log')
    const lock = join(dir, 'rotation.lock')

    for (let index = 0; index < 4; index += 1) {
      writeFileSync(log, `rotation-${index}\n`.repeat(8))
      const result = rotate(log, lock, ['--keep', '2'])
      expect(result.exitCode).toBe(0)
    }

    expect(archivesFor(log)).toHaveLength(2)
  })

  test('skips contention and recovers after a killed lock holder', async () => {
    const dir = makeTempDir()
    const log = join(dir, 'service.log')
    const lock = join(dir, 'rotation.lock')
    writeFileSync(log, 'held lock\n'.repeat(8))
    const holder = Bun.spawn(['/usr/bin/lockf', '-k', lock, '/bin/sleep', '30'])

    for (let attempt = 0; attempt < 100 && !existsSync(lock); attempt += 1) {
      await Bun.sleep(10)
    }
    const contention = Bun.spawnSync([
      '/usr/bin/lockf',
      '-s',
      '-t',
      '0',
      '-k',
      lock,
      '/usr/bin/true',
    ])
    expect(contention.exitCode).toBe(75)

    const skipped = rotate(log, lock)
    expect(skipped.exitCode).toBe(0)
    expect(readFileSync(log, 'utf8')).not.toBe('')
    expect(archivesFor(log)).toEqual([])

    holder.kill(9)
    await holder.exited
    expect(existsSync(lock)).toBe(true)

    const recovered = rotate(log, lock)
    expect(recovered.exitCode).toBe(0)
    expect(readFileSync(log, 'utf8')).toBe('')
    expect(archivesFor(log)).toHaveLength(1)
  })
})
