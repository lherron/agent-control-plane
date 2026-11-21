import type { EvaluateEventJob, JobsStore } from '../index.js'

export function queueFlowEvent(store: JobsStore) {
  store.insertInboxEvent({ eventId: 'flow-trigger', eventSeq: 1, event: 'created', payload: {} })
}

export const mintFlowEvent: EvaluateEventJob = ({ event, job }) => ({
  decision: 'mint',
  resolved: { scopeRef: job.scopeRef, laneRef: job.laneRef, input: job.input },
  source: { kind: 'webhook', eventId: event.eventId },
})
