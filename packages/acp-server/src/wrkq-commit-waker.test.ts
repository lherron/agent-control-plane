import { expect, test } from 'bun:test'
import { WrkqCommitWaker } from './wrkq-commit-waker.js'

// Failure cases: a commit during a view read; many subscribers multiplying RPC
// waits; saturation/error spinning; subscriber abort; shutdown leaking waiters.
test('one RPC wait fans out and retains a wake that arrives during a read', async () => {
  let calls = 0
  let active = 0
  let maxActive = 0
  let complete: ((value: { token: string; changed: boolean }) => void) | undefined
  const waker = new WrkqCommitWaker(async (params) => {
    calls++
    expect(params.timeoutMs).toBeLessThanOrEqual(25_000)
    if (params.since === undefined) return { token: 'boot:0', changed: true }
    active++
    maxActive = Math.max(maxActive, active)
    const result = await new Promise<{ token: string; changed: boolean }>((resolve) => {
      complete = resolve
    })
    active--
    return result
  })
  const token = await waker.token()
  const waits = Array.from({ length: 30 }, () => waker.wait(token))
  complete?.({ token: 'boot:1', changed: true })
  await Promise.all(waits)
  // Same token was captured before an asynchronous view; no lost wake.
  await waker.wait(token)
  expect(maxActive).toBe(1)
  expect(calls).toBe(3)
  const controller = new AbortController()
  const pending = waker.wait(await waker.token(), { signal: controller.signal })
  controller.abort()
  await pending
  const stopped = waker.wait(await waker.token())
  waker.stop()
  await stopped
  complete?.({ token: 'boot:1', changed: false })
})

test('immediate unchanged responses and failures back off rather than spinning', async () => {
  for (const fail of [false, true]) {
    let calls = 0
    const waker = new WrkqCommitWaker(async () => {
      calls++
      if (fail) throw new Error('disconnected')
      return { token: 'boot:0', changed: false }
    })
    await waker.token()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toBeLessThanOrEqual(2)
    waker.stop()
  }
})

test('shutdown before the first subscriber does not start a transport', async () => {
  let calls = 0
  const waker = new WrkqCommitWaker(async () => {
    calls++
    return { token: 'stopped', changed: false }
  })
  waker.stop()
  await waker.token()
  expect(calls).toBe(0)
})
