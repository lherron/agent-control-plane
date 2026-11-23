import { describe, expect, test } from 'bun:test'
import { HrcDomainError } from 'hrc-core'
import {
  BASE_SCOPE_REF,
  BASE_SESSION_REF,
  REQUEST_ID,
  createMobileSessionHrcClient,
  withMobileSessionServer,
} from './fixtures/mobile-session-creation.js'

describe('mobile alternate scope consent (T-13458)', () => {
  test.each(['primary', 'minisvc'])(
    'requires confirmation for %s and preserves exact approval',
    async (taskId) => {
      const { client, starts } = createMobileSessionHrcClient()
      await withMobileSessionServer(async ({ post }) => {
        for (const confirmedTaskId of [undefined, `${taskId}-nova`]) {
          const response = await post({
            taskId,
            requestId: `${taskId}-${confirmedTaskId ?? 'initial'}`,
            scopeConfirmation: {
              mode: 'require',
              ...(confirmedTaskId ? { confirmedTaskId } : {}),
            },
          })
          expect(response.status).toBe(200)
          expect(starts.at(-1)).toMatchObject({
            conflictPolicy: 'confirm',
            baseSessionRef: `agent:mable:project:hrc-runtime:task:${taskId}/lane:main`,
          })
          expect((starts.at(-1) as unknown as Record<string, unknown>)['confirmedTaskId']).toBe(
            confirmedTaskId
          )
        }
      }, client)
    }
  )

  test('preserves authoritative proposal detail without a second start', async () => {
    const scopeConfirmation = {
      baseTaskId: 'primary',
      proposedTaskId: 'primary-nova',
      occupied: {
        scopeRef: BASE_SCOPE_REF,
        sessionRef: BASE_SESSION_REF,
        hostSessionId: 'hsid-existing',
        generation: 8,
        isLive: true,
      },
    }
    const { client, starts } = createMobileSessionHrcClient({
      startError: new HrcDomainError('session_scope_confirmation_required', 'confirm alternate', {
        scopeConfirmation,
      }),
    })
    await withMobileSessionServer(async ({ post, json }) => {
      const response = await post({ scopeConfirmation: { mode: 'require' } })
      expect(response.status).toBe(409)
      expect(await json(response)).toMatchObject({
        ok: false,
        requestId: REQUEST_ID,
        code: 'session_scope_confirmation_required',
        detail: { scopeConfirmation },
      })
      expect(starts).toHaveLength(1)
    }, client)
  })

  test.each([
    { scopeConfirmation: null },
    { scopeConfirmation: {} },
    { scopeConfirmation: { mode: 'suffix' } },
    { scopeConfirmation: { mode: 'require', confirmedTaskId: '' } },
    { scopeConfirmation: { mode: 'require', confirmedTaskId: 4 } },
    { scopeConfirmation: { mode: 'require', extra: true } },
    { taskId: 'hrcdev', scopeConfirmation: { mode: 'require' } },
    { force: { mode: 'new_context' }, scopeConfirmation: { mode: 'require' } },
  ])('refuses malformed/incompatible confirmation before HRC: %j', async (extra) => {
    const fixture = createMobileSessionHrcClient()
    await withMobileSessionServer(async ({ post }) => {
      const response = await post(extra)
      expect(response.status).toBe(400)
      expect(fixture.resolveCalls).toHaveLength(0)
      expect(fixture.starts).toHaveLength(0)
    }, fixture.client)
  })
})
