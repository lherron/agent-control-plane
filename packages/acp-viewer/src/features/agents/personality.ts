/*
 * Agent personality overlay — design proposal for /agents/__glam.
 * Hard-coded for now; would migrate to a DB-backed agent profile in production.
 *
 * Colors are picked to sit on the Midnight Plum canvas alongside brass (#e3a857)
 * without competing with it. All signature hues land at similar value (~0.65)
 * and saturation (~0.4) so the lineup reads as a coherent ensemble.
 */

export type AgentMotif = 'dots' | 'lines' | 'rules' | 'hatch' | 'chevron' | 'checker'

export interface AgentPersonality {
  /** Signature color in hex. Used for monogram, keyline, accent strip, hover tint. */
  color: string
  /** Optional secondary accent — used for the card's diagonal gradient wash. */
  accent?: string
  /** 1–2 character monogram displayed in the avatar. */
  monogram: string
  /** Optional uploaded PFP URL. Falls back to monogram sigil when absent. */
  pfpUrl?: string
  // —— above the rule (personality)
  /** Magazine-style subhead — rendered display-italic in signature color. */
  tagline: string
  /** Three short descriptors that telegraph voice. e.g. ["terse","technical","dry"]. */
  vibe: string[]
  // —— below the rule (spec)
  /** Role/discipline kicker. */
  role: string
  /** Originating model identifier, e.g. "claude-opus-4-7". */
  originatingModel: string
  /** Discipline tags rendered as chips. */
  specialties: string[]
  // —— card decoration
  /** Background pattern that tints the card surface. */
  motif: AgentMotif
  /** Single character/glyph rendered as a giant watermark behind the spec area. */
  glyph: string
}

const FALLBACK: AgentPersonality = {
  color: '#a59cb0', // dusty mauve (matches --color-muted)
  monogram: '?',
  tagline: 'unattributed correspondent',
  vibe: ['unprofiled'],
  role: 'unknown',
  originatingModel: 'unknown',
  specialties: [],
  motif: 'dots',
  glyph: '·',
}

const REGISTRY: Record<string, AgentPersonality> = {
  clod: {
    color: '#d97a4a', // terracotta
    accent: '#b04a1f',
    monogram: 'C',
    pfpUrl: '/pfp/clod.png',
    tagline: 'clod code rules the world',
    vibe: ['terse', 'executable', 'deadpan'],
    role: 'principal engineer · claude code',
    originatingModel: 'claude-opus-4-7',
    specialties: ['code', 'refactor', 'tooling'],
    motif: 'dots',
    glyph: '{ }',
  },
  cody: {
    color: '#7fbfb1', // pale jade
    accent: '#4f8e85',
    monogram: 'Co',
    pfpUrl: '/pfp/cody.png',
    tagline: 'codex of operations',
    vibe: ['procedural', 'patient', 'deliberate'],
    role: 'principal engineer · openai codex',
    originatingModel: 'gpt-5-codex',
    specialties: ['code', 'infra', 'review'],
    motif: 'lines',
    glyph: '§',
  },
  larry: {
    color: '#d68aa0', // dusty rose
    accent: '#a45b73',
    monogram: 'L',
    pfpUrl: '/pfp/larry.png',
    tagline: 'a poet in a pinstripe suit',
    vibe: ['narrative', 'wry', 'considered'],
    role: 'narrator · conversational ops',
    originatingModel: 'claude-sonnet-4-6',
    specialties: ['narrative', 'comms', 'prose'],
    motif: 'rules',
    glyph: '¶',
  },
  rex: {
    color: '#9bb56e', // sage
    accent: '#6a8746',
    monogram: 'R',
    tagline: 'first principal, keeper of the throne',
    vibe: ['foundational', 'steady', 'principled'],
    role: 'founding agent · platform steward',
    originatingModel: 'claude-opus-4-7',
    specialties: ['architecture', 'governance', 'platform'],
    motif: 'hatch',
    glyph: '☩',
  },
  blaster: {
    color: '#a8a3e3', // periwinkle
    accent: '#7872c2',
    monogram: 'B',
    tagline: 'every message, in flight',
    vibe: ['fast', 'reliable', 'transparent'],
    role: 'messenger · discord gateway',
    originatingModel: 'claude-haiku-4-5',
    specialties: ['messaging', 'ops', 'gateway'],
    motif: 'chevron',
    glyph: '➤',
  },
  virtu: {
    color: '#e3b48a', // peach
    accent: '#b07e57',
    monogram: 'V',
    tagline: 'the kind of QA that keeps you honest',
    vibe: ['skeptical', 'thorough', 'fair'],
    role: 'virtual tester · discord harness',
    originatingModel: 'claude-haiku-4-5',
    specialties: ['testing', 'qa', 'harness'],
    motif: 'checker',
    glyph: '✓',
  },
}

export function agentPersonality(agentId: string): AgentPersonality {
  return REGISTRY[agentId.toLowerCase()] ?? deriveFallback(agentId)
}

export function hasPersonality(agentId: string): boolean {
  return Object.hasOwn(REGISTRY, agentId.toLowerCase())
}

function deriveFallback(agentId: string): AgentPersonality {
  const first = agentId.trim().charAt(0).toUpperCase() || '?'
  return { ...FALLBACK, monogram: first }
}
