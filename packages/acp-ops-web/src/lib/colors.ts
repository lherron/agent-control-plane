import type { DashboardEventFamily, SessionTimelineRow } from 'acp-ops-projection'

export const FAMILY_COLORS: Record<DashboardEventFamily, string> = {
  runtime: 'rgb(28, 224, 224)',
  agent_message: 'rgb(43, 133, 255)',
  tool: 'rgb(245, 172, 42)',
  input: 'rgb(167, 139, 250)',
  delivery: 'rgb(84, 219, 64)',
  handoff: 'rgb(255, 45, 139)',
  surface: 'rgb(148, 163, 184)',
  context: 'rgb(251, 146, 60)',
  warning: 'rgb(255, 56, 104)',
}

export function colorForRole(role?: SessionTimelineRow['visualState']['colorRole']): string {
  if (role === 'message') return FAMILY_COLORS.agent_message
  return FAMILY_COLORS[role ?? 'runtime'] ?? FAMILY_COLORS.runtime
}

export function familyToneClass(family: DashboardEventFamily): string {
  return `tone-${family}`
}
