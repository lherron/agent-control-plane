import { json } from '../http.js'

import type { RouteHandler } from '../routing/route-context.js'

/**
 * POST /v1/messages — DEPRECATED (P1.8 rename).
 *
 * All callers should migrate to POST /v1/coordination/messages.
 * This handler returns 410 Gone unconditionally.
 */
export const handleCreateMessage: RouteHandler = async () => {
  return json(
    {
      error: {
        code: 'route_moved',
        message: 'POST /v1/messages moved to /v1/coordination/messages',
      },
    },
    410
  )
}
