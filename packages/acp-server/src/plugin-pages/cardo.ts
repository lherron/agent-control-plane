/**
 * The spawn wrapper around the installed `cardo` CLI (cardo T-14122). ACP writes no
 * frames: the phone builds the wire request, the CLI adds id/client/caller and prints
 * the kernel's reply line, and ACP hands that line back byte for byte. Exit codes
 * report transport only: 0 a reply arrived, 3 a read hit its deadline, 7 a write's
 * reply was lost, 75 no live mount.
 */
import { spawn } from 'node:child_process'

export type CardoAddress = { mount: string; owner?: string | undefined; graph?: string | undefined }

export type CardoRequestOutcome =
  | { kind: 'reply'; line: string }
  | { kind: 'timeout'; outcomeUnknown: boolean }
  | { kind: 'unavailable' }
  | { kind: 'failed'; exitCode: number | null; stderr: string }

/** `<mount>[@<owner>][/<graph>]`, the CLI's address form. */
export function cardoTarget(address: CardoAddress): string {
  return `${address.mount}${address.owner !== undefined ? `@${address.owner}` : ''}${
    address.graph !== undefined ? `/${address.graph}` : ''
  }`
}

/** The first line of `stdout`, newline included, as the CLI printed it. */
function firstLine(stdout: Buffer): string | undefined {
  const end = stdout.indexOf(0x0a)
  return end < 0 ? undefined : stdout.subarray(0, end + 1).toString('utf8')
}

/**
 * One `cardo <target> request -`. The child is killed `backstopMs` after spawn, which
 * the caller sets to the CLI's own deadline plus a grace, so it should never fire; when
 * it does, the request may have been applied, so the outcome is unknown.
 */
export function cardoRequest(input: {
  bin: string
  address: CardoAddress
  request: unknown
  backstopMs: number
}): Promise<CardoRequestOutcome> {
  return new Promise((resolve) => {
    const child = spawn(input.bin, [cardoTarget(input.address), 'request', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, input.backstopMs)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => finish({ kind: 'failed', exitCode: null, stderr: error.message }))
    child.on('close', (code) => {
      if (killed) return finish({ kind: 'timeout', outcomeUnknown: true })
      const line = firstLine(Buffer.concat(stdout))
      if (code === 0 && line !== undefined) return finish({ kind: 'reply', line })
      if (code === 7) return finish({ kind: 'timeout', outcomeUnknown: true })
      if (code === 3) return finish({ kind: 'timeout', outcomeUnknown: false })
      if (code === 75) return finish({ kind: 'unavailable' })
      finish({
        kind: 'failed',
        exitCode: code,
        stderr: Buffer.concat(stderr).toString('utf8').slice(-2000),
      })
    })
    let done = false
    function finish(outcome: CardoRequestOutcome) {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(outcome)
    }
    child.stdin.end(`${JSON.stringify(input.request)}\n`)
  })
}

export type CardoWatch = { kill(): void }

/**
 * One `cardo <target> watch --args - --raw` whose stdout lines (the subscribe reply,
 * then each event, then a fresh subscribe reply after any CLI resubscribe) go to
 * `onLine` without their newline. `onExit` fires once when the child is gone.
 */
export function cardoWatch(input: {
  bin: string
  address: CardoAddress
  args: unknown
  forSeconds: number
  onLine(line: string): void
  onExit(exitCode: number | null, stderr: string): void
}): CardoWatch {
  const child = spawn(
    input.bin,
    [
      cardoTarget(input.address),
      'watch',
      '--args',
      '-',
      '--raw',
      '--for',
      String(input.forSeconds),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let pending = ''
  const stderr: Buffer[] = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    let end = pending.indexOf('\n')
    while (end >= 0) {
      input.onLine(pending.slice(0, end))
      pending = pending.slice(end + 1)
      end = pending.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.on('error', () => {})
  let exited = false
  const exit = (code: number | null) => {
    if (exited) return
    exited = true
    input.onExit(code, Buffer.concat(stderr).toString('utf8').slice(-2000))
  }
  child.on('error', () => exit(null))
  child.on('close', (code) => exit(code))
  child.stdin.end(`${JSON.stringify(input.args)}\n`)
  return { kill: () => child.kill('SIGKILL') }
}
