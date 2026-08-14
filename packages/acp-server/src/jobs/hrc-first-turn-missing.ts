import { type JobRecord, type JobsStore, validateJobFlow } from 'acp-jobs-store'

export const HRC_EVENT_SOURCE = 'hrc'
export const HRC_FIRST_TURN_MISSING_EVENT = 'first_turn_missing'
export const HRC_FIRST_TURN_MISSING_JOB_SLUG = 'hrc-first-turn-missing-notify'
export const HRC_EVENT_LOCAL_NODE_PROBE = 'hrc-event-local-node.v1'

const JOB_PROJECT_ID = 'agent-control-plane'
const JOB_AGENT_ID = 'fettle'
const JOB_SCOPE_REF = 'agent:fettle:project:agent-control-plane:task:primary'
const JOB_LANE_REF = 'main'

export function ensureHrcFirstTurnMissingJob(store: JobsStore): JobRecord {
  const desired = hrcFirstTurnMissingJobInput()
  const existing = store
    .listJobs({ projectId: JOB_PROJECT_ID })
    .jobs.find((job) => job.slug === HRC_FIRST_TURN_MISSING_JOB_SLUG)

  if (existing === undefined) {
    return store.createJob(desired).job
  }

  return store.updateJob(existing.jobId, {
    description: desired.description,
    trigger: desired.trigger,
    input: desired.input,
    flow: desired.flow,
    disabled: false,
  }).job
}

function hrcFirstTurnMissingJobInput() {
  const flow = {
    sequence: [
      {
        id: 'verify_local_node',
        kind: 'probe' as const,
        probe: { name: HRC_EVENT_LOCAL_NODE_PROBE },
        branches: { outcome: { idle: 'succeed' as const, work: 'notify_fettle' } },
      },
      {
        id: 'notify_fettle',
        kind: 'agent-dispatch' as const,
        agentId: JOB_AGENT_ID,
        projectId: JOB_PROJECT_ID,
        scopeRef: JOB_SCOPE_REF,
        laneRef: JOB_LANE_REF,
        input: { content: '{{input.content}}' },
      },
    ],
  }
  const validation = validateJobFlow(flow, { allowInputFile: false })
  if (!validation.valid) {
    throw new Error(
      `built-in HRC first-turn-missing flow is invalid: ${validation.errors.map((error) => error.message).join('; ')}`
    )
  }

  return {
    slug: HRC_FIRST_TURN_MISSING_JOB_SLUG,
    description:
      'Built-in notification turn for HRC runtimes that trip before producing a first turn.',
    projectId: JOB_PROJECT_ID,
    agentId: JOB_AGENT_ID,
    scopeRef: JOB_SCOPE_REF,
    laneRef: JOB_LANE_REF,
    trigger: {
      kind: 'event' as const,
      source: HRC_EVENT_SOURCE,
      match: { event: HRC_FIRST_TURN_MISSING_EVENT },
      cooldown: '300s',
      // Rev3 always records the initiating principal. Real HRC trips are commonly
      // agent-initiated, so the default agent-origin deny would blind this notifier.
      originPolicy: { agent: 'allow' as const },
    },
    input: {
      nodeId: '{{payload.nodeId}}',
      content:
        'HRC first-turn-missing notification\n\nNode: {{payload.nodeId}}\nScope: {{payload.scopeRef}}\nRuntime: {{payload.runtimeId}}\nGeneration: {{payload.generation}}\nInvocation: {{payload.invocationId}}\nRun: {{payload.runId}}\n\n{{payload.retrievalHint}}',
    },
    flow,
    disabled: false,
    createdAt: '2026-08-14T00:00:00.000Z',
  }
}
