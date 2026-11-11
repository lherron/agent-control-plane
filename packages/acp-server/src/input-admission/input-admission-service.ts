import type { AttachmentRef, InputAdmissionRecord, InputApplication, InputIntent } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { HrcRuntimeIntent } from 'hrc-core'
import type { UnifiedSessionEvent } from 'spaces-runtime'
import type { ResolvedAcpServerDeps } from '../deps.js'
import type { StoredRun } from '../domain/run-store.js'
import { forbidden } from '../http.js'
import { ActiveRunContributionAdmission } from './active-run-contribution-admission.js'
import { admitActiveRunControl } from './active-run-control-admission.js'
import { AdmissionRecords } from './admission-records.js'
import { prepareInputDelivery } from './input-delivery.js'
import { admitNewWork } from './new-work-admission.js'

export type InputAdmissionResult = {
  inputAttempt: {
    inputAttemptId: string
    scopeRef: string
    laneRef: string
    taskId?: string | undefined
    idempotencyKey?: string | undefined
    actor: {
      kind: 'human' | 'agent' | 'system'
      id: string
      displayName?: string | undefined
    }
    createdAt: string
    metadata?: Readonly<Record<string, unknown>> | undefined
  }
  run?: StoredRun | undefined
  targetRun?: StoredRun | undefined
  inputApplication?: InputApplication | undefined
  admission: InputAdmissionRecord
  currentState: Readonly<Record<string, unknown>>
  created: boolean
  launched?:
    | {
        runId: string
        sessionId: string
        hostSessionId?: string | undefined
        generation?: number | undefined
      }
    | undefined
}

export type AdmitInput = {
  sessionRef: SessionRef
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  content: string
  actor: {
    kind: 'human' | 'agent' | 'system'
    id: string
    displayName?: string | undefined
  }
  metadata?: Readonly<Record<string, unknown>> | undefined
  attachments?: AttachmentRef[] | undefined
  intent?: InputIntent | undefined
  dispatch?: boolean | undefined
  launch?: {
    intent?: HrcRuntimeIntent | undefined
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    onEvent?: ((event: UnifiedSessionEvent) => void | Promise<void>) | undefined
    createOnEvent?:
      | ((input: {
          runId: string
          inputAttemptId: string
        }) => ((event: UnifiedSessionEvent) => void | Promise<void>) | undefined)
      | undefined
    waitForCompletion?: boolean | undefined
  }
}

function admissionOperationForIntent(intent: InputIntent): string {
  switch (intent.kind) {
    case 'new_work':
      return 'inputs.create'
    case 'contribute_to_active_run':
      return 'inputs.contribute_active_run'
    case 'control_active_run':
      return 'inputs.control_active_run'
  }
}

export class InputAdmissionService {
  private readonly records: AdmissionRecords

  constructor(deps: ResolvedAcpServerDeps) {
    this.records = new AdmissionRecords(deps)
  }

  async admit(input: AdmitInput): Promise<InputAdmissionResult> {
    const intent = input.intent ?? { kind: 'new_work' as const }
    const operation = admissionOperationForIntent(intent)
    if (
      this.records.deps.authorize(input.actor, operation, {
        kind: 'session',
        id: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
      }) === 'deny'
    ) {
      forbidden('authz_deny', 'forbidden')
    }

    const attempt = this.records.deps.inputAttemptStore.createAttempt({
      sessionRef: input.sessionRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      content: input.content,
      actor: input.actor,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    })
    if (!attempt.created) {
      return this.records.replay(attempt, intent)
    }
    if (intent.kind === 'control_active_run') {
      return await admitActiveRunControl(this.records, { ...input, intent }, attempt)
    }
    const delivery = await prepareInputDelivery(
      this.records.deps,
      input,
      attempt.inputAttempt.inputAttemptId
    )
    const collaboration = await this.records.recordHumanCollaborationSay({
      sessionRef: input.sessionRef,
      content: delivery.content,
      actor: input.actor,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
    })
    if (collaboration !== undefined) {
      return this.records.createAcceptedCollaborationAdmission({ attempt, intent, collaboration })
    }
    if (intent.kind === 'contribute_to_active_run') {
      return await new ActiveRunContributionAdmission(this.records).admit(
        { ...input, intent },
        attempt,
        delivery
      )
    }
    return await admitNewWork(this.records, input, intent, attempt, delivery)
  }
}
