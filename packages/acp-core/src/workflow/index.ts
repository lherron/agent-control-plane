import type * as Types from './types.js'
import { clone } from './value-semantics.js'
export type * from './types.js'
export { stableJson } from '../internal/canonical-json.js'
import { createContexts } from './contexts.js'
import { createEvidenceCommands } from './evidence-commands.js'
import { createJournal } from './journal.js'
import { createKernelState } from './kernel-state.js'
import { createObligationCommands } from './obligation-commands.js'
import { createParticipantCommands } from './participant-commands.js'
import { createSupervisorCommands } from './supervisor-commands.js'
import { createSupervisorTransitions } from './supervisor-transitions.js'
import { createTaskCommands } from './task-commands.js'
import { createTransitionCommands } from './transition-commands.js'
import { createTransitionPolicy } from './transition-policy.js'

export function createInMemoryWorkflowKernel(
  input: { now?: string | undefined; snapshot?: Types.WorkflowKernelSnapshot | undefined } = {}
) {
  const state = createKernelState(input)
  const journal = createJournal(state)
  const policy = createTransitionPolicy(state, journal)
  const taskCommands = createTaskCommands(state, journal)
  const contexts = createContexts(state, policy)
  const evidenceCommands = createEvidenceCommands(state, journal)
  const obligationCommands = createObligationCommands(state, journal)
  const participantCommands = createParticipantCommands(journal, state, contexts)
  const supervisorTransitions = createSupervisorTransitions(state, journal, policy)
  const supervisorCommands = createSupervisorCommands(
    journal,
    state,
    contexts,
    evidenceCommands,
    obligationCommands,
    supervisorTransitions
  )
  const transitionCommands = createTransitionCommands(journal, state, policy, evidenceCommands)
  const {
    idempotency,
    events,
    effects,
    obligations,
    definitions,
    tasks,
    evidence,
    supervisorRuns,
    participantRuns,
    anomalies,
    patchProposals,
    workflowHrcRunMaps,
    currentContextHashes,
  } = state
  const { publishWorkflowDefinition, getWorkflowDefinition, createTask } = taskCommands
  const { compileSupervisorContext, compileParticipantContext } = contexts
  const { attachEvidence } = evidenceCommands
  const { waiveObligation, cancelObligation, expireObligation } = obligationCommands
  const {
    startParticipantRun,
    recordWorkflowHrcRunMap,
    resumeParticipantRun,
    markParticipantRunRunning,
    completeParticipantRun,
    failParticipantRun,
    cancelParticipantRun,
  } = participantCommands
  const { startSupervisorRun, submitControlAction } = supervisorCommands
  const { applyTransition } = transitionCommands
  return {
    publishWorkflowDefinition,
    getWorkflowDefinition,
    createTask,
    startSupervisorRun,
    applyTransition,
    attachEvidence,
    waiveObligation,
    cancelObligation,
    expireObligation,
    submitControlAction,
    compileParticipantContext,
    compileSupervisorContext,
    startParticipantRun,
    recordWorkflowHrcRunMap,
    resumeParticipantRun,
    markParticipantRunRunning,
    completeParticipantRun,
    failParticipantRun,
    cancelParticipantRun,
    getTask: (taskId: string): Types.WorkflowTask | undefined => clone(tasks.get(taskId)),
    listEvents: (taskId: string): Types.WorkflowEvent[] => clone(events.get(taskId) ?? []),
    listSupervisorRuns: (taskId: string): Types.SupervisorRunRecord[] =>
      clone(supervisorRuns.get(taskId) ?? []),
    listEvidence: (taskId: string): Types.EvidenceRecord[] => clone(evidence.get(taskId) ?? []),
    listObligations: (taskId: string): Types.ObligationRecord[] =>
      clone(obligations.get(taskId) ?? []),
    listEffectIntents: (taskId: string): Types.EffectIntent[] => clone(effects.get(taskId) ?? []),
    listWorkflowHrcRunMaps: (taskId: string): Types.WorkflowHrcRunMap[] =>
      clone(workflowHrcRunMaps.get(taskId) ?? []),
    listParticipantRuns: (taskId: string): Types.ParticipantRunRecord[] =>
      clone(participantRuns.get(taskId) ?? []),
    listAnomalies: (taskId: string): Types.WorkflowAnomaly[] => clone(anomalies.get(taskId) ?? []),
    listWorkflowPatchProposals: (taskId: string): Types.WorkflowPatchProposal[] =>
      clone(patchProposals.get(taskId) ?? []),
    exportSnapshot: (): Types.WorkflowKernelSnapshot => ({
      definitions: clone([...definitions.values()]),
      tasks: clone([...tasks.values()]),
      evidence: clone([...evidence.values()].flat()),
      obligations: clone([...obligations.values()].flat()),
      effects: clone([...effects.values()].flat()),
      events: clone([...events.values()].flat()),
      workflowHrcRunMaps: clone([...workflowHrcRunMaps.values()].flat()),
      supervisorRuns: clone([...supervisorRuns.values()].flat()),
      participantRuns: clone([...participantRuns.values()].flat()),
      anomalies: clone([...anomalies.values()].flat()),
      patchProposals: clone([...patchProposals.values()].flat()),
      idempotency: clone(
        [...idempotency.entries()].map(([key, record]) => ({
          key,
          record,
        }))
      ),
      contextHashes: [...currentContextHashes.entries()].map(([taskId, hashes]) => ({
        taskId,
        hashes: [...hashes],
      })),
      sequence: state.getSequence(),
    }),
  }
}
