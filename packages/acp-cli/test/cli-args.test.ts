import { describe, expect, test } from 'bun:test'

import {
  parseArgs,
  parseCommaList,
  parseIntegerValue,
  parseJsonObject,
  requireStringFlag,
} from '../src/cli-args.js'

describe('cli-args', () => {
  test('parses boolean, string, and multi-string flags', () => {
    const parsed = parseArgs(
      ['--json', '--task', 'T-1', '--role', 'implementer:larry', '--role=tester:curly'],
      {
        booleanFlags: ['--json'],
        stringFlags: ['--task'],
        multiStringFlags: ['--role'],
      }
    )

    expect(parsed.booleanFlags.has('--json')).toBe(true)
    expect(parsed.stringFlags['--task']).toBe('T-1')
    expect(parsed.multiStringFlags['--role']).toEqual(['implementer:larry', 'tester:curly'])
  })

  test('rejects unknown flags', () => {
    expect(() => parseArgs(['--wat'], {})).toThrow('unknown flag: --wat')
  })

  test('parses numeric and JSON values', () => {
    expect(parseIntegerValue('--expected-version', '3', { min: 0 })).toBe(3)
    expect(parseJsonObject('--meta', '{"ok":true}')).toEqual({ ok: true })
  })

  test('requires non-empty comma lists and required string flags', () => {
    expect(() => parseCommaList(' ,, ', '--evidence')).toThrow(
      '--evidence requires at least one value'
    )

    const parsed = parseArgs([], { stringFlags: ['--task'] })
    expect(() => requireStringFlag(parsed, '--task')).toThrow('--task is required')
  })
})
