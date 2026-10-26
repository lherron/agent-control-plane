#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from './lib/live-discovery.ts'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function main(): Promise<void> {
  const rawRoot = process.env['ACP_DEV_ENV_ROOT']
  assert(
    rawRoot && /^\/tmp\/acpv-[a-zA-Z0-9-]+$/.test(rawRoot),
    'require fresh /tmp/acpv-<id> owned dev-env root'
  )
  const root = await realpath(rawRoot)
  const base = process.env['ACP_BASE_URL']
  assert(base, 'ACP_BASE_URL required')
  const url = new URL(base)
  const port = (await readFile(join(root, 'acp.port'), 'utf8')).trim()
  assert(
    url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === port &&
      port !== '18470',
    'require allocated scratch loopback port, never production'
  )
  for (const [key, relative] of [
    ['WRKQ_DB', 'db/wrkq.db'],
    ['HRC_RUNTIME_DIR', 'hrc-run'],
    ['HRC_STATE_DIR', 'hrc-state'],
    ['ASP_AGENTS_ROOT', 'agents'],
    ['ACP_RUNTIME_DIR', 'acp-run'],
    ['ACP_STATE_DB_PATH', 'db/acp-state.db'],
    ['ACP_INTERFACE_DB_PATH', 'db/acp-interface.db'],
  ]) {
    const value = process.env[key as string]
    assert(value && (await realpath(value)) === join(root, relative as string), `unsafe ${key}`)
  }
  assert(await Bun.file(join(root, 'processes')).exists(), 'missing owned process registry')
  const evidence: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    sourceSha: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repoRoot })
      .stdout.toString()
      .trim(),
    installedAcpSha: null,
    implementation: 'source CLI and source ACP; installed HRC/wrkq substrate',
    root,
    base,
    proven: [],
    undriven: [
      'jobs/effects',
      'mail/ACK/reconciler',
      'Discord',
      'mobile bearer/history/WS',
      'viewers',
      'deployment',
      'catalog/promotion',
    ],
  }
  const records: unknown[] = []
  evidence['proven'] = records
  async function http(path: string, expected: number): Promise<Record<string, unknown>> {
    const response = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10000) })
    const body = (await response.json()) as Record<string, unknown>
    records.push({ kind: 'http', path, status: response.status, keys: Object.keys(body).sort() })
    assert(response.status === expected, `${path}: expected ${expected}, got ${response.status}`)
    return body
  }
  // Observe real wire keys before asserting the declared project response shape.
  await http('/v1/mobile/health', 200)
  const observed = await http('/v1/admin/projects', 200)
  records.push({ kind: 'wire-shapes', projects: Object.keys(observed).sort() })
  assert(Array.isArray(observed['projects']), 'observed project list lacks projects array')
  const project = `verify-scratch-${process.pid}`
  async function cli(args: string[]): Promise<Record<string, unknown>> {
    const child = Bun.spawn(
      [
        'bun',
        join(repoRoot, 'packages/acp-cli/src/cli.ts'),
        ...args,
        '--server',
        base as string,
        '--json',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    const stdout = await new Response(child.stdout).text()
    const stderr = await new Response(child.stderr).text()
    assert((await child.exited) === 0, `CLI failed: ${stderr}`)
    return JSON.parse(stdout) as Record<string, unknown>
  }
  const created = await cli([
    'project',
    'create',
    '--project',
    project,
    '--display-name',
    'Scratch verification',
    '--actor',
    'verify-scratch',
  ])
  const shown = await cli(['project', 'show', '--project', project])
  for (const [kind, body] of [
    ['project-create', created],
    ['project-show', shown],
  ] as const) {
    const row = body['project'] as Record<string, unknown>
    assert(row?.['projectId'] === project, `${kind}: id mismatch`)
    records.push({ kind, projectId: row['projectId'], keys: Object.keys(row).sort() })
  }
  const conflict = await fetch(new URL('/v1/admin/projects', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acp-actor-agent-id': 'verify-scratch' },
    body: JSON.stringify({ projectId: project, displayName: 'Conflicting name' }),
    signal: AbortSignal.timeout(10000),
  })
  records.push({ kind: 'project-conflict', status: conflict.status })
  assert(conflict.status === 409, `expected project conflict 409, got ${conflict.status}`)
  await http(`/v1/admin/projects/${project}-missing`, 404)
  await http('/v1/verify-scratch-missing', 404)
  const database = new Database(join(root, 'db/acp-admin.db'), { readonly: true })
  try {
    const tables = database.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string
    }[]
    const table = tables.find((row) => row.name === 'projects')
    assert(table, 'projects table missing')
    const row = database.query('SELECT * FROM projects WHERE project_id = ?').get(project)
    assert(row, 'project missing from persisted SQLite')
    records.push({ kind: 'admin-sqlite-persistence', projectId: project })
  } finally {
    database.close()
  }
  await writeFile(join(root, 'verify-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(
    `PASS scratch HTTP/CLI/admin persistence: ${records.length} observations; report ${root}/verify-evidence.json`
  )
}

if (import.meta.main) await main()
