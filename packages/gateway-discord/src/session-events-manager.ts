import { createLogger } from './logger.js'
import type {
  GatewaySessionEvent,
  PermissionAction,
  RenderFrame,
  SessionEventEnvelope,
} from './types.js'

const log = createLogger({ component: 'gateway-discord' })

interface ToolExecution {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  status: 'running' | 'completed' | 'failed'
  output?: string | undefined
  images?: Array<{ data: string; mimeType: string }> | undefined
  mediaRefs?:
    | Array<{
        url: string
        mimeType?: string | undefined
        filename?: string | undefined
        alt?: string | undefined
      }>
    | undefined
}

export interface RunState {
  runId: string
  projectId: string
  status: 'queued' | 'running' | 'awaiting_permission' | 'completed' | 'failed' | 'cancelled'
  inputContent: string
  startedAt?: number | undefined
  completedAt?: number | undefined
  userMessage?: string | undefined
  assistantMessage?: string | undefined
  toolExecutions: ToolExecution[]
  permissionRequest?:
    | {
        requestId: string
        toolUseId: string
        toolName: string
        toolInput: Record<string, unknown>
        actions: PermissionAction[]
      }
    | undefined
  discordMessageId?: string | undefined
  discordChannelId?: string | undefined
}

interface ProjectState {
  projectId: string
  lastSeq: number
  runs: Map<string, RunState>
  internalRunIds: Set<string>
  focusedRunId?: string | undefined
}

function isSessionMetadataEvent(event: GatewaySessionEvent): boolean {
  return [
    'continuation_key_observed',
    'user_input_received',
    'user_input_queued_in_flight',
    'user_input_applied_in_flight',
    'user_input_interrupt_requested',
    'user_input_interrupt_applied',
    'user_input_rejected',
    'harness_process_started',
    'harness_process_exited',
    'tmux_pane_bound',
    'tmux_pane_unbound',
    'ghostty_surface_bound',
    'ghostty_surface_unbound',
    'sdk_session_id',
  ].includes(event.type)
}

