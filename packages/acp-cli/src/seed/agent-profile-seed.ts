import type { AdminAgentProfile } from 'acp-core'

export type AgentProfileSeed = AdminAgentProfile

export type AgentProfileSeedAgentId = 'clod' | 'cody' | 'larry' | 'rex' | 'blaster' | 'virtu'

export const AGENT_PROFILE_SEED: Record<AgentProfileSeedAgentId, AgentProfileSeed> = {
  clod: {
    displayColor: '#d97a4a',
    monogram: 'C',
    avatarUrl: '/v1/assets/agents/clod/pfp.png',
    tagline: 'clod code rules the world',
    vibe: ['terse', 'executable', 'deadpan'],
    role: 'principal engineer · claude code',
    defaultModel: 'claude-opus-4-7',
    specialties: ['code', 'refactor', 'tooling'],
  },
  cody: {
    displayColor: '#7fbfb1',
    monogram: 'Co',
    avatarUrl: '/v1/assets/agents/cody/pfp.png',
    tagline: 'codex of operations',
    vibe: ['procedural', 'patient', 'deliberate'],
    role: 'principal engineer · openai codex',
    defaultModel: 'gpt-5-codex',
    specialties: ['code', 'infra', 'review'],
  },
  larry: {
    displayColor: '#d68aa0',
    monogram: 'L',
    avatarUrl: '/v1/assets/agents/larry/pfp.png',
    tagline: 'a poet in a pinstripe suit',
    vibe: ['narrative', 'wry', 'considered'],
    role: 'narrator · conversational ops',
    defaultModel: 'claude-sonnet-4-6',
    specialties: ['narrative', 'comms', 'prose'],
  },
  rex: {
    displayColor: '#9bb56e',
    monogram: 'R',
    tagline: 'first principal, keeper of the throne',
    vibe: ['foundational', 'steady', 'principled'],
    role: 'founding agent · platform steward',
    defaultModel: 'claude-opus-4-7',
    specialties: ['architecture', 'governance', 'platform'],
  },
  blaster: {
    displayColor: '#a8a3e3',
    monogram: 'B',
    tagline: 'every message, in flight',
    vibe: ['fast', 'reliable', 'transparent'],
    role: 'messenger · discord gateway',
    defaultModel: 'claude-haiku-4-5',
    specialties: ['messaging', 'ops', 'gateway'],
  },
  virtu: {
    displayColor: '#e3b48a',
    monogram: 'V',
    tagline: 'the kind of QA that keeps you honest',
    vibe: ['skeptical', 'thorough', 'fair'],
    role: 'virtual tester · discord harness',
    defaultModel: 'claude-haiku-4-5',
    specialties: ['testing', 'qa', 'harness'],
  },
}
