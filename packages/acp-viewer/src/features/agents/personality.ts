/*
 * Agent personality — API-driven profile with deterministic fallback.
 *
 * Reads profile data returned by the API (Phase B). When the API row has no
 * profile (or fields are missing), deriveFallbackProfile() synthesises a
 * coherent placeholder so the catalogue always renders.
 */

import type { AgentSummaryProfile } from '@/types/api'

export interface AgentPersonality {
  /** Signature color in hex. Used for monogram, keyline, accent strip, hover tint. */
  color: string
  /** 1–2 character monogram displayed in the avatar. */
  monogram: string
  /** Optional uploaded PFP URL. Falls back to monogram sigil when absent. */
  pfpUrl?: string
  /** Magazine-style subhead — rendered display-italic in signature color. */
  tagline: string
  /** Short descriptors that telegraph voice. */
  vibe: string[]
  /** Role/discipline kicker. */
  role: string
  /** Originating model identifier. */
  originatingModel: string
  /** Discipline tags rendered as chips. */
  specialties: string[]
}

const DEFAULT_COLOR = '#a59cb0' // dusty mauve (matches --color-muted)

/**
 * Derive a deterministic fallback profile for an agent with no API profile.
 * Monogram is derived from displayName initial(s); color is a muted default.
 */
export function deriveFallbackProfile(agentId: string, displayName?: string): AgentPersonality {
  const name = displayName?.trim() || agentId.trim()
  const parts = name.split(/\s+/).filter(Boolean)
  const monogram =
    parts.length >= 2
      ? (parts[0]?.charAt(0).toUpperCase() ?? '') + (parts[1]?.charAt(0).toUpperCase() ?? '')
      : parts[0]?.charAt(0).toUpperCase() || '?'

  return {
    color: DEFAULT_COLOR,
    monogram,
    tagline: 'unattributed correspondent',
    vibe: ['unprofiled'],
    role: 'unknown',
    originatingModel: 'unknown',
    specialties: [],
  }
}

/**
 * Build a complete AgentPersonality by merging an optional API profile onto
 * a deterministic fallback. Fields present in the API profile win.
 */
export function agentPersonality(
  agentId: string,
  apiProfile?: AgentSummaryProfile | null,
  displayName?: string
): AgentPersonality {
  const fallback = deriveFallbackProfile(agentId, displayName)
  if (!apiProfile) return fallback

  return {
    color: apiProfile.displayColor || fallback.color,
    monogram: apiProfile.monogram || fallback.monogram,
    pfpUrl: apiProfile.avatarUrl || undefined,
    tagline: apiProfile.tagline || fallback.tagline,
    vibe: apiProfile.vibe ?? fallback.vibe,
    role: apiProfile.role || fallback.role,
    originatingModel: apiProfile.defaultModel || fallback.originatingModel,
    specialties: apiProfile.specialties ?? fallback.specialties,
  }
}

/**
 * Does this agent have a real profile? True when the API supplies a tagline.
 */
export function hasPersonality(_agentId: string, apiProfile?: AgentSummaryProfile | null): boolean {
  return Boolean(apiProfile?.tagline)
}
