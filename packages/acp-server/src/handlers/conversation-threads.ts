import { normalizeSessionRef } from 'agent-scope'

import { json, notFound } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleListConversationThreads: RouteHandler = async ({ url, deps }) => {
  if (deps.conversationStore === undefined) {
    return Response.json({ error: 'not_implemented', code: 'pending_p1_impl' }, { status: 501 })
  }

  const projectId = url.searchParams.get('projectId') ?? undefined
  const scopeRef = url.searchParams.get('scopeRef') ?? undefined
  const laneRef = url.searchParams.get('laneRef') ?? undefined

  const sessionRef =
    scopeRef !== undefined && laneRef !== undefined
      ? normalizeSessionRef({ scopeRef, laneRef })
      : undefined

  const threads = deps.conversationStore.listThreads({
    projectId,
    sessionRef,
  })

  return json({ threads })
}

export const handleGetConversationThread: RouteHandler = async ({ params, deps }) => {
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

  return json({ thread })
}
