import { isLoopbackPeer } from '../routing/peer.js'
import type { RouteHandler } from '../routing/route-context.js'
import { ThreadRequestError, createThreads, knownRefusal, reason } from './threads.js'

function route(operation: 'read' | 'options' | 'create' | 'edit' | 'open' | 'close'): RouteHandler {
  return async (context) => {
    if (!isLoopbackPeer(context.peer))
      return Response.json({ ok: false, outcome: 'loopback_required' }, { status: 403 })
    const service = createThreads(context.deps)
    const id = context.params['id'] ?? ''
    try {
      if (operation === 'read') return Response.json({ ok: true, thread: await service.read(id) })
      if (operation === 'options')
        return Response.json(
          await service.options(context.url.searchParams.get('project') ?? undefined)
        )
      const raw: unknown = await context.request.json()
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new ThreadRequestError('body_must_be_object')
      const b = raw as Record<string, unknown>
      if (typeof b['requestId'] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(b['requestId']))
        throw new ThreadRequestError('requestId_required')
      for (const key of ['project', 'agent', 'prompt', 'title', 'note', 'outcome']) {
        if (b[key] !== undefined && typeof b[key] !== 'string')
          throw new ThreadRequestError(`${key}_must_be_string`)
      }
      if (b['seat'] !== undefined && b['seat'] !== null && typeof b['seat'] !== 'string')
        throw new ThreadRequestError('seat_must_be_string_or_null')
      if (
        (operation === 'edit' || operation === 'close') &&
        (!Number.isSafeInteger(b['expectEtag']) || Number(b['expectEtag']) < 1)
      )
        throw new ThreadRequestError('expectEtag_required')
      const input = b as {
        requestId: string
        expectEtag: number
        title?: string
        note?: string
        seat?: string | null
        project?: string
        agent?: string
        prompt?: string
        outcome?: string
      }
      const result =
        operation === 'create'
          ? await service.create(input)
          : operation === 'edit'
            ? await service.edit(id, input)
            : operation === 'open'
              ? await service.open(id, input.requestId)
              : await service.close(id, input)
      return Response.json(result, { status: result.outcome === 'conflict' ? 409 : 200 })
    } catch (error) {
      const refused =
        error instanceof ThreadRequestError || error instanceof SyntaxError || knownRefusal(error)
      return Response.json(
        { ok: false, outcome: refused ? 'refused' : 'unknown_outcome', reason: reason(error) },
        { status: refused ? 400 : 503 }
      )
    }
  }
}
export const handleThreadOptions = route('options')
export const handleThreadRead = route('read')
export const handleThreadCreate = route('create')
export const handleThreadEdit = route('edit')
export const handleThreadOpen = route('open')
export const handleThreadClose = route('close')
