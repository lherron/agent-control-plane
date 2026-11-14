import type { Actor, AdminProject } from 'acp-core'
import { type MutableActorStamp, sameActor, serializeMutableActorStamp } from './actor-stamps.js'
import { validateOptionalPath } from './placement-path.js'
import type { SqliteDatabase } from './sqlite.js'

type ProjectRow = {
  project_id: string
  display_name: string
  default_agent_id: string | null
  root_dir: string | null
  created_at: string
  updated_at: string
  actor_stamp: string
}

export interface CreateProjectInput {
  projectId: string
  displayName: string
  homeDir?: string | undefined
  rootDir?: string | undefined
  actor: Actor
  now: string
}

export interface ProjectsStore {
  create(input: CreateProjectInput): AdminProject
  list(): AdminProject[]
  get(projectId: string): AdminProject | undefined
  setDefaultAgent(input: {
    projectId: string
    agentId: string
    actor: Actor
    now: string
  }): AdminProject | undefined
}

function toAdminProject(row: ProjectRow): AdminProject {
  const stamp = JSON.parse(row.actor_stamp) as MutableActorStamp
  return {
    projectId: row.project_id,
    displayName: row.display_name,
    ...(row.default_agent_id === null ? {} : { defaultAgentId: row.default_agent_id }),
    ...(row.root_dir === null ? {} : { homeDir: row.root_dir }),
    ...(row.root_dir === null ? {} : { rootDir: row.root_dir }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: stamp.createdBy,
    updatedBy: stamp.updatedBy,
  }
}

const SELECT_RECORD = `SELECT project_id, display_name, default_agent_id, root_dir, created_at, updated_at, actor_stamp
           FROM projects`

export function createProjectsStore(sqlite: SqliteDatabase): ProjectsStore {
  return {
    create(input) {
      const homeDir = validateOptionalPath(input.homeDir, 'homeDir')
      const rootDir = validateOptionalPath(input.rootDir, 'rootDir')
      if (homeDir !== null && rootDir !== null && homeDir !== rootDir) {
        throw new Error('homeDir and rootDir must match when both are provided')
      }
      const projectDir = homeDir ?? rootDir
      const existing = this.get(input.projectId)
      if (existing !== undefined) {
        if (
          existing.displayName === input.displayName &&
          sameActor(existing.createdBy, input.actor)
        ) {
          return existing
        }

        throw new Error(`project ${input.projectId} already exists with different values`)
      }

      sqlite
        .prepare(
          `INSERT INTO projects (
            project_id,
            display_name,
            default_agent_id,
            root_dir,
            created_at,
            updated_at,
            actor_stamp
          ) VALUES (?, ?, NULL, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.displayName,
          projectDir,
          input.now,
          input.now,
          serializeMutableActorStamp(input.actor, input.actor)
        )

      return this.get(input.projectId) as AdminProject
    },

    list() {
      return (
        sqlite
          .prepare(
            `${SELECT_RECORD}
           ORDER BY created_at ASC, project_id ASC`
          )
          .all() as ProjectRow[]
      ).map(toAdminProject)
    },

    get(projectId) {
      const row = sqlite
        .prepare(
          `${SELECT_RECORD}
           WHERE project_id = ?`
        )
        .get(projectId) as ProjectRow | undefined

      return row === undefined ? undefined : toAdminProject(row)
    },

    setDefaultAgent(input) {
      const existing = this.get(input.projectId)
      if (existing === undefined) {
        return undefined
      }

      sqlite
        .prepare(
          `UPDATE projects
           SET default_agent_id = ?, updated_at = ?, actor_stamp = ?
           WHERE project_id = ?`
        )
        .run(
          input.agentId,
          input.now,
          serializeMutableActorStamp(existing.createdBy, input.actor),
          input.projectId
        )

      return this.get(input.projectId)
    },
  }
}
