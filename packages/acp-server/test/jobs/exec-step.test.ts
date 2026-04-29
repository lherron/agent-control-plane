import { afterEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import type { ExecFlowStep, ExecStepResult } from 'acp-core'

import type { JobExecPolicy } from '../../src/jobs/exec-policy.js'
import { resolveJobExecPolicy } from '../../src/jobs/exec-policy.js'
import { runExecStep } from '../../src/jobs/exec-step.js'

const jsRuntime = process.execPath
const defaultCwd = process.cwd()

function execStep(argv: string[], exec?: Partial<ExecFlowStep['exec']>): ExecFlowStep {
  return {
    id: 'exec-test',
    kind: 'exec',
    exec: {
      argv,
      ...exec,
    },
  }
}

function policy(overrides: Partial<JobExecPolicy> = {}): JobExecPolicy {
  return {
    enabled: true,
    allowedCwdRoots: [defaultCwd],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 5_000,
    defaultMaxOutputBytes: 64 * 1024,
    maxOutputBytes: 64 * 1024,
    inheritEnvAllowlist: [],
    ...overrides,
  }
}

async function expectCodedRejection(promise: Promise<ExecStepResult>, code: string): Promise<void> {
  expect.assertions(2)

  try {
    await promise
  } catch (error) {
    expect(error).toMatchObject({ code })
    expect(error).toBeInstanceOf(Error)
    return
  }

  throw new Error(`Expected rejection with code ${code}`)
}

describe('resolveJobExecPolicy', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  test('defaults to disabled unless ACP_JOB_FLOW_EXEC_ENABLED=1', () => {
    process.env.ACP_JOB_FLOW_EXEC_ENABLED = undefined

    expect(resolveJobExecPolicy({ allowedCwdRoots: [defaultCwd] }).enabled).toBe(false)

    process.env.ACP_JOB_FLOW_EXEC_ENABLED = '1'

    expect(resolveJobExecPolicy({ allowedCwdRoots: [defaultCwd] }).enabled).toBe(true)
  })
})

describe('runExecStep', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key]
      }
    }
    Object.assign(process.env, originalEnv)
  })

  test('captures stdout, stderr, exit code, cwd, and timestamps from a real subprocess', async () => {
    const result = await runExecStep({
      step: execStep([
        jsRuntime,
        '-e',
        [
          "process.stdout.write('stdout-line')",
          "process.stderr.write('stderr-line')",
          'process.exit(0)',
        ].join(';'),
      ]),
      defaultCwd,
      policy: policy(),
    })

    expect(result).toMatchObject({
      kind: 'exec',
      argv: [jsRuntime, '-e', expect.any(String)],
      cwd: defaultCwd,
      exitCode: 0,
      stdout: 'stdout-line',
      stderr: 'stderr-line',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(Date.parse(result.startedAt)).not.toBeNaN()
    expect(Date.parse(result.completedAt)).not.toBeNaN()
  })

  test('returns non-zero exit code without hiding subprocess output', async () => {
    const result = await runExecStep({
      step: execStep([
        jsRuntime,
        '-e',
        "process.stdout.write('before-fail'); process.stderr.write('bad'); process.exit(7)",
      ]),
      defaultCwd,
      policy: policy(),
    })

    expect(result.exitCode).toBe(7)
    expect(result.signal).toBeUndefined()
    expect(result.stdout).toBe('before-fail')
    expect(result.stderr).toBe('bad')
    expect(result.timedOut).toBe(false)
  })

  test('enforces timeout and marks the result as timed out', async () => {
    const result = await runExecStep({
      step: execStep([jsRuntime, '-e', 'setTimeout(() => {}, 1000)']),
      defaultCwd,
      policy: policy({ defaultTimeoutMs: 25, maxTimeoutMs: 25 }),
    })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeLessThan(1_000)
  })

  test('truncates stdout and stderr at maxOutputBytes', async () => {
    const result = await runExecStep({
      step: execStep([
        jsRuntime,
        '-e',
        "process.stdout.write('abcdef'); process.stderr.write('uvwxyz')",
      ]),
      defaultCwd,
      policy: policy({ defaultMaxOutputBytes: 4, maxOutputBytes: 4 }),
    })

    expect(result.stdout).toBe('abcd')
    expect(result.stderr).toBe('uvwx')
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  test('denies execution when policy is disabled', async () => {
    await expectCodedRejection(
      runExecStep({
        step: execStep([jsRuntime, '-e', "process.stdout.write('should-not-run')"]),
        defaultCwd,
        policy: policy({ enabled: false }),
      }),
      'exec_policy_denied'
    )
  })

  test('denies cwd outside allowed roots', async () => {
    await expectCodedRejection(
      runExecStep({
        step: execStep([jsRuntime, '-e', "process.stdout.write('should-not-run')"], {
          cwd: path.parse(defaultCwd).root,
        }),
        defaultCwd,
        policy: policy({ allowedCwdRoots: [path.join(defaultCwd, 'allowed-root')] }),
      }),
      'exec_policy_denied'
    )
  })

  test('preserves argv literally and does not require shell-string invocation', async () => {
    const shellLikeArgument = 'literal; echo SHELL_WOULD_HAVE_RUN'

    const result = await runExecStep({
      step: execStep([
        jsRuntime,
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        shellLikeArgument,
      ]),
      defaultCwd,
      policy: policy(),
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(shellLikeArgument)
    expect(result.stdout).not.toContain('\nSHELL_WOULD_HAVE_RUN')
  })

  test('inherits only allowlisted env vars and adds explicit step env', async () => {
    process.env.ACP_EXEC_ALLOWED_TEST = 'from-parent'
    process.env.ACP_EXEC_DENIED_TEST = 'from-parent-denied'

    const result = await runExecStep({
      step: execStep(
        [
          jsRuntime,
          '-e',
          [
            'process.stdout.write(JSON.stringify({',
            'allowed: process.env.ACP_EXEC_ALLOWED_TEST,',
            'denied: process.env.ACP_EXEC_DENIED_TEST,',
            'explicit: process.env.ACP_EXEC_EXPLICIT_TEST',
            '}))',
          ].join(' '),
        ],
        {
          env: {
            ACP_EXEC_EXPLICIT_TEST: 'from-step',
          },
        }
      ),
      defaultCwd,
      policy: policy({ inheritEnvAllowlist: ['ACP_EXEC_ALLOWED_TEST'] }),
    })

    expect(JSON.parse(result.stdout)).toEqual({
      allowed: 'from-parent',
      explicit: 'from-step',
    })
  })
})
