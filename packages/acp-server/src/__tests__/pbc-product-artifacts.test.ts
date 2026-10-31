// PBC product facade: artifacts. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import { DISPOSED_NEXT, TASK, makeProductFakePort } from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('GET /v1/pbc/tasks/:taskId — artifacts populated from evidence (RED, T-03110)', () => {
  test('[RED] intake_metadata evidence → artifacts.intake defined with data', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        {
          id: 'ev-001',
          kind: 'intake_metadata',
          data: { title: 'Fix login button', description: 'Mobile UX issue' },
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts is {} — intake must be populated but is missing
        expect(artifacts['intake']).toBeDefined()
        const intake = artifacts['intake'] as Record<string, unknown>
        expect(intake['data']).toEqual({
          title: 'Fix login button',
          description: 'Mobile UX issue',
        })
      },
      { wrkf }
    )
  })

  test('[RED] behavior_note evidence → artifacts.behaviorNote defined', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-002', kind: 'behavior_note', data: { notes: 'User double-taps save button' } },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts.behaviorNote must be defined from evidence
        expect(artifacts['behaviorNote']).toBeDefined()
        const bn = artifacts['behaviorNote'] as Record<string, unknown>
        expect((bn['data'] as Record<string, unknown>)['notes']).toBe(
          'User double-taps save button'
        )
      },
      { wrkf }
    )
  })

  test('[RED] pbc_draft evidence → artifacts.draft defined with first-class data', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        { id: 'ev-002', kind: 'behavior_note', data: { notes: 'test' } },
        { id: 'ev-003', kind: 'pbc_draft', data: { content: 'Initial draft of the PBC document' } },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts.draft must be populated — currently {} so draft is missing
        expect(artifacts['draft']).toBeDefined()
        const draft = artifacts['draft'] as Record<string, unknown>
        // data is first-class on ArtifactView (not nested inside another wrapper)
        expect(draft['data']).toBeDefined()
        expect((draft['data'] as Record<string, unknown>)['content']).toBe(
          'Initial draft of the PBC document'
        )
      },
      { wrkf }
    )
  })

  test('[RED] pre_interview_analysis evidence → artifacts.preInterviewAnalysis defined', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        {
          id: 'ev-002',
          kind: 'pre_interview_analysis',
          data: { analysis: 'Likely needs a clarification round' },
          facts: { clarification_needed: true },
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts.preInterviewAnalysis must be defined from evidence
        expect(artifacts['preInterviewAnalysis']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] pressure_pass + pbc_final evidence → artifacts.pressurePass and artifacts.final defined', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        { id: 'ev-002', kind: 'pbc_draft', data: { content: 'First draft' } },
        {
          id: 'ev-003',
          kind: 'pressure_pass',
          data: { review: 'Looks ready' },
          facts: { verdict: 'ready', reviewedDraftEvidenceId: 'ev-002' },
        },
        {
          id: 'ev-004',
          kind: 'pbc_final',
          data: { content: 'Final PBC document' },
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: both must be defined from evidence
        expect(artifacts['pressurePass']).toBeDefined()
        expect(artifacts['final']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] after revise loop, artifacts.draft shows LATEST fresh draft (not stale pre-boundary)', async () => {
    // Evidence timeline:
    //   ev-003: pbc_draft (stale — before revision boundary)
    //   ev-004: pressure_pass(verdict=too_vague) — REVISION BOUNDARY
    //   ev-005: pbc_draft (fresh — after boundary, this is the one to show)
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        { id: 'ev-002', kind: 'behavior_note', data: { notes: 'test' } },
        { id: 'ev-003', kind: 'pbc_draft', data: { content: 'Stale first draft', version: 1 } },
        {
          id: 'ev-004',
          kind: 'pressure_pass',
          data: { review: 'Too vague' },
          facts: { verdict: 'too_vague', reviewedDraftEvidenceId: 'ev-003' },
        },
        // ↑ revision boundary (too_vague verdict)
        { id: 'ev-005', kind: 'pbc_draft', data: { content: 'Fresh second draft', version: 2 } },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts.draft must be defined and show the LATEST fresh draft (ev-005)
        expect(artifacts['draft']).toBeDefined()
        const draft = artifacts['draft'] as Record<string, unknown>
        const draftData = draft['data'] as Record<string, unknown>
        // Must show the fresh draft (ev-005), NOT the stale one (ev-003)
        expect(draftData['content']).toBe('Fresh second draft')
        expect(draftData['version']).toBe(2)
      },
      { wrkf }
    )
  })

  test('[RED] clarification_response + patch_decision evidence → respective artifact keys defined', async () => {
    const wrkf = makeProductFakePort({
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        {
          id: 'ev-002',
          kind: 'clarification_response',
          data: { answer: 'The user double-clicks the save button' },
        },
        {
          id: 'ev-003',
          kind: 'patch_decision',
          data: { notes: 'Patch applied' },
          facts: { route: 'finalize' },
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: both must be present in artifacts (currently {} — missing)
        expect(artifacts['clarificationResponse']).toBeDefined()
        expect(artifacts['patchDecision']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] disposition_decision evidence → artifacts.disposition defined', async () => {
    const wrkf = makeProductFakePort({
      next: async () => DISPOSED_NEXT,
      evidenceList: async () => [
        { id: 'ev-001', kind: 'intake_metadata', data: { title: 'Fix login button' } },
        {
          id: 'ev-002',
          kind: 'disposition_decision',
          data: { reason: 'Out of scope for this sprint' },
          facts: { resolution: 'out_of_scope' },
        },
      ],
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const artifacts = body['artifacts'] as Record<string, unknown>

        // RED: artifacts.disposition must be defined from evidence
        expect(artifacts['disposition']).toBeDefined()
      },
      { wrkf }
    )
  })
})
