import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { normalizeSessionRef } from 'agent-scope'

import {
  DEFAULT_INTERFACE_MEDIA_STATE_DIR,
  contentTypeFromFilename,
  ensureAttachmentExtension,
  resolveAttachmentMaxBytes,
  sanitizeFilename,
  uniqueStoredAttachmentPath,
} from '../attachments.js'
import { AcpHttpError, json } from '../http.js'
import { readOptionalTrimmedStringOrThrow } from '../internal/read-helpers.js'
import {
  isRecord,
  parseJsonBody,
  requireRecord,
  requireTrimmedStringField,
} from '../parsers/body.js'
import type { RouteHandler } from '../routing/route-context.js'

const ACTIVE_RUN_STATUSES = new Set(['pending', 'started', 'running'])
const SUPPORTED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'application/json',
  'text/plain',
])

type MultipartFormData = Awaited<ReturnType<Request['formData']>>
type MultipartFormDataEntryValue = ReturnType<MultipartFormData['get']>
type UploadedFile = Exclude<NonNullable<MultipartFormDataEntryValue>, string>

type CorrelationFields = {
  hrcRunId?: string | undefined
  hrcHostSessionId?: string | undefined
  hrcGeneration?: string | undefined
}

type InterfaceRunSource = {
  gatewayId: string
  bindingId: string
  conversationRef: string
  threadRef?: string | undefined
  messageRef: string
  replyToMessageRef?: string | undefined
}

function getSingleFormString(form: MultipartFormData, name: string): string | undefined {
  const value = form.get(name)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function getRequestField(
  request: Request,
  url: URL,
  form: MultipartFormData | undefined,
  names: readonly string[]
): string | undefined {
  for (const name of names) {
    const headerValue = request.headers.get(name)
    if (headerValue !== null && headerValue.trim() !== '') {
      return headerValue.trim()
    }
  }

  for (const name of names) {
    const queryValue = url.searchParams.get(name)
    if (queryValue !== null && queryValue.trim() !== '') {
      return queryValue.trim()
    }
  }

  if (form !== undefined) {
    for (const name of names) {
      const formValue = getSingleFormString(form, name)
      if (formValue !== undefined) {
        return formValue
      }
    }
  }

  return undefined
}

function getCorrelationFields(
  request: Request,
  url: URL,
  form: MultipartFormData | undefined
): CorrelationFields {
  return {
    hrcRunId: getRequestField(request, url, form, ['HRC_RUN_ID', 'hrc-run-id', 'x-hrc-run-id']),
    hrcHostSessionId: getRequestField(request, url, form, [
      'HRC_HOST_SESSION_ID',
      'hrc-host-session-id',
      'x-hrc-host-session-id',
    ]),
    hrcGeneration: getRequestField(request, url, form, [
      'HRC_GENERATION',
      'hrc-generation',
      'x-hrc-generation',
    ]),
  }
}

function normalizeContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(';')[0]?.trim().toLowerCase()
  return normalized === undefined || normalized === '' ? undefined : normalized
}

function isUploadedFile(value: MultipartFormDataEntryValue): value is UploadedFile {
  return (
    value !== null &&
    typeof value !== 'string' &&
    typeof value.arrayBuffer === 'function' &&
    typeof value.size === 'number'
  )
}

function requireRunId(params: Readonly<Record<string, string | undefined>>): string {
  const runId = params['runId']
  if (runId === undefined || runId.trim() === '') {
    throw new AcpHttpError(400, 'malformed_request', 'missing runId')
  }

  return runId
}

function findRun(deps: Parameters<RouteHandler>[0]['deps'], requestedRunId: string) {
  const exact = deps.runStore.getRun(requestedRunId)
  if (exact !== undefined) {
    return exact
  }

  return deps.runStore.listRuns().find((run) => run.hrcRunId === requestedRunId)
}

function requireRun(deps: Parameters<RouteHandler>[0]['deps'], requestedRunId: string) {
  const run = findRun(deps, requestedRunId)
  if (run === undefined) {
    throw new AcpHttpError(404, 'run_not_found', `run not found: ${requestedRunId}`, {
      runId: requestedRunId,
    })
  }

  return run
}

function assertRunAcceptsOutbound(run: ReturnType<typeof requireRun>): void {
  if (!ACTIVE_RUN_STATUSES.has(String(run.status))) {
    throw new AcpHttpError(
      409,
      'run_not_accepting_outbound',
      `run is not accepting outbound attachments: ${run.runId}`,
      { runId: run.runId, status: run.status }
    )
  }
}

