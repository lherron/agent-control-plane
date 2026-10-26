import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

test('launchd recipes preserve host settings and handle lifecycle failures in scratch HOME', () => {
  const result = spawnSync('python3', [join(import.meta.dir, 'launchd-jobs.test.py')], {
    encoding: 'utf8',
  })
  expect(result.status, result.stdout + result.stderr).toBe(0)
}, 30_000)
