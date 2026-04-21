import type {
  InterfaceBinding,
  InterfaceBindingListFilters,
  InterfaceBindingLookup,
} from '../types.js'

import type { RepoContext } from './shared.js'
import { toOptionalString } from './shared.js'

type InterfaceBindingRow = {
  binding_id: string
  gateway_id: string
  conversation_ref: string
  thread_ref: string | null
  scope_ref: string
  lane_ref: string
  project_id: string | null
  status: InterfaceBinding['status']
  created_at: string
  updated_at: string
}

function mapInterfaceBindingRow(row: InterfaceBindingRow): InterfaceBinding {
  return {
    bindingId: row.binding_id,
    gatewayId: row.gateway_id,
    conversationRef: row.conversation_ref,
    threadRef: toOptionalString(row.thread_ref),
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    projectId: toOptionalString(row.project_id),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class BindingRepo {
  constructor(private readonly context: RepoContext) {}

  create(binding: InterfaceBinding): InterfaceBinding {
    this.context.sqlite
      .prepare(
        `INSERT INTO interface_bindings (
           binding_id,
           gateway_id,
           conversation_ref,
           thread_ref,
           scope_ref,
           lane_ref,
           project_id,
           status,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        binding.bindingId,
        binding.gatewayId,
        binding.conversationRef,
        binding.threadRef ?? null,
        binding.scopeRef,
        binding.laneRef,
        binding.projectId ?? null,
        binding.status,
        binding.createdAt,
        binding.updatedAt
      )

    return this.requireById(binding.bindingId)
  }

  upsertByLookup(binding: InterfaceBinding): InterfaceBinding {
    return this.context.sqlite.transaction(() => {
      const existing = this.loadByLookup(binding)
      if (existing === undefined) {
        return this.create(binding)
      }

      this.context.sqlite
        .prepare(
          `UPDATE interface_bindings
              SET scope_ref = ?,
                  lane_ref = ?,
                  project_id = ?,
                  status = ?,
                  updated_at = ?
            WHERE binding_id = ?`
        )
        .run(
          binding.scopeRef,
          binding.laneRef,
          binding.projectId ?? null,
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

    const rows = this.context.sqlite
      .prepare(
        `SELECT binding_id,
                gateway_id,
                conversation_ref,
                thread_ref,
                scope_ref,
                lane_ref,
                project_id,
                status,
                created_at,
                updated_at
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
        `SELECT binding_id,
                gateway_id,
                conversation_ref,
                thread_ref,
                scope_ref,
                lane_ref,
                project_id,
                status,
                created_at,
                updated_at
           FROM interface_bindings
          WHERE binding_id = ?`
      )
      .get(bindingId) as InterfaceBindingRow | undefined

    return row === undefined ? undefined : mapInterfaceBindingRow(row)
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

  private loadByLookup(lookup: InterfaceBindingLookup): InterfaceBinding | undefined {
    const row =
      lookup.threadRef === undefined
        ? (this.context.sqlite
            .prepare(
              `SELECT binding_id,
                    gateway_id,
                    conversation_ref,
                    thread_ref,
                    scope_ref,
                    lane_ref,
                    project_id,
                    status,
                    created_at,
                    updated_at
               FROM interface_bindings
              WHERE gateway_id = ?
                AND conversation_ref = ?
                AND thread_ref IS NULL
              LIMIT 1`
            )
            .get(lookup.gatewayId, lookup.conversationRef) as InterfaceBindingRow | undefined)
        : (this.context.sqlite
            .prepare(
              `SELECT binding_id,
                    gateway_id,
                    conversation_ref,
                    thread_ref,
                    scope_ref,
                    lane_ref,
                    project_id,
                    status,
                    created_at,
                    updated_at
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
              `SELECT binding_id,
                    gateway_id,
                    conversation_ref,
                    thread_ref,
                    scope_ref,
                    lane_ref,
                    project_id,
                    status,
                    created_at,
                    updated_at
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
              `SELECT binding_id,
                    gateway_id,
                    conversation_ref,
                    thread_ref,
                    scope_ref,
                    lane_ref,
                    project_id,
                    status,
                    created_at,
                    updated_at
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
