// PBC product facade: actions. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  CLARIFICATION_NEXT,
  DISPOSED_NEXT,
  FINALIZED_NEXT,
  INTAKE_NEXT,
  PATCH_DECISION_NEXT,
  TASK,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('GET /v1/pbc/tasks/:taskId — product actions shape and enablement (RED, T-03110)', () => {
  test('[RED] actions array contains exactly the 5 product action kinds (no raw wrkf names)', async () => {
    // BEHAVIOR_NOTE_NEXT has actions:[{transition:'draft_pbc'}]
    // Currently produces [{kind:'draft_pbc', enabled:true}] — wrong shape
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const PRODUCT_KINDS = [
          'continue',
          'submit_clarification',
          'submit_patch_decision',
          'dispose',
          'retry_effect_delivery',
        ]

        // RED: action kinds are raw wrkf names, not product kinds
        for (const kind of PRODUCT_KINDS) {
          expect(actions.map((a) => a.kind)).toContain(kind)
        }
        // No raw wrkf action names must appear
        expect(actions.map((a) => a.kind)).not.toContain('draft_pbc')
        expect(actions.map((a) => a.kind)).not.toContain('normalize_feedback')
        expect(actions.map((a) => a.kind)).not.toContain('collect_behavior_note')
      },
      { wrkf }
    )
  })

  test('[RED] working screen (active/behavior_note) → continue enabled, submit_* disabled', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const find = (kind: string) => actions.find((a) => a.kind === kind)

        // RED: actions is [{kind:'draft_pbc', enabled:true}] — 'continue' not present
        expect(find('continue')).toBeDefined()
        expect(find('continue')?.enabled).toBe(true)
        expect(find('submit_clarification')?.enabled).toBe(false)
        expect(find('submit_patch_decision')?.enabled).toBe(false)
      },
      { wrkf }
    )
  })

  test('[RED] starting screen (active/intake) → continue enabled', async () => {
    const wrkf = makeProductFakePort({ next: async () => INTAKE_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const find = (kind: string) => actions.find((a) => a.kind === kind)

        // RED: 'continue' kind not present in current raw-mapped output
        expect(find('continue')).toBeDefined()
        expect(find('continue')?.enabled).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] clarification screen (waiting/clarification) → submit_clarification enabled, continue disabled', async () => {
    const wrkf = makeProductFakePort({ next: async () => CLARIFICATION_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const find = (kind: string) => actions.find((a) => a.kind === kind)

        // RED: current actions is [] (no raw actions for waiting state)
        // submit_clarification must be present and enabled
        expect(find('submit_clarification')).toBeDefined()
        expect(find('submit_clarification')?.enabled).toBe(true)
        // continue must be disabled when waiting for human input
        expect(find('continue')?.enabled).toBe(false)
        expect(find('submit_patch_decision')?.enabled).toBe(false)
      },
      { wrkf }
    )
  })

  test('[RED] patch_decision screen (waiting/patch_decision) → submit_patch_decision enabled, continue disabled', async () => {
    const wrkf = makeProductFakePort({ next: async () => PATCH_DECISION_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const find = (kind: string) => actions.find((a) => a.kind === kind)

        // RED: current actions is [] for waiting/patch_decision
        expect(find('submit_patch_decision')).toBeDefined()
        expect(find('submit_patch_decision')?.enabled).toBe(true)
        expect(find('continue')?.enabled).toBe(false)
        expect(find('submit_clarification')?.enabled).toBe(false)
      },
      { wrkf }
    )
  })

  test('[RED] finalized screen (closed/finalized) → all product actions disabled', async () => {
    const wrkf = makeProductFakePort({ next: async () => FINALIZED_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>

        // RED: current actions is [] (no raw actions for closed) but must be 5 product actions all disabled
        expect(actions.length).toBeGreaterThan(0) // 5 product kinds must always be present
        for (const action of actions) {
          expect(action.enabled).toBe(false)
        }
      },
      { wrkf }
    )
  })

  test('[RED] disposed screen (closed/disposed) → all product actions disabled', async () => {
    const wrkf = makeProductFakePort({ next: async () => DISPOSED_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>

        // RED: current actions is [] for closed/disposed, but must be 5 all-disabled product actions
        expect(actions.length).toBeGreaterThan(0)
        for (const action of actions) {
          expect(action.enabled).toBe(false)
        }
      },
      { wrkf }
    )
  })

  test('[RED] dispose action enabled on active/working screen', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const disposeAction = actions.find((a) => a.kind === 'dispose')

        // RED: 'dispose' kind not present in current raw-mapped [{kind:'draft_pbc',...}]
        expect(disposeAction).toBeDefined()
        expect(disposeAction?.enabled).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] dispose action enabled on clarification screen (active, waiting for input)', async () => {
    const wrkf = makeProductFakePort({ next: async () => CLARIFICATION_NEXT })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const disposeAction = actions.find((a) => a.kind === 'dispose')

        // RED: 'dispose' not in raw-mapped actions (actions is [] for waiting state)
        expect(disposeAction).toBeDefined()
        expect(disposeAction?.enabled).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] retry_effect_delivery enabled when pending effect has retryable:true', async () => {
    const nextWithRetryableEffect = {
      instance: {
        id: 'inst-pbc-001',
        state: { status: 'active', phase: 'behavior_note' },
        revision: 2,
        contextHash: 'sha256:ctx-eff-retry',
      },
      actions: [{ id: 'draft_pbc', transition: 'draft_pbc', role: 'agent' }],
      blockedTransitions: [],
      openObligations: [],
      pendingEffects: [
        { id: 'eff-001', kind: 'set_task_state', status: 'failed', retryable: true },
      ],
    }
    const wrkf = makeProductFakePort({ next: async () => nextWithRetryableEffect })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const retryAction = actions.find((a) => a.kind === 'retry_effect_delivery')

        // RED: 'retry_effect_delivery' not in raw-mapped actions
        expect(retryAction).toBeDefined()
        expect(retryAction?.enabled).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] retry_effect_delivery disabled when no pending retryable effect', async () => {
    // BEHAVIOR_NOTE_NEXT has no pendingEffects
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>
        const retryAction = actions.find((a) => a.kind === 'retry_effect_delivery')

        // RED: 'retry_effect_delivery' not in raw-mapped actions at all
        expect(retryAction).toBeDefined()
        expect(retryAction?.enabled).toBe(false)
      },
      { wrkf }
    )
  })

  test('[RED] raw wrkf action names remain in diagnostics.legalTransitions (not in actions)', async () => {
    // BEHAVIOR_NOTE_NEXT: actions:[{transition:'draft_pbc'}]
    // diagnostics.legalTransitions must still contain 'draft_pbc'; actions must NOT
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const diagnostics = body['diagnostics'] as Record<string, unknown>
        const legalTransitions = diagnostics['legalTransitions'] as string[]
        const actions = body['actions'] as Array<{ kind: string; enabled: boolean }>

        // diagnostics.legalTransitions MUST still carry raw wrkf names (already passes)
        expect(legalTransitions).toContain('draft_pbc')

        // actions MUST NOT carry raw wrkf names (currently RED: actions has 'draft_pbc')
        expect(actions.map((a) => a.kind)).not.toContain('draft_pbc')
      },
      { wrkf }
    )
  })
})
