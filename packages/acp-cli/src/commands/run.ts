import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError, AcpClientTransportError, parseResponseText } from '../http-client.js'
import { renderKeyValueTable, renderTable } from '../output/table.js'
import {
  hasFlag,
  parseArgs,
  readStringFlag,
  requireNoPositionals,
  requireStringFlag,
} from './options.js'

import {
  type CommandDependencies,
  type CommandOutput,
  asJson,
  asText,
  correlationHeadersFromEnv,
  createRawAcpRequester,
  createRawRequesterFromParsed,
  renderJsonOrTable,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

type RunResponse = {
  run: Record<string, unknown>
}

type OutboundAttachmentResponse = {
  outboundAttachmentId: string
  path: string
  filename: string
  contentType: string
  sizeBytes: number
  alt?: string | undefined
}

type OutboundAttachmentListResponse = {
  attachments: OutboundAttachmentResponse[]
}

type DeleteFallbackResponse = OutboundAttachmentListResponse & {
  cleared: false
  reason: string
}

const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
}

function contentTypeFromFilename(filename: string): string | undefined {
  const dotIndex = filename.lastIndexOf('.')
  if (dotIndex < 0) {
    return undefined
  }

  return CONTENT_TYPES_BY_EXTENSION[filename.slice(dotIndex).toLowerCase()]
}

function resolveRunId(parsed: ReturnType<typeof parseArgs>, env: NodeJS.ProcessEnv): string {
  const runId = readStringFlag(parsed, '--run') ?? env['HRC_RUN_ID']
  if (runId === undefined || runId.trim().length === 0) {
    throw new CliUsageError('--run is required (or set HRC_RUN_ID)')
  }

  return runId.trim()
}

async function requireFile(path: string): Promise<void> {
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new CliUsageError(`file does not exist: ${path}`)
    }
    throw error
  }

  if (!fileStat.isFile()) {
    throw new CliUsageError(`path is not a file: ${path}`)
  }
}

function renderAttachmentSummary(attachment: OutboundAttachmentResponse): string {
  return `attached ${attachment.filename} (${attachment.sizeBytes} bytes) → ${attachment.outboundAttachmentId}`
}

function renderAttachmentTable(attachments: readonly OutboundAttachmentResponse[]): string {
  return renderTable(
    [
      { header: 'Attachment', value: (row) => row.outboundAttachmentId },
      { header: 'Filename', value: (row) => row.filename },
      { header: 'Type', value: (row) => row.contentType },
      { header: 'Bytes', value: (row) => String(row.sizeBytes) },
      { header: 'Alt', value: (row) => row.alt ?? '' },
    ],
    attachments
  )
}

async function postAttachment(input: {
  serverUrl: string
  fetchImpl: NonNullable<CommandDependencies['fetchImpl']>
  runId: string
  path: string
  filename: string
  contentType?: string | undefined
  alt?: string | undefined
  actorAgentId?: string | undefined
  headers: Readonly<Record<string, string>>
}): Promise<OutboundAttachmentResponse> {
  const form = new FormData()
  const file = Bun.file(
    input.path,
    input.contentType !== undefined ? { type: input.contentType } : {}
  )
  form.set('file', file, input.filename)
  if (input.alt !== undefined) {
    form.set('alt', input.alt)
  }
  if (input.filename !== basename(input.path)) {
    form.set('filename', input.filename)
  }
  if (input.contentType !== undefined) {
    form.set('contentType', input.contentType)
  }

  const headers = new Headers(input.headers)
  if (input.actorAgentId !== undefined) {
    headers.set('x-acp-actor-agent-id', input.actorAgentId)
  }

  let response: Response
  try {
    response = await input.fetchImpl(
      `${input.serverUrl.replace(/\/+$/, '')}/v1/runs/${encodeURIComponent(input.runId)}/outbound-attachments`,
      {
        method: 'POST',
        headers,
        body: form,
      }
    )
  } catch (error) {
    throw new AcpClientTransportError(`failed to reach ACP server at ${input.serverUrl}`, {
      cause: error,
    })
  }

  const body = parseResponseText(await response.text())
  if (!response.ok) {
    throw new AcpClientHttpError(response.status, body)
  }

  return body as OutboundAttachmentResponse
}

