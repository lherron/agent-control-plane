import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { inspectMailEnvelope } from '../src/inspect.js'

describe('hrc-mail-injector inspect', () => {
  test('shows a durable hold with the authoritative ledger state, then its resolution', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-mail-injector-inspect-'))
    const statePath = join(directory, 'injector.sqlite')
    const fakeWrkq = join(directory, 'wrkq')
    const originalPath = process.env['PATH']
    const originalState = process.env['INSPECT_LEDGER_STATE']
    const db = openHrcDatabase(statePath)
    try {
      db.mailDelivery.recordPresentation({
        envelopeId: 'EN-08642',
        runtimeId: 'rt-held',
        targetSessionRef: 'agent:cody:project:agent-control-plane:task:T-08642/lane:main',
        presentationId: 'present-held',
        deliveryOutcome: 'steered',
        landingHrcSeq: 42,
      })
      db.mailDelivery.markReceiptCommitted('EN-08642', 'rt-held')
      db.mailDelivery.armReminder({
        envelopeId: 'EN-08642',
        runtimeId: 'rt-held',
        turnEndedAt: new Date().toISOString(),
        remindAt: new Date().toISOString(),
      })
      db.mailDelivery.recordReminderLanding('EN-08642', 'rt-held', 43)
      db.mailDelivery.recordDisposition('EN-08642', 'rt-held', 'held:awaiting_operator')
      db.close()

      await writeFile(
        fakeWrkq,
        `#!/usr/bin/env bun
const frames = (await new Response(Bun.stdin.stream()).text()).trim().split('\\n').map(JSON.parse)
const state = process.env.INSPECT_LEDGER_STATE ?? 'presented'
const terminal = state === 'acked'
const envelope = {
  uuid: 'uuid-EN-08642', id: 'EN-08642', roomUuid: 'room', roomKey: 'T-08642', roomKind: 'task',
  from: { principalRef: 'agent:astra' }, to: { principalRef: 'agent:cody' }, obligation: 'reply_required',
  delivery: 'queue', body: 'inspect fixture', state, terminal, presentedTo: [{ memberRef: 'agent:cody', runtimeId: 'rt-held', presentedAt: new Date().toISOString() }],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
}
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frames[0].id, result: { protocolVersion: '2026-06-30' } }) + '\\n')
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frames[1].id, result: envelope }) + '\\n')
`
      )
      await chmod(fakeWrkq, 0o755)
      process.env['PATH'] = `${directory}:${originalPath ?? ''}`

      const held = await inspectMailEnvelope({ statePath, envelopeId: 'EN-08642' })
      expect(held).toMatchObject({
        ledger: { ok: true, state: 'presented', terminal: false },
        verdict: { code: 'held:awaiting_operator' },
        presentations: [
          {
            runtimeId: 'rt-held',
            presentationId: 'present-held',
            reminder: { landedAt: expect.any(String) },
            disposition: 'held:awaiting_operator',
            disposedAt: expect.any(String),
          },
        ],
      })

      process.env['INSPECT_LEDGER_STATE'] = 'acked'
      const resolved = await inspectMailEnvelope({ statePath, envelopeId: 'EN-08642' })
      expect(resolved).toMatchObject({
        ledger: { ok: true, state: 'acked', terminal: true },
        verdict: { code: 'ledger_terminal' },
        presentations: [{ disposition: 'held:awaiting_operator' }],
      })
    } finally {
      try {
        db.close()
      } catch {
        // The fixture is already closed before read-only inspection.
      }
      process.env['PATH'] = originalPath
      if (originalState === undefined) process.env['INSPECT_LEDGER_STATE'] = undefined
      else process.env['INSPECT_LEDGER_STATE'] = originalState
      await rm(directory, { recursive: true, force: true })
    }
  })
})
