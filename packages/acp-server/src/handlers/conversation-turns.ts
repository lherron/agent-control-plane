import { json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleListConversationTurns: RouteHandler = async ({ params, url, deps }) => {
  if (deps.conversationStore === undefined) {
    return Response.json({ error: 'not_implemented', code: 'pending_p1_impl' }, { status: 501 })
  }

  const threadId = params['threadId']
  if (threadId === undefined || threadId.length === 0) {
    notFound('threadId route param is required')
  }

  const thread = deps.conversationStore.getThread(threadId)
  if (thread === undefined) {
    notFound(`thread not found: ${threadId}`)
  }

  const since = url.searchParams.get('since') ?? undefined
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined

  const turns = deps.conversationStore.listTurns(threadId, { since, limit })

  return json({ turns })
}
