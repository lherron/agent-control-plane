import { describe, expect, test } from 'bun:test'

import {
  type WorkClient,
  WorkRpcError,
  type WrkqComment,
  type WrkqRelation,
  type WrkqTask,
} from '@wrkq/client'

import { withWiredServer } from './fixtures/wired-server.js'

const TASK: WrkqTask = {
  uuid: 'task-uuid',
  id: 'T-07475',
  slug: 'wrkq-task-inspector-plugin',
  title: 'Add selection-following wrkq task inspector plugin',
  projectUuid: 'project-uuid',
  path: 'hrc-ios/inbox/wrkq-task-inspector-plugin',
  state: 'in_progress',
  priority: 2,
  kind: 'task',
  description: 'Task description',
  specification: 'Task specification',
  outcome: 'Task outcome',
  labels: ['ui', 'plugin'],
  meta: { workflowPreset: 'implementation', phase: 'build', resolution: 'landed' },
  riskClass: 'medium',
  etag: 4,
  startAt: '2026-08-22T10:00:00Z',
  dueAt: '2026-08-24T10:00:00Z',
  createdAt: '2026-08-22T09:00:00Z',
  updatedAt: '2026-08-22T12:00:00Z',
  completedAt: '2026-08-22T12:00:00Z',
  acknowledgedAt: '2026-08-22T12:01:00Z',
  assigneePrincipalRef: 'agent:cody',
  claimedBy: 'agent:cody',
  claimedScope: 'agent:cody:project:hrc-ios:task:T-07475',
  claimedNode: 'max3',
  claimedAt: '2026-08-22T10:01:00Z',
  claimGeneration: 3,
}

function comment(id: string, createdAt: string): WrkqComment {
  return {
    uuid: `${id}-uuid`,
    id,
    task: TASK.id,
    body: `body ${id}`,
    meta: {},
    etag: 1,
    createdAt,
    createdByPrincipalRef: 'agent:cody',
  }
}

function fakeWorkClient(options?: { notFound?: boolean }) {
  const calls: Array<{ method: string; params: unknown }> = []
  const comments = [
    comment('C-00001', '2026-08-22T10:00:00Z'),
    comment('C-00002', '2026-08-22T11:00:00Z'),
    comment('C-00003', '2026-08-22T12:00:00Z'),
  ]
  const relation: WrkqRelation = {
    fromTask: TASK.id,
    toTask: 'T-07474',
    kind: 'relates_to',
    direction: 'outgoing',
  }

  const client = {
    wrkq: {
      task: {
        show: async (params: unknown) => {
          calls.push({ method: 'task.show', params })
          if (options?.notFound === true) {
            throw new WorkRpcError({
              code: -32004,
              message: `task not found: ${TASK.id}`,
              data: { code: 'WRKQ_NOT_FOUND' },
            })
          }
          return TASK
        },
      },
      comment: {
        list: async (params: { cursor?: string }) => {
          calls.push({ method: 'comment.list', params })
          return params.cursor === undefined
            ? { items: comments.slice(0, 2), nextCursor: 'page-2' }
            : { items: comments.slice(2) }
        },
      },
      relation: {
        list: async (params: unknown) => {
          calls.push({ method: 'relation.list', params })
          return { items: [relation] }
        },
      },
    },
  } as unknown as WorkClient

  return { client, calls }
}

describe('GET /v1/wrkq/tasks/:taskId', () => {
  test('returns one full task with latest bounded comments and relations', async () => {
    const { client, calls } = fakeWorkClient()

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: '/v1/wrkq/tasks/T-07475?comments=2',
        })

        expect(response.status).toBe(200)
        expect(await json(response)).toEqual({
          task: {
            id: 'T-07475',
            title: 'Add selection-following wrkq task inspector plugin',
            state: 'in_progress',
            priority: 2,
            kind: 'task',
            project: 'hrc-ios',
            path: 'hrc-ios/inbox/wrkq-task-inspector-plugin',
            labels: ['ui', 'plugin'],
            assignee: 'agent:cody',
            assigneePrincipalRef: 'agent:cody',
            claimedBy: 'agent:cody',
            claimedScope: 'agent:cody:project:hrc-ios:task:T-07475',
            claimedNode: 'max3',
            claimedAt: '2026-08-22T10:01:00Z',
            claimGeneration: 3,
            description: 'Task description',
            specification: 'Task specification',
            outcome: 'Task outcome',
            resolution: 'landed',
            workflowPreset: 'implementation',
            phase: 'build',
            riskClass: 'medium',
            startAt: '2026-08-22T10:00:00Z',
            dueAt: '2026-08-24T10:00:00Z',
            createdAt: '2026-08-22T09:00:00Z',
            updatedAt: '2026-08-22T12:00:00Z',
            completedAt: '2026-08-22T12:00:00Z',
            acknowledgedAt: '2026-08-22T12:01:00Z',
            etag: 4,
          },
          comments: [
            {
              id: 'C-00003',
              kind: null,
              body: 'body C-00003',
              author: 'agent:cody',
              principalRef: 'agent:cody',
              scopeRef: null,
              createdAt: '2026-08-22T12:00:00Z',
              updatedAt: null,
            },
            {
              id: 'C-00002',
              kind: null,
              body: 'body C-00002',
              author: 'agent:cody',
              principalRef: 'agent:cody',
              scopeRef: null,
              createdAt: '2026-08-22T11:00:00Z',
              updatedAt: null,
            },
          ],
          relations: [
            {
              fromTask: 'T-07475',
              toTask: 'T-07474',
              kind: 'relates_to',
              direction: 'outgoing',
              createdAt: null,
            },
          ],
        })
        expect(calls).toHaveLength(4)
        expect(calls[0]).toEqual({ method: 'task.show', params: { task: 'T-07475' } })
        expect(calls).toEqual(
          expect.arrayContaining([
            { method: 'comment.list', params: { task: 'T-07475', limit: 500 } },
            {
              method: 'comment.list',
              params: { task: 'T-07475', limit: 500, cursor: 'page-2' },
            },
            { method: 'relation.list', params: { task: 'T-07475' } },
          ])
        )
      },
      { workClient: client }
    )
  })

  test('rejects malformed ids and comment limits before reading wrkq', async () => {
    const { client, calls } = fakeWorkClient()

    await withWiredServer(
      async ({ request }) => {
        for (const path of [
          '/v1/wrkq/tasks/primary',
          '/v1/wrkq/tasks/T-07475?comments=-1',
          '/v1/wrkq/tasks/T-07475?comments=26',
        ]) {
          const response = await request({ method: 'GET', path })
          expect(response.status).toBe(400)
        }
        expect(calls).toEqual([])
      },
      { workClient: client }
    )
  })

  test('maps a missing wrkq task to the existing 404 domain boundary', async () => {
    const { client, calls } = fakeWorkClient({ notFound: true })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({ method: 'GET', path: '/v1/wrkq/tasks/T-07475' })
        expect(response.status).toBe(404)
        expect(await json<{ error: { code: string } }>(response)).toMatchObject({
          error: { code: 'WRKQ_NOT_FOUND' },
        })
        expect(calls).toEqual([{ method: 'task.show', params: { task: 'T-07475' } }])
      },
      { workClient: client }
    )
  })
})
