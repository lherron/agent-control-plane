/**
 * Red tests for PBC output-parser fence/single-JSON leniency (T-03554).
 *
 * Module under test: src/wrkf/packs/pbc/output-parser.ts
 *
 * ─── BUG ──────────────────────────────────────────────────────────────────────
 *
 *   parseStrictParticipantOutput (lines 25-36) requires the ENTIRE trimmed text
 *   to be exactly one JSON object (isSingleJsonObject check).  Real agents
 *   (larry, curly) may wrap the JSON in a ```json fence or add prose, causing
 *   the parser to throw 'participant output must be exactly one JSON object'.
 *
 * ─── DESIRED LENIENCY (proposal lines 643-651) ────────────────────────────────
 *
 *   Accept ONE JSON object that is:
 *     a) bare (existing behaviour — stays green), OR
 *     b) wrapped in a single ```json ... ``` fenced code block, OR
 *     c) wrapped in a single bare ``` ... ``` fenced code block, OR
 *     d) the sole fenced code block surrounded by prose.
 *
 *   STILL REJECT:
 *     • multiple JSON objects / multiple fenced blocks
 *     • prose-only / no JSON
 *
 *   All downstream shape validation (isParticipantOutput) must still apply to
 *   the extracted JSON.
 *
 * ─── TEST STATUS ──────────────────────────────────────────────────────────────
 *
 *   Tests marked [RED] currently FAIL — the parser has not yet been made lenient.
 *   Tests marked [GREEN] currently PASS — existing behaviour that must not regress.
 */

import { describe, expect, test } from 'bun:test'

import { mapPbcHumanInput, parseStrictParticipantOutput } from './output-parser.js'
import type { ParticipantOutput } from '../../runtime/evidence-writer.js'

// ---------------------------------------------------------------------------
// Shared fixture — a minimal valid ParticipantOutput object
// ---------------------------------------------------------------------------

const VALID_OUTPUT: ParticipantOutput = {
  evidence: [{ kind: 'behavior_note', summary: 'agent works correctly' }],
  proposedTransition: 'draft_pbc',
}

const VALID_JSON = JSON.stringify(VALID_OUTPUT)

// ---------------------------------------------------------------------------
// 1. [GREEN] Bare single JSON object — existing happy path must not regress
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — bare JSON object [GREEN]', () => {
  test('[GREEN] bare valid JSON object parses and returns ParticipantOutput', () => {
    const result = parseStrictParticipantOutput(VALID_JSON)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[GREEN] bare JSON with surrounding whitespace parses', () => {
    const result = parseStrictParticipantOutput(`\n  ${VALID_JSON}\n`)
    expect(result).toEqual(VALID_OUTPUT)
  })
})

// ---------------------------------------------------------------------------
// 2. [RED] Single JSON object wrapped in ```json ... ``` fence
//
//    Currently throws 'participant output must be exactly one JSON object'
//    because isSingleJsonObject sees the backtick fence and returns false.
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — ```json fenced block [RED]', () => {
  test('[RED] ```json fence — parses and returns same output as bare object', () => {
    const fenced = `\`\`\`json\n${VALID_JSON}\n\`\`\``
    // Currently throws — after fix must return VALID_OUTPUT
    expect(() => parseStrictParticipantOutput(fenced)).not.toThrow()
    const result = parseStrictParticipantOutput(fenced)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[RED] ```json fence with surrounding whitespace — parses', () => {
    const fenced = `\n\`\`\`json\n${VALID_JSON}\n\`\`\`\n`
    expect(() => parseStrictParticipantOutput(fenced)).not.toThrow()
    const result = parseStrictParticipantOutput(fenced)
    expect(result).toEqual(VALID_OUTPUT)
  })
})