export async function runRunCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const subcommand = args[0]
  const rest = args.slice(1)
  const parsed = parseArgs(subcommand === 'attachment' ? args.slice(2) : rest, {
    booleanFlags: ['--json', '--table'],
    stringFlags: [
      '--run',
      '--server',
      '--actor',
      '--project',
      '--alt',
      '--filename',
      '--content-type',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('run help is handled by the top-level CLI')
  }

  if (subcommand === 'attachment') {
    const env = deps.env ?? process.env
    const attachmentSubcommand = args[1]
    const attachmentPath = parsed.positionals[0]
    const runFlag = readStringFlag(parsed, '--run')
    const runId = resolveRunId(parsed, env)
    const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env)
    const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)

    if (attachmentSubcommand === 'add') {
      if (attachmentPath === undefined || parsed.positionals.length !== 1) {
        throw new CliUsageError('usage: acp run attachment add <path> [options]')
      }

      await requireFile(attachmentPath)
      const filename = readStringFlag(parsed, '--filename')?.trim() || basename(attachmentPath)
      const explicitContentType = readStringFlag(parsed, '--content-type')?.trim()
      const contentType =
        explicitContentType && explicitContentType.length > 0
          ? explicitContentType
          : contentTypeFromFilename(filename)
      const response = await postAttachment({
        serverUrl,
        fetchImpl: deps.fetchImpl ?? fetch,
        runId,
        path: attachmentPath,
        filename,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(readStringFlag(parsed, '--alt') !== undefined
          ? { alt: readStringFlag(parsed, '--alt') }
          : {}),
        ...(actorAgentId !== undefined ? { actorAgentId } : {}),
        headers: correlationHeadersFromEnv(env, { includeHrcRunId: runFlag === undefined }),
      })

      return hasFlag(parsed, '--json')
        ? asJson(response)
        : asText(renderAttachmentSummary(response))
    }

    if (attachmentSubcommand === 'list') {
      requireNoPositionals(parsed)
      const requester = createRawAcpRequester({
        serverUrl,
        ...(actorAgentId !== undefined ? { actorAgentId } : {}),
        fetchImpl: deps.fetchImpl,
      })
      const response = await requester.requestJson<OutboundAttachmentListResponse>({
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(runId)}/outbound-attachments`,
      })
      return hasFlag(parsed, '--json')
        ? asJson(response)
        : asText(renderAttachmentTable(response.attachments))
    }

    if (attachmentSubcommand === 'clear') {
      requireNoPositionals(parsed)
      const requester = createRawAcpRequester({
        serverUrl,
        ...(actorAgentId !== undefined ? { actorAgentId } : {}),
        fetchImpl: deps.fetchImpl,
      })
      try {
        const response = await requester.requestJson<Record<string, unknown>>({
          method: 'DELETE',
          path: `/v1/runs/${encodeURIComponent(runId)}/outbound-attachments`,
          headers: correlationHeadersFromEnv(env, { includeHrcRunId: runFlag === undefined }),
        })
        return hasFlag(parsed, '--json') ? asJson(response) : asText('cleared outbound attachments')
      } catch (error) {
        if (!(error instanceof AcpClientHttpError) || error.status !== 404) {
          throw error
        }

        const response = await requester.requestJson<OutboundAttachmentListResponse>({
          method: 'GET',
          path: `/v1/runs/${encodeURIComponent(runId)}/outbound-attachments`,
        })
        const fallback: DeleteFallbackResponse = {
          ...response,
          cleared: false,
          reason: 'DELETE /v1/runs/:runId/outbound-attachments is not available',
        }
        return hasFlag(parsed, '--json')
          ? asJson(fallback)
          : asText(
              `clear endpoint unavailable; pending attachments: ${response.attachments.length}`
            )
      }
    }

    throw new CliUsageError(`unknown run attachment subcommand: ${attachmentSubcommand ?? ''}`)
  }

  requireNoPositionals(parsed)

  const requester = createRawRequesterFromParsed(parsed, deps)
  const runId = requireStringFlag(parsed, '--run')

  if (subcommand === 'show') {
    const response = await requester.requestJson<RunResponse>({
      method: 'GET',
      path: `/v1/runs/${encodeURIComponent(runId)}`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.run))
  }

  if (subcommand === 'cancel') {
    const response = await requester.requestJson<RunResponse>({
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    })
    return renderJsonOrTable(parsed, response, () => renderKeyValueTable(response.run))
  }

  throw new CliUsageError(`unknown run subcommand: ${subcommand}`)
}
