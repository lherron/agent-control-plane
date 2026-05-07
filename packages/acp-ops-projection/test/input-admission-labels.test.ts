import { describe, expect, test } from 'bun:test'
import type { InputAdmissionKind, InputApplicationStatus } from 'acp-core'

import { type HrcLifecycleEvent, projectHrcToDashboardEvent } from '../src/index.js'

const allAdmissionKinds = [
  'started_run',
  'queued_run',
  'accepted_in_flight',
  'admission_pending',
  'rejected',
] as const satisfies readonly InputAdmissionKind[]

const allApplicationStatuses = [
  'pending',
  'accepted',
  'applied',
  'failed',
  'ambiguous',
  'cancelled',
] as const satisfies readonly InputApplicationStatus[]

type MissingAdmissionKind = Exclude<InputAdmissionKind, (typeof allAdmissionKinds)[number]>
type MissingApplicationStatus = Exclude<
  InputApplicationStatus,
  (typeof allApplicationStatuses)[number]
>

const assertEveryAdmissionKindCovered: MissingAdmissionKind extends never ? true : never = true
const assertEveryApplicationStatusCovered: MissingApplicationStatus extends never ? true : never =
  true

const baseEvent = (overrides: Partial<HrcLifecycleEvent> = {}): HrcLifecycleEvent => ({
  hrcSeq: 200,
  ts: '2026-05-07T12:00:00.000Z',
  sessionRef: {
    scopeRef: 'agent:curly:project:agent-spaces:task:T-01383',
    laneRef: 'main',
  },
  hostSessionId: 'host-session-labels',
  generation: 1,
  eventKind: 'input.application.accepted',
  category: 'input',
  payload: {},
  ...overrides,
})

describe('input admission UX labels', () => {
  test('label coverage tracks every admission kind and application status', () => {
    expect(assertEveryAdmissionKindCovered).toBe(true)
    expect(assertEveryApplicationStatusCovered).toBe(true)
    expect(allAdmissionKinds).toHaveLength(5)
    expect(allApplicationStatuses).toHaveLength(6)
  })

  test.each([
    [
      'accepted contribution',
      baseEvent({
        eventKind: 'input.application.accepted',
        payload: { admissionKind: 'accepted_in_flight', applicationStatus: 'accepted' },
      }),
      'Contribution accepted',
    ],
    [
      'pending contribution',
      baseEvent({
        eventKind: 'input.application.pending',
        payload: { admissionKind: 'admission_pending', applicationStatus: 'pending' },
      }),
      'Contribution pending',
    ],
    [
      'ambiguous contribution',
      baseEvent({
        eventKind: 'input.application.ambiguous',
        payload: { admissionKind: 'admission_pending', applicationStatus: 'ambiguous' },
      }),
      'Contribution ambiguous',
    ],
    [
      'unsupported contribution queue fallback',
      baseEvent({
        eventKind: 'input.queued',
        payload: {
          admissionKind: 'queued_run',
          applicationStatus: 'failed',
          reason: 'contribution_unsupported_fallback_queued',
        },
      }),
      'Unsupported contribution fallback queued',
    ],
    [
      'ordinary queued work',
      baseEvent({
        eventKind: 'input.queued',
        payload: { admissionKind: 'queued_run', queueStatus: 'queued' },
      }),
      'Queued',
    ],
  ])('projects %s as %s', (_name, event, label) => {
    const projected = projectHrcToDashboardEvent(event)

    expect(projected.label).toBe(label)
    expect(projected.label).not.toMatch(/\bsteered\b/i)
    expect(projected.label).not.toMatch(/\bapplied\b/i)
  })
})
