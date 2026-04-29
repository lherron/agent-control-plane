export type JobExecPolicy = {
  enabled: boolean
  allowedCwdRoots: string[]
  defaultTimeoutMs: number
  maxTimeoutMs: number
  defaultMaxOutputBytes: number
  maxOutputBytes: number
  inheritEnvAllowlist: string[]
}

export const DEFAULT_JOB_EXEC_POLICY: JobExecPolicy = {
  enabled: false,
  allowedCwdRoots: [],
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 15 * 60_000,
  defaultMaxOutputBytes: 64 * 1024,
  maxOutputBytes: 1024 * 1024,
  inheritEnvAllowlist: [],
}

export type ResolveJobExecPolicyInput = Partial<JobExecPolicy>

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return fallback
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function resolveJobExecPolicy(input: ResolveJobExecPolicyInput = {}): JobExecPolicy {
  const enabled = input.enabled ?? process.env['ACP_JOB_FLOW_EXEC_ENABLED'] === '1'
  const allowedCwdRoots =
    input.allowedCwdRoots ??
    parseList(
      process.env['ACP_JOB_FLOW_EXEC_ALLOWED_CWD_ROOTS'],
      DEFAULT_JOB_EXEC_POLICY.allowedCwdRoots
    )
  const defaultTimeoutMs =
    input.defaultTimeoutMs ??
    parsePositiveInteger(
      process.env['ACP_JOB_FLOW_EXEC_DEFAULT_TIMEOUT_MS'],
      DEFAULT_JOB_EXEC_POLICY.defaultTimeoutMs
    )
  const maxTimeoutMs =
    input.maxTimeoutMs ??
    parsePositiveInteger(
      process.env['ACP_JOB_FLOW_EXEC_MAX_TIMEOUT_MS'],
      DEFAULT_JOB_EXEC_POLICY.maxTimeoutMs
    )
  const maxOutputBytes =
    input.maxOutputBytes ??
    parsePositiveInteger(
      process.env['ACP_JOB_FLOW_EXEC_MAX_OUTPUT_BYTES'],
      DEFAULT_JOB_EXEC_POLICY.maxOutputBytes
    )
  const defaultMaxOutputBytes =
    input.defaultMaxOutputBytes ??
    parsePositiveInteger(
      process.env['ACP_JOB_FLOW_EXEC_DEFAULT_MAX_OUTPUT_BYTES'],
      DEFAULT_JOB_EXEC_POLICY.defaultMaxOutputBytes
    )

  return {
    enabled,
    allowedCwdRoots,
    defaultTimeoutMs: Math.min(defaultTimeoutMs, maxTimeoutMs),
    maxTimeoutMs,
    defaultMaxOutputBytes: Math.min(defaultMaxOutputBytes, maxOutputBytes),
    maxOutputBytes,
    inheritEnvAllowlist:
      input.inheritEnvAllowlist ??
      parseList(
        process.env['ACP_JOB_FLOW_EXEC_INHERIT_ENV_ALLOWLIST'],
        DEFAULT_JOB_EXEC_POLICY.inheritEnvAllowlist
      ),
  }
}
