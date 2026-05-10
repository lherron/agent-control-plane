import { formatSessionRef } from 'agent-scope'

import { badRequest, json } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import { parseJsonBody, readOptionalTrimmedStringField, requireRecord } from '../parsers/body.js'
import { normalizeRealLauncherIntent } from '../real-launcher.js'
import type { RouteHandler } from '../routing/route-context.js'
import { parseSessionRefField } from './shared.js'

const ALLOWED_FIELDS = new Set([
  'sessionRef',
  'workflowInteract',
  'workflowTaskId',
  'workflowRef',
  'workflowGoal',
  'initialPrompt',
])

function assertAllowedFields(body: Record<string, unknown>): void {
  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) {
      badRequest(`unexpected field ${field}`, { field })
    }
  }
}

function requireWorkflowInteract(body: Record<string, unknown>): void {
  if (body['workflowInteract'] !== true) {
    badRequest('workflowInteract must be true', { field: 'workflowInteract' })
  }
}

export const handleCreateWorkflowInteractRun: RouteHandler = async ({ request, deps }) => {
  const body = requireRecord(await parseJsonBody(request))
  assertAllowedFields(body)
  requireWorkflowInteract(body)

  const sessionRef = parseSessionRefField(body, 'sessionRef')
  const sessionRefString = formatSessionRef(sessionRef)
  const baseIntent = await resolveLaunchIntent(deps, sessionRef, {
    initialPrompt: readOptionalTrimmedStringField(body, 'initialPrompt'),
  })
  const workflowEnv: Record<string, string> = {
    ACP_WORKFLOW_INTERACT: '1',
  }
  const workflowTaskId = readOptionalTrimmedStringField(body, 'workflowTaskId')
  const workflowRef = readOptionalTrimmedStringField(body, 'workflowRef')
  const workflowGoal = readOptionalTrimmedStringField(body, 'workflowGoal')

  if (workflowTaskId !== undefined) {
    workflowEnv['ACP_WORKFLOW_TASK_ID'] = workflowTaskId
  }
  if (workflowRef !== undefined) {
    workflowEnv['ACP_WORKFLOW_REF'] = workflowRef
  }
  if (workflowGoal !== undefined) {
    workflowEnv['ACP_WORKFLOW_GOAL'] = workflowGoal
  }

  const intent = normalizeRealLauncherIntent({
    sessionRef,
    intent: {
      ...baseIntent,
      launch: {
        ...baseIntent.launch,
        env: {
          ...baseIntent.launch?.env,
          ...workflowEnv,
        },
      },
    },
    liveTmuxRuntime: true,
  })

  if (deps.hrcClient === undefined) {
    throw new Error('acp-server hrcClient: no HRC client wired')
  }

  const resolved = await deps.hrcClient.resolveSession({
    sessionRef: sessionRefString,
    runtimeIntent: intent,
  })
  const runtime = await deps.hrcClient.startRuntime({
    hostSessionId: resolved.hostSessionId,
    intent,
    restartStyle: 'reuse_pty',
  })
  const attachDescriptor = await deps.hrcClient.getAttachDescriptor(runtime.runtimeId)

  return json({
    sessionRef: sessionRefString,
    sessionId: runtime.hostSessionId,
    runtimeId: runtime.runtimeId,
    runtime,
    attachDescriptor,
  })
}
