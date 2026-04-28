/**
 * Result-block parser and step expectation evaluator for JobFlow.
 *
 * PARSING RULES (locked — do not change without updating tests):
 *
 *   1. Block format:  a line containing the block name (case-sensitive), followed
 *      by a JSON object on the same or subsequent lines.  The JSON object is NOT
 *      fenced (no triple-backtick code blocks).
 *
 *   2. Duplicate blocks:  when the same block name appears more than once, the
 *      LAST occurrence wins.
 *
 *   3. Trailing text after the JSON object's closing brace is tolerated — parsing
 *      extends to the first balanced `}` that closes the opening `{`.
 *
 *   4. Malformed JSON inside the block:  returns error code
 *      `result_block_parse_failed`.
 *
 *   5. Block name not present in text:  returns error code
 *      `result_block_missing`.
 *
 * STABLE ERROR CODES (per JOB_FLOW_IMPL.md):
 *   - run_outcome_mismatch
 *   - result_block_missing
 *   - result_block_parse_failed
 *   - required_result_field_missing
 *   - result_field_mismatch
 */

import type { StepExpectation } from 'acp-core'

// ---------------------------------------------------------------------------
// Result-block parser
// ---------------------------------------------------------------------------

export type ParsedResultBlock =
  | { ok: true; data: Readonly<Record<string, unknown>> }
  | { ok: false; error: { code: ResultBlockErrorCode; message: string } }

export type ResultBlockErrorCode = 'result_block_missing' | 'result_block_parse_failed'

/**
 * Parse a named result block from assistant text.
 *
 * Scans `text` for lines containing `blockName`.  For each match, attempts to
 * extract a JSON object starting from the first `{` on or after the name line.
 * When multiple matches exist the last one wins.
 */
export function parseResultBlock(text: string, blockName: string): ParsedResultBlock {
  // Find all occurrences of the block name in the text
  const lines = text.split('\n')
  let lastJsonStart = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line?.includes(blockName)) {
      // Look for the opening brace on this line or subsequent lines
      const braceIndex = findOpeningBrace(lines, i)
      if (braceIndex !== -1) {
        lastJsonStart = braceIndex
      }
    }
  }

  if (lastJsonStart === -1) {
    return {
      ok: false,
      error: {
        code: 'result_block_missing',
        message: `result block "${blockName}" not found in assistant output`,
      },
    }
  }

  // Extract JSON from the text starting at lastJsonStart (character offset in joined text)
  const fullText = lines.join('\n')
  const jsonStr = extractBalancedJson(fullText, lastJsonStart)

  if (jsonStr === undefined) {
    return {
      ok: false,
      error: {
        code: 'result_block_parse_failed',
        message: `result block "${blockName}" has no balanced JSON object`,
      },
    }
  }

  try {
    const parsed: unknown = JSON.parse(jsonStr)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        error: {
          code: 'result_block_parse_failed',
          message: `result block "${blockName}" parsed to a non-object value`,
        },
      }
    }
    return { ok: true, data: parsed as Readonly<Record<string, unknown>> }
  } catch {
    return {
      ok: false,
      error: {
        code: 'result_block_parse_failed',
        message: `result block "${blockName}" contains malformed JSON`,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// Expectation evaluator
// ---------------------------------------------------------------------------

export type RunOutcome = 'succeeded' | 'failed' | 'cancelled'

export type EvaluationResult = {
  ok: boolean
  error?: { code: string; message: string } | undefined
  result?: Readonly<Record<string, unknown>> | undefined
}

/**
 * Map an ACP Run.status to the outcome enum used by expectations.
 *
 *   completed → succeeded
 *   failed    → failed
 *   cancelled → cancelled
 */
export function mapRunStatusToOutcome(status: 'completed' | 'failed' | 'cancelled'): RunOutcome {
  if (status === 'completed') return 'succeeded'
  return status
}

/**
 * Evaluate step expectations against a run outcome and (optionally) parsed
 * result data.
 *
 *   1. Check `expect.outcome` (default `'succeeded'`) against `runOutcome`.
 *   2. When `expect.resultBlock` is set, `parsedResult` must be provided and
 *      its fields are checked against `expect.require` and `expect.equals`.
 *   3. `require`: each listed field must exist as a top-level key.
 *   4. `equals`: each listed key must match by strict scalar equality
 *      (string / number / boolean / null).
 */
export function evaluateExpectation(
  runOutcome: RunOutcome,
  parsedResult: ParsedResultBlock | undefined,
  expectation: StepExpectation
): EvaluationResult {
  // --- 1. Outcome check ---
  const expectedOutcome = expectation.outcome ?? 'succeeded'
  if (runOutcome !== expectedOutcome) {
    return {
      ok: false,
      error: {
        code: 'run_outcome_mismatch',
        message: `expected outcome "${expectedOutcome}", got "${runOutcome}"`,
      },
    }
  }

  // --- 2. Result block required? ---
  if (expectation.resultBlock === undefined) {
    return { ok: true }
  }

  // parsedResult must have been provided when resultBlock is expected
  if (parsedResult === undefined) {
    return {
      ok: false,
      error: {
        code: 'result_block_missing',
        message: `expected result block "${expectation.resultBlock}" but no result was parsed`,
      },
    }
  }

  // If parsing failed, bubble the error
  if (!parsedResult.ok) {
    return {
      ok: false,
      error: parsedResult.error,
    }
  }

  const data = parsedResult.data

  // --- 3. require: top-level fields must exist ---
  if (expectation.require !== undefined) {
    for (const field of expectation.require) {
      if (!(field in data)) {
        return {
          ok: false,
          error: {
            code: 'required_result_field_missing',
            message: `required field "${field}" not found in result block`,
          },
          result: data,
        }
      }
    }
  }

  // --- 4. equals: top-level scalar equality ---
  if (expectation.equals !== undefined) {
    for (const [key, expected] of Object.entries(expectation.equals)) {
      if (!(key in data)) {
        return {
          ok: false,
          error: {
            code: 'result_field_mismatch',
            message: `field "${key}" not found in result block`,
          },
          result: data,
        }
      }

      const actual = data[key]
      if (actual !== expected) {
        return {
          ok: false,
          error: {
            code: 'result_field_mismatch',
            message: `field "${key}": expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
          },
          result: data,
        }
      }
    }
  }

  return { ok: true, result: data }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the character offset of the first `{` on or after line `startLine`.
 * Returns -1 if no opening brace is found within a reasonable lookahead.
 */
function findOpeningBrace(lines: string[], startLine: number): number {
  let offset = 0
  // Compute offset to startLine
  for (let i = 0; i < startLine; i++) {
    const line = lines[i]
    if (line === undefined) break
    offset += line.length + 1 // +1 for newline
  }

  // Look in this line and subsequent lines for the first `{`
  const MAX_LOOKAHEAD = 5
  for (let i = startLine; i < Math.min(startLine + MAX_LOOKAHEAD, lines.length); i++) {
    const line = lines[i]
    if (line === undefined) break
    const braceIdx = line.indexOf('{')
    if (braceIdx !== -1) {
      return offset + braceIdx
    }
    offset += line.length + 1
  }

  return -1
}

/**
 * Extract a balanced JSON object string starting at `startIdx` in `text`.
 * Tracks brace depth; handles strings (with escaped quotes).
 * Returns `undefined` if braces never balance.
 */
function extractBalancedJson(text: string, startIdx: number): string | undefined {
  if (text[startIdx] !== '{') {
    return undefined
  }

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && inString) {
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) {
      continue
    }

    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return text.slice(startIdx, i + 1)
      }
    }
  }

  return undefined
}
