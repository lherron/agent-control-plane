import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  test('initializes each short-lived wrkq RPC session before reading events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-mail-injector-wrkq-'))
    const fakeWrkq = join(directory, 'wrkq')
    const originalPath = process.env['PATH']
    await writeFile(
      fakeWrkq,
      `#!/usr/bin/env bun
const input = await new Response(Bun.stdin.stream()).text()
const frames = input.trim().split('\\n').map((line) => JSON.parse(line))
if (frames.length !== 2 || frames[0].method !== 'rpc.initialize' || frames[1].method !== 'wrkq.monitor.eventsView') {
  process.stderr.write('expected rpc.initialize before eventsView')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: '2026-06-30' } }) + '\\n')
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { items: [], high_water: 7 } }) + '\\n')
`
    )
    await chmod(fakeWrkq, 0o755)
    process.env['PATH'] = `${directory}:${originalPath ?? ''}`
    try {
      await expect(createWrkqLedger().eventsView({ cursor: 0 })).resolves.toEqual({
        items: [],
        highWater: 7,
      })
    } finally {
      process.env['PATH'] = originalPath
      await rm(directory, { recursive: true, force: true })
    }
  })
})
