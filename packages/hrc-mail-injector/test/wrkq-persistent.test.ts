import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WrkqLedgerRequestError, WrkqLedgerUnavailableError } from '../src/policy/ledger/client.js'
import { createWrkqLedger } from '../src/wrkq-ledger.js'

test('one initialized process serves concurrent reads, preserves refusals, reconnects after death, and closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'injector-persistent-'))
  const originalPath = process.env['PATH']
  const trace = join(dir, 'trace.jsonl')
  await writeFile(
    join(dir, 'wrkq'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
for await (const line of createInterface({input: process.stdin})) {
  const f = JSON.parse(line)
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({pid:process.pid,caller:process.env.PRAESIDIUM_CALLER,...f})+'\\n')
  if (f.params?.envelope === 'die') process.exit(1)
  const error = f.params?.envelope === 'refuse' ? {code:-32009,message:'fenced',data:{code:'WRKQ_CONFLICT'}} : undefined
  const result = f.method === 'wrkq.monitor.eventsView' ? {items:[],high_water:7} : {}
  console.log(JSON.stringify({jsonrpc:'2.0',id:f.id,...(error ? {error} : {result})}))
}
`
  )
  await chmod(join(dir, 'wrkq'), 0o755)
  process.env['PATH'] = `${dir}:${originalPath ?? ''}`
  const ledger = createWrkqLedger()
  try {
    expect(
      await Promise.all(Array.from({ length: 8 }, () => ledger.eventsView({ cursor: 0 })))
    ).toEqual(Array.from({ length: 8 }, () => ({ items: [], highWater: 7 })))
    await expect(ledger.envelopeShow({ envelope: 'refuse' })).rejects.toBeInstanceOf(
      WrkqLedgerRequestError
    )
    await ledger.pendingView({})
    let frames = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(frames.filter((f) => f.method === 'rpc.initialize')).toHaveLength(1)
    expect(new Set(frames.map((f) => f.pid)).size).toBe(1)
    expect(new Set(frames.map((f) => f.caller))).toEqual(new Set(['hrc-mail-injector']))
    expect(frames.find((f) => f.method === 'wrkq.envelope.pendingView').params.principalRef).toBe(
      'agent:hrc'
    )
    expect(
      frames.find((f) => f.method === 'wrkq.monitor.eventsView').params.principalRef
    ).toBeUndefined()
    await expect(ledger.envelopeShow({ envelope: 'die' })).rejects.toBeInstanceOf(
      WrkqLedgerUnavailableError
    )
    await ledger.eventsView({ cursor: 7 })
    frames = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(frames.filter((f) => f.method === 'rpc.initialize')).toHaveLength(2)
    expect(frames.filter((f) => f.params?.envelope === 'die')).toHaveLength(1)
    await ledger.close()
    await expect(ledger.eventsView({ cursor: 7 })).rejects.toBeInstanceOf(
      WrkqLedgerUnavailableError
    )
  } finally {
    await ledger.close()
    process.env['PATH'] = originalPath
    await rm(dir, { recursive: true, force: true })
  }
})

test('a stuck initialize times out without sending a ledger operation, then reconnects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'injector-init-timeout-'))
  const originalPath = process.env['PATH']
  const trace = join(dir, 'trace.jsonl')
  const marker = join(dir, 'started')
  await writeFile(
    join(dir, 'wrkq'),
    `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const stuck = !existsSync(${JSON.stringify(marker)})
writeFileSync(${JSON.stringify(marker)}, '')
for await (const line of createInterface({input:process.stdin})) {
  const f=JSON.parse(line)
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify(f)+'\\n')
  if (!stuck) console.log(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{items:[],high_water:9}}))
}
`
  )
  await chmod(join(dir, 'wrkq'), 0o755)
  process.env['PATH'] = `${dir}:${originalPath ?? ''}`
  const ledger = createWrkqLedger()
  try {
    await expect(ledger.eventsView({ cursor: 0 })).rejects.toMatchObject({
      name: 'WrkqLedgerUnavailableError',
      method: 'rpc.initialize',
    })
    expect(
      (await readFile(trace, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
        .map((f) => f.method)
    ).toEqual(['rpc.initialize'])
    await expect(ledger.eventsView({ cursor: 0 })).resolves.toEqual({ items: [], highWater: 9 })
  } finally {
    await ledger.close()
    process.env['PATH'] = originalPath
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

test('a parked commit wait uses its own serial forwarder and never blocks delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'injector-commit-wait-'))
  const originalPath = process.env['PATH']
  const trace = join(dir, 'trace.jsonl')
  await writeFile(
    join(dir, 'wrkq'),
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
for await (const line of createInterface({input: process.stdin})) {
  const f = JSON.parse(line)
  appendFileSync(${JSON.stringify(trace)}, JSON.stringify({pid: process.pid, ...f})+'\\n')
  if (f.method === 'wrkq.commit.wait') await new Promise((resolve) => setTimeout(resolve, 17000))
  const result = f.method === 'wrkq.commit.wait' ? {token:'opaque',changed:false} : {items:[],high_water:7}
  console.log(JSON.stringify({jsonrpc:'2.0',id:f.id,result}))
}
`
  )
  await chmod(join(dir, 'wrkq'), 0o755)
  process.env['PATH'] = `${dir}:${originalPath ?? ''}`
  const ledger = createWrkqLedger()
  try {
    let waitSettled = false
    const waiting = ledger.commitWait({ since: 'before', timeoutMs: 30000 }).then(
      (result) => {
        waitSettled = true
        return result
      },
      (error: unknown) => {
        waitSettled = true
        return error
      }
    )
    await Bun.sleep(100)
    expect(await ledger.eventsView({ cursor: 0 })).toEqual({ items: [], highWater: 7 })
    expect(waitSettled).toBe(false)
    expect(await waiting).toEqual({ token: 'opaque', changed: false })
    const frames = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(new Set(frames.map((f) => f.pid)).size).toBe(2)
    const frame = frames.find((f) => f.method === 'wrkq.commit.wait')
    expect(frame.params).toEqual({ since: 'before', timeoutMs: 25000 })
    const parked = ledger.commitWait({ since: 'opaque' }).catch((error: unknown) => error)
    await Bun.sleep(50)
    await ledger.close()
    expect(await parked).toBeInstanceOf(WrkqLedgerUnavailableError)
  } finally {
    await ledger.close()
    process.env['PATH'] = originalPath
    await rm(dir, { recursive: true, force: true })
  }
}, 45000)
