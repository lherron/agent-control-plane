import { describe, expect, test } from 'bun:test'

import {
  HRC_EXTERNAL_REF_PREFIX,
  formatHrcExternalRef,
  isHrcExternalRef,
  parseHrcExternalRef,
} from '../index.js'

// Required test 1 — Shared parser/formatter contract test.
//
// Contract C-0009: the formatter for HRC launches emits prefixed wrkf refs;
// the parser for HRC calls accepts the prefixed wrkf ref and returns the bare
// id. wrkf never stores bare ids for HRC launches, and HRC never receives
// prefixed ids.
describe('hrc-external-ref shared parser/formatter contract', () => {
  test('HRC launch formatting produces hrc:<id> for wrkf (never stores bare)', () => {
    const formatted = formatHrcExternalRef('run-abc')

    expect(formatted).toBe('hrc:run-abc')
    // wrkf stores the prefixed form...
    expect(formatted.startsWith(HRC_EXTERNAL_REF_PREFIX)).toBe(true)
    // ...and never the bare id for an HRC launch.
    expect(formatted).not.toBe('run-abc')
  })

  test('HRC lookup parsing passes the BARE id to HRC (never prefixed)', () => {
    const bare = parseHrcExternalRef('hrc:run-abc')

    expect(bare).toBe('run-abc')
    // HRC's getRun/listRuns must never receive the hrc: prefix.
    expect(bare.startsWith(HRC_EXTERNAL_REF_PREFIX)).toBe(false)
  })

  test('round-trips parse(format(id)) === id', () => {
    for (const id of ['run-abc', 'run-123', 'r', 'a-b-c-0001']) {
      expect(parseHrcExternalRef(formatHrcExternalRef(id))).toBe(id)
    }
  })

  test('trims surrounding whitespace on both directions', () => {
    expect(formatHrcExternalRef('  run-xyz  ')).toBe('hrc:run-xyz')
    expect(parseHrcExternalRef('  hrc:run-xyz  ')).toBe('run-xyz')
  })

  test('format rejects already-prefixed input (caller bug)', () => {
    expect(() => formatHrcExternalRef('hrc:run-abc')).toThrow()
  })

  test('format rejects empty / whitespace-only input', () => {
    expect(() => formatHrcExternalRef('')).toThrow()
    expect(() => formatHrcExternalRef('   ')).toThrow()
  })

  test('parse rejects non-hrc scheme input', () => {
    expect(() => parseHrcExternalRef('webhook:abc')).toThrow()
    expect(() => parseHrcExternalRef('run-abc')).toThrow()
  })

  test('parse rejects an hrc: ref with an empty bare remainder', () => {
    expect(() => parseHrcExternalRef('hrc:')).toThrow()
    expect(() => parseHrcExternalRef('hrc:   ')).toThrow()
  })
})

// Required test 2 — External-ref compatibility test.
//
// Non-HRC schemes remain valid for generic wrkf bindings (the module does not
// claim or transform them). HRC adapters require hrc: formatting before wrkf
// storage and pass only the bare runId to HRC.
describe('hrc-external-ref external-ref compatibility', () => {
  test('non-HRC schemes are not claimed/transformed by the module', () => {
    expect(isHrcExternalRef('webhook:abc')).toBe(false)
    expect(isHrcExternalRef('s3:bucket/key')).toBe(false)
    // bare ids with no scheme are likewise not HRC refs
    expect(isHrcExternalRef('x')).toBe(false)
  })

  test('recognizes the hrc: scheme', () => {
    expect(isHrcExternalRef('hrc:x')).toBe(true)
    expect(isHrcExternalRef('hrc:run-abc')).toBe(true)
  })

  test('HRC adapters: format prefixes for wrkf storage, parse yields bare for HRC', () => {
    // Before wrkf storage: HRC launches MUST be prefixed.
    const stored = formatHrcExternalRef('run-abc')
    expect(isHrcExternalRef(stored)).toBe(true)
    expect(stored).toBe('hrc:run-abc')

    // Toward HRC: only the bare runId is passed.
    const toHrc = parseHrcExternalRef(stored)
    expect(toHrc).toBe('run-abc')
    expect(isHrcExternalRef(toHrc)).toBe(false)
  })
})
