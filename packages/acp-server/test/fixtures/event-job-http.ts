import { createInMemoryAdminStore } from 'acp-admin-store'
import type { Actor } from 'acp-core'
import { createInMemoryJobsStore } from 'acp-jobs-store'
import type { AcpServerDeps } from '../../src/deps.js'
import { withWiredServer } from './wired-server.js'

const ACTOR: Actor = { kind: 'system', id: 'test' }

export function makeDeps(options: { jobsStore?: boolean } = {}) {
  const adminStore = createInMemoryAdminStore()
  const jobsStore = options.jobsStore === false ? undefined : createInMemoryJobsStore()
  const deps = { adminStore, jobsStore, defaultActor: ACTOR }
  return { adminStore, jobsStore, deps }
}

export function jsonRequest(method: string, path: string, body: unknown): Request {
  return new Request(`http://acp.local${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function call(
  request: Request,
  deps: Pick<AcpServerDeps, 'adminStore' | 'jobsStore' | 'defaultActor'>
): Promise<Response> {
  return withWiredServer((fixture) => fixture.handler(request), deps)
}
