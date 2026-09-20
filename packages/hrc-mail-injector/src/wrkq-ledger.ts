import {
  type MailKickerLedger,
  WrkqLedgerRequestError,
  WrkqLedgerUnavailableError,
} from './policy/ledger/client.js'

type RpcFrame = {
  id?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown; data?: unknown }
}

const HRC_LEDGER_PRINCIPAL_REF = 'agent:hrc'
const PRINCIPAL_FREE_METHODS = new Set(['wrkq.monitor.eventsView', 'wrkq.envelope.birthEnvelope'])
const REQUEST_TIMEOUT_MS = 15_000
const WRKQ_RPC_PROTOCOL_VERSION = '2026-06-30'

function wrkqAuthorityEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  const db = process.env['HRC_WRKQ_DB']?.trim()
  if (db) {
    env['WRKQ_DB'] = db
    env['WRKQ_DB_PATH'] = undefined
    env['WRKQ_DB_PATH_FILE'] = undefined
  }
  const tokenFile = process.env['HRC_WRKQD_TOKEN_FILE']?.trim()
  if (tokenFile) {
    env['WRKQD_TOKEN'] = ''
    env['WRKQD_TOKEN_FILE'] = tokenFile
  }
  return env
}

/**
 * The injector owns its wrkq transport rather than reaching into hrc-server.
 * One short-lived RPC process per operation is slower than HRC's in-process
 * client but makes restart ownership explicit and preserves the same ledger
 * protocol and principal attribution.
 */
export function createWrkqLedger(): MailKickerLedger {
  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const child = Bun.spawn(['wrkq', 'rpc', '--stdio'], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...wrkqAuthorityEnvironment() },
    })
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'rpc.initialize',
        params: {
          protocolVersion: WRKQ_RPC_PROTOCOL_VERSION,
          client: { name: 'hrc-mail-injector', version: '0.1.0' },
        },
      })}\n`
    )
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: PRINCIPAL_FREE_METHODS.has(method)
          ? params
          : { principalRef: HRC_LEDGER_PRINCIPAL_REF, ...params },
      })}\n`
    )
    child.stdin.end()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, REQUEST_TIMEOUT_MS)
    timeout.unref?.()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timeout))
    if (timedOut) {
      throw new WrkqLedgerUnavailableError(
        `wrkq ${method} did not answer within ${REQUEST_TIMEOUT_MS}ms`,
        method
      )
    }
    if (exitCode !== 0) {
      throw new WrkqLedgerUnavailableError(`wrkq ${method} failed: ${stderr.trim()}`, method)
    }
    let frames: RpcFrame[]
    try {
      frames = stdout
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RpcFrame)
    } catch {
      throw new WrkqLedgerUnavailableError(`wrkq ${method} returned invalid JSON`, method)
    }
    const initialization = frames.find((frame) => frame.id === 0)
    if (initialization === undefined) {
      throw new WrkqLedgerUnavailableError(`wrkq ${method} omitted rpc.initialize`, method)
    }
    if (initialization.error !== undefined) {
      throw new WrkqLedgerRequestError(
        `wrkq rpc.initialize refused: ${typeof initialization.error.message === 'string' ? initialization.error.message : 'unknown error'}`,
        'rpc.initialize',
        typeof initialization.error.code === 'number' ? initialization.error.code : -32_000,
        initialization.error.data
      )
    }
    const frame = frames.find((candidate) => candidate.id === 1)
    if (frame === undefined) {
      throw new WrkqLedgerUnavailableError(`wrkq ${method} omitted its response`, method)
    }
    if (frame.error !== undefined) {
      throw new WrkqLedgerRequestError(
        `wrkq ${method} refused: ${typeof frame.error.message === 'string' ? frame.error.message : 'unknown error'}`,
        method,
        typeof frame.error.code === 'number' ? frame.error.code : -32_000,
        frame.error.data
      )
    }
    return frame.result as T
  }
  return {
    pendingView: (params) => call('wrkq.envelope.pendingView', params),
    present: (params) => call('wrkq.envelope.present', params),
    fail: (params) => call('wrkq.envelope.fail', params),
    envelopeShow: (params) => call('wrkq.envelope.show', params),
    eventsView: async (params) => {
      const view = await call<{ items?: unknown; high_water?: unknown }>(
        'wrkq.monitor.eventsView',
        params
      )
      return {
        items: Array.isArray(view.items) ? view.items.map(mapMonitorEvent) : [],
        highWater: typeof view.high_water === 'number' ? view.high_water : params.cursor,
      }
    },
  }
}

function mapMonitorEvent(raw: unknown) {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    id: typeof row['id'] === 'number' ? row['id'] : 0,
    timestamp: typeof row['timestamp'] === 'string' ? row['timestamp'] : '',
    resourceType: typeof row['resource_type'] === 'string' ? row['resource_type'] : '',
    ...(typeof row['resource_uuid'] === 'string' ? { resourceUuid: row['resource_uuid'] } : {}),
    ...(typeof row['resource_id'] === 'string' ? { resourceId: row['resource_id'] } : {}),
    eventType: typeof row['event_type'] === 'string' ? row['event_type'] : '',
    ...(typeof row['payload'] === 'string' ? { payload: row['payload'] } : {}),
  }
}