function assertCorrelation(
  run: ReturnType<typeof requireRun>,
  requestedRunId: string,
  correlation: CorrelationFields
): void {
  if (correlation.hrcRunId !== undefined) {
    const acceptedRunIds = new Set([requestedRunId, run.runId])
    if (run.hrcRunId !== undefined) {
      acceptedRunIds.add(run.hrcRunId)
    }

    if (!acceptedRunIds.has(correlation.hrcRunId)) {
      throw new AcpHttpError(403, 'correlation_mismatch', 'HRC_RUN_ID does not match run', {
        runId: run.runId,
        hrcRunId: correlation.hrcRunId,
      })
    }
  }

  const expectedHostSessionId = run.dispatchFence?.expectedHostSessionId
  if (
    expectedHostSessionId !== undefined &&
    correlation.hrcHostSessionId !== expectedHostSessionId
  ) {
    throw new AcpHttpError(
      403,
      'correlation_mismatch',
      'HRC_HOST_SESSION_ID does not match run dispatch fence',
      {
        runId: run.runId,
        expectedHostSessionId,
        hrcHostSessionId: correlation.hrcHostSessionId,
      }
    )
  }

  const expectedGeneration = run.dispatchFence?.expectedGeneration
  if (expectedGeneration !== undefined) {
    const actualGeneration =
      correlation.hrcGeneration !== undefined
        ? Number.parseInt(correlation.hrcGeneration, 10)
        : undefined
    if (actualGeneration === expectedGeneration) {
      return
    }

    throw new AcpHttpError(
      403,
      'correlation_mismatch',
      'HRC_GENERATION does not match run dispatch fence',
      {
        runId: run.runId,
        expectedGeneration,
        hrcGeneration: correlation.hrcGeneration,
      }
    )
  }
}

function readInterfaceRunSource(run: ReturnType<typeof requireRun>): InterfaceRunSource {
  const metadata = isRecord(run.metadata) ? run.metadata : undefined
  const meta = isRecord(metadata?.['meta']) ? metadata['meta'] : undefined
  const source = isRecord(meta?.['interfaceSource']) ? meta['interfaceSource'] : undefined
  if (source === undefined) {
    throw new AcpHttpError(
      409,
      'run_missing_interface_source',
      `run has no interface source: ${run.runId}`,
      { runId: run.runId }
    )
  }

  const threadRef = readOptionalTrimmedStringOrThrow(
    source,
    'threadRef',
    invalidInterfaceSourceField
  )
  const replyToMessageRef = readOptionalTrimmedStringOrThrow(
    source,
    'replyToMessageRef',
    invalidInterfaceSourceField
  )
  return {
    gatewayId: readRequiredString(source, 'gatewayId'),
    bindingId: readRequiredString(source, 'bindingId'),
    conversationRef: readRequiredString(source, 'conversationRef'),
    ...(threadRef !== undefined ? { threadRef } : {}),
    messageRef: readRequiredString(source, 'messageRef'),
    ...(replyToMessageRef !== undefined ? { replyToMessageRef } : {}),
  }
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AcpHttpError(
      409,
      'run_invalid_interface_source',
      `interface source missing ${field}`,
      {
        field,
      }
    )
  }
  return value.trim()
}

function invalidInterfaceSourceField(field: string): Error {
  return new AcpHttpError(
    409,
    'run_invalid_interface_source',
    `interface source has invalid ${field}`,
    { field }
  )
}

