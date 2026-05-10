import { describe, expect, test } from 'bun:test'

import { openAcpStateStore } from '../src/index.js'

describe('workflow evidence provenance persistence', () => {
  test('workflowRuntime snapshot round-trips EvidenceRecord provenance fields', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })

    try {
      store.workflowRuntime.saveSnapshot({
        definitions: [],
        tasks: [],
        evidence: [
          {
            evidenceId: 'evd_provenance_1',
            taskId: 'T-provenance',
            kind: 'completion_note',
            ref: 'artifact://done',
            summary: 'done',
            actor: { kind: 'agent', id: 'cody' },
            role: 'owner',
            runId: 'run-owner-1',
            participantRunId: 'participant-run-owner-1',
            supervisorRunId: 'supervisor-run-rex-1',
            createdAt: '2026-05-09T12:00:00.000Z',
          } as never,
        ],
        obligations: [],
        effects: [],
        events: [],
        supervisorRuns: [],
        participantRuns: [],
        anomalies: [],
        patchProposals: [],
        idempotency: [],
        contextHashes: [],
        sequence: 1,
      })

      expect(store.workflowRuntime.loadSnapshot().evidence).toEqual([
        {
          evidenceId: 'evd_provenance_1',
          taskId: 'T-provenance',
          kind: 'completion_note',
          ref: 'artifact://done',
          summary: 'done',
          actor: { kind: 'agent', id: 'cody' },
          role: 'owner',
          runId: 'run-owner-1',
          participantRunId: 'participant-run-owner-1',
          supervisorRunId: 'supervisor-run-rex-1',
          createdAt: '2026-05-09T12:00:00.000Z',
        },
      ])
    } finally {
      store.close()
    }
  })
})
