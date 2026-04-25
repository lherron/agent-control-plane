import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRunCommand } from '../../src/commands/run.js'
import { runRuntimeCommand } from '../../src/commands/runtime.js'
import { runSendCommand } from '../../src/commands/send.js'
import { runSessionCommand } from '../../src/commands/session.js'
import { createFetchQueue, runCli } from '../cli-test-helpers.js'

function withTempFile(name: string, contents: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-cli-attachment-'))
  const path = join(dir, name)
  writeFileSync(path, contents)
  return { dir, path }
}

describe('runtime-oriented CLI commands', () => {
  test('runtime resolve posts a normalized sessionRef', async () => {
    const queue = createFetchQueue([
      {
        body: { placement: { agentRoot: '/tmp/agents/larry', runMode: 'task' } },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/runtime/resolve')
          expect(request.body).toEqual({
            sessionRef: {
              scopeRef: 'agent:larry:project:agent-spaces:task:T-01186:role:tester',
            },
          })
        },
      },
    ])

    const output = await runRuntimeCommand(
      ['resolve', '--scope-ref', 'larry@agent-spaces:T-01186/tester'],
      {
        fetchImpl: queue.fetchImpl,
      }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { placement: { runMode: 'task' } } })
  })

  test('session show resolves a semantic scope before loading the concrete session', async () => {
    const queue = createFetchQueue([
      {
        body: { sessionId: 'hsid-123' },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/resolve')
        },
      },
      {
        body: {
          session: {
            sessionId: 'hsid-123',
            scopeRef: 'agent:larry:project:agent-spaces',
            laneRef: 'main',
            generation: 3,
            status: 'active',
            createdAt: '2026-04-23T00:00:00.000Z',
            updatedAt: '2026-04-23T00:00:00.000Z',
          },
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/sessions/hsid-123')
        },
      },
    ])

    const output = await runSessionCommand(
      ['show', '--scope-ref', 'agent:larry:project:agent-spaces'],
      {
        fetchImpl: queue.fetchImpl,
      }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { session: { sessionId: 'hsid-123', generation: 3 } } })
  })

  test('run cancel posts to the cancel route', async () => {
    const queue = createFetchQueue([
      {
        body: { run: { runId: 'run_123', status: 'cancelled' } },
        assert(request) {
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123/cancel')
        },
      },
    ])

    const output = await runRunCommand(['cancel', '--run', 'run_123'], {
      fetchImpl: queue.fetchImpl,
    })

    expect(output.format).toBe('json')
    expect(output).toMatchObject({ body: { run: { status: 'cancelled' } } })
  })

  test('run attachment add uploads a file and renders a success summary', async () => {
    const fixture = withTempFile('diagram.png', 'png-bytes')

    try {
      const output = await runRunCommand(['attachment', 'add', fixture.path, '--alt', 'Diagram'], {
        env: {
          HRC_RUN_ID: 'hrc-run-123',
          HRC_HOST_SESSION_ID: 'hsid-123',
          HRC_GENERATION: '7',
        },
        async fetchImpl(input, init) {
          const request = input instanceof Request ? input : new Request(input, init)
          expect(request.method).toBe('POST')
          expect(new URL(request.url).pathname).toBe('/v1/runs/hrc-run-123/outbound-attachments')
          expect(request.headers.get('HRC_RUN_ID')).toBe('hrc-run-123')
          expect(request.headers.get('HRC_HOST_SESSION_ID')).toBe('hsid-123')
          expect(request.headers.get('HRC_GENERATION')).toBe('7')
          expect(request.headers.get('content-type')).toContain('multipart/form-data')

          const form = await request.formData()
          const file = form.get('file')
          expect(file).toBeInstanceOf(File)
          expect((file as File).name).toBe('diagram.png')
          expect((file as File).type).toBe('image/png')
          expect(await (file as File).text()).toBe('png-bytes')
          expect(form.get('alt')).toBe('Diagram')
          expect(form.get('contentType')).toBe('image/png')

          return Response.json(
            {
              outboundAttachmentId: 'oa_123',
              path: '/state/media/outbound/run_123/diagram.png',
              filename: 'diagram.png',
              contentType: 'image/png',
              sizeBytes: 9,
              alt: 'Diagram',
            },
            { status: 201 }
          )
        },
      })

      expect(output).toEqual({
        format: 'text',
        text: 'attached diagram.png (9 bytes) → oa_123',
      })
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('run attachment add honors --run override and JSON output', async () => {
    const fixture = withTempFile('note.txt', 'hello')

    try {
      const output = await runRunCommand(
        ['attachment', 'add', fixture.path, '--run', 'run_override', '--json'],
        {
          env: {
            HRC_RUN_ID: 'hrc-run-env',
            HRC_HOST_SESSION_ID: 'hsid-123',
          },
          async fetchImpl(input, init) {
            const request = input instanceof Request ? input : new Request(input, init)
            expect(new URL(request.url).pathname).toBe('/v1/runs/run_override/outbound-attachments')
            expect(request.headers.get('HRC_RUN_ID')).toBeNull()
            expect(request.headers.get('HRC_HOST_SESSION_ID')).toBe('hsid-123')

            return Response.json(
              {
                outboundAttachmentId: 'oa_override',
                path: '/state/media/outbound/run_override/note.txt',
                filename: 'note.txt',
                contentType: 'text/plain',
                sizeBytes: 5,
              },
              { status: 201 }
            )
          },
        }
      )

      expect(output).toMatchObject({
        format: 'json',
        body: { outboundAttachmentId: 'oa_override', filename: 'note.txt' },
      })
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('run attachment add exits 1 when no run id is available', async () => {
    const fixture = withTempFile('diagram.png', 'png-bytes')

    try {
      const result = await runCli(['run', 'attachment', 'add', fixture.path], {
        env: {},
      })

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--run is required (or set HRC_RUN_ID)')
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('run attachment add exits 1 when the file does not exist', async () => {
    const result = await runCli(['run', 'attachment', 'add', '/tmp/acp-cli-missing-file.png'], {
      env: { HRC_RUN_ID: 'run_123' },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('file does not exist: /tmp/acp-cli-missing-file.png')
  })

  test('run attachment list fetches pending attachments for the current run', async () => {
    const queue = createFetchQueue([
      {
        body: {
          attachments: [
            {
              outboundAttachmentId: 'oa_listed',
              path: '/state/media/outbound/run_123/chart.png',
              filename: 'chart.png',
              contentType: 'image/png',
              sizeBytes: 12,
              alt: 'Chart alt',
            },
          ],
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123/outbound-attachments')
        },
      },
    ])

    const output = await runRunCommand(['attachment', 'list', '--json'], {
      env: { HRC_RUN_ID: 'run_123' },
      fetchImpl: queue.fetchImpl,
    })

    expect(output).toMatchObject({
      format: 'json',
      body: {
        attachments: [
          {
            outboundAttachmentId: 'oa_listed',
            filename: 'chart.png',
            alt: 'Chart alt',
          },
        ],
      },
    })
  })

  test('run attachment clear falls back to listing when DELETE is unavailable', async () => {
    const queue = createFetchQueue([
      {
        status: 404,
        body: { error: { code: 'route_not_found', message: 'not found' } },
        assert(request) {
          expect(request.method).toBe('DELETE')
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123/outbound-attachments')
          expect(request.headers.get('HRC_RUN_ID')).toBe('run_123')
          expect(request.headers.get('HRC_HOST_SESSION_ID')).toBe('hsid-123')
        },
      },
      {
        body: {
          attachments: [
            {
              outboundAttachmentId: 'oa_pending',
              path: '/state/media/outbound/run_123/pending.png',
              filename: 'pending.png',
              contentType: 'image/png',
              sizeBytes: 6,
            },
          ],
        },
        assert(request) {
          expect(request.method).toBe('GET')
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123/outbound-attachments')
        },
      },
    ])

    const output = await runRunCommand(['attachment', 'clear', '--json'], {
      env: {
        HRC_RUN_ID: 'run_123',
        HRC_HOST_SESSION_ID: 'hsid-123',
      },
      fetchImpl: queue.fetchImpl,
    })

    expect(output).toEqual({
      format: 'json',
      body: {
        attachments: [
          {
            outboundAttachmentId: 'oa_pending',
            path: '/state/media/outbound/run_123/pending.png',
            filename: 'pending.png',
            contentType: 'image/png',
            sizeBytes: 6,
          },
        ],
        cleared: false,
        reason: 'DELETE /v1/runs/:runId/outbound-attachments is not available',
      },
    })
  })

  test('send --wait polls the run until it reaches a terminal state', async () => {
    const queue = createFetchQueue([
      {
        body: {
          inputAttempt: { inputAttemptId: 'ia_123' },
          run: { runId: 'run_123', status: 'pending' },
        },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/inputs')
          expect(request.body).toMatchObject({
            sessionRef: { scopeRef: 'agent:larry:project:agent-spaces' },
            content: 'Proceed',
          })
        },
      },
      {
        body: { run: { runId: 'run_123', status: 'completed' } },
        assert(request) {
          expect(new URL(request.url).pathname).toBe('/v1/runs/run_123')
        },
      },
    ])

    const output = await runSendCommand(
      [
        '--scope-ref',
        'agent:larry:project:agent-spaces',
        '--text',
        'Proceed',
        '--wait',
        '--wait-timeout-ms',
        '1000',
        '--wait-interval-ms',
        '1',
      ],
      { fetchImpl: queue.fetchImpl }
    )

    expect(output.format).toBe('json')
    expect(output).toMatchObject({
      body: { inputAttempt: { inputAttemptId: 'ia_123' }, run: { status: 'completed' } },
    })
  })
})
