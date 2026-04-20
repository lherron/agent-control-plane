import type { Task, TaskStore } from 'acp-core'

import { VersionConflictError } from '../errors.js'
import { type TaskRow, mapTaskRow, mapTaskToWriteRecord } from '../mapping/task-row.js'
import type { RepoContext } from './shared.js'
import {
  deriveTaskSlug,
  loadRoleMap,
  replaceRoleMap,
  requireTaskLookup,
  resolveProjectReference,
} from './shared.js'

type LoadedTaskRow = TaskRow & {
  uuid: string
}

export class TaskRepo implements TaskStore {
  constructor(private readonly context: RepoContext) {}

  createTask(task: Task): Task {
    return this.context.sqlite.transaction((input: Task) => {
      const project = resolveProjectReference(this.context.sqlite, input.projectId)
      const actorUuid = this.context.actorResolver.resolveDefaultActorUuid()
      const record = mapTaskToWriteRecord({
        task: input,
        projectUuid: project.uuid,
        actorUuid,
        slug: deriveTaskSlug(input.taskId),
      })

      this.context.sqlite
        .prepare(
          `INSERT INTO tasks (
             id,
             slug,
             title,
             project_uuid,
             state,
             priority,
             kind,
             description,
             specification,
             workflow_preset,
             preset_version,
             phase,
             risk_class,
             meta,
             etag,
             created_by_actor_uuid,
             updated_by_actor_uuid
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.slug,
          record.title,
          record.projectUuid,
          record.state,
          3,
          'task',
          '',
          '',
          record.workflowPreset,
          record.presetVersion,
          record.phase,
          record.riskClass,
          record.meta,
          record.version,
          record.actorUuid,
          record.actorUuid
        )

      const lookup = requireTaskLookup(this.context.sqlite, input.taskId)
      replaceRoleMap(this.context.sqlite, this.context.actorResolver, lookup.uuid, input.roleMap)
      return this.loadTaskById(input.taskId)
    })(task)
  }

  getTask(taskId: string): Task | undefined {
    return this.context.sqlite.transaction((id: string) => this.loadTaskByIdOrUndefined(id))(taskId)
  }

  updateTask(task: Task): Task {
    return this.context.sqlite.transaction((input: Task) => {
      const existing = requireTaskLookup(this.context.sqlite, input.taskId)
      const project = resolveProjectReference(this.context.sqlite, input.projectId)
      const actorUuid = this.context.actorResolver.resolveDefaultActorUuid()
      const record = mapTaskToWriteRecord({
        task: input,
        projectUuid: project.uuid,
        actorUuid,
        slug: deriveTaskSlug(input.taskId),
      })

      const result = this.context.sqlite
        .prepare(
          `UPDATE tasks
              SET project_uuid = ?,
                  state = ?,
                  workflow_preset = ?,
                  preset_version = ?,
                  phase = ?,
                  risk_class = ?,
                  meta = ?,
                  updated_by_actor_uuid = ?,
                  etag = etag + 1
            WHERE id = ? AND etag = ?`
        )
        .run(
          record.projectUuid,
          record.state,
          record.workflowPreset,
          record.presetVersion,
          record.phase,
          record.riskClass,
          record.meta,
          record.actorUuid,
          input.taskId,
          input.version
        )

      if (result.changes === 0) {
        throw new VersionConflictError(input.taskId, input.version)
      }

      replaceRoleMap(this.context.sqlite, this.context.actorResolver, existing.uuid, input.roleMap)
      return this.loadTaskById(input.taskId)
    })(task)
  }

  private loadTaskById(taskId: string): Task {
    const task = this.loadTaskByIdOrUndefined(taskId)
    if (task === undefined) {
      throw new Error(`Failed to reload task ${taskId}`)
    }

    return task
  }

  private loadTaskByIdOrUndefined(taskId: string): Task | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT t.uuid,
                t.id,
                c.id AS project_id,
                t.state,
                t.workflow_preset,
                t.preset_version,
                t.phase,
                t.risk_class,
                t.etag,
                t.meta,
                t.kind AS wrkq_kind
           FROM tasks AS t
           JOIN containers AS c ON c.uuid = t.project_uuid
          WHERE t.id = ?`
      )
      .get(taskId) as LoadedTaskRow | undefined

    if (row === undefined) {
      return undefined
    }

    return mapTaskRow(row, loadRoleMap(this.context.sqlite, row.uuid))
  }
}
