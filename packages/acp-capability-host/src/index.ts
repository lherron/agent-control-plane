import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'
import { createDefaultDeps, newServer } from 'cap-service'
import type { CatalogStore } from 'catalog-store'

type CapRpcServer = ReturnType<typeof newServer>
type ProviderManifest = NonNullable<Awaited<ReturnType<CatalogStore['getManifest']>>>
type CapabilityDescriptor = NonNullable<Awaited<ReturnType<CatalogStore['getCapability']>>>
type BindingDecl = NonNullable<Awaited<ReturnType<CatalogStore['getBinding']>>>
type OperationRecord = NonNullable<Awaited<ReturnType<CatalogStore['getOperation']>>>
type ExecutionRecord = NonNullable<Awaited<ReturnType<CatalogStore['getExecution']>>>
type ExecutionEvent = Awaited<ReturnType<CatalogStore['listEvents']>>[number]

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: {
    code: number
    message: string
    data?: Record<string, unknown>
  }
}

type SocketServerHandle = {
  readonly path: string
  stop(): Promise<void>
}

type SocketConnectionState = {
  buffer: string
  tail: Promise<void>
}

export type RegisteredCapabilityProvider = {
  id: string
  capabilityCount: number
}

export interface AcpCapabilityHostOptions {
  capabilitiesDir: string
  socketPath: string
  acpBaseUrl: string
  catalogStateDir?: string | undefined
  logger?: ((message: string) => void) | undefined
}

export interface AcpCapabilityHost {
  readonly socketPath: string
  readonly acpBaseUrl: string
  readonly registeredProviders: readonly RegisteredCapabilityProvider[]
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  handleHttpJsonRpc(request: Request): Promise<Response>
  shutdown(): Promise<void>
}

export async function startAcpCapabilityHost(
  options: AcpCapabilityHostOptions
): Promise<AcpCapabilityHost> {
  await mkdir(dirname(options.socketPath), { recursive: true })
  if (options.catalogStateDir !== undefined) {
    await mkdir(options.catalogStateDir, { recursive: true })
  }

  process.env['ACP_BASE_URL'] = options.acpBaseUrl

  const defaultDeps = createDefaultDeps()
  const store =
    options.catalogStateDir !== undefined
      ? createSqliteCatalogStore(join(options.catalogStateDir, 'catalog.db'))
      : defaultDeps.store
  const server = newServer({
    ...defaultDeps,
    store,
  })
  const registeredProviders = await registerProviderManifests(server, options.capabilitiesDir)
  const socket = await serveCapSocket(server, options.socketPath)
  options.logger?.(
    `acp capability host listening on ${socket.path} providers=${registeredProviders
      .map((provider) => `${provider.id}:${provider.capabilityCount}`)
      .join(',')}`
  )

  let closed = false
  return {
    socketPath: socket.path,
    acpBaseUrl: options.acpBaseUrl,
    registeredProviders,
    call: (method, params) => callRpc(server, method, params),
    handleHttpJsonRpc: (request) => handleHttpJsonRpc(server, request),
    async shutdown() {
      if (closed) {
        return
      }

      closed = true
      await socket.stop()
      closeCatalogStore(store)
    },
  }
}

export function createSqliteCatalogStore(dbPath: string): CatalogStore & { close(): void } {
  return new SqliteCatalogStore(dbPath)
}

