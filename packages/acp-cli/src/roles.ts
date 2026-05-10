import { CliUsageError } from './cli-runtime.js'

export function normalizeRoleName(value: string, _flagLabel = 'role'): string {
  const normalized = value.trim().toLowerCase().replaceAll('-', '_')
  if (normalized.length === 0) {
    throw new CliUsageError('role name cannot be empty')
  }
  return normalized
}

export function parseRoleAssignment(raw: string): { role: string; agentId: string } {
  const separator = raw.indexOf(':')
  if (separator <= 0 || separator === raw.length - 1) {
    throw new CliUsageError(`invalid --role assignment: ${raw}`)
  }

  const role = normalizeRoleName(raw.slice(0, separator), '--role')
  const agentId = raw.slice(separator + 1).trim()
  if (agentId.length === 0) {
    throw new CliUsageError(`invalid --role assignment: ${raw}`)
  }

  return { role, agentId }
}
