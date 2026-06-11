import {
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalRecordField,
  readOptionalString,
  readRecord,
  requireNumber,
  requireRecord,
  requireString,
} from './value.js'

export type WrkfWorkflowState = {
  status: string
  phase: string
}

export type WrkfInstance = {
  id?: string | undefined
  instanceId?: string | undefined
  taskRef?: string | undefined
  workflowRef?: string | undefined
  template?: Record<string, unknown> | undefined
  state: WrkfWorkflowState
  revision: number
  contextHash?: string | undefined
  stale?: boolean | undefined
  raw: Record<string, unknown>
}

export type ActionRecord = {
  id?: string | undefined
  kind?: string | undefined
  transition?: string | undefined
  role?: string | undefined
  label?: string | undefined
  raw: Record<string, unknown>
}

export type BlockedTransitionRecord = {
  id?: string | undefined
  transition?: string | undefined
  reason?: string | undefined
  raw: Record<string, unknown>
}

export type EvidenceRecord = {
  id: string
  kind: string
  ref?: string | undefined
  summary?: string | undefined
  facts?: Record<string, unknown> | undefined
  data?: unknown
  actor?: unknown
  role?: string | undefined
  raw: Record<string, unknown>
}

export type ObligationRecord = {
  id: string
  kind: string
  status: string
  evidenceId?: string | undefined
  raw: Record<string, unknown>
}

export type EffectRecord = {
  id: string
  kind: string
  status: string
  payload?: Record<string, unknown> | undefined
  idempotencyKey?: string | undefined
  revision?: number | undefined
  attempts?: number | undefined
  retryable?: boolean | undefined
  raw: Record<string, unknown>
}

export type NextActionResponse = {
  instance: WrkfInstance
  actions: ActionRecord[]
  blockedTransitions: BlockedTransitionRecord[]
  openObligations: ObligationRecord[]
  pendingEffects: EffectRecord[]
  raw: Record<string, unknown>
}

export function projectNextActionResponse(value: unknown): NextActionResponse {
  const next = requireRecord(value, 'next')
  const instance = projectInstance(next['instance'], 'next.instance')

  return {
    instance,
    actions: projectOptionalArray(next, 'actions', 'next', projectActionRecord),
    blockedTransitions: projectOptionalArray(
      next,
      'blockedTransitions',
      'next',
      projectBlockedTransitionRecord
    ),
    openObligations: projectOptionalArray(next, 'openObligations', 'next', projectObligationRecord),
    pendingEffects: projectOptionalArray(next, 'pendingEffects', 'next', projectEffectRecord),
    raw: next,
  }
}

export function projectInstance(value: unknown, label = 'instance'): WrkfInstance {
  const instance = requireRecord(value, label)
  const state = projectWorkflowState(instance, label)
  const revision = requireNumber(instance, 'revision', label)
  const template = readOptionalRecordField(instance, 'template', label)
  const id = readOptionalString(instance, 'id')
  const instanceId = readOptionalString(instance, 'instanceId')
  const taskRef = readOptionalString(instance, 'taskRef')
  const workflowRef = projectWorkflowRef(instance, template)
  const contextHash = readOptionalString(instance, 'contextHash')
  const stale = readOptionalBoolean(instance, 'stale')

  return {
    ...(id !== undefined ? { id } : {}),
    ...(instanceId !== undefined ? { instanceId } : {}),
    ...(taskRef !== undefined ? { taskRef } : {}),
    ...(workflowRef !== undefined ? { workflowRef } : {}),
    ...(template !== undefined ? { template } : {}),
    state,
    revision,
    ...(contextHash !== undefined ? { contextHash } : {}),
    ...(stale !== undefined ? { stale } : {}),
    raw: instance,
  }
}

