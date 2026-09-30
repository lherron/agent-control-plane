import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { findTaskIds, isTaskId, parseTaskId, taskOwnerId } from '../index.js'
import fixtures from './fixtures/task-id-grammar.json'

// Verbatim copy of hrc-core/fixtures/task-id-grammar.json (hrc-runtime
// 306bc036, T-09894). hrc-core is the reference; this repo mirrors it.
const HRC_CORE_FIXTURE = join(
  homedir(),
  'praesidium/hrc-runtime/packages/hrc-core/fixtures/task-id-grammar.json'
)

describe('task-id grammar (shared hrc-core fixtures)', () => {
  test.skipIf(!existsSync(HRC_CORE_FIXTURE))('fixture copy matches hrc-core', () => {
    const local = readFileSync(join(import.meta.dir, 'fixtures/task-id-grammar.json'), 'utf8')
    expect(local).toBe(readFileSync(HRC_CORE_FIXTURE, 'utf8'))
  })

  for (const valid of fixtures.valid) {
    test(`accepts ${valid.id}`, () => {
      const { $comment: _, ...expected } = valid as typeof valid & { $comment?: string }
      expect(parseTaskId(valid.id)).toEqual(expected)
      expect(taskOwnerId(valid.id)).toBe(valid.ownerId)
      expect(isTaskId(valid.id)).toBe(true)
    })
  }

  for (const invalid of fixtures.invalid) {
    test(`refuses ${JSON.stringify(invalid)}`, () => {
      expect(parseTaskId(invalid)).toBeUndefined()
      expect(isTaskId(invalid)).toBe(false)
    })
  }

  for (const prose of fixtures.prose) {
    test(`prose ${JSON.stringify(prose.text)}`, () => {
      expect(findTaskIds(prose.text)).toEqual(prose.ids)
    })
  }
})
