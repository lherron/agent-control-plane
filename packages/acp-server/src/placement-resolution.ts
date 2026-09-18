import { HrcDomainError, HrcErrorCode, resolveControlSocketPath } from 'hrc-core'

/**
 * T-08598: daemon-backed scope placement resolution (`POST
 * /v1/placements/resolve`, T-08597). acp-server performs NO local ASP
 * declaration interpretation: agent roots, project roots, bundles and harness
 * facts come from the installed HRC daemon, which reads them through aspd.
 * There is no fallback — an unreachable daemon or a daemon without the route
 * is a typed refusal, and a declaration refusal (unknown agent/project)
 * propagates with the daemon's code and message.
 *
 * Transport note: this posts over the daemon unix socket with Bun's `unix`
 * fetch option, the same transport `HrcClient` uses. When ACP's governed HRC
 * tuple advances past the T-08597 install, prefer the hrc-sdk daemon-backed
 * names (`resolveHrcAgentPlacementPaths` / `resolveProfileAwareScopeInput`)
 * and delete this module's transport.
 */

export type PlacementResolutionRequest = {
  scopeRef?: string | undefined
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  cwd?: string | undefined
  projectRoot?: string | undefined
  agentRoot?: string | undefined
  runMode?: string | undefined
}

export type PlacementResolutionHarness = {
  provider: 'anthropic' | 'openai'
  frontend?: string | undefined
  effectiveHarness?: string | undefined
  transport?: string | undefined
  interactive: boolean
}

export type PlacementResolution = {
  agentRoot: string
  projectRoot?: string | undefined
  cwd: string
  bundle: { kind: string; [key: string]: unknown }
  bundleIdentity?: string | undefined
  harness: PlacementResolutionHarness
}

export type FetchPlacementResolution = (
  input: PlacementResolutionRequest,
  opts?: { socketPath?: string | undefined }
) => Promise<PlacementResolution>

type BunRequestInit = RequestInit & { unix?: string | undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' ? value : undefined
}

function requirePlacementResolution(body: unknown): PlacementResolution {
  if (!isRecord(body)) {
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      'HRC placement resolution returned a malformed body',
      {
        code: 'placement_malformed',
      }
    )
  }
  const agentRoot = readOptionalString(body, 'agentRoot')
  const cwd = readOptionalString(body, 'cwd')
  const bundle = body['bundle']
  const harness = body['harness']
  const provider = isRecord(harness) ? harness['provider'] : undefined
  const interactive = isRecord(harness) ? harness['interactive'] : undefined
  if (
    agentRoot === undefined ||
    cwd === undefined ||
    !isRecord(bundle) ||
    typeof bundle['kind'] !== 'string' ||
    !isRecord(harness) ||
    (provider !== 'anthropic' && provider !== 'openai') ||
    typeof interactive !== 'boolean'
  ) {
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      'HRC placement resolution returned a malformed body',
      {
        code: 'placement_malformed',
      }
    )
  }
  return {
    agentRoot,
    ...(readOptionalString(body, 'projectRoot') !== undefined
      ? { projectRoot: readOptionalString(body, 'projectRoot') as string }
      : {}),
    cwd,
    bundle: bundle as { kind: string; [key: string]: unknown },
    ...(readOptionalString(body, 'bundleIdentity') !== undefined
      ? { bundleIdentity: readOptionalString(body, 'bundleIdentity') as string }
      : {}),
    harness: {
      provider,
      interactive,
      ...(readOptionalString(harness, 'frontend') !== undefined
        ? { frontend: readOptionalString(harness, 'frontend') as string }
        : {}),
      ...(readOptionalString(harness, 'effectiveHarness') !== undefined
        ? { effectiveHarness: readOptionalString(harness, 'effectiveHarness') as string }
        : {}),
      ...(readOptionalString(harness, 'transport') !== undefined
        ? { transport: readOptionalString(harness, 'transport') as string }
        : {}),
    },
  }
}

async function throwPlacementError(res: Response, socketPath: string): Promise<never> {
  let code: string | undefined
  let message = `HRC placement resolution failed with status ${res.status}`
  let detail: unknown = { route: '/v1/placements/resolve', socketPath }
  try {
    const body = (await res.json()) as unknown
    if (isRecord(body) && isRecord(body['error'])) {
      const error = body['error']
      if (typeof error['code'] === 'string') code = error['code']
      if (typeof error['message'] === 'string') message = error['message']
      if (error['detail'] !== undefined) detail = error['detail']
    }
  } catch {
    // Fall through with the status-derived error.
  }
  const knownCodes = new Set<string>(Object.values(HrcErrorCode))
  const domainCode =
    code !== undefined && knownCodes.has(code)
      ? (code as HrcErrorCode)
      : HrcErrorCode.RUNTIME_UNAVAILABLE
  throw new HrcDomainError(
    domainCode,
    message,
    (isRecord(detail)
      ? { ...detail, ...(code !== undefined ? { producerCode: code } : {}) }
      : { detail }) as Record<string, unknown>
  )
}

export async function fetchPlacementResolution(
  input: PlacementResolutionRequest,
  opts: { socketPath?: string | undefined } = {}
): Promise<PlacementResolution> {
  const socketPath = opts.socketPath ?? resolveControlSocketPath()
  let res: Response
  try {
    res = await fetch('http://localhost/v1/placements/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      unix: socketPath,
    } as BunRequestInit)
  } catch (error) {
    throw new HrcDomainError(
      HrcErrorCode.RUNTIME_UNAVAILABLE,
      `HRC daemon unreachable at ${socketPath}`,
      {
        code: 'hrc_daemon_unreachable',
        socketPath,
        cause: error instanceof Error ? error.message : String(error),
      }
    )
  }
  if (res.status === 404) {
    throw new HrcDomainError(
      HrcErrorCode.UNSUPPORTED_CAPABILITY,
      'HRC daemon does not serve placement resolution',
      { capability: 'placements.resolve', route: '/v1/placements/resolve' }
    )
  }
  if (!res.ok) {
    await throwPlacementError(res, socketPath)
  }
  return requirePlacementResolution(await res.json())
}
