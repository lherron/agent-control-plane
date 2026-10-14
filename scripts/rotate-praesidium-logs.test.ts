import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
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

function logLines(output: Uint8Array | Buffer) {
  return output
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const record = JSON.parse(line) as {
        ts: string
        level: string
        component: string
        event: string
        data: Record<string, unknown>
      }
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(record.component).toBe('log-rotation')
      return record
    })
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
    expect(logLines(result.stdout)).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'rotation.rotated',
        data: expect.objectContaining({ path: log, archive: join(dir, archives[0]!), inode }),
      }),
    ])
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

  describe('default set', () => {
    function seed(path: string): void {
      mkdirSync(resolve(path, '..'), { recursive: true })
      writeFileSync(path, 'line\n'.repeat(16))
    }

    function rotateDefault(env: Record<string, string>) {
      return Bun.spawnSync(['/bin/bash', script, '--max-bytes', '1', '--keep', '7'], {
        env: { PATH: '/usr/bin:/bin', ...env },
      })
    }

    test('rotates every project directory one level deep plus root, never _archive', () => {
      const root = makeTempDir()
      const lock = join(root, 'rotation.lock')
      const rotated = [
        join(root, 'agent-control-plane', 'acp-server.log'),
        join(root, 'agent-control-plane', 'acp-server.err.log'),
        join(root, 'hrc-runtime', 'hrc-server.log'),
        join(root, 'hrc-server.log'),
      ]
      const untouched = [
        join(root, '_archive', 'deploy-old.log'),
        join(root, '_archive', 'control-plane', 'old.log'),
        join(root, 'agent-control-plane', 'nested', 'deep.log'),
        join(root, 'agent-control-plane', 'notes.txt'),
      ]
      for (const path of [...rotated, ...untouched]) seed(path)

      const result = rotateDefault({
        PRAESIDIUM_LOG_ROTATION_ROOT: root,
        PRAESIDIUM_LOG_ROTATION_LOCK_FILE: lock,
      })

      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      for (const path of rotated) {
        expect(readFileSync(path, 'utf8')).toBe('')
        // *.err.log also matches *.log; each file must rotate exactly once.
        expect(archivesFor(path)).toHaveLength(1)
      }
      for (const path of untouched) {
        expect(readFileSync(path, 'utf8')).not.toBe('')
        expect(archivesFor(path)).toEqual([])
      }
      const [scan, ...rotations] = logLines(result.stdout)
      expect(scan).toMatchObject({
        level: 'info',
        event: 'rotation.scan',
        data: { root, count: rotated.length },
      })
      expect([...(scan!.data['logs'] as string[])].sort()).toEqual([...rotated].sort())
      expect(rotations.map((r) => r.event)).toEqual(rotated.map(() => 'rotation.rotated'))
      expect(result.stdout.toString()).not.toContain('_archive')
    })

    test('defaults the log root and lock file under $HOME', () => {
      const home = makeTempDir()
      const log = join(home, 'praesidium', 'var', 'logs', 'taskboard', 'taskboard-server.log')
      seed(log)

      const result = rotateDefault({ HOME: home })

      expect(result.stderr.toString()).toBe('')
      expect(result.exitCode).toBe(0)
      expect(readFileSync(log, 'utf8')).toBe('')
      expect(archivesFor(log)).toHaveLength(1)
      expect(
        existsSync(join(home, 'praesidium', 'var', 'run', 'praesidium-log-rotation.lock'))
      ).toBe(true)
    })

    test('an empty log root is a no-op', () => {
      const root = makeTempDir()
      const result = rotateDefault({
        PRAESIDIUM_LOG_ROTATION_ROOT: root,
        PRAESIDIUM_LOG_ROTATION_LOCK_FILE: join(root, 'rotation.lock'),
      })

      expect(result.exitCode).toBe(0)
      expect(logLines(result.stdout)).toEqual([
        expect.objectContaining({
          level: 'info',
          event: 'rotation.scan',
          data: { root, count: 0, logs: [] },
        }),
      ])
    })
  })
})
