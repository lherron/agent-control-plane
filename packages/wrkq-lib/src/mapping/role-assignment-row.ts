import type { RoleMap } from 'acp-core'

export type RoleAssignmentRow = {
  role: string
  actor_slug: string
}

export function mapRoleAssignmentRows(rows: readonly RoleAssignmentRow[]): RoleMap {
  return rows.reduce<Record<string, string>>((roleMap, row) => {
    roleMap[row.role] = row.actor_slug
    return roleMap
  }, {})
}
