/**
 * Shared query parsing for the WS routes' upgrade handlers.
 *
 * Both /v1/timeline and /v1/diagnostics/events accept the same core selector
 * (sessionRef + optional hostSessionId/generation + fromHrcSeq). This helper
 * centralizes that parsing — including the subtle `Number.isFinite` and
 * `.trim() || undefined` idioms — so a fix is made once. Each handler layers
 * its own route-specific params on top of the returned common fields.
 */

/** Common selector fields shared by the timeline and diagnostics WS routes. */
export type CommonWsSelector = {
  sessionRef: string
  hostSessionId: string | undefined
  generation: number | undefined
  fromHrcSeq: number
}

/**
 * Parse the shared WS selector from a request URL. Returns null when the
 * required `sessionRef` param is missing/empty (callers reject the upgrade).
 */
export function parseCommonWsSelector(url: URL): CommonWsSelector | null {
  const sessionRef = url.searchParams.get('sessionRef')
  if (!sessionRef) return null

  const hostSessionId = url.searchParams.get('hostSessionId')?.trim() || undefined
  const generationRaw = url.searchParams.get('generation')
  const generation =
    generationRaw === null || generationRaw.trim().length === 0
      ? undefined
      : Number.parseInt(generationRaw, 10)
  const fromHrcSeq = Number.parseInt(url.searchParams.get('fromHrcSeq') ?? '0', 10)

  return {
    sessionRef,
    hostSessionId,
    generation: Number.isFinite(generation) ? generation : undefined,
    fromHrcSeq: Number.isFinite(fromHrcSeq) ? fromHrcSeq : 0,
  }
}
