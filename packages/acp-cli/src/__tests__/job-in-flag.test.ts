import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { main } from '../cli.js'

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type FetchExpectation = {
  status?: number | undefined
  body?: unknown
  assert(request: {
    url: string
    method: string
    headers: Headers
    body: unknown
  }): void
}

class CliExit extends Error {
  constructor(readonly code: number) {
    super(`CLI exited with code ${code}`)
  }
}

function captureChunk(chunk: string | ArrayBufferView | ArrayBuffer, target: string[]): void {
  if (typeof chunk === 'string') {
    target.push(chunk)
    return
  }

  const view = chunk as ArrayBufferView
  target.push(Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8'))
}

async function runCli(
  args: string[],
  options: {
    fetchImpl?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>
    env?: NodeJS.ProcessEnv | undefined
  } = {}
): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit

  process.stdout.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stdout)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: string | ArrayBufferView | ArrayBuffer, ...rest: unknown[]) => {
    captureChunk(chunk, stderr)
    const callback = rest.find((value) => typeof value === 'function') as (() => void) | undefined
    callback?.()
    return true
  }) as typeof process.stderr.write

  process.exit = ((code?: number) => {
    throw new CliExit(code ?? 0)
  }) as typeof process.exit

  try {
    await main(args, {
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    })
    return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: 0 }
  } catch (error) {
    if (error instanceof CliExit) {
      return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: error.code }
    }
    throw error
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
  }
}

function createFetchQueue(expectations: FetchExpectation[]) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = []

  return {
    calls,
    async fetchImpl(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const text = await request.text()
      const body =
        text.length === 0
          ? undefined
          : (() => {
              try {
                return JSON.parse(text) as unknown
              } catch {
                return text
              }
            })()

      const recorded = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body,
      }
      calls.push(recorded)

      const expectation = expectations.shift()
      if (expectation === undefined) {
        throw new Error(`unexpected fetch for ${request.method} ${request.url}`)
      }

      expectation.assert(recorded)
      return new Response(
        expectation.body === undefined ? null : JSON.stringify(expectation.body),
        {
          status: expectation.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    },
  }
}

