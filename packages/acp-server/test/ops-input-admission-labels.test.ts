import { describe, expect, test } from 'bun:test'
import type { SystemEvent } from 'acp-core'

import { projectInputAdmissionSystemEvent } from '../src/handlers/ops-dashboard-shared.js'

function systemEvent(kind: string, payload: Record<string, unknown> = {}): SystemEvent {
  return {
    eventId: '501',
    projectId: 'agent-spaces',
    kind,
    payload: {
      scopeRef: 'agent:curly:project:agent-spaces:task:T-01383',
      laneRef: 'main',
      hostSessionId: 'host-session-labels',
      generation: 1,
      ...payload,
    },
    occurredAt: '2026-05-07T12:00:00.000Z',
    recordedAt: '2026-05-07T12:00:00.001Z',
  }
}

describe('ops dashboard input admission labels', () => {
  test.each([
    [
      systemEvent('input.application.accepted', {
        admissionKind: 'accepted_in_flight',
        applicationStatus: 'accepted',
      }),
      'Contribution accepted',
    ],
    [
      systemEvent('input.application.pending', {
        admissionKind: 'admission_pending',
        applicationStatus: 'pending',
      }),
      'Contribution pending',
    ],
    [
      systemEvent('input.application.ambiguous', {
        admissionKind: 'admission_pending',
        applicationStatus: 'ambiguous',
      }),
      'Contribution ambiguous',
    ],
    [
      systemEvent('input.queued', {
        admissionKind: 'queued_run',
        applicationStatus: 'failed',
        reason: 'contribution_unsupported_fallback_queued',
      }),
      'Unsupported contribution fallback queued',
    ],
    [
      systemEvent('input.queued', {
        admissionKind: 'queued_run',
        queueStatus: 'queued',
      }),
      'Queued',
    ],
  ])('projects system event as %s', (event, label) => {
    const projected = projectInputAdmissionSystemEvent(event)

    expect(projected?.label).toBe(label)
    expect(projected?.label).not.toMatch(/\bsteered\b/i)
    expect(projected?.label).not.toMatch(/\bapplied\b/i)
  })
})