// ---------------------------------------------------------------------------
// 3. [RED] Single JSON object wrapped in bare ``` ... ``` fence (no language tag)
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — bare ``` fenced block [RED]', () => {
  test('[RED] bare ``` fence — parses and returns same output as bare object', () => {
    const fenced = `\`\`\`\n${VALID_JSON}\n\`\`\``
    // Currently throws — after fix must return VALID_OUTPUT
    expect(() => parseStrictParticipantOutput(fenced)).not.toThrow()
    const result = parseStrictParticipantOutput(fenced)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[RED] bare ``` fence with whitespace — parses', () => {
    const fenced = `  \`\`\`\n${VALID_JSON}\n\`\`\`  `
    expect(() => parseStrictParticipantOutput(fenced)).not.toThrow()
    const result = parseStrictParticipantOutput(fenced)
    expect(result).toEqual(VALID_OUTPUT)
  })
})

// ---------------------------------------------------------------------------
// 4. [RED] Single fenced JSON block surrounded by prose
//
//    Real agents typically add explanatory text before/after the JSON block.
//    If there is EXACTLY ONE fenced code block containing a valid JSON object,
//    the parser should extract it and ignore the surrounding prose.
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — single fenced block with prose [RED]', () => {
  test('[RED] leading prose + ```json fence — parses the fenced JSON', () => {
    const input = `Here is my analysis of the task:\n\n\`\`\`json\n${VALID_JSON}\n\`\`\``
    expect(() => parseStrictParticipantOutput(input)).not.toThrow()
    const result = parseStrictParticipantOutput(input)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[RED] ```json fence + trailing prose — parses the fenced JSON', () => {
    const input = `\`\`\`json\n${VALID_JSON}\n\`\`\`\n\nLet me know if you need clarification.`
    expect(() => parseStrictParticipantOutput(input)).not.toThrow()
    const result = parseStrictParticipantOutput(input)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[RED] prose before and after a single ```json fence — parses the fenced JSON', () => {
    const input = [
      'I have completed the behavior analysis.',
      '',
      '```json',
      VALID_JSON,
      '```',
      '',
      'The evidence above captures the key observations.',
    ].join('\n')
    expect(() => parseStrictParticipantOutput(input)).not.toThrow()
    const result = parseStrictParticipantOutput(input)
    expect(result).toEqual(VALID_OUTPUT)
  })

  test('[RED] prose before and after a single bare ``` fence — parses the fenced JSON', () => {
    const input = [
      'Analysis complete.',
      '',
      '```',
      VALID_JSON,
      '```',
      '',
      'Done.',
    ].join('\n')
    expect(() => parseStrictParticipantOutput(input)).not.toThrow()
    const result = parseStrictParticipantOutput(input)
    expect(result).toEqual(VALID_OUTPUT)
  })
})

