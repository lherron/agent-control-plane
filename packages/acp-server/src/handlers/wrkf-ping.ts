import type { RouteHandler } from '../routing/route-context.js'

export const handleWrkfPing: RouteHandler = ({ deps }) =>
  Response.json({ wrkf: deps.wrkf === undefined ? 'unavailable' : 'available' })