function processEvent(
  state: ProjectState,
  event: GatewaySessionEvent,
  runId: string | undefined,
  seq: number
): ProjectState {
  const newState = { ...state, lastSeq: seq, runs: new Map(state.runs) }

  const getOrCreateRun = (rid: string): RunState => {
    const existing = newState.runs.get(rid)
    if (existing) {
      return {
        ...existing,
        toolExecutions: existing.toolExecutions.map((tool) => ({
          ...tool,
          ...(tool.images ? { images: [...tool.images] } : {}),
          ...(tool.mediaRefs ? { mediaRefs: [...tool.mediaRefs] } : {}),
        })),
      }
    }

    return {
      runId: rid,
      projectId: state.projectId,
      status: 'queued',
      inputContent: '',
      toolExecutions: [],
    }
  }

  switch (event.type) {
    case 'run_queued': {
      const run = getOrCreateRun(event.runId)
      run.projectId = event.projectId
      run.status = 'queued'
      run.inputContent = event.input.content
      newState.runs.set(event.runId, run)
      newState.focusedRunId = event.runId
      break
    }

    case 'run_started': {
      const run = getOrCreateRun(event.runId)
      run.status = 'running'
      run.startedAt = event.startedAt
      newState.runs.set(event.runId, run)
      newState.focusedRunId = event.runId
      break
    }

    case 'run_completed': {
      const run = getOrCreateRun(event.runId)
      run.status = 'completed'
      run.completedAt = event.completedAt
      if (event.finalOutput) {
        run.assistantMessage = event.finalOutput
      }
      newState.runs.set(event.runId, run)
      break
    }

    case 'run_failed': {
      const run = getOrCreateRun(event.runId)
      run.status = 'failed'
      newState.runs.set(event.runId, run)
      break
    }

    case 'run_cancelled': {
      const run = getOrCreateRun(event.runId)
      run.status = 'cancelled'
      newState.runs.set(event.runId, run)
      break
    }

    case 'message_start':
    case 'message_end': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      const message = event.message
      if (message) {
        const content =
          typeof message.content === 'string'
            ? message.content
            : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

        if (message.role === 'user') {
          run.userMessage = content
        } else if (message.role === 'assistant' && content) {
          run.assistantMessage = content
        }
      }

      newState.runs.set(runId, run)
      break
    }

    case 'message_update': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      if (event.textDelta) {
        run.assistantMessage = (run.assistantMessage ?? '') + event.textDelta
      }

      if (event.contentBlocks) {
        const textContent = event.contentBlocks
          .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
          .map((block) => block.text)
          .join('')

        if (textContent) {
          run.assistantMessage = textContent
        }
      }

      newState.runs.set(runId, run)
      break
    }

    case 'tool_execution_start': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      const existingIndex = run.toolExecutions.findIndex(
        (tool) => tool.toolUseId === event.toolUseId
      )

      if (existingIndex >= 0) {
        const existingTool = run.toolExecutions[existingIndex]
        if (!existingTool) {
          break
        }

        run.toolExecutions[existingIndex] = {
          ...existingTool,
          status: 'running',
        }
      } else {
        run.toolExecutions.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          status: 'running',
        })
      }

      newState.runs.set(runId, run)
      break
    }

    case 'tool_execution_end': {
      if (!runId) {
        break
      }

      const run = getOrCreateRun(runId)
      const toolIndex = run.toolExecutions.findIndex((tool) => tool.toolUseId === event.toolUseId)
      let output = ''
      const images: Array<{ data: string; mimeType: string }> = []
      const mediaRefs: Array<{
        url: string
        mimeType?: string | undefined
        filename?: string | undefined
        alt?: string | undefined
      }> = []

      const result = event.result as {
        content?: Array<{
          type: string
          text?: string | undefined
          data?: string | undefined
          mimeType?: string | undefined
          url?: string | undefined
          filename?: string | undefined
          alt?: string | undefined
        }>
        details?:
          | {
              content?: Array<{
                type: string
                text?: string | undefined
                data?: string | undefined
                mimeType?: string | undefined
                url?: string | undefined
                filename?: string | undefined
                alt?: string | undefined
              }>
            }
          | undefined
      }

      const contentBlocks = result.content ?? result.details?.content ?? []
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          output += block.text
        } else if (block.type === 'image' && block.data && block.mimeType) {
          images.push({ data: block.data, mimeType: block.mimeType })
        } else if (block.type === 'media_ref' && block.url) {
          mediaRefs.push({
            url: block.url,
            mimeType: block.mimeType,
            filename: block.filename,
            alt: block.alt,
          })
        }
      }

      const existingOutput = toolIndex >= 0 ? run.toolExecutions[toolIndex]?.output : undefined
      const existingImages = toolIndex >= 0 ? run.toolExecutions[toolIndex]?.images : undefined
      const existingMediaRefs =
        toolIndex >= 0 ? run.toolExecutions[toolIndex]?.mediaRefs : undefined

      const finalOutput = output || existingOutput || ''
      const finalImages = images.length > 0 ? images : existingImages
      const finalMediaRefs = mediaRefs.length > 0 ? mediaRefs : existingMediaRefs

      if (toolIndex >= 0) {
        const existingTool = run.toolExecutions[toolIndex]
        if (!existingTool) {
          break
        }

        run.toolExecutions[toolIndex] = {
          ...existingTool,
          status: event.isError ? 'failed' : 'completed',
          output: finalOutput,
          images: finalImages,
          mediaRefs: finalMediaRefs,
        }
      } else {
        run.toolExecutions.push({
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: {},
          status: event.isError ? 'failed' : 'completed',
          output: finalOutput,
          images: finalImages,
          mediaRefs: finalMediaRefs,
        })
      }

      newState.runs.set(runId, run)
      break
    }

    case 'permission_request': {
      const run = getOrCreateRun(event.runId)
      run.status = 'awaiting_permission'
      run.permissionRequest = {
        requestId: event.requestId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolInput: event.toolInput,
        actions: event.actions,
      }
      newState.runs.set(event.runId, run)
      break
    }

    case 'permission_decision': {
      const run = getOrCreateRun(event.runId)
      run.permissionRequest = undefined
      if (run.status === 'awaiting_permission') {
        run.status = 'running'
      }
      newState.runs.set(event.runId, run)
      break
    }

    default:
      if (isSessionMetadataEvent(event)) {
        break
      }
      break
  }

  return newState
}