class SqliteCatalogStore implements CatalogStore {
  private readonly db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cap_provider_manifests (
        provider TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cap_operations (
        operation_id TEXT PRIMARY KEY,
        resolved_capability TEXT NOT NULL,
        idempotency_key TEXT,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cap_operations_idempotency_idx
        ON cap_operations (resolved_capability, idempotency_key);
      CREATE TABLE IF NOT EXISTS cap_executions (
        execution_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cap_executions_operation_idx
        ON cap_executions (operation_id);
      CREATE TABLE IF NOT EXISTS cap_execution_events (
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      );
    `)
  }

  async putManifest(manifest: ProviderManifest): Promise<void> {
    this.db
      .query(
        `INSERT INTO cap_provider_manifests (provider, manifest_json, updated_at)
         VALUES ($provider, $manifestJson, $updatedAt)
         ON CONFLICT(provider) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           updated_at = excluded.updated_at`
      )
      .run({
        $provider: manifest.provider.id,
        $manifestJson: JSON.stringify(manifest),
        $updatedAt: new Date().toISOString(),
      })
  }

  async listProviders(): Promise<string[]> {
    const rows = this.db
      .query('SELECT provider FROM cap_provider_manifests ORDER BY provider ASC')
      .all() as Array<{ provider: string }>
    return rows.map((row) => row.provider)
  }

  async getManifest(provider: string): Promise<ProviderManifest | undefined> {
    const row = this.db
      .query('SELECT manifest_json FROM cap_provider_manifests WHERE provider = $provider')
      .get({ $provider: provider }) as { manifest_json: string } | null
    return row === null ? undefined : JSON.parse(row.manifest_json)
  }

  async listManifests(): Promise<ProviderManifest[]> {
    const rows = this.db
      .query('SELECT manifest_json FROM cap_provider_manifests ORDER BY provider ASC')
      .all() as Array<{ manifest_json: string }>
    return rows.map((row) => JSON.parse(row.manifest_json) as ProviderManifest)
  }

  async getCapability(capabilityId: string): Promise<CapabilityDescriptor | undefined> {
    return (await this.listCapabilities()).find((item) => item.id === capabilityId)
  }

  async listCapabilities(): Promise<CapabilityDescriptor[]> {
    return (await this.listManifests()).flatMap((manifest) => manifest.capabilities)
  }

  async getBinding(bindingId: string): Promise<BindingDecl | undefined> {
    for (const manifest of await this.listManifests()) {
      const binding = manifest.bindings?.find((item) => item.id === bindingId)
      if (binding !== undefined) {
        return binding
      }
    }
    return undefined
  }

  async getOperation(operationId: string): Promise<OperationRecord | undefined> {
    const row = this.db
      .query('SELECT record_json FROM cap_operations WHERE operation_id = $operationId')
      .get({ $operationId: operationId }) as { record_json: string } | null
    return row === null ? undefined : JSON.parse(row.record_json)
  }

  async findOperationByIdempotency(
    resolvedCapability: string,
    idempotencyKey: string
  ): Promise<OperationRecord | undefined> {
    const row = this.db
      .query(
        `SELECT record_json FROM cap_operations
         WHERE resolved_capability = $resolvedCapability
           AND idempotency_key = $idempotencyKey
         ORDER BY rowid ASC
         LIMIT 1`
      )
      .get({
        $resolvedCapability: resolvedCapability,
        $idempotencyKey: idempotencyKey,
      }) as { record_json: string } | null
    return row === null ? undefined : JSON.parse(row.record_json)
  }

  async putOperation(record: OperationRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO cap_operations (
           operation_id,
           resolved_capability,
           idempotency_key,
           record_json
         )
         VALUES ($operationId, $resolvedCapability, $idempotencyKey, $recordJson)
         ON CONFLICT(operation_id) DO UPDATE SET
           resolved_capability = excluded.resolved_capability,
           idempotency_key = excluded.idempotency_key,
           record_json = excluded.record_json`
      )
      .run({
        $operationId: record.operationId,
        $resolvedCapability: record.resolvedCapability,
        $idempotencyKey: record.idempotencyKey ?? null,
        $recordJson: JSON.stringify(record),
      })
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    const row = this.db
      .query('SELECT record_json FROM cap_executions WHERE execution_id = $executionId')
      .get({ $executionId: executionId }) as { record_json: string } | null
    return row === null ? undefined : JSON.parse(row.record_json)
  }

  async listExecutionsForOperation(operationId: string): Promise<ExecutionRecord[]> {
    const rows = this.db
      .query(
        `SELECT record_json FROM cap_executions
         WHERE operation_id = $operationId
         ORDER BY rowid ASC`
      )
      .all({ $operationId: operationId }) as Array<{ record_json: string }>
    return rows.map((row) => JSON.parse(row.record_json) as ExecutionRecord)
  }

  async putExecution(record: ExecutionRecord): Promise<void> {
    this.db
      .query(
        `INSERT INTO cap_executions (execution_id, operation_id, record_json)
         VALUES ($executionId, $operationId, $recordJson)
         ON CONFLICT(execution_id) DO UPDATE SET
           operation_id = excluded.operation_id,
           record_json = excluded.record_json`
      )
      .run({
        $executionId: record.executionId,
        $operationId: record.operationId,
        $recordJson: JSON.stringify(record),
      })
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    this.db
      .query(
        `INSERT OR REPLACE INTO cap_execution_events (execution_id, seq, event_json)
         VALUES ($executionId, $seq, $eventJson)`
      )
      .run({
        $executionId: event.executionId,
        $seq: event.seq,
        $eventJson: JSON.stringify(event),
      })
  }

  async listEvents(executionId: string): Promise<ExecutionEvent[]> {
    const rows = this.db
      .query(
        `SELECT event_json FROM cap_execution_events
         WHERE execution_id = $executionId
         ORDER BY seq ASC`
      )
      .all({ $executionId: executionId }) as Array<{ event_json: string }>
    return rows.map((row) => JSON.parse(row.event_json) as ExecutionEvent)
  }

  close(): void {
    this.db.close()
  }
}

function closeCatalogStore(store: CatalogStore): void {
  if ('close' in store && typeof store.close === 'function') {
    store.close()
  }
}

async function registerProviderManifests(
  server: CapRpcServer,
  capabilitiesDir: string
): Promise<RegisteredCapabilityProvider[]> {
  const manifestPaths = [
    join(capabilitiesDir, 'provider.acp.yaml'),
    join(capabilitiesDir, 'provider.pbc.yaml'),
  ]
  const registered: RegisteredCapabilityProvider[] = []

  for (const manifestPath of manifestPaths) {
    const manifest = await readFile(manifestPath, 'utf8')
    const summary = summarizeManifest(manifest, manifestPath)
    await callRpc(server, 'cap.provider.register', { manifest })
    registered.push(summary)
  }

  return registered
}

function summarizeManifest(manifest: string, manifestPath: string): RegisteredCapabilityProvider {
  const parsed = Bun.YAML.parse(manifest)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`provider manifest is not an object: ${manifestPath}`)
  }

  const record = parsed as Record<string, unknown>
  const provider = record['provider']
  const id =
    provider !== null && typeof provider === 'object' && !Array.isArray(provider)
      ? (provider as Record<string, unknown>)['id']
      : undefined
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`provider manifest is missing provider.id: ${manifestPath}`)
  }

  const capabilities = record['capabilities']
  return {
    id,
    capabilityCount: Array.isArray(capabilities) ? capabilities.length : 0,
  }
}

