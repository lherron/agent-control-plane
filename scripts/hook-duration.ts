/** Advisory whole-hook timing. Shell gates retain authority over their exit status. */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'

function git(...args: string[]): string | undefined {
  const child = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 2000,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return child.status === 0 ? child.stdout : undefined
}
function journal(): string {
  const common = git('rev-parse', '--git-common-dir')?.trim()
  if (!common) throw new Error('Not a Git repository')
  return resolve(common, 'praesidium/hook-timings.jsonl')
}
function start(hook: string) {
  const startedAt = new Date().toISOString()
  const names =
    hook === 'pre-commit'
      ? git('diff', '--cached', '--name-only', '-z')
      : git('diff', '--name-only', '-z', '@{upstream}', 'HEAD')
  return {
    source: 'agent-control-plane-git-hook',
    duration_clock: 'wall',
    node: hostname(),
    hook,
    run_id: randomUUID(),
    started_at: startedAt,
    change_kind: 'unclassified',
    head: git('rev-parse', '--verify', 'HEAD')?.trim(),
    branch: git('branch', '--show-current')?.trim(),
    file_count: names === undefined ? undefined : names.split('\0').filter(Boolean).length,
    _journal: journal(),
  }
}
type Record = Omit<ReturnType<typeof start>, '_journal'> & {
  finished_at: string
  duration_ms: number
  exit_code: number
  result: string
}
function post(record: Record): boolean {
  const { finished_at, ...attributes } = record
  const args = [
    'post',
    'agent-control-plane',
    '--type',
    'hook.settled',
    '--key',
    `hook:${record.run_id}`,
    '--occurred-at',
    finished_at,
    '--message',
    `${record.hook} ${record.result} in ${record.duration_ms}ms`,
    ...Object.entries(attributes).flatMap(([key, value]) =>
      value === undefined || value === '' ? [] : ['--attr', `${key}=${value}`]
    ),
  ]
  return (
    spawnSync(process.env.ACP_HOOK_PUBLISHER || 'wrkp', args, {
      stdio: 'ignore',
      timeout: 2000,
      killSignal: 'SIGKILL',
      env: { ...process.env },
    }).status === 0
  )
}
function finish(state: string, exitCode: number) {
  const { _journal, ...attributes } = JSON.parse(state) as ReturnType<typeof start>
  const finishedAt = new Date().toISOString()
  const record: Record = {
    ...attributes,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(attributes.started_at)),
    exit_code: exitCode,
    result: exitCode !== 0 ? 'failed' : process.env.LEFTHOOK === '0' ? 'skipped' : 'passed',
  }
  try {
    mkdirSync(dirname(_journal), { recursive: true })
    appendFileSync(_journal, `${JSON.stringify(record)}\n`)
  } catch {
    /* Local telemetry cannot block the hook. */
  }
  post(record)
}
if (import.meta.main) {
  try {
    const [mode, state, code] = process.argv.slice(2)
    if (mode === '--start') console.log(JSON.stringify(start(state)))
    else if (mode === '--finish') finish(state, Number(code))
    else if (mode === '--backfill') {
      let records: Record[] = []
      try {
        records = readFileSync(journal(), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      let posted = 0
      for (const record of records) {
        if (
          record.source !== 'agent-control-plane-git-hook' ||
          record.duration_clock !== 'wall' ||
          !record.run_id ||
          !record.finished_at ||
          !['passed', 'failed', 'skipped'].includes(record.result)
        )
          throw new Error('Invalid timing history')
        if (post(record)) posted++
      }
      console.log(JSON.stringify({ records: records.length, posted }))
      process.exitCode = posted === records.length ? 0 : 1
    }
  } catch {
    process.exitCode = 1
  }
}
