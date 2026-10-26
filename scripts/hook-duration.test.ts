import { afterEach, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acp-hooks-'))
  roots.push(root)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && key !== 'ACP_HOOK_TIMING_ACTIVE'
    )
  )
  env.PATH = `${root}/bin:${env.PATH}`
  env.ACP_HOOK_PUBLISHER = `${root}/bin/publisher`
  env.HOOK_FIXTURE = root
  mkdirSync(`${root}/bin`)
  cpSync(resolve('.githooks'), `${root}/.githooks`, { recursive: true })
  mkdirSync(`${root}/scripts`)
  cpSync(resolve('scripts/hook-duration.ts'), `${root}/scripts/hook-duration.ts`)
  const run = (args: string[], input = '') =>
    Bun.spawnSync(args, {
      cwd: root,
      env,
      stdin: Buffer.from(input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
  run(['git', 'init', '-q'])
  mkdirSync(`${root}/node_modules/.bin`, { recursive: true })
  writeFileSync(
    `${root}/node_modules/.bin/lefthook`,
    '#!/bin/sh\necho gate >> "$HOOK_FIXTURE/order"\ncat > "$HOOK_FIXTURE/gate-stdin"\nprintf "%s\\n" "$@" > "$HOOK_FIXTURE/gate-args"\nexit "${GATE_STATUS:-0}"\n',
    { mode: 0o755 }
  )
  writeFileSync(
    `${root}/bin/wrkp`,
    '#!/bin/sh\necho reporter >> "$HOOK_FIXTURE/order"\ncat > "$HOOK_FIXTURE/reporter-stdin"\nexit "${REPORTER_STATUS:-0}"\n',
    { mode: 0o755 }
  )
  writeFileSync(
    env.ACP_HOOK_PUBLISHER,
    '#!/bin/sh\necho publisher >> "$HOOK_FIXTURE/order"\nprintf "%s\\n" "$@" > "$HOOK_FIXTURE/post-args"\nexit "${PUBLISH_STATUS:-0}"\n',
    { mode: 0o755 }
  )
  return {
    root,
    env,
    run,
    records: () =>
      readFileSync(`${root}/.git/praesidium/hook-timings.jsonl`, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  }
}

test('push preserves ref stdin, gate then reporter order, and one settled fact', () => {
  const f = fixture()
  const refs = 'refs/heads/main abc refs/heads/main def\n'
  expect(f.run(['sh', '.githooks/pre-push', 'origin', 'fixture-url'], refs).exitCode).toBe(0)
  expect(readFileSync(`${f.root}/gate-stdin`, 'utf8')).toBe(refs)
  expect(readFileSync(`${f.root}/reporter-stdin`, 'utf8')).toBe(refs)
  expect(readFileSync(`${f.root}/order`, 'utf8')).toBe('gate\nreporter\npublisher\n')
  expect(readFileSync(`${f.root}/gate-args`, 'utf8')).toBe(
    'run\npre-push\n--no-auto-install\norigin\nfixture-url\n'
  )
  const [record] = f.records()
  expect(f.records()).toHaveLength(1)
  expect(record).toMatchObject({
    hook: 'pre-push',
    result: 'passed',
    exit_code: 0,
    change_kind: 'unclassified',
  })
  expect(record.duration_ms).toBeGreaterThanOrEqual(0)
  const posted = readFileSync(`${f.root}/post-args`, 'utf8')
  expect(posted).toContain(`hook:${record.run_id}\n`)
  expect(posted).toContain(`--occurred-at\n${record.finished_at}\n`)
  expect(posted).not.toContain('head=\n')
})

for (const hook of ['pre-commit', 'pre-push']) {
  for (const status of [0, 23]) {
    for (const publisher of ['missing', 'failing']) {
      test(`${hook} preserves exit ${status} with ${publisher} publisher`, () => {
        const f = fixture()
        f.env.GATE_STATUS = String(status)
        f.env.PUBLISH_STATUS = '19'
        f.env.REPORTER_STATUS = '17'
        if (publisher === 'missing') f.env.ACP_HOOK_PUBLISHER = `${f.root}/absent`
        expect(f.run(['sh', `.githooks/${hook}`, 'origin', 'fixture-url']).exitCode).toBe(status)
        expect(f.records()).toHaveLength(1)
        expect(f.records()[0]).toMatchObject({
          exit_code: status,
          result: status ? 'failed' : 'passed',
        })
        const order = readFileSync(`${f.root}/order`, 'utf8')
        expect(order.includes('reporter')).toBe(hook === 'pre-push' && status === 0)
      })
    }
  }
}

test('missing lefthook retains 127; explicit disabled lefthook records skipped', () => {
  const f = fixture()
  rmSync(`${f.root}/node_modules`, { recursive: true })
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(127)
  expect(f.records()[0].exit_code).toBe(127)
  const g = fixture()
  g.env.LEFTHOOK = '0'
  expect(g.run(['sh', '.githooks/pre-commit']).exitCode).toBe(0)
  expect(g.records()[0].result).toBe('skipped')
})

test('nested invocation of the same wrapper publishes only once', () => {
  const f = fixture()
  writeFileSync(
    `${f.root}/node_modules/.bin/lefthook`,
    '#!/bin/sh\nif [ -z "${NESTED:-}" ]; then NESTED=1 sh .githooks/pre-commit; fi\n',
    { mode: 0o755 }
  )
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(0)
  expect(f.records()).toHaveLength(1)
})

test('hung publisher is bounded and cannot mask a failed gate', () => {
  const f = fixture()
  f.env.GATE_STATUS = '31'
  writeFileSync(f.env.ACP_HOOK_PUBLISHER, '#!/bin/sh\nexec sleep 20\n', { mode: 0o755 })
  const started = Date.now()
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(31)
  expect(Date.now() - started).toBeLessThan(4500)
})

test('unavailable timing helper cannot block the gate', () => {
  const f = fixture()
  rmSync(`${f.root}/scripts/hook-duration.ts`)
  f.env.GATE_STATUS = '29'
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(29)
})

test('staged file count and backfill reuse real journal record keys', () => {
  const f = fixture()
  writeFileSync(`${f.root}/staged.txt`, 'fixture')
  f.run(['git', 'add', 'staged.txt'])
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(0)
  expect(f.records()[0].file_count).toBe(1)
  const original = readFileSync(`${f.root}/post-args`, 'utf8')
  expect(f.run([process.execPath, 'scripts/hook-duration.ts', '--backfill']).exitCode).toBe(0)
  expect(readFileSync(`${f.root}/post-args`, 'utf8')).toBe(original)
  expect(f.records()).toHaveLength(1)
})

test('elapsed duration spans the separate start and finish helper processes', () => {
  const f = fixture()
  writeFileSync(`${f.root}/node_modules/.bin/lefthook`, '#!/bin/sh\nsleep 0.15\n', { mode: 0o755 })
  expect(f.run(['sh', '.githooks/pre-commit']).exitCode).toBe(0)
  const [record] = f.records()
  expect(record.duration_ms).toBeGreaterThanOrEqual(150)
  expect(record.duration_ms).toBeLessThanOrEqual(
    Date.parse(record.finished_at) - Date.parse(record.started_at) + 1
  )
})
