import type { InputIntent } from 'acp-core'
import {
  type AdmissionAttempt,
  type AdmissionRecords,
  admissionResponse,
} from './admission-records.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'
import type { AdmitInput, InputAdmissionResult } from './input-admission-service.js'

export async function admitActiveRunControl(
  records: AdmissionRecords,
  input: AdmitInput & {
    intent: Extract<InputIntent, { kind: 'control_active_run' }>
  },
  attempt: AdmissionAttempt
): Promise<InputAdmissionResult> {
  const deps = records.deps
  if (deps.hrcClient === undefined || input.intent.action === 'pause') {
    return records.createRejectedAdmission({
      attempt,
      intent: input.intent,
      reason:
        input.intent.action === 'pause'
          ? 'control_action_not_supported'
          : 'hrc_client_not_configured',
    })
  }

  const resolved = await deps.hrcClient.resolveSession({
    sessionRef: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
  })
  if (!resolved.found) {
    return records.createRejectedAdmission({
      attempt,
      intent: input.intent,
      reason: 'runtime_not_found',
    })
  }
  const runtimes = await deps.hrcClient.listRuntimes({
    hostSessionId: resolved.hostSessionId,
  })
  const latest = runtimes.at(-1)
  if (latest === undefined) {
    return records.createRejectedAdmission({
      attempt,
      intent: input.intent,
      reason: 'runtime_not_found',
    })
  }

  if (input.intent.action === 'interrupt') {
    await deps.hrcClient.interrupt(latest.runtimeId)
  } else {
    await deps.hrcClient.terminate(latest.runtimeId)
  }

  const currentState = {
    controlStatus: 'accepted',
    action: input.intent.action,
    runtimeId: latest.runtimeId,
    hostSessionId: latest.hostSessionId,
  }
  const admission = deps.inputAdmissionStore.create({
    inputAttemptId: attempt.inputAttempt.inputAttemptId,
    admissionKind: 'accepted_in_flight',
    intent: input.intent,
    originalResponse: admissionResponse({
      kind: 'accepted_in_flight',
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      currentState,
    }),
    currentState,
    status: 'accepted',
  })
  recordInputAdmissionEvent(deps, {
    eventKind: 'input.application.accepted',
    scopeRef: attempt.inputAttempt.scopeRef,
    laneRef: attempt.inputAttempt.laneRef,
    inputAttemptId: attempt.inputAttempt.inputAttemptId,
    admission,
    payload: {
      controlAction: input.intent.action,
      runtimeId: latest.runtimeId,
      hostSessionId: latest.hostSessionId,
    },
  })
  return {
    inputAttempt: attempt.inputAttempt,
    admission,
    currentState,
    created: true,
  }
}
