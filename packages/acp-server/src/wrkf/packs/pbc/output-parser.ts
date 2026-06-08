import type { MapHumanInputFn, ParseParticipantOutputFn } from '../../runtime/workflow-pack.js'
import type { ParticipantOutput } from '../../runtime/evidence-writer.js'

export const parsePbcParticipantOutput: ParseParticipantOutputFn = ({ text }) =>
  parseStrictParticipantOutput(text)

export const mapPbcHumanInput: MapHumanInputFn = ({ text, next }) => {
  const state = `${next.instance.state.status}/${next.instance.state.phase}`
  if (state === 'waiting/clarification') {
    return {
      evidence: [{ kind: 'clarification_response', summary: text }],
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
  const trimmed = text.trim()
  if (!isSingleJsonObject(trimmed)) {
    throw new Error('participant output must be exactly one JSON object')
  }

  const parsed = JSON.parse(trimmed) as unknown
  if (!isParticipantOutput(parsed)) {
    throw new Error('participant output JSON does not match the required shape')
  }
  return parsed
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
