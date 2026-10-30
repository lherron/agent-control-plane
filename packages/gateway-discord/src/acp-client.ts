import { GATEWAY_DISCORD_USER_AGENT } from './user-agent.js'

type MobileSessionSummary = {
  sessionRef?: string | undefined
  status?: string | undefined
  summaryStatus?: string | undefined
  activeTurnId?: string | undefined
  capabilities?: {
    input?: boolean | undefined
  }
}

type MobileDashboardSnapshot = {
  type?: string | undefined
  sessions?: MobileSessionSummary[] | undefined
  cursors?: {
    lastHrcSeq?: number | undefined
  }
}

export type DashboardSnapshotFetcher = (
  acpBaseUrl: string,
  options?: { timeoutMs?: number | undefined }
) => Promise<MobileDashboardSnapshot>

export async function fetchDashboardSnapshotViaWebSocket(
  acpBaseUrl: string,
  options?: { timeoutMs?: number | undefined }
): Promise<MobileDashboardSnapshot> {
  const wsUrl = `${acpBaseUrl.replace(/^http/, 'ws')}/v1/mobile/dashboard`
  const timeoutMs = options?.timeoutMs ?? 5_000

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { 'user-agent': GATEWAY_DISCORD_USER_AGENT } })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`dashboard snapshot timeout after ${timeoutMs}ms`))
      try {
        ws.close()
      } catch {
        // ignore
      }
    }, timeoutMs)

    ws.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String((event as MessageEvent).data)) as MobileDashboardSnapshot
        if (payload?.type === 'dashboard_snapshot') {
          if (settled) return
          settled = true
          clearTimeout(timer)
          // Bun dispatches the resulting close event synchronously. Resolve the
          // snapshot before closing so that clean client teardown cannot win
          // the promise race and masquerade as a pre-snapshot server close.
          resolve(payload)
          try {
            ws.close()
          } catch {
            // ignore
          }
        }
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    })

    ws.addEventListener('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('dashboard snapshot websocket error'))
    })

    ws.addEventListener('close', (event) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new Error(
          `dashboard snapshot websocket closed before snapshot (code=${(event as CloseEvent).code})`
        )
      )
    })
  })
}

export class GatewayAcpClient {
  constructor(
    readonly baseUrl: string,
    readonly fetch: typeof globalThis.fetch,
    readonly dashboardSnapshot: DashboardSnapshotFetcher
  ) {}

  async fetchJson<T>(path: string): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`)
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
    return (await response.json()) as T
  }

  async postJson(path: string, body: unknown): Promise<void> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${await response.text()}`)
    }
  }
}
