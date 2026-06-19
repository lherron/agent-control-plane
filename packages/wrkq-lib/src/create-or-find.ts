/**
 * create-or-find.ts — Idempotent wrkq task create-or-find port.
 *
 * Types + stub: T-04943 Phase B (RED).
 * Implementation: T-04943 Phase B execution.
 *
 * Contract:
 *   1. Find task by deterministic path BEFORE attempting create.
 *   2. If found, return it (created=false).
 *   3. If not found, create with idempotencyKey + path.
 *   4. Crash-safe: if external create succeeded before local result was
 *      persisted, the next call finds the task by path on find-first and
 *      returns the same taskId (created=false). Never a second task.
 *   5. Two calls with the same key ALWAYS return the same taskId.
 */

import type { WorkClient } from '@wrkq/client'

export type WrkqTaskCreateOrFindInput = {
  /**
   * Deterministic external idempotency key derived from the incident.
   * e.g. "acp-health:dispatch-timeout:${canonicalEventId}:task"
   */
  key: string
  /**
   * Deterministic task path (container + slug).
   * e.g. "agent-control-plane/inbox/acp-health:dispatch-timeout:evt123:task"
   */
  path: string
  /** Project container id or slug (e.g. "agent-control-plane"). */
  projectId: string
  title: string
  description?: string | undefined
}

export type WrkqTaskCreateOrFindResult = {
  taskId: string
  projectId: string
  taskPath: string
  created: boolean
}

/**
 * Find-or-create a wrkq task by deterministic path + idempotency key.
 *
 * Guarantees:
 *   - Repeated calls with the same key return the same taskId.
 *   - Crash-safe: if create succeeded externally but caller never persisted
 *     the result (crash between create and result persistence), the next call
 *     finds the task by path and returns it unchanged (created=false).
 *   - create() is called AT MOST ONCE per key across all calls.
 *
 * Find by deterministic path → if found return existing (created=false);
 * else create with idempotencyKey (created=true).
 *
 * Concurrency: concurrent calls with the same deterministic key are
 * de-duplicated through an in-process in-flight map so a single logical
 * incident never issues more than one create across racing callers.
 */
const inflightByKey = new Map<string, Promise<WrkqTaskCreateOrFindResult>>()

export async function createOrFindWrkqTask(
  client: WorkClient,
  input: WrkqTaskCreateOrFindInput
): Promise<WrkqTaskCreateOrFindResult> {
  const existing = inflightByKey.get(input.key)
  if (existing !== undefined) {
    // A concurrent caller is already creating-or-finding this exact key.
    // Join its result; from this caller's perspective the task was found.
    const result = await existing
    return { ...result, created: false }
  }

  const pending = doCreateOrFind(client, input)
  inflightByKey.set(input.key, pending)
  try {
    return await pending
  } finally {
    inflightByKey.delete(input.key)
  }
}

async function doCreateOrFind(
  client: WorkClient,
  input: WrkqTaskCreateOrFindInput
): Promise<WrkqTaskCreateOrFindResult> {
  // 1. Recover the canonical project id from the container.
  const container = await client.wrkq.container.show({ project: input.projectId })
  const projectId = container.id

  // 2. Find by deterministic path BEFORE attempting create. `task.list.path`
  // names the containing folder, not the exact task path, so list the parent
  // container and match the returned task DTO's full path.
  const parentPath = parentContainerPath(input.path)
  const listed = await client.wrkq.task.list({ path: parentPath })
  const found = listed.items.find((item) => taskPath(item) === input.path)
  if (found !== undefined) {
    return {
      taskId: found.id,
      projectId,
      taskPath: input.path,
      created: false,
    }
  }

  // 3. Not found → create with the deterministic idempotency key + path.
  const created = await client.wrkq.task.create({
    path: input.path,
    project: input.projectId,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    idempotencyKey: input.key,
  })
  return {
    taskId: created.id,
    projectId,
    taskPath: input.path,
    created: true,
  }
}

function parentContainerPath(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx === -1 ? '' : path.slice(0, idx)
}

function taskPath(task: unknown): string | undefined {
  if (task !== null && typeof task === 'object') {
    const path = (task as { path?: unknown }).path
    return typeof path === 'string' ? path : undefined
  }
  return undefined
}
