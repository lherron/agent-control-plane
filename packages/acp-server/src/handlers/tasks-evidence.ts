import { json } from '../http.js'
import { extractActor } from '../parsers/actor.js'
import { parseJsonBody, requireRecord } from '../parsers/body.js'
import { parseEvidenceItems, requireTaskId } from './shared.js'

import type { RouteHandler } from '../routing/route-context.js'

export const handleAttachTaskEvidence: RouteHandler = async ({ request, params, deps }) => {
  const taskId = requireTaskId(params)
  const body = requireRecord(await parseJsonBody(request))
  const actor = extractActor(request, body)
  const evidence = parseEvidenceItems(body['evidence']).map((item) => ({
    ...item,
    ...(item.producedBy === undefined
      ? { producedBy: { agentId: actor?.agentId ?? 'unknown' } }
      : {}),
  }))

  deps.wrkqStore.runInTransaction((store) => {
    store.evidenceRepo.appendEvidence(taskId, evidence)
  })

  return json(null, 204)
}
