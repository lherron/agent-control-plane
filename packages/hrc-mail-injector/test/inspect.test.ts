import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { inspectMailEnvelope } from '../src/inspect.js'
import { createWrkqLedger } from '../src/wrkq-ledger.js'

async function runWrkq(command: string, args: string[]): Promise<string> {
  const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command} failed: ${stderr.trim()}`)
  return stdout
}

async function runWrkqJson<T>(command: string, args: string[]): Promise<T> {
  return JSON.parse(await runWrkq(command, args)) as T
}

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
  }, 15_000)

  test('reads the live wrkq terminal `reason` field through the injector RPC transport', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hrc-mail-injector-inspect-real-'))
    const statePath = join(directory, 'injector.sqlite')
    const ledgerPath = join(directory, 'wrkq.db')
    const originalLedgerPath = process.env['HRC_WRKQ_DB']
    const targetSessionRef = 'cody@inbox:T-00001'
    const db = openHrcDatabase(statePath)
    try {
      db.mailDelivery.recordPresentation({
        envelopeId: 'EN-00001',
        runtimeId: 'rt-real-inspect',
        targetSessionRef,
        presentationId: 'present-real-inspect',
        deliveryOutcome: 'steered',
        landingHrcSeq: 42,
      })
      db.mailDelivery.markReceiptCommitted('EN-00001', 'rt-real-inspect')
      db.close()

      await runWrkq('wrkqadm', ['--db', ledgerPath, 'init'])
      await runWrkq('wrkq', [
        'touch',
        'inspect-real-wire',
        '--db',
        ledgerPath,
        '--project',
        'inbox',
        '-t',
        'inspect real wire',
      ])
      const created = await runWrkqJson<{ envelopes: Array<{ id: string }> }>('wrkc', [
        'say',
        'T-00001',
        '--db',
        ledgerPath,
        '--project',
        'inbox',
        '--as',
        'agent:astra',
        '--scope-ref',
        'astra@agent-control-plane:primary',
        '--to',
        targetSessionRef,
        '-m',
        'real inspect envelope',
        '--json',
      ])
      expect(created.envelopes[0]?.id).toBe('EN-00001')
      process.env['HRC_WRKQ_DB'] = ledgerPath
      const ledger = createWrkqLedger()
      await ledger.present({
        envelope: 'EN-00001',
        memberRef: targetSessionRef,
        runtimeId: 'rt-real-inspect',
        hostSessionId: 'host-real-inspect',
        generation: '1',
        driveAttemptId: 'present-real-inspect',
        deliveryOutcome: 'steered',
      })
      await runWrkq('wrkc', [
        'say',
        'EN-00001',
        '--db',
        ledgerPath,
        '--project',
        'inbox',
        '--as',
        'agent:cody',
        '--scope-ref',
        targetSessionRef,
        '--to',
        'astra@agent-control-plane:primary',
        '-m',
        'real reply',
      ])

      // This is an actual `wrkq rpc` call from inspectMailEnvelope, against
      // the migrated SQLite ledger created above—not a response shaped by this
      // test. `reason` is top-level on the installed wrkq envelope wire.
      expect(await inspectMailEnvelope({ statePath, envelopeId: 'EN-00001' })).toMatchObject({
        ledger: { ok: true, state: 'acked', terminal: true, terminalReason: 'reply' },
        verdict: { code: 'ledger_terminal', line: 'ledger terminal: reply' },
      })
    } finally {
      try {
        db.close()
      } catch {
        // Inspection owns the read-only connection after fixture setup.
      }
      if (originalLedgerPath === undefined) process.env['HRC_WRKQ_DB'] = undefined
      else process.env['HRC_WRKQ_DB'] = originalLedgerPath
      await rm(directory, { recursive: true, force: true })
    }
  })
})
