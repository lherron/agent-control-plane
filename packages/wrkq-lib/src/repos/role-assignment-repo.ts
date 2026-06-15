import type { RoleAssignmentStore, RoleMap } from 'acp-core'

import type { RepoContext } from './shared.js'
import { findTaskUuid, loadRoleMap, replaceRoleMap, requireTaskLookup } from './shared.js'

export class RoleAssignmentRepo implements RoleAssignmentStore {
  constructor(private readonly context: RepoContext) {}

  async getRoleMap(taskId: string): Promise<RoleMap | undefined> {
    return this.context.sqlite.transaction((id: string) => {
      const taskUuid = findTaskUuid(this.context.sqlite, id)

      if (taskUuid === undefined) {
        return undefined
      }

      return loadRoleMap(this.context.sqlite, taskUuid)
    })(taskId)
  }

  async setRoleMap(taskId: string, roleMap: RoleMap): Promise<void> {
    this.context.sqlite.transaction((id: string, nextRoleMap: RoleMap) => {
      const task = requireTaskLookup(this.context.sqlite, id)
      replaceRoleMap(this.context.sqlite, this.context.actorResolver, task.uuid, nextRoleMap)
    })(taskId, roleMap)
  }
}
