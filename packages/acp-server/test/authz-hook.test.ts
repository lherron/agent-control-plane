import { describe, expect, mock, test } from 'bun:test'

import { withWiredServer } from './fixtures/wired-server.js'

describe('authz-hook', () => {
  test('defaults to allow when no authorize hook is provided', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/admin/projects',
        body: {
          projectId: 'authz-default-allow',
          displayName: 'Default Allow',
          actor: { kind: 'human', id: 'body-operator' },
        },
      })

      expect(response.status).toBe(201)
    })
  })

  test('returns 403 authz_deny when the authorize hook denies project creation', async () => {
    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          body: {
            projectId: 'authz-denied-project',
            displayName: 'Authz Denied',
            actor: { kind: 'human', id: 'body-operator' },
          },
        })

        expect(response.status).toBe(403)
        expect(await fixture.json<{ error: { code: string; message: string } }>(response)).toEqual({
          error: {
            code: 'authz_deny',
            message: 'forbidden',
          },
        })
      },
      {
        authorize: () => 'deny',
      }
    )
  })

  test('passes the resolved actor, operation slug, and resource to the authorize hook', async () => {
    const authorize = mock(() => 'allow' as const)

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/admin/projects',
          headers: { 'x-acp-actor': 'agent:curly' },
          body: {
            projectId: 'authz-hook-args',
            displayName: 'Hook Args',
            actor: { kind: 'human', id: 'body-operator' },
          },
        })

        expect(response.status).toBe(201)
        expect(authorize).toHaveBeenCalledTimes(1)
        expect(authorize).toHaveBeenCalledWith(
          { kind: 'agent', id: 'curly' },
          'admin.projects.create',
          { kind: 'project', id: 'authz-hook-args' }
        )
      },
      { authorize }
    )
  })
})