async function callRpc<T = unknown>(
  server: CapRpcServer,
  method: string,
  params?: unknown
): Promise<T> {
  const response = (await server.handle({
    jsonrpc: '2.0',
    id: `${Date.now()}:${Math.random()}`,
    method,
    ...(params !== undefined ? { params } : {}),
  })) as JsonRpcResponse

  if (response.error !== undefined) {
    throw new Error(
      `cap RPC ${method} failed: ${response.error.message}${
        response.error.data !== undefined ? ` ${JSON.stringify(response.error.data)}` : ''
      }`
    )
  }

  return response.result as T
}

async function handleHttpJsonRpc(server: CapRpcServer, request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      { error: { code: 'method_not_allowed', message: 'use POST for cap JSON-RPC' } },
      { status: 405 }
    )
  }

  let frame: unknown
  try {
    frame = await request.json()
  } catch (error) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 400 }
    )
  }

  if (!isJsonRpcRequest(frame)) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'invalid JSON-RPC request' },
      },
      { status: 400 }
    )
  }

  return Response.json(await server.handle(frame))
}

function isJsonRpcRequest(frame: unknown): frame is JsonRpcRequest {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return false
  }

  const record = frame as Record<string, unknown>
  return (
    record['jsonrpc'] === '2.0' &&
    (typeof record['id'] === 'string' || typeof record['id'] === 'number') &&
    typeof record['method'] === 'string'
  )
}

async function serveCapSocket(
  server: CapRpcServer,
  socketPath: string
): Promise<SocketServerHandle> {
  await ensureSocketAvailable(socketPath)
  const decoder = new TextDecoder()
  const conns = new WeakMap<object, SocketConnectionState>()
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        conns.set(socket, { buffer: '', tail: Promise.resolve() })
      },
      data(socket, data) {
        const state = conns.get(socket)
        if (state === undefined) {
          return
        }

        state.buffer += decoder.decode(data, { stream: true })
        let newlineIndex = state.buffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = state.buffer.slice(0, newlineIndex).trim()
          state.buffer = state.buffer.slice(newlineIndex + 1)
          if (line.length > 0) {
            state.tail = state.tail.then(async () => {
              const response = await server.handleRaw(line)
              try {
                socket.write(`${JSON.stringify(response)}\n`)
              } catch {
                // The CLI may have disconnected after sending the frame.
              }
            })
          }
          newlineIndex = state.buffer.indexOf('\n')
        }
      },
      close(socket) {
        conns.delete(socket)
      },
      error(socket) {
        conns.delete(socket)
      },
    },
  })

  try {
    await chmod(socketPath, 0o600)
  } catch {
    // Best effort; some platforms create the socket lazily.
  }

  let stopped = false
  return {
    path: socketPath,
    async stop() {
      if (stopped) {
        return
      }

      stopped = true
      listener.stop(true)
      if (existsSync(socketPath)) {
        await unlink(socketPath).catch(() => undefined)
      }
    },
  }
}

async function ensureSocketAvailable(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return
  }

  let live = false
  try {
    const probe = await Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.end()
        },
        data() {},
        close() {},
        error() {},
      },
    })
    live = true
    probe.end()
  } catch {
    live = false
  }

  if (live) {
    throw new Error(`cap socket already in use by a live server: ${socketPath}`)
  }

  await unlink(socketPath)
}
