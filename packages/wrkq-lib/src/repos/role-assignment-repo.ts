import type { RoleAssignmentStore, RoleMap } from 'acp-core'

import type { RepoContext } from './shared.js'
import { findTaskUuid, loadRoleMap, replaceRoleMap, requireTaskLookup } from './shared.js'

export class RoleAssignmentRepo implements RoleAssignmentStore {
  constructor(private readonly context: RepoContext) {}

  getRoleMap(taskId: string): RoleMap | undefined {
    return this.context.sqlite.transaction((id: string) => {
      const taskUuid = findTaskUuid(this.context.sqlite, id)

      if (taskUuid === undefined) {
        return undefined
      }

      return loadRoleMap(this.context.sqlite, taskUuid)
    })(taskId)
  }

  setRoleMap(taskId: string, roleMap: RoleMap): void {
    this.context.sqlite.transaction((id: string, nextRoleMap: RoleMap) => {
      const task = requireTaskLookup(this.context.sqlite, id)
      replaceRoleMap(this.context.sqlite, this.context.actorResolver, task.uuid, nextRoleMap)
    })(taskId, roleMap)
  }
}
