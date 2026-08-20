import { describe, expect, test } from 'bun:test'

import type { WorkClient, WrkqTask, WrkqTaskListParams } from '@wrkq/client'

import { withWiredServer } from './fixtures/wired-server.js'

const TASK: WrkqTask = {
  uuid: 'task-uuid',
  id: 'T-07370',
  slug: 'wrkq-read-route',
  title: 'Read-only wrkq route',
  projectUuid: 'project-uuid',
  path: 'agent-control-plane/inbox/wrkq-read-route',
  state: 'open',
  priority: 2,
  kind: 'task',
  description: 'must not cross the HTTP boundary',
  specification: 'must not cross the HTTP boundary',
  labels: [],
  meta: {},
  etag: 1,
  createdAt: '2026-08-20T12:00:00Z',
  updatedAt: '2026-08-20T13:00:00Z',
}

function fakeWorkClient(
  requests: WrkqTaskListParams[],
  result: { items: WrkqTask[]; nextCursor?: string }
): WorkClient {
  return {
    wrkq: {
      task: {
        list: async (request = {}) => {
          requests.push(request)
          return result
        },
      },
    },
  } as unknown as WorkClient
}

describe('GET /v1/wrkq/tasks', () => {
  test('forwards native board filters and returns summary-only task rows', async () => {
    const requests: WrkqTaskListParams[] = []
    const workClient = fakeWorkClient(requests, { items: [TASK], nextCursor: 'next-page' })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: '/v1/wrkq/tasks?project=agent-control-plane&state=open,in_progress&state=blocked&limit=25&sort=priority&direction=asc&cursor=current-page',
        })

        expect(response.status).toBe(200)
        expect(requests).toEqual([
          {
            path: 'agent-control-plane',
            state: ['open', 'in_progress', 'blocked'],
            limit: 25,
            sort: 'priority',
            direction: 'asc',
            cursor: 'current-page',
            recursive: true,
            summary: true,
          },
        ])
        expect(await json(response)).toEqual({
          tasks: [
            {
              id: 'T-07370',
              title: 'Read-only wrkq route',
              state: 'open',
              priority: 2,
              kind: 'task',
              path: 'agent-control-plane/inbox/wrkq-read-route',
              project: 'agent-control-plane',
              updatedAt: '2026-08-20T13:00:00Z',
            },
          ],
          nextCursor: 'next-page',
        })
      },
      { workClient }
    )
  })

  test('uses bounded board defaults and preserves an explicit container-path recursion choice', async () => {
    const requests: WrkqTaskListParams[] = []
    const workClient = fakeWorkClient(requests, { items: [] })

    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'GET',
          path: '/v1/wrkq/tasks?path=agent-control-plane%2Finbox&recursive=false',
        })

        expect(response.status).toBe(200)
        expect(requests).toEqual([
          {
            path: 'agent-control-plane/inbox',
            limit: 100,
            sort: 'updated_at',
            direction: 'desc',
            recursive: false,
            summary: true,
          },
        ])
        expect(await json(response)).toEqual({ tasks: [], nextCursor: null })
      },
      { workClient }
    )
  })

  test('rejects invalid states, oversized limits, and ambiguous path selectors before listing', async () => {
    const requests: WrkqTaskListParams[] = []
    const workClient = fakeWorkClient(requests, { items: [] })

    await withWiredServer(
      async ({ request }) => {
        for (const path of [
          '/v1/wrkq/tasks?state=not-a-state',
          '/v1/wrkq/tasks?limit=201',
          '/v1/wrkq/tasks?project=agent-control-plane&path=agent-control-plane%2Finbox',
        ]) {
          const response = await request({ method: 'GET', path })
          expect(response.status).toBe(400)
        }
        expect(requests).toEqual([])
      },
      { workClient }
    )
  })
})
