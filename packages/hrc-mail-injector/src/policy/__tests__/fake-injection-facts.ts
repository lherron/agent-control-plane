import type { HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'

/** Test-owned facts behind the fake HrcInjectionPort; no HRC database or writer. */
export class FakeInjectionFacts {
  private readonly sessionRows = new Map<string, HrcSessionRecord>()
  private readonly runtimeRows = new Map<string, HrcRuntimeSnapshot>()
  private readonly invocationRows = new Map<string, { capabilitiesJson?: string }>()
  private readonly eventRows: FakeBrokerEvent[] = []
  private readonly bindings = new Map<
    string,
    {
      scopeRef: string
      homeNodeId: string
      updatedAt: string
      state: 'active'
    }
  >()

  readonly sessions = {
    insert: (record: HrcSessionRecord) => {
      this.sessionRows.set(record.hostSessionId, structuredClone(record))
      return structuredClone(record)
    },
    getByHostSessionId: (id: string) => structuredClone(this.sessionRows.get(id) ?? null),
  }

  readonly runtimes = {
    insert: (record: HrcRuntimeSnapshot) => {
      this.runtimeRows.set(record.runtimeId, structuredClone(record))
      return structuredClone(record)
    },
    getByRuntimeId: (id: string) => structuredClone(this.runtimeRows.get(id) ?? null),
    update: (id: string, patch: Partial<HrcRuntimeSnapshot>) => {
      const row = this.runtimeRows.get(id)
      if (row === undefined) return null
      Object.assign(row, patch)
      return structuredClone(row)
    },
    updateStatus: (id: string, status: HrcRuntimeSnapshot['status'], updatedAt: string) =>
      this.runtimes.update(id, { status, statusChangedAt: updatedAt, updatedAt }),
    listAll: () => structuredClone([...this.runtimeRows.values()]),
    listByHostSessionId: (id: string) =>
      this.runtimes
        .listAll()
        .filter((row) => row.hostSessionId === id)
        .sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.runtimeId.localeCompare(b.runtimeId)
        ),
    listLiveSessionRefs: () =>
      [
        ...new Set(
          this.runtimes
            .listAll()
            .filter(
              (row) =>
                row.scopeRef.startsWith('agent:') &&
                ['starting', 'ready', 'busy', 'awaiting_input', 'stopping'].includes(row.status)
            )
            .map((row) => `${row.scopeRef}/lane:${row.laneRef}`)
        ),
      ].sort(),
  }

  readonly brokerInvocations = {
    insert: (row: { invocationId: string; capabilitiesJson?: string; [key: string]: unknown }) => {
      this.invocationRows.set(row.invocationId, structuredClone(row))
    },
    getByInvocationId: (id: string) => this.invocationRows.get(id),
  }

  private eventsFor(runtimeId: string) {
    return this.eventRows
      .filter((row) => row.runtimeId === runtimeId && row.evidenceOrigin !== 'retained')
      .sort((a, b) => a.time.localeCompare(b.time) || a.seq - b.seq)
  }

  readonly brokerInvocationEvents = {
    appendEvent: (row: FakeBrokerEvent) => {
      const prior = this.eventRows.find(
        (item) => item.invocationId === row.invocationId && item.seq === row.seq
      )
      if (prior !== undefined) {
        // HRC's append_raw (hrc-native projection/mod.rs) keys on invocation
        // and seq and compares only payload, runId, harnessGeneration and
        // turnAttempt. Comparing the whole row made a replay that straddled
        // a millisecond (a fresh `time`) a conflict.
        if (brokerEventIdentity(prior) !== brokerEventIdentity(row))
          throw new Error('conflicting fake broker event')
        return
      }
      this.eventRows.push(structuredClone(row))
    },
    maxBrokerSeq: (id: string) =>
      Math.max(0, ...this.eventRows.filter((row) => row.invocationId === id).map((row) => row.seq)),
    hasInputAccepted: (runtimeId: string, inputId: string) =>
      this.eventsFor(runtimeId).some(
        (row) => row.type === 'input.accepted' && row.payload['inputId'] === inputId
      ),
    findAdmissionRejection: (runtimeId: string, submissionId: string) => {
      const row = this.eventsFor(runtimeId)
        .reverse()
        .find(
          (row) => row.type === 'admission.rejected' && row.payload['submissionId'] === submissionId
        )
      return row?.payload['layer'] == null
        ? undefined
        : { layer: row.payload['layer'], reason: row.payload['reason'] ?? '' }
    },
    findSubmissionDisposition: (runtimeId: string, submissionId: string) => {
      const row = this.eventsFor(runtimeId).find(
        (row) =>
          [
            'submission.absorbed',
            'submission.executed',
            'submission.rejected',
            'submission.expired',
            'submission.withdrawn',
            'submission.cancelled',
            'submission.lost',
          ].includes(row.type) && row.payload['submissionId'] === submissionId
      )
      return row === undefined ? undefined : { type: row.type, ...row.payload }
    },
    findInputRejectionDeliveryEvidence: (runtimeId: string, submissionId: string) => {
      const row = this.eventsFor(runtimeId).find(
        (row) => row.type === 'input.rejected' && row.payload['inputId'] === submissionId
      )
      const evidence = row?.payload['deliveryEvidence']
      return evidence === 'not_written' || evidence === 'possibly_written' ? evidence : undefined
    },
    // HRC BrokerEventsQueryOp / BrokerEventsQueryResponse (hrc-core):
    // unique-submission-after returns a result only for one distinct admission
    // matching runtime, invocation, envelope and the exclusive broker cursor.
    findUniqueSubmissionForEnvelopeAfter: (input: {
      runtimeId: string
      invocationId: string
      afterSeq: number
      envelopeId: string
    }) => {
      const ids = new Set(
        this.eventsFor(input.runtimeId)
          .filter(
            (row) =>
              row.invocationId === input.invocationId &&
              row.seq > input.afterSeq &&
              row.type === 'admission.requested' &&
              (row.payload['origin'] as { envelopeId?: string } | undefined)?.envelopeId ===
                input.envelopeId
          )
          .map((row) => row.payload['submissionId'])
          .filter((id): id is string => typeof id === 'string')
      )
      return ids.size === 1 ? [...ids][0] : undefined
    },
  }

  readonly hrcEvents = {
    maxHrcSeq: () => 0,
    listByKind: () => [],
  }

  readonly placement = {
    installActive: (input: { scopeRef: string; homeNodeId: string; updatedAt: string }) => {
      this.bindings.set(input.scopeRef, { ...input, state: 'active' })
    },
    list: () => [...this.bindings.values()],
  }
}

/** The fields HRC compares when the same invocation and seq is appended again. */
function brokerEventIdentity(row: FakeBrokerEvent): string {
  return JSON.stringify([
    row.payload,
    row['runId'] ?? null,
    row['harnessGeneration'] ?? null,
    row['turnAttempt'] ?? null,
  ])
}

type FakeBrokerEvent = {
  invocationId: string
  runtimeId: string
  seq: number
  time: string
  type: string
  payload: Record<string, unknown>
  evidenceOrigin?: 'retained'
  [key: string]: unknown
}
