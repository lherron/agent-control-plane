import type { DashboardEvent } from 'acp-ops-projection'
import { badRequest } from '../http.js'
import type { RouteHandler } from '../routing/route-context.js'
import {
  type DashboardFilters,
  compareDashboardEvents,
  eventMatchesFilters,
  parseBoolean,
  parsePositiveInteger,
  projectCoreHrcEvent,
  projectInputAdmissionSystemEvent,
} from './ops-dashboard-shared.js'

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson',
  'transfer-encoding': 'chunked',
}
const HEARTBEAT_MS = 100

function isDashboardEvent(value: DashboardEvent | undefined): value is DashboardEvent {
  return value !== undefined
}

export const handleOpsDashboardEvents: RouteHandler = async ({ request, url, deps }) => {
  const hrcClient = deps.hrcClient
  const fromSeq = parsePositiveInteger(url.searchParams.get('fromSeq'), 1)
  const follow = parseBoolean(url.searchParams.get('follow'), false)
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw === null ? undefined : parsePositiveInteger(limitRaw, 1)
  const filters: DashboardFilters = {
    scopeRef: url.searchParams.get('scopeRef') ?? undefined,
    laneRef: url.searchParams.get('laneRef') ?? undefined,
    projectId: url.searchParams.get('projectId') ?? undefined,
    hostSessionId: url.searchParams.get('hostSessionId') ?? undefined,
    runtimeId: url.searchParams.get('runtimeId') ?? undefined,
    runId: url.searchParams.get('runId') ?? undefined,
    family: url.searchParams.get('family') ?? undefined,
  }

  if (fromSeq < 1) {
    badRequest('fromSeq must be >= 1', { field: 'fromSeq' })
  }

  if (hrcClient === undefined) {
    const admissionEvents = deps.adminStore.systemEvents
      .list({
        ...(filters.projectId !== undefined ? { projectId: filters.projectId } : {}),
      })
      .map(projectInputAdmissionSystemEvent)
      .filter(isDashboardEvent)
      .filter((event) => eventMatchesFilters(event, filters))
      .sort(compareDashboardEvents)
      .slice(0, limit)

    return new Response(admissionEvents.map((event) => JSON.stringify(event)).join('\n'), {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  if (!follow) {
    return new Response(
      await collectFiniteDashboardEvents({
        hrcClient,
        fromSeq,
        filters,
        limit,
        deps,
      }),
      {
        status: 200,
        headers: NDJSON_HEADERS,
      }
    )
  }

  const abortController = new AbortController()
  const iterable = hrcClient.watch({ fromSeq, follow, signal: abortController.signal })
  const iterator = iterable[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let closed = false
  let emitted = 0

  const close = () => {
    if (closed) {
      return
    }

    closed = true
    abortController.abort()
    if (heartbeat !== undefined) {
      clearInterval(heartbeat)
      heartbeat = undefined
    }

    void iterator.return?.()
    try {
      controllerRef?.close()
    } catch {
      // Bun may close the stream first when the client disconnects.
    }
  }

  request.signal.addEventListener('abort', close, { once: true })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      if (follow) {
        heartbeat = setInterval(() => {
          if (closed) {
            return
          }

          try {
            controller.enqueue(encoder.encode('\n'))
          } catch {
            close()
          }
        }, HEARTBEAT_MS)
      }
    },
    async pull(controller) {
      if (closed) {
        return
      }

      if (limit !== undefined && emitted >= limit) {
        close()
        return
      }

      while (!closed) {
        const next = await iterator.next()
        if (next.done === true) {
          close()
          return
        }

        const event = projectCoreHrcEvent(next.value)
        if (event === undefined || !eventMatchesFilters(event, filters)) {
          continue
        }

        emitted += 1
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        if (limit !== undefined && emitted >= limit) {
          close()
        }
        return
      }
    },
    cancel: close,
  })

  return new Response(stream, {
    status: 200,
    headers: NDJSON_HEADERS,
  })
}

async function collectFiniteDashboardEvents(input: {
  hrcClient: NonNullable<Parameters<typeof handleOpsDashboardEvents>[0]['deps']['hrcClient']>
  fromSeq: number
  filters: DashboardFilters
  limit?: number | undefined
  deps: Parameters<typeof handleOpsDashboardEvents>[0]['deps']
}): Promise<string> {
  const events = []
  for await (const rawEvent of input.hrcClient.watch({ fromSeq: input.fromSeq, follow: false })) {
    const event = projectCoreHrcEvent(rawEvent)
    if (event !== undefined && eventMatchesFilters(event, input.filters)) {
      events.push(event)
    }
  }

  for (const systemEvent of input.deps.adminStore.systemEvents.list({
    ...(input.filters.projectId !== undefined ? { projectId: input.filters.projectId } : {}),
  })) {
    const event = projectInputAdmissionSystemEvent(systemEvent)
    if (event !== undefined && eventMatchesFilters(event, input.filters)) {
      events.push(event)
    }
  }

  const sorted = events.sort(compareDashboardEvents)
  const limited = input.limit === undefined ? sorted : sorted.slice(0, input.limit)
  return limited.map((event) => JSON.stringify(event)).join('\n')
}