function createDeliveryRequestId(runId: string): string {
  return `dr_${runId}_oob_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function resolveOutboundFilename(
  form: MultipartFormData,
  file: UploadedFile,
  contentType: string
): string {
  const requestedFilename =
    getSingleFormString(form, 'filename') ?? (file.name !== undefined ? basename(file.name) : '')
  const sanitized = sanitizeFilename(requestedFilename || 'attachment')
  return ensureAttachmentExtension(sanitized, contentType)
}

function resolveOutboundContentType(form: MultipartFormData, file: UploadedFile): string {
  const requestedFilename =
    getSingleFormString(form, 'filename') ?? (file.name !== undefined ? basename(file.name) : '')
  const sanitizedFilename = sanitizeFilename(requestedFilename || 'attachment')
  const fileContentType = normalizeContentType(file.type)
  const contentType =
    normalizeContentType(getSingleFormString(form, 'contentType')) ??
    contentTypeFromFilename(sanitizedFilename) ??
    (fileContentType === 'application/octet-stream' ? undefined : fileContentType)

  if (contentType === undefined || !SUPPORTED_CONTENT_TYPES.has(contentType)) {
    throw new AcpHttpError(400, 'unsupported_content_type', 'unsupported attachment content type', {
      contentType,
      filename: sanitizedFilename,
    })
  }

  return contentType
}

export const handlePostRunOutboundAttachment: RouteHandler = async ({
  request,
  url,
  params,
  deps,
}) => {
  const requestedRunId = requireRunId(params)
  const run = requireRun(deps, requestedRunId)
  assertRunAcceptsOutbound(run)

  const form = await request.formData()
  assertCorrelation(run, requestedRunId, getCorrelationFields(request, url, form))

  const file = form.get('file')
  if (!isUploadedFile(file)) {
    throw new AcpHttpError(400, 'malformed_request', 'multipart field "file" is required')
  }

  const contentType = resolveOutboundContentType(form, file)
  const filename = resolveOutboundFilename(form, file, contentType)
  const maxBytes = resolveAttachmentMaxBytes(deps.attachmentMaxBytes)
  if (file.size > maxBytes) {
    throw new AcpHttpError(413, 'attachment_too_large', 'attachment exceeds max bytes', {
      runId: run.runId,
      sizeBytes: file.size,
      maxBytes,
    })
  }

  const directory = join(
    deps.mediaStateDir ?? DEFAULT_INTERFACE_MEDIA_STATE_DIR,
    'media',
    'outbound',
    run.runId
  )
  await mkdir(directory, { recursive: true })
  const path = await uniqueStoredAttachmentPath(directory, filename)
  const bytes = Buffer.from(await file.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new AcpHttpError(413, 'attachment_too_large', 'attachment exceeds max bytes', {
      runId: run.runId,
      sizeBytes: bytes.byteLength,
      maxBytes,
    })
  }
  await writeFile(path, bytes)

  const alt = getSingleFormString(form, 'alt')
  const attachment = deps.interfaceStore.outboundAttachments.create({
    runId: run.runId,
    path,
    filename,
    contentType,
    sizeBytes: bytes.byteLength,
    ...(alt !== undefined ? { alt } : {}),
  })

  return json(
    {
      outboundAttachmentId: attachment.outboundAttachmentId,
      path: attachment.path,
      filename: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.alt !== undefined ? { alt: attachment.alt } : {}),
    },
    201
  )
}

export const handlePostRunOutboundMessage: RouteHandler = async ({
  request,
  url,
  params,
  deps,
}) => {
  const requestedRunId = requireRunId(params)
  const run = requireRun(deps, requestedRunId)
  assertRunAcceptsOutbound(run)
  assertCorrelation(run, requestedRunId, getCorrelationFields(request, url, undefined))

  const body = requireRecord(await parseJsonBody(request))
  const text = requireTrimmedStringField(body, 'text')
  const source = readInterfaceRunSource(run)
  const deliveryRequestId = createDeliveryRequestId(run.runId)
  const createdAt = new Date().toISOString()

  deps.interfaceStore.deliveries.enqueue({
    deliveryRequestId,
    actor: run.actor,
    gatewayId: source.gatewayId,
    bindingId: source.bindingId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    runId: run.runId,
    conversationRef: source.conversationRef,
    ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
    ...(source.replyToMessageRef !== undefined
      ? { replyToMessageRef: source.replyToMessageRef }
      : {}),
    bodyKind: 'text/markdown',
    bodyText: text,
    createdAt,
  })

  if (deps.conversationStore !== undefined) {
    try {
      const thread = deps.conversationStore.createOrGetThread({
        gatewayId: source.gatewayId,
        conversationRef: source.conversationRef,
        ...(source.threadRef !== undefined ? { threadRef: source.threadRef } : {}),
        sessionRef: normalizeSessionRef({ scopeRef: run.scopeRef, laneRef: run.laneRef }),
        audience: 'human',
      })
      const turnId = deps.conversationStore.createTurn({
        threadId: thread.threadId,
        role: 'assistant',
        body: text,
        renderState: 'pending',
        links: { runId: run.runId },
        actor: run.actor,
        sentAt: createdAt,
      })
      deps.conversationStore.attachLinks(turnId, { deliveryRequestId })
    } catch (error) {
      console.error(
        `[acp-server] conversation turn creation failed for outbound message ${deliveryRequestId}:`,
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  return json(
    {
      deliveryRequestId,
      status: 'queued',
      body: {
        kind: 'text/markdown',
        text,
      },
    },
    201
  )
}

export const handleListRunOutboundAttachments: RouteHandler = ({ params, deps }) => {
  const requestedRunId = requireRunId(params)
  const run = requireRun(deps, requestedRunId)

  return json({
    attachments: deps.interfaceStore.outboundAttachments.listForRun(run.runId),
  })
}
