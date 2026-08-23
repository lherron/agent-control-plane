const CURSOR_VERSION = 1
const MAX_LEDGER_INCARNATION_ID_BYTES = 512

type CursorPayload = {
  v: typeof CURSOR_VERSION
  ledgerIncarnationId: string
  hrcSeq: number
}

export type PluginEventCursorPosition = {
  ledgerIncarnationId: string
  hrcSeq: number
}

export class PluginEventCursorError extends Error {
  readonly code = 'cursor_invalid'

  constructor(message: string) {
    super(message)
    this.name = 'PluginEventCursorError'
  }
}

function assertPosition(position: PluginEventCursorPosition): void {
  if (
    position.ledgerIncarnationId.length === 0 ||
    Buffer.byteLength(position.ledgerIncarnationId, 'utf8') > MAX_LEDGER_INCARNATION_ID_BYTES
  ) {
    throw new PluginEventCursorError('cursor ledger incarnation is invalid')
  }
  if (!Number.isSafeInteger(position.hrcSeq) || position.hrcSeq < 0) {
    throw new PluginEventCursorError('cursor HRC sequence is invalid')
  }
}

/**
 * ACP-owned, deterministic cursor encoding. The fixed key order plus the
 * round-trip equality check in decode makes alternate JSON/base64 spellings
 * invalid instead of creating several tokens for one position.
 */
export function encodePluginEventCursor(position: PluginEventCursorPosition): string {
  assertPosition(position)
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    ledgerIncarnationId: position.ledgerIncarnationId,
    hrcSeq: position.hrcSeq,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodePluginEventCursor(cursor: string): PluginEventCursorPosition {
  if (cursor.length === 0 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new PluginEventCursorError('cursor encoding is invalid')
  }

  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new PluginEventCursorError('cursor payload is invalid')
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginEventCursorError('cursor payload must be an object')
  }
  const payload = value as Record<string, unknown>
  if (
    Object.keys(payload).length !== 3 ||
    payload['v'] !== CURSOR_VERSION ||
    typeof payload['ledgerIncarnationId'] !== 'string' ||
    typeof payload['hrcSeq'] !== 'number'
  ) {
    throw new PluginEventCursorError('cursor fields or version are invalid')
  }

  const position = {
    ledgerIncarnationId: payload['ledgerIncarnationId'],
    hrcSeq: payload['hrcSeq'],
  }
  assertPosition(position)
  if (encodePluginEventCursor(position) !== cursor) {
    throw new PluginEventCursorError('cursor is not canonically encoded')
  }
  return position
}
