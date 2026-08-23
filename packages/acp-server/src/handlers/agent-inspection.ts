import {
  AspcValidationError,
  validateAspcCatalogAgentInspectionRequest,
} from 'spaces-aspc-protocol'
import {
  agentCatalogResponseSchema,
  agentInspectionOutcomeSchema,
  agentInspectionRequestSchema,
} from 'spaces-aspc-protocol/agent-inspection'

import type { AdminStore } from 'acp-admin-store'

import { AcpHttpError, json } from '../http.js'

import type { AgentInspectionAuthority } from '../deps.js'
import type { RouteContext, RouteHandler } from '../routing/route-context.js'

type CodedError = Error & {
  code?: unknown
  status?: unknown
  issues?: unknown
  details?: unknown
}

const MALFORMED_REQUEST_CODE = 'invalid_agent_inspection_request'
const PROTOCOL_FAILURE_CODE = 'agent_inspection_protocol_failure'
const PRODUCER_UNAVAILABLE_CODE = 'agent_inspection_producer_unavailable'

/** Trusted ACP project-id resolver supplied to Agent Spaces at service startup. */
export function resolveAgentInspectionProjectRoot(
  adminStore: AdminStore | undefined,
  projectId: string
): string | undefined {
  const project = adminStore?.projects.get(projectId)
  return project?.rootDir ?? project?.homeDir
}

function authorityFrom(context: RouteContext): AgentInspectionAuthority {
  const authority = context.deps.agentInspectionAuthority
  if (authority === undefined) {
    throw new AcpHttpError(
      503,
      PRODUCER_UNAVAILABLE_CODE,
      'Agent Spaces inspection authority is unavailable'
    )
  }
  return authority
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof Error)) return undefined
  const coded = error as CodedError
  const details: Record<string, unknown> = {}
  if (Array.isArray(coded.issues)) details['issues'] = coded.issues
  if (
    typeof coded.details === 'object' &&
    coded.details !== null &&
    !Array.isArray(coded.details)
  ) {
    Object.assign(details, coded.details)
  }
  return Object.keys(details).length === 0 ? undefined : details
}

function malformed(error: unknown, message = 'Agent inspection request is invalid'): never {
  throw new AcpHttpError(400, MALFORMED_REQUEST_CODE, message, errorDetails(error))
}

function validateCatalogRequest(url: URL): { projectId?: string | undefined } {
  for (const key of url.searchParams.keys()) {
    if (key !== 'projectId') malformed(undefined, `query parameter ${key} is not accepted`)
  }
  const projectIds = url.searchParams.getAll('projectId')
  if (projectIds.length > 1) malformed(undefined, 'projectId must be supplied at most once')
  const request = projectIds.length === 0 ? {} : { projectId: projectIds[0] }
  try {
    return validateAspcCatalogAgentInspectionRequest(request)
  } catch (error) {
    malformed(error)
  }
}

function producerError(error: unknown): never {
  if (error instanceof AcpHttpError) throw error
  if (error instanceof AspcValidationError) {
    throw new AcpHttpError(
      502,
      PROTOCOL_FAILURE_CODE,
      'Agent Spaces rejected the adapter protocol request',
      errorDetails(error)
    )
  }

  const coded = error instanceof Error ? (error as CodedError) : undefined
  const isProtocolFailure =
    typeof coded?.code === 'string' && coded.code.startsWith('INVALID_ASPC_')
  const status =
    typeof coded?.status === 'number' && [400, 404, 502, 503].includes(coded.status)
      ? coded.status
      : isProtocolFailure
        ? 502
        : 503
  const code =
    typeof coded?.code === 'string' && coded.code.length > 0
      ? coded.code
      : PRODUCER_UNAVAILABLE_CODE
  throw new AcpHttpError(
    status,
    code,
    error instanceof Error ? error.message : 'Agent Spaces inspection authority is unavailable',
    errorDetails(error)
  )
}

function parseCatalogOutcome(
  value: unknown,
  expectedProjectId: string | null
): ReturnType<typeof agentCatalogResponseSchema.parse> {
  try {
    const catalog = agentCatalogResponseSchema.parse(value)
    if (catalog.projectId !== expectedProjectId) {
      throw new Error('catalog projectId does not match the validated request')
    }
    return catalog
  } catch (error) {
    throw new AcpHttpError(
      502,
      PROTOCOL_FAILURE_CODE,
      'Agent Spaces returned an invalid catalog response',
      errorDetails(error)
    )
  }
}

function parseInspectionOutcome(
  value: unknown,
  expectedIdentity: unknown
): ReturnType<typeof agentInspectionOutcomeSchema.parse> {
  try {
    const outcome = agentInspectionOutcomeSchema.parse(value)
    if (
      outcome.ok &&
      JSON.stringify(outcome.inspection.identity) !== JSON.stringify(expectedIdentity)
    ) {
      throw new Error('inspection identity does not match the validated request')
    }
    return outcome
  } catch (error) {
    throw new AcpHttpError(
      502,
      PROTOCOL_FAILURE_CODE,
      'Agent Spaces returned an invalid inspection response',
      errorDetails(error)
    )
  }
}

export const handleCatalogAgentInspection: RouteHandler = async (context) => {
  const request = validateCatalogRequest(context.url)
  try {
    const catalog = await authorityFrom(context).catalogAgentInspection(request)
    return json(parseCatalogOutcome(catalog, request.projectId ?? null))
  } catch (error) {
    producerError(error)
  }
}

export const handleInspectAgentSelection: RouteHandler = async (context) => {
  const agentId = context.params['agentId']
  if (agentId === undefined || agentId.length === 0) malformed(undefined, 'agentId is required')

  let body: unknown
  try {
    body = await context.request.json()
  } catch (error) {
    malformed(error, 'request body must be valid JSON')
  }
  const parsed = agentInspectionRequestSchema.safeParse(body)
  if (!parsed.success) malformed(parsed.error)
  if (parsed.data.identifiers.agentId !== agentId) {
    malformed(undefined, 'identifiers.agentId must match the route agentId')
  }

  try {
    const outcome = parseInspectionOutcome(
      await authorityFrom(context).inspectAgentSelection({ agentId, request: parsed.data }),
      parsed.data.identifiers
    )
    return json(outcome, outcome.ok ? 200 : 502)
  } catch (error) {
    producerError(error)
  }
}