// ---------------------------------------------------------------------------
// 5. [GREEN] MULTIPLE JSON objects / fences — must still be REJECTED
//
//    The leniency only applies to EXACTLY ONE fenced block.  Multiple
//    objects (ambiguous or contradictory) must be rejected.
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — multiple JSON objects REJECTED [GREEN]', () => {
  test('[GREEN] two bare JSON objects on separate lines throws', () => {
    const two = `${VALID_JSON}\n${VALID_JSON}`
    expect(() => parseStrictParticipantOutput(two)).toThrow()
  })

  test('[GREEN] two ```json fenced blocks throws', () => {
    const two = [
      '```json',
      VALID_JSON,
      '```',
      '',
      '```json',
      VALID_JSON,
      '```',
    ].join('\n')
    expect(() => parseStrictParticipantOutput(two)).toThrow()
  })

  test('[GREEN] one ```json fence and one bare JSON object throws', () => {
    const mixed = `\`\`\`json\n${VALID_JSON}\n\`\`\`\n\n${VALID_JSON}`
    expect(() => parseStrictParticipantOutput(mixed)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 6. [GREEN] Prose-only / no JSON — must still be REJECTED
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — prose-only REJECTED [GREEN]', () => {
  test('[GREEN] plain prose without any JSON throws', () => {
    expect(() =>
      parseStrictParticipantOutput('I have finished the analysis and everything looks good.')
    ).toThrow()
  })

  test('[GREEN] empty string throws', () => {
    expect(() => parseStrictParticipantOutput('')).toThrow()
  })

  test('[GREEN] fenced block containing non-JSON prose throws', () => {
    const fenced = '```\nThis is just a prose paragraph.\n```'
    expect(() => parseStrictParticipantOutput(fenced)).toThrow()
  })

  test('[GREEN] fenced block containing a JSON array (not an object) throws', () => {
    const fenced = '```json\n[1, 2, 3]\n```'
    expect(() => parseStrictParticipantOutput(fenced)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// 7. [RED] Shape validation still applied after extraction
//
//    A fenced block that IS valid JSON but does NOT match ParticipantOutput
//    must still fail the shape check (not just the fence check).
//
//    Currently [RED]: parser throws "participant output must be exactly one
//    JSON object" (fence stripping not implemented) rather than the shape
//    error.  After the fix, fence is stripped, JSON is parsed, THEN shape
//    validation fires → correct error message.
// ---------------------------------------------------------------------------

describe('parseStrictParticipantOutput — shape validation after fence extraction [RED]', () => {
  test('[RED] ```json fence wrapping JSON missing evidence array throws shape error', () => {
    const badJson = JSON.stringify({ proposedTransition: 'draft_pbc' }) // no evidence
    const fenced = `\`\`\`json\n${badJson}\n\`\`\``
    // After fix: fence stripped → JSON parsed → shape check fires with this message
    expect(() => parseStrictParticipantOutput(fenced)).toThrow(
      /participant output JSON does not match the required shape/
    )
  })

  test('[RED] ```json fence wrapping JSON with evidence=null throws shape error', () => {
    const badJson = JSON.stringify({ evidence: null })
    const fenced = `\`\`\`json\n${badJson}\n\`\`\``
    expect(() => parseStrictParticipantOutput(fenced)).toThrow(
      /participant output JSON does not match the required shape/
    )
  })

  test('[RED] ```json fence wrapping JSON with evidence item missing kind throws shape error', () => {
    const badJson = JSON.stringify({ evidence: [{ summary: 'no kind field' }] })
    const fenced = `\`\`\`json\n${badJson}\n\`\`\``
    expect(() => parseStrictParticipantOutput(fenced)).toThrow(
      /participant output JSON does not match the required shape/
    )
  })
})

// ---------------------------------------------------------------------------
// T-04091 — clarification answers must land in facts (acceptedDefault was lost)
// ---------------------------------------------------------------------------

describe('mapPbcHumanInput — clarification_response records facts (RED, T-04091)', () => {
  const makeNext = (status: string, phase: string) =>
    ({
      instance: { id: 'wfi_x', state: { status, phase }, revision: 3 },
      actions: [],
      openObligations: [],
      pendingEffects: [],
    }) as never

  test('[RED] clarification input with structured data → facts {answer, acceptedDefault}', async () => {
    const mapped = await mapPbcHumanInput({
      text: 'Only the lock screen preview leaks',
      data: { answer: 'Only the lock screen preview leaks', acceptedDefault: true },
      role: 'product_owner',
      actor: 'human:lance',
      next: makeNext('waiting', 'clarification'),
    })
    const evidence = mapped.evidence[0]
    expect(evidence?.kind).toBe('clarification_response')
    expect(evidence?.summary).toBe('Only the lock screen preview leaks')
    expect(evidence?.facts).toEqual({
      answer: 'Only the lock screen preview leaks',
      acceptedDefault: true,
    })
  })

  test('[RED] clarification input without structured data → facts {answer} from text', async () => {
    const mapped = await mapPbcHumanInput({
      text: 'free-form answer',
      role: 'product_owner',
      actor: 'human:lance',
      next: makeNext('waiting', 'clarification'),
    })
    const evidence = mapped.evidence[0]
    expect(evidence?.facts).toEqual({ answer: 'free-form answer' })
  })

  test('patch_decision facts unchanged by data threading', async () => {
    const mapped = await mapPbcHumanInput({
      text: 'revise',
      data: { route: 'revise' },
      role: 'product_owner',
      actor: 'human:lance',
      next: makeNext('waiting', 'patch_decision'),
    })
    expect(mapped.evidence[0]?.facts).toEqual({ route: 'revise' })
  })
})
