import {
  HrcDomainError,
  HrcErrorCode,
  type HrcHarness,
  type HrcHarnessIntent,
  resolveControlSocketPath,
} from 'hrc-core'

/**
 * T-08598: daemon-backed scope placement resolution (`POST
 * /v1/placements/resolve`, T-08597) and run preview (`POST /v1/previews/run`).
 * acp-server performs NO local ASP declaration interpretation: agent roots,
 * project roots, bundles, harness facts and compiled prompts come from the
 * installed HRC daemon, which reads them through aspd. There is no fallback —
 * an unreachable daemon or a daemon without the route is a typed refusal,
 * and a declaration refusal (unknown agent/project) propagates with the
 * daemon's code and message.
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

/**
 * Harness facts as the daemon reports them. Under ASP harness selection v2
 * the daemon may report only `effectiveHarness`: provider, frontend and
 * transport are ASP's to select at launch, so every field is optional.
 */
export type PlacementResolutionHarness = {
  provider?: 'anthropic' | 'openai' | undefined
  frontend?: string | undefined
  effectiveHarness?: string | undefined
  transport?: string | undefined
  interactive?: boolean | undefined
}

export type PlacementResolution = {
  agentRoot: string
  projectRoot?: string | undefined
  cwd: string
  bundle: { kind: string; [key: string]: unknown }
  bundleIdentity?: string | undefined
  harness: PlacementResolutionHarness
  agentSources?: { agentsRoot?: string | undefined; aspHome?: string | undefined } | undefined
}

export type FetchPlacementResolution = (
  input: PlacementResolutionRequest,
  opts?: { socketPath?: string | undefined }
) => Promise<PlacementResolution>

export type RunPreviewRequest = {
  intent: {
    placement: Record<string, unknown>
    harness?: Record<string, unknown> | undefined
    [key: string]: unknown
  }
  sessionRef: string
}

export type RunPreview = {
  systemPrompt: string | null
  systemPromptMode: 'replace' | 'append'
  primingPrompt?: string | undefined
  reminderContent?: string | undefined
  promptSectionSizes: string[]
  reminderSectionSizes: string[]
  totalContextChars: number
  nearMaxChars: boolean
  warnings: string[]
}

export type FetchRunPreview = (
  input: RunPreviewRequest,
  opts?: { socketPath?: string | undefined }
) => Promise<RunPreview>

const HRC_HARNESS_IDS: ReadonlySet<string> = new Set<HrcHarness>([
  'agent-sdk',
  'claude-code',
  'codex-cli',
  'pi',
  'pi-cli',
  'pi-sdk',
])

function isHrcHarness(value: string): value is HrcHarness {
  return HRC_HARNESS_IDS.has(value)
}

/**
 * Map a daemon-resolved harness to the launch intent shape. Only HRC-known
 * harness ids are forwarded as an explicit id; anything else lets HRC pick
 * its default at launch. A v2 resolution without a provider omits it so HRC
 * leaves provider selection to ASP; the cast covers ACP's pinned hrc-core,
 * which still types `provider` as required.
 */
export function daemonHarnessToHrcHarness(harness: PlacementResolutionHarness): HrcHarnessIntent {
  const frontend = harness.frontend
  return {
    ...(harness.provider !== undefined ? { provider: harness.provider } : {}),
    interactive: harness.interactive ?? true,
    ...(frontend !== undefined && isHrcHarness(frontend) ? { id: frontend } : {}),
  } as HrcHarnessIntent
}

type BunRequestInit = RequestInit & { unix?: string | undefined }

type DaemonRoute = {
  path: '/v1/placements/resolve' | '/v1/previews/run'
  capability: 'placements.resolve' | 'previews.run'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  return typeof value === 'string' ? value : undefined
}

function malformed(route: DaemonRoute): HrcDomainError {
  return new HrcDomainError(
    HrcErrorCode.RUNTIME_UNAVAILABLE,
    `HRC ${route.capability} returned a malformed body`,
    { code: `${route.capability.replace('.', '_')}_malformed` }
  )
}

