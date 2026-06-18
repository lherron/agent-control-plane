import { parseScopeRef, validateScopeRef } from 'agent-scope'

import type {
  InterfaceBinding,
  InterfaceBindingListFilters,
  InterfaceBindingLookup,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

const BINDING_COLUMNS = `binding_id,
                gateway_id,
                gateway_type,
                conversation_ref,
                thread_ref,
                lane_ref,
                project_id,
                agent_id,
                task_id,
                role_name,
                status,
                created_at,
                updated_at`

function buildScopeRef(parts: {
  agentId: string
  projectId: string
  taskId?: string | undefined
  roleName?: string | undefined
}): string {
  let ref = `agent:${parts.agentId}:project:${parts.projectId}`
  if (parts.taskId !== undefined) ref += `:task:${parts.taskId}`
  if (parts.roleName !== undefined) ref += `:role:${parts.roleName}`
  return ref
}

function assertBindingScope(binding: InterfaceBinding): void {
  const validation = validateScopeRef(binding.scopeRef)
  if (!validation.ok) {
    throw new Error(
      `Interface binding scopeRef "${binding.scopeRef}" is invalid: ${validation.error}`
    )
  }

  const parsed = parseScopeRef(binding.scopeRef)
  if (parsed.projectId === undefined) {
    throw new Error(
      `Interface binding scopeRef "${binding.scopeRef}" must include a project segment`
    )
  }

  if (binding.projectId === undefined) {
    throw new Error(
      `Interface binding projectId is required (scopeRef "${binding.scopeRef}" has project "${parsed.projectId}")`
    )
  }

  if (binding.projectId !== parsed.projectId) {
    throw new Error(
      `Interface binding projectId "${binding.projectId}" disagrees with scopeRef project "${parsed.projectId}"`
    )
  }
}

function normalizeGatewayType(binding: InterfaceBinding): string {
  const value = (binding as InterfaceBinding & { gatewayType?: string | undefined }).gatewayType
  return value !== undefined && value.trim().length > 0 ? value.trim() : 'unknown'
}

type InterfaceBindingRow = {
  binding_id: string
  gateway_id: string
  gateway_type: string
  conversation_ref: string
  thread_ref: string | null
  lane_ref: string
  project_id: string
  agent_id: string
  task_id: string | null
  role_name: string | null
  status: InterfaceBinding['status']
  created_at: string
  updated_at: string
}

function mapInterfaceBindingRow(row: InterfaceBindingRow): InterfaceBinding {
  const taskId = toOptionalString(row.task_id)
  const roleName = toOptionalString(row.role_name)
  const scopeRef = buildScopeRef({
    agentId: row.agent_id,
    projectId: row.project_id,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(roleName !== undefined ? { roleName } : {}),
  })

  return {
    bindingId: row.binding_id,
    gatewayId: row.gateway_id,
    gatewayType: row.gateway_type,
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    scopeRef,
    laneRef: row.lane_ref,
    projectId: row.project_id,
    agentId: row.agent_id,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(roleName !== undefined ? { roleName } : {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type ParsedBindingScope = {
  agentId: string
  projectId: string
  taskId?: string | undefined
  roleName?: string | undefined
}

function deriveStructuredFields(binding: InterfaceBinding): ParsedBindingScope {
  const parsed = parseScopeRef(binding.scopeRef)
  if (parsed.projectId === undefined) {
    throw new Error(
      `Interface binding scopeRef "${binding.scopeRef}" must include a project segment`
    )
  }
  const roleName = parsed.roleName ?? binding.roleName
  return {
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
    ...(roleName !== undefined ? { roleName } : {}),
  }
}

export class BindingRepo {
  constructor(private readonly context: RepoContext) {}

  create(binding: InterfaceBinding): InterfaceBinding {
    assertBindingScope(binding)
    const structured = deriveStructuredFields(binding)
    this.context.sqlite
      .prepare(
        `INSERT INTO interface_bindings (
           binding_id,
           gateway_id,
           gateway_type,
           conversation_ref,
           thread_ref,
           lane_ref,
           project_id,
           agent_id,
           task_id,
           role_name,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        binding.bindingId,
        binding.gatewayId,
        normalizeGatewayType(binding),
        binding.conversationRef,
        binding.threadRef ?? null,
        binding.laneRef,
        structured.projectId,
        structured.agentId,
        structured.taskId ?? null,
        structured.roleName ?? null,
        binding.status,
        binding.createdAt,
        binding.updatedAt
      )

    return this.requireById(binding.bindingId)
  }

  upsertByLookup(binding: InterfaceBinding): InterfaceBinding {
    assertBindingScope(binding)
    return this.context.sqlite.transaction(() => {
      const existing = this.loadByLookup(binding)
      if (existing === undefined) {
        return this.create(binding)
      }

      const structured = deriveStructuredFields(binding)
      this.context.sqlite
        .prepare(
          `UPDATE interface_bindings
              SET gateway_type = ?,
                  lane_ref = ?,
                  project_id = ?,
                  agent_id = ?,
                  task_id = ?,
                  role_name = ?,
                  status = ?,
                  updated_at = ?
            WHERE binding_id = ?`
        )
        .run(
          normalizeGatewayType(binding),
          binding.laneRef,
          structured.projectId,
          structured.agentId,
          structured.taskId ?? null,
          structured.roleName ?? null,
          binding.status,
          binding.updatedAt,
          existing.bindingId
        )

      return this.requireById(existing.bindingId)
    })()
  }

  list(filters: InterfaceBindingListFilters = {}): InterfaceBinding[] {
    const where: string[] = []
    const params: unknown[] = []

    if (filters.gatewayId !== undefined) {
      where.push('gateway_id = ?')
      params.push(filters.gatewayId)
    }

    if (filters.gatewayType !== undefined) {
      where.push('gateway_type = ?')
      params.push(filters.gatewayType)
    }

    if (filters.conversationRef !== undefined) {
      where.push('conversation_ref = ?')
      params.push(filters.conversationRef)
    }

    if (filters.threadRef !== undefined) {
      where.push('thread_ref = ?')
      params.push(filters.threadRef)
    }

    if (filters.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(filters.projectId)
    }

    if (filters.agentId !== undefined) {
      where.push('agent_id = ?')
      params.push(filters.agentId)
    }

    if (filters.laneRef !== undefined) {
      where.push('lane_ref = ?')
      params.push(filters.laneRef)
    }

    if (filters.status !== undefined) {
      where.push('status = ?')
      params.push(filters.status)
    }

    const rows = this.context.sqlite
      .prepare(
        `SELECT ${BINDING_COLUMNS}
           FROM interface_bindings
          ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at ASC, binding_id ASC`
      )
      .all(...params) as InterfaceBindingRow[]

    return rows.map(mapInterfaceBindingRow)
  }

  getById(bindingId: string): InterfaceBinding | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${BINDING_COLUMNS}
           FROM interface_bindings
          WHERE binding_id = ?`
      )
      .get(bindingId) as InterfaceBindingRow | undefined

    return row === undefined ? undefined : mapInterfaceBindingRow(row)
  }

  findById(bindingId: string): InterfaceBinding | undefined {
    return this.getById(bindingId)
  }

  resolve(lookup: InterfaceBindingLookup): InterfaceBinding | undefined {
    if (lookup.threadRef !== undefined) {
      const threadMatch = this.loadActiveByLookup(lookup)
      if (threadMatch !== undefined) {
        return threadMatch
      }
    }

    return this.loadActiveByLookup({
      gatewayId: lookup.gatewayId,
      conversationRef: lookup.conversationRef,
    })
  }

  listPrimaryCandidates(input: {
    gatewayType: string
    agentId: string
    projectId: string
    laneRef: string
  }): InterfaceBinding[] {
    const rows = this.context.sqlite
      .prepare(
        `SELECT ${BINDING_COLUMNS}
           FROM interface_bindings
          WHERE gateway_type = ?
            AND status = 'active'
            AND agent_id = ?
            AND project_id = ?
            AND lane_ref = ?
            AND task_id IS NULL
            AND role_name IS NULL
          ORDER BY created_at ASC, binding_id ASC`
      )
      .all(
        input.gatewayType,
        input.agentId,
        input.projectId,
        input.laneRef
      ) as InterfaceBindingRow[]

    return rows.map(mapInterfaceBindingRow)
  }

  private loadByLookup(lookup: InterfaceBindingLookup): InterfaceBinding | undefined {
    const row =
      lookup.threadRef === undefined
        ? (this.context.sqlite
            .prepare(
              `SELECT ${BINDING_COLUMNS}
               FROM interface_bindings
              WHERE gateway_id = ?
                AND conversation_ref = ?
                AND thread_ref IS NULL
              LIMIT 1`
            )
            .get(lookup.gatewayId, lookup.conversationRef) as InterfaceBindingRow | undefined)
        : (this.context.sqlite
            .prepare(
              `SELECT ${BINDING_COLUMNS}
               FROM interface_bindings
              WHERE gateway_id = ?
                AND conversation_ref = ?
                AND thread_ref = ?
              LIMIT 1`
            )
            .get(lookup.gatewayId, lookup.conversationRef, lookup.threadRef) as
            | InterfaceBindingRow
            | undefined)

    return row === undefined ? undefined : mapInterfaceBindingRow(row)
  }

  private loadActiveByLookup(lookup: InterfaceBindingLookup): InterfaceBinding | undefined {
    const row =
      lookup.threadRef === undefined
        ? (this.context.sqlite
            .prepare(
              `SELECT ${BINDING_COLUMNS}
               FROM interface_bindings
              WHERE gateway_id = ?
                AND conversation_ref = ?
                AND thread_ref IS NULL
                AND status = 'active'
              LIMIT 1`
            )
            .get(lookup.gatewayId, lookup.conversationRef) as InterfaceBindingRow | undefined)
        : (this.context.sqlite
            .prepare(
              `SELECT ${BINDING_COLUMNS}
               FROM interface_bindings
              WHERE gateway_id = ?
                AND conversation_ref = ?
                AND thread_ref = ?
                AND status = 'active'
              LIMIT 1`
            )
            .get(lookup.gatewayId, lookup.conversationRef, lookup.threadRef) as
            | InterfaceBindingRow
            | undefined)

    return row === undefined ? undefined : mapInterfaceBindingRow(row)
  }

  private requireById(bindingId: string): InterfaceBinding {
    const binding = this.getById(bindingId)
    if (binding === undefined) {
      throw new Error(`Failed to reload interface binding ${bindingId}`)
    }

    return binding
  }
}
