import type { AcpWrkfWorkflowPort } from './port.js'

type WrkfClientLike = {
  initialize(): Promise<unknown>
  close?: (() => Promise<void>) | undefined
  kill?: (() => void) | undefined
}

type WrkfClientConstructor = {
  spawn(opts: {
    command: string
    dbPath: string
    clientInfo: { name: string; version: string }
  }): WrkfClientLike
}

const importRuntimeModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

export interface WrkfLifecycleOptions {
  command?: string | undefined
  dbPath: string
  clientInfo: { name: string; version: string }
  wrkfDisabled?: boolean | undefined
  _clientOverride?: WrkfClientLike | undefined
}

export interface WrkfLifecycle {
  wrkf: AcpWrkfWorkflowPort | undefined
  close(): Promise<void>
}

export async function createWrkfClientLifecycle(
  opts: WrkfLifecycleOptions
): Promise<WrkfLifecycle> {
  if (opts.wrkfDisabled) {
    return {
      wrkf: undefined,
      async close(): Promise<void> {},
    }
  }

  const client =
    opts._clientOverride ??
    (await loadWrkfClient()).spawn({
      command: opts.command ?? process.env['WRKF_BIN'] ?? 'wrkf',
      dbPath: opts.dbPath,
      clientInfo: opts.clientInfo,
    })

  try {
    await client.initialize()
  } catch (error) {
    await closeOrKill(client)
    throw error
  }

  let closed = false
  return {
    wrkf: client as unknown as AcpWrkfWorkflowPort,
    async close(): Promise<void> {
      if (closed) {
        return (() => {}) as never
      }
      closed = true
      await closeOrKill(client)
    },
  }
}

async function loadWrkfClient(): Promise<WrkfClientConstructor> {
  const module = (await importRuntimeModule('@wrkf/client')) as {
    WrkfClient?: WrkfClientConstructor
  }
  if (module.WrkfClient === undefined) {
    throw new Error('@wrkf/client did not export WrkfClient')
  }
  return module.WrkfClient
}

async function closeOrKill(client: WrkfClientLike): Promise<void> {
  if (typeof client.close === 'function') {
    await client.close()
    return
  }

  if (typeof client.kill === 'function') {
    client.kill()
  }
}
