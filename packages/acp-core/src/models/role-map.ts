export type RoleMap = Readonly<Record<string, string>>

export function getRoleAgentId(roleMap: RoleMap, role: string): string | undefined {
  return roleMap[role]
}

export function hasRoleAssignment(roleMap: RoleMap, role: string): boolean {
  return getRoleAgentId(roleMap, role) !== undefined
}

export function listAssignedRoles(roleMap: RoleMap): string[] {
  return Object.keys(roleMap)
}
