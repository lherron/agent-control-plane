import { spawn } from 'node:child_process'
import path from 'node:path'

import type { ExecFlowStep, ExecStepResult } from 'acp-core'

import type { JobExecPolicy } from './exec-policy.js'

export type RunExecStepInput = {
  step: ExecFlowStep
  defaultCwd: string
  policy: JobExecPolicy
  now?: (() => Date) | undefined
}

export class ExecStepError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ExecStepError'
    this.code = code
  }
}

type OutputCapture = {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

function deny(message: string): never {
  throw new ExecStepError('exec_policy_denied', message)
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function resolveCwd(step: ExecFlowStep, defaultCwd: string, policy: JobExecPolicy): string {
  const cwd = path.resolve(defaultCwd, step.exec.cwd ?? '.')
  const allowedRoots = policy.allowedCwdRoots.map((root) => path.resolve(root))

  if (!allowedRoots.some((root) => isPathWithinRoot(cwd, root))) {
    deny(`exec cwd is outside allowed roots: ${cwd}`)
  }

  return cwd
}

function buildEnv(step: ExecFlowStep, policy: JobExecPolicy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const key of policy.inheritEnvAllowlist) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(step.exec.env ?? {})) {
    env[key] = value
  }

  return env
}

function parseIsoDurationMs(value: string): number | undefined {
  const match =
    /^P(?:(\d+(?:[.,]\d+)?)D)?(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/.exec(
      value
    )
  if (match === null) {
    return undefined
  }

  const days = parseDurationPart(match[1], 24 * 60 * 60 * 1000)
  const hours = parseDurationPart(match[2], 60 * 60 * 1000)
  const minutes = parseDurationPart(match[3], 60 * 1000)
  const seconds = parseDurationPart(match[4], 1000)
  const total = days + hours + minutes + seconds
  return total > 0 && Number.isFinite(total) ? Math.floor(total) : undefined
}

function parseDurationPart(value: string | undefined, factor: number): number {
  if (value === undefined) {
    return 0
  }

  return Number.parseFloat(value.replace(',', '.')) * factor
}

function resolveTimeoutMs(step: ExecFlowStep, policy: JobExecPolicy): number {
  const stepTimeout = step.exec.timeout ?? step.timeout
  const requested =
    stepTimeout === undefined ? policy.defaultTimeoutMs : parseIsoDurationMs(stepTimeout)
  return Math.min(requested ?? policy.defaultTimeoutMs, policy.maxTimeoutMs)
}

function resolveMaxOutputBytes(step: ExecFlowStep, policy: JobExecPolicy): number {
  const requested = step.exec.maxOutputBytes ?? policy.defaultMaxOutputBytes
  return Math.max(0, Math.min(requested, policy.maxOutputBytes))
}

function appendCapture(capture: OutputCapture, chunk: Buffer, maxBytes: number): void {
  const remaining = maxBytes - capture.bytes
  if (remaining > 0) {
    const acceptedBytes = Math.min(remaining, chunk.length)
    if (acceptedBytes > 0) {
      capture.chunks.push(chunk.subarray(0, acceptedBytes))
      capture.bytes += acceptedBytes
    }
    if (acceptedBytes < chunk.length) {
      capture.truncated = true
    }
    return
  }

  if (chunk.length > 0) {
    capture.truncated = true
  }
}

function captureToString(capture: OutputCapture): string {
  return Buffer.concat(capture.chunks).toString('utf8')
}

export async function runExecStep(input: RunExecStepInput): Promise<ExecStepResult> {
  if (!input.policy.enabled) {
    deny('exec steps are disabled by policy')
  }
  if (input.step.exec.argv.length === 0) {
    throw new ExecStepError('exec_spawn_failed', 'exec argv must not be empty')
  }

  const cwd = resolveCwd(input.step, input.defaultCwd, input.policy)
  const env = buildEnv(input.step, input.policy)
  const timeoutMs = resolveTimeoutMs(input.step, input.policy)
  const maxOutputBytes = resolveMaxOutputBytes(input.step, input.policy)
  const startedAtDate = (input.now ?? (() => new Date()))()
  const startedAt = startedAtDate.toISOString()
  const controller = new AbortController()
  const stdout: OutputCapture = { chunks: [], bytes: 0, truncated: false }
  const stderr: OutputCapture = { chunks: [], bytes: 0, truncated: false }
  let timedOut = false

  const [command, ...args] = input.step.exec.argv
  if (command === undefined) {
    throw new ExecStepError('exec_spawn_failed', 'exec argv must include a command')
  }

  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    signal: controller.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    appendCapture(stdout, chunk, maxOutputBytes)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    appendCapture(stderr, chunk, maxOutputBytes)
  })

  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const closeResult = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once('error', (error) => {
          if (timedOut && error.name === 'AbortError') {
            return
          }
          reject(error)
        })
        child.once('close', (exitCode, signal) => {
          resolve({ exitCode, signal })
        })
      }
    )
    const completedAtDate = (input.now ?? (() => new Date()))()

    return {
      kind: 'exec',
      argv: input.step.exec.argv,
      cwd,
      exitCode: timedOut ? null : closeResult.exitCode,
      ...(closeResult.signal !== null ? { signal: closeResult.signal } : {}),
      stdout: captureToString(stdout),
      stderr: captureToString(stderr),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      timedOut,
      durationMs: Math.max(0, completedAtDate.getTime() - startedAtDate.getTime()),
      startedAt,
      completedAt: completedAtDate.toISOString(),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to spawn exec step'
    throw new ExecStepError('exec_spawn_failed', message)
  } finally {
    clearTimeout(timeoutId)
  }
}