async function postDaemonJson(
  route: DaemonRoute,
  input: Record<string, unknown>,
  opts: { socketPath?: string | undefined }
): Promise<unknown> {
  const socketPath = opts.socketPath ?? resolveControlSocketPath()
  let res: Response
  try {
    res = await fetch(`http://localhost${route.path}`, {
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
      `HRC daemon does not serve ${route.capability}`,
      { capability: route.capability, route: route.path }
    )
  }
  if (!res.ok) {
    let code: string | undefined
    let message = `HRC ${route.capability} failed with status ${res.status}`
    let detail: unknown = { route: route.path, socketPath }
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
  return res.json()
}

function requirePlacementResolution(body: unknown): PlacementResolution {
  const route: DaemonRoute = { path: '/v1/placements/resolve', capability: 'placements.resolve' }
  if (!isRecord(body)) throw malformed(route)
  const agentRoot = readOptionalString(body, 'agentRoot')
  const cwd = readOptionalString(body, 'cwd')
  const bundle = body['bundle']
  const harness = isRecord(body['harness']) ? body['harness'] : {}
  if (agentRoot === undefined || cwd === undefined || !isRecord(bundle)) throw malformed(route)
  if (typeof bundle['kind'] !== 'string') throw malformed(route)
  const provider = harness['provider']
  const interactive = harness['interactive']
  const projectRoot = readOptionalString(body, 'projectRoot')
  const bundleIdentity = readOptionalString(body, 'bundleIdentity')
  const frontend = readOptionalString(harness, 'frontend')
  const effectiveHarness = readOptionalString(harness, 'effectiveHarness')
  const transport = readOptionalString(harness, 'transport')
  const agentSources = isRecord(body['agentSources']) ? body['agentSources'] : undefined
  const agentsRoot = agentSources && readOptionalString(agentSources, 'agentsRoot')
  const aspHome = agentSources && readOptionalString(agentSources, 'aspHome')
  return {
    agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd,
    bundle: bundle as { kind: string; [key: string]: unknown },
    ...(bundleIdentity !== undefined ? { bundleIdentity } : {}),
    harness: {
      ...(provider === 'anthropic' || provider === 'openai' ? { provider } : {}),
      ...(typeof interactive === 'boolean' ? { interactive } : {}),
      ...(frontend !== undefined ? { frontend } : {}),
      ...(effectiveHarness !== undefined ? { effectiveHarness } : {}),
      ...(transport !== undefined ? { transport } : {}),
    },
    ...(agentSources !== undefined
      ? {
          agentSources: {
            ...(agentsRoot !== undefined ? { agentsRoot } : {}),
            ...(aspHome !== undefined ? { aspHome } : {}),
          },
        }
      : {}),
  }
}

function requireRunPreview(body: unknown): RunPreview {
  const route: DaemonRoute = { path: '/v1/previews/run', capability: 'previews.run' }
  if (!isRecord(body)) throw malformed(route)
  const systemPrompt = body['systemPrompt']
  if (systemPrompt !== null && typeof systemPrompt !== 'string') throw malformed(route)
  const mode = body['systemPromptMode']
  if (mode !== 'replace' && mode !== 'append') throw malformed(route)
  const readSizes = (field: string): string[] => {
    const value = body[field]
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
  }
  const readChars = (field: string): number => {
    const value = body[field]
    return typeof value === 'number' ? value : 0
  }
  return {
    systemPrompt,
    systemPromptMode: mode,
    ...(readOptionalString(body, 'primingPrompt') !== undefined
      ? { primingPrompt: readOptionalString(body, 'primingPrompt') as string }
      : {}),
    ...(readOptionalString(body, 'reminderContent') !== undefined
      ? { reminderContent: readOptionalString(body, 'reminderContent') as string }
      : {}),
    promptSectionSizes: readSizes('promptSectionSizes'),
    reminderSectionSizes: readSizes('reminderSectionSizes'),
    totalContextChars: readChars('totalContextChars'),
    nearMaxChars: body['nearMaxChars'] === true,
    warnings: readSizes('warnings'),
  }
}

export async function fetchPlacementResolution(
  input: PlacementResolutionRequest,
  opts: { socketPath?: string | undefined } = {}
): Promise<PlacementResolution> {
  const body = await postDaemonJson(
    { path: '/v1/placements/resolve', capability: 'placements.resolve' },
    input as Record<string, unknown>,
    opts
  )
  return requirePlacementResolution(body)
}

export async function fetchRunPreview(
  input: RunPreviewRequest,
  opts: { socketPath?: string | undefined } = {}
): Promise<RunPreview> {
  const body = await postDaemonJson(
    { path: '/v1/previews/run', capability: 'previews.run' },
    input as unknown as Record<string, unknown>,
    opts
  )
  return requireRunPreview(body)
}
