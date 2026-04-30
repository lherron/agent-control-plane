/**
 * Environment variable resolution for gateway-ios.
 */

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 18480
export const DEFAULT_GATEWAY_ID = 'ios-local'

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.length > 0) {
      return value
    }
  }
  throw new Error(`Missing required env var: ${names.join(' or ')}`)
}

function optionalEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.length > 0) {
      return value
    }
  }
  return undefined
}

function envNumber(names: string[], fallback: number): number {
  const raw = optionalEnv(...names)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export type GatewayIosConfig = {
  hrcSocketPath: string
  host: string
  port: number
  bearerToken: string | undefined
  gatewayId: string
}

/** Resolve gateway config from environment variables. */
export function resolveConfig(): GatewayIosConfig {
  return {
    hrcSocketPath: requiredEnv('HRC_SOCKET_PATH', 'HRC_CONTROL_SOCKET'),
    host: optionalEnv('ACP_IOS_GATEWAY_HOST') ?? DEFAULT_HOST,
    port: envNumber(['ACP_IOS_GATEWAY_PORT'], DEFAULT_PORT),
    bearerToken: optionalEnv('ACP_IOS_GATEWAY_TOKEN'),
    gatewayId: optionalEnv('ACP_IOS_GATEWAY_ID') ?? DEFAULT_GATEWAY_ID,
  }
}
