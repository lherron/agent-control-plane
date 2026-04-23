import type { RouteHandler } from '../routing/route-context.js'

export const handlePendingP1Impl: RouteHandler = () =>
  Response.json(
    {
      error: 'not_implemented',
      code: 'pending_p1_impl',
    },
    { status: 501 }
  )
