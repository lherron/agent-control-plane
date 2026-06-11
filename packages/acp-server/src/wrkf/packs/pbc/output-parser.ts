import type { ParticipantOutput } from '../../runtime/evidence-writer.js'
import type { MapHumanInputFn, ParseParticipantOutputFn } from '../../runtime/workflow-pack.js'

export const parsePbcParticipantOutput: ParseParticipantOutputFn = ({ text }) =>
  parseStrictParticipantOutput(text)

export const mapPbcHumanInput: MapHumanInputFn = ({ text, data, next }) => {
  const state = `${next.instance.state.status}/${next.instance.state.phase}`
  if (state === 'waiting/clarification') {
    // Record the structured answer in facts — summary alone loses
    // acceptedDefault, and downstream readers need `.data` populated (T-04091).
    const answer = typeof data?.['answer'] === 'string' ? data['answer'] : text
    const acceptedDefault = data?.['acceptedDefault']
    return {
      evidence: [
        {
          kind: 'clarification_response',
          summary: text,
          facts: {
            answer,
            ...(typeof acceptedDefault === 'boolean' ? { acceptedDefault } : {}),
          },
        },
      ],
      satisfyObligations: [{ obligationKind: 'clarification_response', evidenceIndex: 0 }],
    }
  }
  if (state === 'waiting/patch_decision') {
    const route = text.trim().toLowerCase() === 'revise' ? 'revise' : 'finalize'
    return {
      evidence: [{ kind: 'patch_decision', facts: { route } }],
      satisfyObligations: [{ obligationKind: 'patch_decision', evidenceIndex: 0 }],
    }
  }
  return parseStrictParticipantOutput(text)
}

export function parseStrictParticipantOutput(text: string): ParticipantOutput {
  const candidate = extractSingleJsonObject(text)
  if (candidate === undefined) {
    throw new Error('participant output must be exactly one JSON object')
  }

  const parsed = JSON.parse(candidate) as unknown
  if (!isParticipantOutput(parsed)) {
    throw new Error('participant output JSON does not match the required shape')
  }
  return parsed
}

/**
 * Extract exactly one top-level JSON object from participant text, tolerating a
 * single fenced code block (```json … ``` or ``` … ```) optionally surrounded
 * by prose. Returns the JSON object text (still to be shape-validated), or
 * undefined when the text does not contain exactly one JSON object.
 *
 * Rejects (returns undefined): multiple JSON objects / multiple fences,
 * prose-only / no JSON, a fence whose body is not a single JSON object
 * (e.g. prose or a JSON array).
 */
function extractSingleJsonObject(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const fences = [...trimmed.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]

  if (fences.length > 1) {
    // Multiple fenced blocks — ambiguous, reject.
    return undefined
  }

  const fence = fences[0]
  if (fence !== undefined) {
    const inner = (fence[1] ?? '').trim()
    if (!isSingleJsonObject(inner)) {
      return undefined
    }
    // Reject when a bare JSON object also appears outside the fence.
    const remaining = trimmed.replace(fence[0], '').trim()
    if (remaining.length > 0 && isSingleJsonObject(remaining)) {
      return undefined
    }
    return inner
  }

  // No fences — accept only a bare single JSON object.
  return isSingleJsonObject(trimmed) ? trimmed : undefined
}

function isSingleJsonObject(text: string): boolean {
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return false
  }
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0 && index !== text.length - 1) {
        return false
      }
      if (depth < 0) {
        return false
      }
    }
  }
  return depth === 0 && !inString
}

function isParticipantOutput(value: unknown): value is ParticipantOutput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record['evidence'])) {
    return false
  }
  return record['evidence'].every(isEvidence)
}

function isEvidence(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return typeof (value as Record<string, unknown>)['kind'] === 'string'
}