describe('acp job --in flag', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'job-in-flag-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('job validate --in', () => {
    test('posts parsed JSON body to /v1/admin/jobs/validate', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          projectId: 'proj-1',
          agentId: 'agent-1',
          schedule: { cron: '0 * * * *' },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: { valid: true },
          assert(request) {
            expect(request.method).toBe('POST')
            expect(new URL(request.url).pathname).toBe('/v1/admin/jobs/validate')
            expect(request.body).toMatchObject({
              projectId: 'proj-1',
              agentId: 'agent-1',
              schedule: { cron: '0 * * * *' },
            })
          },
        },
      ])

      const result = await runCli(['job', 'validate', '--in', jobFile, '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ valid: true })
      expect(fetchQueue.calls).toHaveLength(1)
    })

    test('resolves inputFile in flow.sequence before sending', async () => {
      const promptFile = join(tempDir, 'prompt.txt')
      writeFileSync(promptFile, 'hello from file')

      const jobFile = join(tempDir, 'job.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          schedule: { cron: '0 * * * *' },
          flow: {
            sequence: [{ stepId: 's1', inputFile: 'prompt.txt' }],
          },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: { valid: true },
          assert(request) {
            const body = request.body as Record<string, unknown>
            const flow = body['flow'] as Record<string, unknown>
            const steps = flow['sequence'] as Record<string, unknown>[]
            expect(steps[0]['input']).toBe('hello from file')
            expect(steps[0]['inputFile']).toBeUndefined()
          },
        },
      ])

      const result = await runCli(['job', 'validate', '--in', jobFile, '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(0)
    })

    test('errors when --in is not provided', async () => {
      const fetchQueue = createFetchQueue([])

      const result = await runCli(['job', 'validate', '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(2)
      expect(fetchQueue.calls).toHaveLength(0)
    })
  })

  describe('job create --in', () => {
    test('posts file body to /v1/admin/jobs', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          projectId: 'proj-1',
          agentId: 'agent-1',
          scopeRef: 'agent:agent-1:project:proj-1',
          schedule: { cron: '0 * * * *' },
          input: { content: 'from file' },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: {
            job: { jobId: 'job-1', projectId: 'proj-1', agentId: 'agent-1' },
          },
          assert(request) {
            expect(request.method).toBe('POST')
            expect(new URL(request.url).pathname).toBe('/v1/admin/jobs')
            expect(request.body).toMatchObject({
              projectId: 'proj-1',
              agentId: 'agent-1',
              scopeRef: 'agent:agent-1:project:proj-1',
              schedule: { cron: '0 * * * *' },
              input: { content: 'from file' },
            })
          },
        },
      ])

      const result = await runCli(['job', 'create', '--in', jobFile, '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ job: { jobId: 'job-1' } })
      expect(fetchQueue.calls).toHaveLength(1)
    })

    test('--job overrides jobId from file', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          jobId: 'file-id',
          projectId: 'proj-1',
          agentId: 'agent-1',
          scopeRef: 'agent:agent-1:project:proj-1',
          schedule: { cron: '0 * * * *' },
          input: { content: 'test' },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: {
            job: { jobId: 'override-id', projectId: 'proj-1' },
          },
          assert(request) {
            expect((request.body as Record<string, unknown>)['jobId']).toBe('override-id')
          },
        },
      ])

      const result = await runCli(
        ['job', 'create', '--in', jobFile, '--job', 'override-id', '--json'],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(0)
    })

    test('mutual exclusion: --in with --input errors', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(jobFile, JSON.stringify({ projectId: 'p' }))

      const fetchQueue = createFetchQueue([])
      const result = await runCli(
        ['job', 'create', '--in', jobFile, '--input', '{"x":1}', '--json'],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--in cannot be combined with --input')
      expect(fetchQueue.calls).toHaveLength(0)
    })

    test('mutual exclusion: --in with --cron errors', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(jobFile, JSON.stringify({ projectId: 'p' }))

      const fetchQueue = createFetchQueue([])
      const result = await runCli(
        ['job', 'create', '--in', jobFile, '--cron', '0 * * * *', '--json'],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--in cannot be combined with --cron')
      expect(fetchQueue.calls).toHaveLength(0)
    })

    test('mutual exclusion: --in with --project errors', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(jobFile, JSON.stringify({ projectId: 'p' }))

      const fetchQueue = createFetchQueue([])
      const result = await runCli(
        ['job', 'create', '--in', jobFile, '--project', 'proj-1', '--json'],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--in cannot be combined with --project')
      expect(fetchQueue.calls).toHaveLength(0)
    })

    test('mutual exclusion: --in with --agent errors', async () => {
      const jobFile = join(tempDir, 'job.json')
      writeFileSync(jobFile, JSON.stringify({ projectId: 'p' }))

      const fetchQueue = createFetchQueue([])
      const result = await runCli(['job', 'create', '--in', jobFile, '--agent', 'a1', '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--in cannot be combined with --agent')
      expect(fetchQueue.calls).toHaveLength(0)
    })
  })

  describe('job create (legacy --input still works)', () => {
    test('existing --input behavior is preserved', async () => {
      const fetchQueue = createFetchQueue([
        {
          body: {
            job: { jobId: 'job-1', projectId: 'agent-spaces', agentId: 'larry' },
          },
          assert(request) {
            expect(request.method).toBe('POST')
            expect(new URL(request.url).pathname).toBe('/v1/admin/jobs')
            expect(request.body).toMatchObject({
              projectId: 'agent-spaces',
              agentId: 'larry',
              scopeRef: 'agent:larry:project:agent-spaces',
              schedule: { cron: '0 * * * *' },
              input: { content: 'status' },
            })
          },
        },
      ])

      const result = await runCli(
        [
          'job',
          'create',
          '--project',
          'agent-spaces',
          '--agent',
          'larry',
          '--scope-ref',
          'agent:larry:project:agent-spaces',
          '--cron',
          '0 * * * *',
          '--input',
          '{"content":"status"}',
          '--json',
        ],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ job: { jobId: 'job-1' } })
    })
  })

  describe('job patch --in', () => {
    test('patches job with file body', async () => {
      const jobFile = join(tempDir, 'patch.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          schedule: { cron: '*/5 * * * *' },
          input: { content: 'patched' },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: {
            job: { jobId: 'job-1', schedule: { cron: '*/5 * * * *' } },
          },
          assert(request) {
            expect(request.method).toBe('PATCH')
            expect(new URL(request.url).pathname).toBe('/v1/admin/jobs/job-1')
            expect(request.body).toMatchObject({
              schedule: { cron: '*/5 * * * *' },
              input: { content: 'patched' },
            })
          },
        },
      ])

      const result = await runCli(['job', 'patch', '--job', 'job-1', '--in', jobFile, '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ job: { jobId: 'job-1' } })
    })

    test('resolves inputFile in patch file before sending', async () => {
      const promptFile = join(tempDir, 'step-input.txt')
      writeFileSync(promptFile, 'resolved step input')

      const jobFile = join(tempDir, 'patch.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          flow: {
            sequence: [{ stepId: 's1', inputFile: 'step-input.txt' }],
          },
        })
      )

      const fetchQueue = createFetchQueue([
        {
          body: { job: { jobId: 'job-1' } },
          assert(request) {
            const body = request.body as Record<string, unknown>
            const flow = body['flow'] as Record<string, unknown>
            const steps = flow['sequence'] as Record<string, unknown>[]
            expect(steps[0]['input']).toBe('resolved step input')
            expect(steps[0]['inputFile']).toBeUndefined()
          },
        },
      ])

      const result = await runCli(['job', 'patch', '--job', 'job-1', '--in', jobFile, '--json'], {
        fetchImpl: fetchQueue.fetchImpl,
      })

      expect(result.exitCode).toBe(0)
    })

    test('mutual exclusion: --in with --input errors for patch', async () => {
      const jobFile = join(tempDir, 'patch.json')
      writeFileSync(jobFile, JSON.stringify({ schedule: { cron: '0 * * * *' } }))

      const fetchQueue = createFetchQueue([])
      const result = await runCli(
        ['job', 'patch', '--job', 'j1', '--in', jobFile, '--input', '{"x":1}', '--json'],
        { fetchImpl: fetchQueue.fetchImpl }
      )

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--in cannot be combined with --input')
      expect(fetchQueue.calls).toHaveLength(0)
    })
  })
})
