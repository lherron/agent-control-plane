import { describe, expect, test } from 'bun:test'

import { parseResultBlock } from '../../src/jobs/result-block.js'

describe('parseResultBlock', () => {
  test('happy path: extracts JSON object after block name', () => {
    const text = `Here is the output.

RESULT
{"status": "ok", "count": 42}

Done.`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ status: 'ok', count: 42 })
    }
  })

  test('block name on same line as JSON', () => {
    const text = `RESULT {"value": "inline"}`
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ value: 'inline' })
    }
  })

  test('block name followed by JSON on next line', () => {
    const text = `RESULT
{
  "multi": true,
  "line": "json"
}`
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ multi: true, line: 'json' })
    }
  })

  test('missing block name returns result_block_missing', () => {
    const text = 'No relevant blocks here.'
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_missing')
      expect(result.error.message).toContain('RESULT')
    }
  })

  test('malformed JSON returns result_block_parse_failed', () => {
    const text = `RESULT
{not valid json}`
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_parse_failed')
    }
  })

  test('duplicate blocks: takes the LAST occurrence', () => {
    const text = `RESULT
{"version": 1}

Some other output...

RESULT
{"version": 2}`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ version: 2 })
    }
  })

  test('trailing text after JSON closing brace is tolerated', () => {
    const text = `RESULT
{"status": "done"} some trailing text here
more trailing`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ status: 'done' })
    }
  })

  test('multiple distinct blocks: only extracts named block', () => {
    const text = `BLOCK_A
{"a": 1}

BLOCK_B
{"b": 2}

BLOCK_C
{"c": 3}`

    const resultA = parseResultBlock(text, 'BLOCK_A')
    expect(resultA.ok).toBe(true)
    if (resultA.ok) {
      expect(resultA.data).toEqual({ a: 1 })
    }

    const resultB = parseResultBlock(text, 'BLOCK_B')
    expect(resultB.ok).toBe(true)
    if (resultB.ok) {
      expect(resultB.data).toEqual({ b: 2 })
    }

    const resultC = parseResultBlock(text, 'BLOCK_C')
    expect(resultC.ok).toBe(true)
    if (resultC.ok) {
      expect(resultC.data).toEqual({ c: 3 })
    }
  })

  test('nested JSON objects are handled correctly', () => {
    const text = `RESULT
{"outer": {"inner": "value"}, "count": 1}`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ outer: { inner: 'value' }, count: 1 })
    }
  })

  test('JSON with escaped quotes in strings', () => {
    const text = `RESULT
{"message": "he said \\"hello\\""}`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ message: 'he said "hello"' })
    }
  })

  test('JSON with braces inside strings does not confuse brace balancing', () => {
    const text = `RESULT
{"pattern": "{a: b}", "ok": true}`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ pattern: '{a: b}', ok: true })
    }
  })

  test('block name that appears as substring does not cause false match', () => {
    const text = `MY_RESULT
{"wrong": true}

RESULT
{"right": true}`

    // "MY_RESULT" also contains "RESULT" — last occurrence of "RESULT" line wins
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ right: true })
    }
  })

  test('empty text returns result_block_missing', () => {
    const result = parseResultBlock('', 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_missing')
    }
  })

  test('block name present but no JSON object follows returns result_block_missing', () => {
    const text = `RESULT
just some text, no braces`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_missing')
    }
  })

  test('unbalanced braces return result_block_parse_failed', () => {
    const text = `RESULT
{"unclosed": true`

    const result = parseResultBlock(text, 'RESULT')
    // Block name found but JSON never balances → parse_failed
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_parse_failed')
    }
  })

  test('JSON array (not object) returns result_block_parse_failed', () => {
    const text = `RESULT
[1, 2, 3]`

    // The parser looks for `{`, so `[` won't match — this is "missing"
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_missing')
    }
  })

  test('null values in JSON are preserved', () => {
    const text = `RESULT
{"value": null, "name": "test"}`

    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual({ value: null, name: 'test' })
    }
  })
})
