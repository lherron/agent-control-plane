import {
  readOptionalBoolean,
  readOptionalRecordField,
  readOptionalString,
  readOptionalStringArray,
  requireRecord,
  requireString,
} from './value.js'

export const PBC_WORKFLOW_TEMPLATE_REF = 'pbc-progressive-refinement@5'

export type PbcScopeModel = {
  required?: boolean | undefined
  source?: string | undefined
  defaultShape?: string | undefined
  allowedKinds: string[]
  laneDefault?: string | undefined
  handoffPolicy?: string | undefined
  raw: Record<string, unknown>
}

export type PbcPromptCatalogEntry = {
  kind?: string | undefined
  summary?: string | undefined
  templateRefs: string[]
  raw: Record<string, unknown>
}

export type PbcRoleModel = {
  basePromptRef?: string | undefined
  purpose?: string | undefined
  hardRules: string[]
  raw: Record<string, unknown>
}

export type PbcPhaseGuidance = {
  agentInstruction: string
  expectedEvidence: string[]
  blockedBy: string[]
  avoid: string[]
  decisionFacts?: Record<string, unknown> | undefined
  raw: Record<string, unknown>
}

export type PbcTransitionGuidance = {
  prompt: string
  produceEvidence: string[]
  satisfyObligations: string[]
  operatorHint?: string | undefined
  raw: Record<string, unknown>
}

export type PbcTemplateModel = {
  schemaVersion?: string | undefined
  scope: PbcScopeModel
  promptCatalog: Record<string, PbcPromptCatalogEntry>
  roles: Record<string, PbcRoleModel>
  phaseGuidance: Record<string, PbcPhaseGuidance>
  transitionGuidance: Record<string, PbcTransitionGuidance>
  raw: Record<string, unknown>
}

export function projectPbcTemplateModelFromWorkflowShow(value: unknown): PbcTemplateModel {
  const workflow = requireRecord(value, 'workflow')
  const nestedWorkflow = readOptionalRecordField(workflow, 'workflow', 'workflow')
  const nestedTemplate = readOptionalRecordField(workflow, 'template', 'workflow')
  const nextActionModel =
    workflow['nextActionModel'] ??
    nestedWorkflow?.['nextActionModel'] ??
    nestedTemplate?.['nextActionModel']

  return projectPbcTemplateModel(nextActionModel, 'workflow.nextActionModel')
}

export function projectPbcTemplateModel(value: unknown, label = 'nextActionModel'): PbcTemplateModel {
  const model = requireRecord(value, label)
  const schemaVersion = readOptionalString(model, 'schemaVersion')
  return {
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    scope: projectScopeModel(model['scope'], `${label}.scope`),
    promptCatalog: projectRecordMap(
      model['promptCatalog'],
      `${label}.promptCatalog`,
      projectPromptCatalogEntry
    ),
    roles: projectRecordMap(model['roles'], `${label}.roles`, projectRoleModel),
    phaseGuidance: projectRecordMap(
      model['phaseGuidance'],
      `${label}.phaseGuidance`,
      projectPhaseGuidance
    ),
    transitionGuidance: projectRecordMap(
      model['transitionGuidance'],
      `${label}.transitionGuidance`,
      projectTransitionGuidance
    ),
    raw: model,
  }
}

export function getPhaseGuidance(
  model: PbcTemplateModel,
  state: { status: string; phase: string }
): PbcPhaseGuidance | undefined {
  return model.phaseGuidance[`${state.status}/${state.phase}`]
}

export function getTransitionGuidance(
  model: PbcTemplateModel,
  transition: string
): PbcTransitionGuidance | undefined {
  return model.transitionGuidance[transition]
}

function projectScopeModel(value: unknown, label: string): PbcScopeModel {
  const scope = requireRecord(value, label)
  const required = readOptionalBoolean(scope, 'required')
  const source = readOptionalString(scope, 'source')
  const defaultShape = readOptionalString(scope, 'defaultShape')
  const allowedKinds = readOptionalStringArray(scope, 'allowedKinds', label) ?? []
  const laneDefault = readOptionalString(scope, 'laneDefault')
  const handoffPolicy = readOptionalString(scope, 'handoffPolicy')
  return {
    ...(required !== undefined ? { required } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(defaultShape !== undefined ? { defaultShape } : {}),
    allowedKinds,
    ...(laneDefault !== undefined ? { laneDefault } : {}),
    ...(handoffPolicy !== undefined ? { handoffPolicy } : {}),
    raw: scope,
  }
}

function projectPromptCatalogEntry(
  value: unknown,
  label: string
): PbcPromptCatalogEntry {
  const entry = requireRecord(value, label)
  const kind = readOptionalString(entry, 'kind')
  const summary = readOptionalString(entry, 'summary')
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(summary !== undefined ? { summary } : {}),
    templateRefs: readOptionalStringArray(entry, 'templateRefs', label) ?? [],
    raw: entry,
  }
}

function projectRoleModel(value: unknown, label: string): PbcRoleModel {
  const role = requireRecord(value, label)
  const basePromptRef = readOptionalString(role, 'basePromptRef')
  const purpose = readOptionalString(role, 'purpose')
  const hardRules = readOptionalStringArray(role, 'hardRules', label)
  if (hardRules === undefined) {
    throw new Error(`${label}.hardRules must be an array of strings`)
  }
  return {
    ...(basePromptRef !== undefined ? { basePromptRef } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    hardRules,
    raw: role,
  }
}

function projectPhaseGuidance(value: unknown, label: string): PbcPhaseGuidance {
  const guidance = requireRecord(value, label)
  const decisionFacts = readOptionalRecordField(guidance, 'decisionFacts', label)
  return {
    agentInstruction: requireString(guidance, 'agentInstruction', label),
    expectedEvidence: readOptionalStringArray(guidance, 'expectedEvidence', label) ?? [],
    blockedBy: readOptionalStringArray(guidance, 'blockedBy', label) ?? [],
    avoid: readOptionalStringArray(guidance, 'avoid', label) ?? [],
    ...(decisionFacts !== undefined ? { decisionFacts } : {}),
    raw: guidance,
  }
}

function projectTransitionGuidance(value: unknown, label: string): PbcTransitionGuidance {
  const guidance = requireRecord(value, label)
  const operatorHint = readOptionalString(guidance, 'operatorHint')
  return {
    prompt: requireString(guidance, 'prompt', label),
    produceEvidence: readOptionalStringArray(guidance, 'produceEvidence', label) ?? [],
    satisfyObligations: readOptionalStringArray(guidance, 'satisfyObligations', label) ?? [],
    ...(operatorHint !== undefined ? { operatorHint } : {}),
    raw: guidance,
  }
}

function projectRecordMap<T>(
  value: unknown,
  label: string,
  projector: (value: unknown, label: string) => T
): Record<string, T> {
  const record = requireRecord(value, label)
  const output: Record<string, T> = {}
  for (const [key, entry] of Object.entries(record)) {
    output[key] = projector(entry, `${label}.${key}`)
  }
  return output
}
