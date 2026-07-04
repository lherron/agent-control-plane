#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface Row {
  date: string
  workItem: string
  evidence: string
  lesson: string
  routedCarrier: string
  decision: string
}

interface RequiredCommit {
  hash: string
  subject: string
  date: string
}

interface Violation {
  kind: string
  where: string
  failed: string
  why: string
  fix: string
}

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const changelogPath = 'docs/agent-enablement-changelog.md'
const agentsPath = 'AGENTS.md'
const requiredHeader = '| Date | Work item | Evidence | Lesson | Routed carrier | Decision |'
const allowedCarriers = new Set(['docs', 'rules', 'skills', 'tools', 'checks', 'TACIT'])
const requiredWorkItems = [
  'T-05535',
  'T-05536',
  'T-05537',
  'T-05538',
  'T-05539',
  'T-05540',
  'T-05541',
  'T-05542',
] as const
const requiredCommits: Record<string, RequiredCommit[]> = {
  'T-05536': [
    {
      hash: 'cdc6804',
      subject: 'Materialize local lefthook gate',
      date: '2026-07-03',
    },
    {
      hash: 'd780feb',
      subject: 'Pin hook test project context',
      date: '2026-07-03',
    },
  ],
  'T-05537': [
    {
      hash: 'a4eb67a',
      subject: 'Improve boundary manifest diagnostics',
      date: '2026-07-03',
    },
  ],
  'T-05538': [
    {
      hash: 'fed9d1a',
      subject: 'feat: add suppression cost guard',
      date: '2026-07-03',
    },
  ],
  'T-05539': [
    {
      hash: 'ff0a0d6',
      subject: 'Add ACP public surface freshness guard',
      date: '2026-07-03',
    },
  ],
  'T-05540': [
    {
      hash: '9bddf21',
      subject: 'Add ACP CLI surface conformance guard',
      date: '2026-07-03',
    },
  ],
  'T-05541': [
    {
      hash: 'f15e31b',
      subject: 'Add live ACP discovery tools',
      date: '2026-07-03',
    },
  ],
}

async function readText(path: string): Promise<string> {
  return await readFile(join(repoRoot, path), 'utf8')
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return []
  return trimmed
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim())
}

function parseRows(text: string, violations: Violation[]): Row[] {
  const lines = text.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim() === requiredHeader)
  if (headerIndex === -1) {
    violations.push({
      kind: 'changelog-shape',
      where: changelogPath,
      failed: 'Required markdown table header is missing.',
      why: 'Agents need a stable one-row-per-lesson format that a guard can parse.',
      fix: `Restore the header: ${requiredHeader}`,
    })
    return []
  }

  const separator = lines[headerIndex + 1]?.trim()
  if (separator !== '|---|---|---|---|---|---|') {
    violations.push({
      kind: 'changelog-shape',
      where: `${changelogPath} table separator`,
      failed: `Separator is ${JSON.stringify(separator)}.`,
      why: 'The changelog table should stay simple enough for agents and scripts to update.',
      fix: 'Use |---|---|---|---|---|---| directly below the header.',
    })
  }

  const rows: Row[] = []
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!line.trim().startsWith('|')) continue
    const cells = splitMarkdownRow(line)
    if (cells.length !== 6) {
      violations.push({
        kind: 'changelog-shape',
        where: `${changelogPath}:${index + 1}`,
        failed: `Expected 6 table cells, found ${cells.length}.`,
        why: 'Each row must carry exactly one routed carrier decision.',
        fix: 'Keep lesson text free of raw pipe characters or escape/reword the cell.',
      })
      continue
    }
    rows.push({
      date: cells[0] ?? '',
      workItem: cells[1] ?? '',
      evidence: cells[2] ?? '',
      lesson: cells[3] ?? '',
      routedCarrier: cells[4] ?? '',
      decision: cells[5] ?? '',
    })
  }

  return rows
}

