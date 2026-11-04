import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeFailureNoticeDispatchResult } from '../src/failure-notice-dispatch.js'
import { assertMailInjectorPosture } from '../src/index.js'
import { createWrkqLedger } from '../src/wrkq-ledger.js'

describe('mail injector HRC ownership admission', () => {
  test('accepts bridge and deletion postures only', () => {
    expect(() => assertMailInjectorPosture('disabled')).not.toThrow()
    expect(() => assertMailInjectorPosture('absent')).not.toThrow()
  })

  test('refuses concurrent or malformed HRC delivery ownership', () => {
    expect(() => assertMailInjectorPosture('in-process')).toThrow(/in-process/)
    expect(() => assertMailInjectorPosture(undefined)).toThrow(/recognized/)
  })

  test('settles a sender-failure notice when HRC reports a completed enqueue', () => {
    const options = {
      ttlMs: 1_000,
      submissionOrigin: {
        principalRef: 'system:hrc-kicker',
        scopeRef: 'agent:cody:project:hrc-runtime',
      },
    }
    const settled = normalizeFailureNoticeDispatchResult(
      { status: 'completed', runId: 'run-1' } as never,
      options
    ) as { status?: string; runId?: string }
    expect(settled).toEqual({ status: 'started', runId: 'run-1' })

    const mail = normalizeFailureNoticeDispatchResult(
      { status: 'completed', runId: 'run-2' } as never,
      { ...options, submissionOrigin: { ...options.submissionOrigin, envelopeId: 'EN-15076' } }
    ) as { status?: string }
    expect(mail.status).toBe('completed')
  })

  test('wrkq ledger: each RPC session sends rpc.initialize before eventsView and decodes high_water', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-mail-injector-wrkq-'))
    const fakeWrkq = join(directory, 'wrkq')
    const originalPath = process.env['PATH']
    await writeFile(
      fakeWrkq,
      `#!/usr/bin/env bun
import { createInterface } from 'node:readline'
let initialized = false
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line)
  if (frame.method === 'rpc.initialize') initialized = true
  else if (!initialized) process.exit(1)
  const result = frame.method === 'wrkq.monitor.eventsView' ? { items: [], high_water: 7 } : {}
  console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }))
}
`
    )
    await chmod(fakeWrkq, 0o755)
    process.env['PATH'] = `${directory}:${originalPath ?? ''}`
    const ledger = createWrkqLedger()
    try {
      await expect(ledger.eventsView({ cursor: 0 })).resolves.toEqual({
        items: [],
        highWater: 7,
      })
    } finally {
      await ledger.close()
      process.env['PATH'] = originalPath
      await rm(directory, { recursive: true, force: true })
    }
  })
})
