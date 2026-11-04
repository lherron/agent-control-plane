import { type WorkClient, WorkRpcError, createClient } from '@wrkq/client'

import {
  type MailKickerLedger,
  WrkqLedgerRequestError,
  WrkqLedgerUnavailableError,
} from './policy/ledger/client.js'

const HRC_LEDGER_PRINCIPAL_REF = 'agent:hrc'
const PRINCIPAL_FREE_METHODS = new Set(['wrkq.monitor.eventsView', 'wrkq.envelope.birthEnvelope'])
const REQUEST_TIMEOUT_MS = 15_000

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

/** One lazy, initialized transport for this injector; failures reconnect on the next call. */
export function createWrkqLedger(): MailKickerLedger & { close(): Promise<void> } {
  let connection: Promise<WorkClient> | undefined
  let closed = false

  const deadline = async <T>(
    client: WorkClient,
    method: string,
    operation: Promise<T>
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new WrkqLedgerUnavailableError(
                `wrkq ${method} did not answer within ${REQUEST_TIMEOUT_MS}ms`,
                method
              )
            )
            client.kill()
          }, REQUEST_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  const connect = async (): Promise<WorkClient> => {
    // Initialize explicitly so the handshake also has a deadline and cleanup.
    const client = await createClient({
      command: 'wrkq',
      env: { ...wrkqAuthorityEnvironment(), PRAESIDIUM_CALLER: 'hrc-mail-injector' },
      clientInfo: { name: 'hrc-mail-injector', version: '0.1.0' },
      autoInitialize: false,
    })
    try {
      await deadline(client, 'rpc.initialize', client.rpc.initialize())
      return client
    } catch (error) {
      client.kill()
      throw error
    }
  }

  const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (closed) throw new WrkqLedgerUnavailableError('wrkq ledger is closed', method)
    connection ??= connect()
    const pending = connection
    let client: WorkClient | undefined
    try {
      client = await pending
      return await deadline(
        client,
        method,
        client.call<T>(
          method,
          PRINCIPAL_FREE_METHODS.has(method)
            ? params
            : { principalRef: HRC_LEDGER_PRINCIPAL_REF, ...params }
        )
      )
    } catch (error) {
      // Refusals keep a healthy transport. Never replay a possibly committed write.
      // An older failing request cannot invalidate a replacement connection.
      if (client === undefined || !(error instanceof WorkRpcError)) {
        if (connection === pending) connection = undefined
        client?.kill()
      }
      if (error instanceof WorkRpcError) {
        throw new WrkqLedgerRequestError(
          `wrkq ${error.method} refused: ${error.message}`,
          error.method ?? method,
          error.rpcCode,
          error.data
        )
      }
      if (error instanceof WrkqLedgerUnavailableError) throw error
      throw new WrkqLedgerUnavailableError(
        `wrkq ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
        method
      )
    }
  }
  return {
    async close() {
      closed = true
      const pending = connection
      connection = undefined
      if (pending === undefined) return
      const client = await pending.catch(() => undefined)
      if (client === undefined) return
      try {
        await deadline(client, 'rpc.shutdown', client.close())
      } catch {
        client.kill()
      }
    },
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