function validateRows(rows: Row[], violations: Violation[]): void {
  const byWorkItem = new Map<string, Row>()
  for (const row of rows) {
    const where = `${changelogPath} ${row.workItem}`
    if (byWorkItem.has(row.workItem)) {
      violations.push({
        kind: 'duplicate-work-item',
        where,
        failed: 'Work item appears more than once.',
        why: 'The changelog contract is one row per substantial task or task-linked lesson.',
        fix: 'Merge the lesson into one row with one routed carrier decision.',
      })
    }
    byWorkItem.set(row.workItem, row)

    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      violations.push({
        kind: 'row-date',
        where,
        failed: `Date is ${JSON.stringify(row.date)}.`,
        why: 'Enablement history needs concrete dates, not relative terms.',
        fix: 'Use YYYY-MM-DD.',
      })
    }

    if (!/^T-\d{5}$/.test(row.workItem) && !/^TACIT:[a-z0-9-]+$/.test(row.workItem)) {
      violations.push({
        kind: 'work-item',
        where,
        failed: `Work item is ${JSON.stringify(row.workItem)}.`,
        why: 'Rows need a task id, or an explicit TACIT slug when the lesson came from an untracked follow-up.',
        fix: 'Use T-NNNNN or TACIT:short-slug.',
      })
    }

    if (!allowedCarriers.has(row.routedCarrier)) {
      violations.push({
        kind: 'carrier',
        where,
        failed: `Routed carrier is ${JSON.stringify(row.routedCarrier)}.`,
        why: 'Each lesson must route to one recognized carrier, or explicitly stay tacit.',
        fix: 'Use exactly one of docs, rules, skills, tools, checks, or TACIT.',
      })
    }

    for (const [field, value] of Object.entries({
      evidence: row.evidence,
      lesson: row.lesson,
      decision: row.decision,
    })) {
      if (value.trim().length === 0) {
        violations.push({
          kind: 'row-content',
          where: `${where} ${field}`,
          failed: 'Cell is empty.',
          why: 'A changelog row without evidence, lesson, and decision is not useful to future agents.',
          fix: `Fill the ${field} cell with a concrete statement.`,
        })
      }
    }
  }

  for (const workItem of requiredWorkItems) {
    if (!byWorkItem.has(workItem)) {
      violations.push({
        kind: 'missing-seed-row',
        where: changelogPath,
        failed: `${workItem} is not seeded in the changelog.`,
        why: 'The accepted AE baseline and same-lane remediation history are the minimum useful seed set.',
        fix: `Add a row for ${workItem}.`,
      })
    }
  }

  for (const [workItem, commits] of Object.entries(requiredCommits)) {
    const row = byWorkItem.get(workItem)
    if (row === undefined) continue
    for (const commit of commits) {
      if (!row.evidence.includes(commit.hash)) {
        violations.push({
          kind: 'missing-seed-commit',
          where: `${changelogPath} ${workItem}`,
          failed: `Evidence does not cite ${commit.hash}.`,
          why: 'The seed history must stay anchored to the accepted ACP remediation commits.',
          fix: `Cite ${commit.hash} in the evidence cell.`,
        })
      }
    }
  }
}

function citedHashes(text: string): string[] {
  return [...new Set(text.match(/\b[0-9a-f]{7,40}\b/g) ?? [])]
}

function gitShow(hash: string): { date: string; subject: string } | undefined {
  const result = Bun.spawnSync({
    cmd: ['git', 'show', '--no-patch', '--format=%ad%x00%s', '--date=short', hash],
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return undefined
  const [date, subject] = new TextDecoder().decode(result.stdout).trim().split('\0')
  if (date === undefined || subject === undefined) return undefined
  return { date, subject }
}

function validateHashes(text: string, violations: Violation[]): void {
  for (const hash of citedHashes(text)) {
    const resolved = gitShow(hash)
    if (resolved === undefined) {
      violations.push({
        kind: 'unknown-hash',
        where: `${changelogPath} ${hash}`,
        failed: 'Cited hash does not resolve in this repository.',
        why: 'Every cited hash must be true on the current tree.',
        fix: 'Replace the hash with a commit that exists in this repo, or remove the citation.',
      })
    }
  }

  for (const [workItem, commits] of Object.entries(requiredCommits)) {
    for (const expected of commits) {
      const resolved = gitShow(expected.hash)
      if (resolved === undefined) continue
      if (resolved.date !== expected.date || resolved.subject !== expected.subject) {
        violations.push({
          kind: 'seed-commit-drift',
          where: `${changelogPath} ${workItem}`,
          failed: `${expected.hash} resolved to ${resolved.date} ${JSON.stringify(resolved.subject)}.`,
          why: 'The changelog seed rows should describe the actual accepted remediation commits.',
          fix: 'Update the row and checker if the accepted baseline commit changed intentionally.',
        })
      }
    }
  }
}

function validateAgentsRoute(agents: string, violations: Violation[]): void {
  if (!agents.includes('[Agent enablement changelog](docs/agent-enablement-changelog.md)')) {
    violations.push({
      kind: 'missing-route',
      where: agentsPath,
      failed: 'AGENTS.md does not route agents to the enablement changelog.',
      why: 'The carrier must be discoverable from the agent-facing entry point.',
      fix: 'Add a link to docs/agent-enablement-changelog.md from AGENTS.md.',
    })
  }
}

function printViolations(violations: Violation[]): void {
  console.error(`enablement changelog check failed: ${violations.length} violation(s)`)
  for (const violation of violations) {
    console.error(`\n[${violation.kind}] ${violation.where}`)
    console.error(`What failed: ${violation.failed}`)
    console.error(`Why it matters: ${violation.why}`)
    console.error(`How to fix: ${violation.fix}`)
  }
}

async function main(): Promise<number> {
  const [changelog, agents] = await Promise.all([readText(changelogPath), readText(agentsPath)])
  const violations: Violation[] = []
  const rows = parseRows(changelog, violations)
  validateRows(rows, violations)
  validateHashes(changelog, violations)
  validateAgentsRoute(agents, violations)

  if (violations.length > 0) {
    printViolations(violations)
    return 1
  }

  console.log(`enablement changelog check passed (${rows.length} rows)`)
  return 0
}

const exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(`enablement changelog check crashed: ${message}`)
  return 1
})

process.exit(exitCode)