function formatToolSummary(_toolName: string, toolInput: Record<string, unknown>): string {
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value

  for (const value of Object.values(toolInput)) {
    if (typeof value === 'string' && value.length > 0) {
      return `\`${truncate(value, 80)}\``
    }
  }

  const json = JSON.stringify(toolInput)
  return json.length > 2 ? truncate(json, 80) : ''
}

export function runStateToFrame(run: RunState): RenderFrame {
  const phase =
    run.status === 'queued'
      ? 'queued'
      : run.status === 'awaiting_permission'
        ? 'permission'
        : run.status === 'running'
          ? 'progress'
          : run.status === 'completed'
            ? 'final'
            : 'error'

  const blocks: RenderFrame['blocks'] = []
  const truncate = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max)}...` : value
  const allMediaRefs: Array<{
    url: string
    mimeType?: string | undefined
    filename?: string | undefined
    alt?: string | undefined
  }> = []

  for (const tool of run.toolExecutions) {
    blocks.push({
      t: 'tool',
      toolName: tool.toolName,
      summary: formatToolSummary(tool.toolName, tool.input),
      output: tool.output,
      images: tool.images,
      approved: tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined,
    })

    if (tool.mediaRefs && tool.mediaRefs.length > 0) {
      allMediaRefs.push(...tool.mediaRefs)
    }
  }

  if (run.permissionRequest) {
    const { toolName, toolInput } = run.permissionRequest
    const command = toolInput['command']
    if (toolName === 'Bash' && typeof command === 'string') {
      blocks.push({ t: 'code', lang: 'bash', code: command })
    } else {
      blocks.push({
        t: 'code',
        lang: 'json',
        code: JSON.stringify(toolInput, null, 2),
      })
    }
  }

  if (run.assistantMessage) {
    blocks.push({ t: 'markdown', md: run.assistantMessage })
  } else if (phase === 'progress') {
    const runningTool = run.toolExecutions.find((tool) => tool.status === 'running')
    if (runningTool) {
      blocks.push({
        t: 'markdown',
        md: formatToolSummary(runningTool.toolName, runningTool.input),
      })
    } else {
      blocks.push({ t: 'markdown', md: '...' })
    }
  }

  for (const media of allMediaRefs) {
    blocks.push({
      t: 'media_ref',
      url: media.url,
      mimeType: media.mimeType,
      filename: media.filename,
      alt: media.alt,
    })
  }

  const actions = run.permissionRequest?.actions.map((action) => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    style: action.style,
  }))

  return {
    runId: run.runId,
    projectId: run.projectId,
    phase,
    title: `${phase === 'permission' ? '🔐' : phase === 'final' ? '✅' : phase === 'error' ? '❌' : '⚙️'} ${truncate(run.inputContent, 100)}`,
    blocks: blocks.length > 0 ? blocks : [{ t: 'markdown', md: '...' }],
    ...(actions ? { actions } : {}),
    statusLine: run.status,
    updatedAt: Date.now(),
  }
}

export type OnRenderCallback = (
  projectId: string,
  runId: string,
  frame: RenderFrame,
  run: RunState
) => void

export type OnRunQueuedCallback = (projectId: string, runId: string, inputContent: string) => void

export class SessionEventsManager {
  private readonly gatewayId: string
  private readonly onRender: OnRenderCallback
  private readonly onRunQueued?: OnRunQueuedCallback | undefined
  private readonly projects = new Map<string, ProjectState>()

  constructor(gatewayId: string, onRender: OnRenderCallback, onRunQueued?: OnRunQueuedCallback) {
    this.gatewayId = gatewayId
    this.onRender = onRender
    this.onRunQueued = onRunQueued
  }

  subscribe(projectId: string): void {
    if (!this.projects.has(projectId)) {
      this.projects.set(projectId, {
        projectId,
        lastSeq: 0,
        runs: new Map(),
        internalRunIds: new Set(),
      })
    }
  }

  unsubscribe(projectId: string): void {
    this.projects.delete(projectId)
  }

  receive(envelope: SessionEventEnvelope): void {
    const state = this.ensureProject(envelope.projectId)
    const seq = envelope.seq ?? state.lastSeq + 1
    const isInternal = envelope.run?.visibility === 'internal'

    if (seq <= state.lastSeq) {
      log.debug('session.event.dedupe', {
        message: `Ignoring duplicate event: ${envelope.event.type}`,
        trace: { gatewayId: this.gatewayId, projectId: envelope.projectId, runId: envelope.runId },
        data: { eventType: envelope.event.type, seq, lastSeq: state.lastSeq },
      })
      return
    }

    if (envelope.runId && (isInternal || state.internalRunIds.has(envelope.runId))) {
      state.lastSeq = seq
      if (isInternal) {
        state.internalRunIds.add(envelope.runId)
      }
      return
    }

    log.info('session.event.received', {
      message: `Received event: ${envelope.event.type}`,
      trace: { gatewayId: this.gatewayId, projectId: envelope.projectId, runId: envelope.runId },
      data: { eventType: envelope.event.type, seq },
    })

    this.processAndEmit(envelope.projectId, envelope.event, envelope.runId, seq)
  }

  getRunState(projectId: string, runId: string): RunState | undefined {
    return this.projects.get(projectId)?.runs.get(runId)
  }

  setDiscordMessage(projectId: string, runId: string, messageId: string, channelId: string): void {
    const project = this.projects.get(projectId)
    const run = project?.runs.get(runId)
    if (!run) {
      return
    }

    run.discordMessageId = messageId
    run.discordChannelId = channelId
  }

  private ensureProject(projectId: string): ProjectState {
    const existing = this.projects.get(projectId)
    if (existing) {
      return existing
    }

    const created: ProjectState = {
      projectId,
      lastSeq: 0,
      runs: new Map(),
      internalRunIds: new Set(),
    }
    this.projects.set(projectId, created)
    return created
  }

  private processAndEmit(
    projectId: string,
    event: GatewaySessionEvent,
    runId: string | undefined,
    seq: number
  ): void {
    const state = this.ensureProject(projectId)
    const newState = processEvent(state, event, runId, seq)
    this.projects.set(projectId, newState)

    if (event.type === 'run_queued' && this.onRunQueued) {
      this.onRunQueued(event.projectId, event.runId, event.input.content)
    }

    const affectedRunId = this.getAffectedRunId(event, runId)
    if (!affectedRunId) {
      return
    }

    const run = newState.runs.get(affectedRunId)
    if (!run) {
      return
    }

    this.onRender(projectId, affectedRunId, runStateToFrame(run), run)
  }

  private getAffectedRunId(
    event: GatewaySessionEvent,
    contextRunId?: string | undefined
  ): string | undefined {
    switch (event.type) {
      case 'run_queued':
      case 'run_started':
      case 'run_completed':
      case 'run_failed':
      case 'run_cancelled':
      case 'permission_request':
      case 'permission_decision':
        return event.runId
      default:
        return contextRunId
    }
  }
}
