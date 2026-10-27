import { describe, expect, test } from 'bun:test'

import { parseResultBlock } from '../../src/jobs/result-block.js'

describe('parseResultBlock', () => {
  test('extracts the JSON object after the block name across layouts and string contents', () => {
    const cases: Array<{ layout: string; text: string; data: Record<string, unknown> }> = [
      {
        layout: 'object on the line after the name',
        text: 'Here is the output.\n\nRESULT\n{"status": "ok", "count": 42}\n\nDone.',
        data: { status: 'ok', count: 42 },
      },
      {
        layout: 'object on the same line as the name',
        text: 'RESULT {"value": "inline"}',
        data: { value: 'inline' },
      },
      {
        layout: 'multi-line object',
        text: 'RESULT\n{\n  "multi": true,\n  "line": "json"\n}',
        data: { multi: true, line: 'json' },
      },
      {
        layout: 'trailing text after the closing brace',
        text: 'RESULT\n{"status": "done"} some trailing text here\nmore trailing',
        data: { status: 'done' },
      },
      {
        layout: 'nested objects',
        text: 'RESULT\n{"outer": {"inner": "value"}, "count": 1}',
        data: { outer: { inner: 'value' }, count: 1 },
      },
      {
        layout: 'escaped quotes in strings',
        text: 'RESULT\n{"message": "he said \\"hello\\""}',
        data: { message: 'he said "hello"' },
      },
      {
        layout: 'braces inside strings',
        text: 'RESULT\n{"pattern": "{a: b}", "ok": true}',
        data: { pattern: '{a: b}', ok: true },
      },
      {
        layout: 'null values',
        text: 'RESULT\n{"value": null, "name": "test"}',
        data: { value: null, name: 'test' },
      },
    ]

    for (const { layout, text, data } of cases) {
      expect({ layout, result: parseResultBlock(text, 'RESULT') }).toEqual({
        layout,
        result: { ok: true, data },
      })
    }
  })

  test('no block name, empty text, a name with no object after it, or a JSON array reads as result_block_missing naming the block', () => {
    const texts = [
      'No relevant blocks here.',
      '',
      'RESULT\njust some text, no braces',
      // The parser looks for `{`, so `[` never matches: this is "missing", not parse_failed.
      'RESULT\n[1, 2, 3]',
    ]

    for (const text of texts) {
      expect({ text, result: parseResultBlock(text, 'RESULT') }).toEqual({
        text,
        result: {
          ok: false,
          error: {
            code: 'result_block_missing',
            message: 'result block "RESULT" not found in assistant output',
          },
        },
      })
    }
  })

  test('malformed JSON inside the block returns result_block_parse_failed naming malformed JSON', () => {
    const text = `RESULT
{not valid json}`
    const result = parseResultBlock(text, 'RESULT')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_parse_failed')
      expect(result.error.message).toContain('malformed JSON')
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

  test('unbalanced braces return result_block_parse_failed naming the missing balanced object', () => {
    const text = `RESULT
{"unclosed": true`

    const result = parseResultBlock(text, 'RESULT')
    // Block name found but JSON never balances → parse_failed
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('result_block_parse_failed')
      expect(result.error.message).toContain('no balanced JSON object')
    }
  })
})
