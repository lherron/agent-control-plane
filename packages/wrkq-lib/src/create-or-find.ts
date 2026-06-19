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
 * NOT YET IMPLEMENTED — stub throws to keep Phase B tests RED.
 * Implement: list by path → if found return existing; else create with idempotencyKey.
 */
export async function createOrFindWrkqTask(
  client: WorkClient,
  input: WrkqTaskCreateOrFindInput
): Promise<WrkqTaskCreateOrFindResult> {
  // Phase B implementation:
  //   1. client.wrkq.task.list({ path: input.path }) → if items[0] exists, return it (created=false)
  //   2. client.wrkq.task.create({ path: input.path, title: input.title, idempotencyKey: input.key, ... })
  //   3. recover projectId from client.wrkq.container.show({ project: input.projectId }).id
  throw new Error('createOrFindWrkqTask: not implemented — T-04943 Phase B')
}