export function projectEvidenceRecord(value: unknown, label = 'evidence'): EvidenceRecord {
  const evidence = requireRecord(value, label)
  const facts = readOptionalRecordField(evidence, 'facts', label)
  const ref = readOptionalString(evidence, 'ref')
  const summary = readOptionalString(evidence, 'summary')
  const role = readOptionalString(evidence, 'role')
  return {
    id: requireString(evidence, 'id', label),
    kind: requireString(evidence, 'kind', label),
    ...(ref !== undefined ? { ref } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(facts !== undefined ? { facts } : {}),
    ...(Object.prototype.hasOwnProperty.call(evidence, 'data') ? { data: evidence['data'] } : {}),
    ...(Object.prototype.hasOwnProperty.call(evidence, 'actor')
      ? { actor: evidence['actor'] }
      : {}),
    ...(role !== undefined ? { role } : {}),
    raw: evidence,
  }
}

export function projectObligationRecord(value: unknown, label = 'obligation'): ObligationRecord {
  const obligation = requireRecord(value, label)
  const evidenceId = readOptionalString(obligation, 'evidenceId')
  return {
    id: requireString(obligation, 'id', label),
    kind: requireString(obligation, 'kind', label),
    status: requireString(obligation, 'status', label),
    ...(evidenceId !== undefined ? { evidenceId } : {}),
    raw: obligation,
  }
}

export function projectEffectRecord(value: unknown, label = 'effect'): EffectRecord {
  const effect = requireRecord(value, label)
  const payload = readOptionalRecordField(effect, 'payload', label)
  const idempotencyKey = readOptionalString(effect, 'idempotencyKey')
  const revision = readOptionalNumber(effect, 'revision')
  const attempts = readOptionalNumber(effect, 'attempts')
  const retryable = readOptionalBoolean(effect, 'retryable')
  return {
    id: requireString(effect, 'id', label),
    kind: requireString(effect, 'kind', label),
    status: requireString(effect, 'status', label),
    ...(payload !== undefined ? { payload } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    raw: effect,
  }
}

function projectWorkflowState(instance: Record<string, unknown>, label: string): WrkfWorkflowState {
  const state = readRecord(instance['state'])
  if (state !== undefined) {
    return {
      status: requireString(state, 'status', `${label}.state`),
      phase: requireString(state, 'phase', `${label}.state`),
    }
  }

  return {
    status: requireString(instance, 'status', label),
    phase: requireString(instance, 'phase', label),
  }
}

function projectWorkflowRef(
  instance: Record<string, unknown>,
  template: Record<string, unknown> | undefined
): string | undefined {
  const direct =
    readOptionalString(instance, 'workflowRef') ?? readOptionalString(instance, 'workflowId')
  if (direct !== undefined) {
    return direct
  }

  if (template === undefined) {
    return undefined
  }
  const id = readOptionalString(template, 'id')
  const version = readOptionalString(template, 'version')
  if (id === undefined) {
    return undefined
  }
  return version === undefined ? id : `${id}@${version}`
}

function projectActionRecord(value: unknown, label = 'action'): ActionRecord {
  const action = requireRecord(value, label)
  const id = readOptionalString(action, 'id')
  const kind = readOptionalString(action, 'kind')
  // PBC@5 emits transition-kind actions with id='transition_<name>' (no 'transition' field).
  // Strip the prefix so harness can use the bare wrkf transition name.
  const explicitTransition = readOptionalString(action, 'transition')
  const derivedTransition =
    explicitTransition ??
    (kind === 'transition' && typeof id === 'string' && id.startsWith('transition_')
      ? id.slice('transition_'.length)
      : id)
  const role = readOptionalString(action, 'role')
  const labelText = readOptionalString(action, 'label')
  return {
    ...(id !== undefined ? { id } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(derivedTransition !== undefined ? { transition: derivedTransition } : {}),
    ...(role !== undefined ? { role } : {}),
    ...(labelText !== undefined ? { label: labelText } : {}),
    raw: action,
  }
}

function projectBlockedTransitionRecord(
  value: unknown,
  label = 'blockedTransition'
): BlockedTransitionRecord {
  const blocked = requireRecord(value, label)
  const id = readOptionalString(blocked, 'id')
  const transition = readOptionalString(blocked, 'transition') ?? id
  const reason = readOptionalString(blocked, 'reason')
  return {
    ...(id !== undefined ? { id } : {}),
    ...(transition !== undefined ? { transition } : {}),
    ...(reason !== undefined ? { reason } : {}),
    raw: blocked,
  }
}

function projectOptionalArray<T>(
  input: Record<string, unknown>,
  field: string,
  label: string,
  projector: (value: unknown, label: string) => T
): T[] {
  const value = input[field]
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label}.${field} must be an array`)
  }
  return value.map((entry, index) => projector(entry, `${label}.${field}[${index}]`))
}
