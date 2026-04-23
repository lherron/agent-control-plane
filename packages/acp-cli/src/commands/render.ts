import { hasFlag, parseArgs, readStringFlag, requireNoPositionals } from '../cli-args.js'
import { CliUsageError } from '../cli-runtime.js'
import { AcpClientHttpError, AcpClientTransportError } from '../http-client.js'
import {
  type RenderedView,
  parseNdjsonText,
  reduceEventStream,
  reduceEvents,
  streamNdjsonEvents,
} from '../output/replay-reducer.js'

import { resolveConcreteSessionId } from './session-shared.js'
import {
  type CommandDependencies,
  type CommandOutput,
  asText,
  createRawRequesterFromParsed,
  renderJsonOrTable,
  resolveEnv,
  resolveOptionalActorAgentId,
  resolveServerUrl,
} from './shared.js'

type CaptureResponse = {
  text: string
}

/**
 * Render the session view.
 *
 * Default mode (**replay-backed**): fetches `/sessions/{id}/events` and
 * reduces the event stream into a rendered text view via a state fold.
 *
 * Snapshot mode (`--source capture`): fetches `/sessions/{id}/capture`
 * for a point-in-time capture snapshot — clearly labeled as such.
 */
export async function runRenderCommand(
  args: string[],
  deps: CommandDependencies = {}
): Promise<CommandOutput> {
  const parsed = parseArgs(args, {
    booleanFlags: ['--json', '--table'],
    stringFlags: [
      '--session',
      '--scope-ref',
      '--lane-ref',
      '--server',
      '--actor',
      '--project',
      '--source',
    ],
  })

  if (hasFlag(parsed, '--help')) {
    throw new CliUsageError('render help is handled by the top-level CLI')
  }
  requireNoPositionals(parsed)

  const source = readStringFlag(parsed, '--source') ?? 'replay'
  if (source !== 'replay' && source !== 'capture') {
    throw new CliUsageError('--source must be "replay" or "capture"')
  }

  const sessionId = await resolveConcreteSessionId(parsed, deps)

  // ---------- Capture / snapshot mode ----------
  if (source === 'capture') {
    return renderFromCapture(parsed, sessionId, deps)
  }

  // ---------- Replay-backed mode (default) ----------
  return renderFromReplay(parsed, sessionId, deps)
}

// ---------------------------------------------------------------------------
// Replay-backed render
// ---------------------------------------------------------------------------

async function renderFromReplay(
  parsed: ReturnType<typeof parseArgs>,
  sessionId: string,
  deps: CommandDependencies
): Promise<CommandOutput> {
  const env = resolveEnv(deps)
  const serverUrl = resolveServerUrl(readStringFlag(parsed, '--server'), env).replace(/\/+$/, '')
  const actorAgentId = resolveOptionalActorAgentId(readStringFlag(parsed, '--actor'), env)
  const fetchImpl = deps.fetchImpl ?? fetch

  const url = `${serverUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`
  const headers = new Headers()
  if (actorAgentId !== undefined) {
    headers.set('x-acp-actor-agent-id', actorAgentId)
  }

  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET', headers })
  } catch (error) {
    throw new AcpClientTransportError(`failed to reach ACP server at ${serverUrl}`, {
      cause: error,
    })
  }

  if (!response.ok) {
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    throw new AcpClientHttpError(response.status, body)
  }

  let view: RenderedView
  if (response.body !== null) {
    view = await reduceEventStream(streamNdjsonEvents(response.body))
  } else {
    const text = await response.text()
    view = reduceEvents(parseNdjsonText(text))
  }

  const body = {
    sessionId,
    source: 'replay',
    frame: {
      kind: 'replay',
      text: view.text,
      eventCount: view.eventCount,
      lastSeq: view.lastSeq ?? null,
    },
  }

  return renderJsonOrTable(parsed, body, () => view.text)
}

// ---------------------------------------------------------------------------
// Capture / snapshot render
// ---------------------------------------------------------------------------

async function renderFromCapture(
  parsed: ReturnType<typeof parseArgs>,
  sessionId: string,
  deps: CommandDependencies
): Promise<CommandOutput> {
  const requester = createRawRequesterFromParsed(parsed, deps)
  const capture = await requester.requestJson<CaptureResponse>({
    method: 'GET',
    path: `/v1/sessions/${encodeURIComponent(sessionId)}/capture`,
  })

  const body = {
    sessionId,
    source: 'capture',
    frame: {
      kind: 'capture-snapshot',
      text: capture.text,
    },
  }

  if (hasFlag(parsed, '--table') && !hasFlag(parsed, '--json')) {
    return asText(capture.text)
  }

  return renderJsonOrTable(parsed, body, () => capture.text)
}
