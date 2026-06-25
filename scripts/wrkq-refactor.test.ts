import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  classifyTask,
  extractTaskFields,
  normalizeRefactorTaskList,
  parseArgs,
  renderPacket,
} from './wrkq-refactor'

type ClassifyTaskInput = Parameters<typeof classifyTask>[0]

function refactorTask(overrides: Partial<ClassifyTaskInput> = {}): ClassifyTaskInput {
  return {
    id: 'T-00001',
    title: '[pkg] F1 - Example',
    path: 'agent-control-plane/refactor-deferred/example',
    state: 'open',
    description: `**Package:** acp-core
**Location:** packages/acp-core/src/example.ts
**Risk:** Low  ·  **API-impact:** internal-only

**Recommended action:** Internal-only, behavior-preserving — implement directly, run scoped typecheck+test.

Source: refactor-workflow auto-deferred item. Full audit detail: \`refactor-analysis/acp-core-report.md\`.
`,
    comments: [],
    ...overrides,
  }
}

describe('wrkq-refactor automation helpers', () => {
  test('parseArgs defaults to next against the refactor-deferred container', () => {
    const options = parseArgs([])

    expect(options.command).toBe('next')
    expect(options.project).toBe('agent-control-plane')
    expect(options.container).toBe('refactor-deferred')
    expect(options.limit).toBe(80)
  })

  test('parseArgs supports archiving an invalid refactor task with a required reason', () => {
    const options = parseArgs([
      'archive',
      '--task',
      'T-00001',
      '--reason',
      'Current source no longer contains the stale export.',
      '--dry-run',
    ])

    expect(options.command).toBe('archive')
    expect(options.taskId).toBe('T-00001')
    expect(options.reason).toBe('Current source no longer contains the stale export.')
    expect(options.dryRun).toBe(true)
  })

  test('parseArgs supports blocking a no-proceed refactor task with a required reason', () => {
    const options = parseArgs([
      'block',
      '--task',
      'T-00001',
      '--reason',
      'Review-required public CLI contract change.',
      '--dry-run',
    ])

    expect(options.command).toBe('block')
    expect(options.taskId).toBe('T-00001')
    expect(options.reason).toBe('Review-required public CLI contract change.')
    expect(options.dryRun).toBe(true)
  })

  test('parseArgs supports the final publish step with a commit message', () => {
    const options = parseArgs([
      'publish',
      '--message',
      'chore(acp): automate wrkq refactor loop',
      '--dry-run',
    ])

    expect(options.command).toBe('publish')
    expect(options.message).toBe('chore(acp): automate wrkq refactor loop')
    expect(options.dryRun).toBe(true)
  })

  test('normalizeRefactorTaskList treats wrkq null output as an empty queue', () => {
    expect(normalizeRefactorTaskList(null)).toEqual([])
  })

  test('normalizeRefactorTaskList keeps only open task records', () => {
    expect(
      normalizeRefactorTaskList([
        refactorTask({ id: 'T-00001', state: 'open' }),
        refactorTask({ id: 'T-00002', state: 'blocked' }),
        null,
      ])
    ).toEqual([
      {
        id: 'T-00001',
        title: '[pkg] F1 - Example',
        path: 'agent-control-plane/refactor-deferred/example',
        state: 'open',
        kind: undefined,
        updated_at: undefined,
      },
    ])
  })

  test('extractTaskFields reads task metadata and report path', () => {
    const fields = extractTaskFields(refactorTask())

    expect(fields.packageName).toBe('acp-core')
    expect(fields.location).toBe('packages/acp-core/src/example.ts')
    expect(fields.risk).toBe('Low')
    expect(fields.apiImpact).toBe('internal-only')
    expect(fields.reportPath).toBe('refactor-analysis/acp-core-report.md')
    expect(fields.recommendedAction).toContain('implement directly')
  })

  test('classifyTask marks direct internal tasks as ready', () => {
    const task = refactorTask()
    const fields = extractTaskFields(task)

    expect(classifyTask(task, fields)).toEqual({
      status: 'ready',
      reasons: ['Task says implement directly and no unsafe/review markers were detected.'],
    })
  })

  test('classifyTask blocks tasks with unsafe comments', () => {
    const task = refactorTask({
      comments: [{ body: 'UNSAFE to merge - observable error path changes.' }],
    })

    const result = classifyTask(task, extractTaskFields(task))

    expect(result.status).toBe('blocked')
    expect(result.reasons[0]).toContain('unsafe')
  })

  test('classifyTask requires review for human decision markers', () => {
    const task = refactorTask({
      description: `${refactorTask().description}

Needs human decision before deleting this public-surface seam.`,
    })

    const result = classifyTask(task, extractTaskFields(task))

    expect(result.status).toBe('review_required')
    expect(result.reasons.join(' ')).toContain('review')
  })

  test('classifyTask treats an APPROVED specification as ready despite public-surface wording', () => {
    const task = refactorTask({
      description: `${refactorTask().description}

Recommended action: Public-surface contract change — route via M02 Expand/Contract.`,
      specification: '## APPROVED — proceed with implementation\n\nNarrow the export.',
      comments: [{ body: 'Selector audit: review-required/public-surface work.' }],
    })

    const result = classifyTask(task, extractTaskFields(task))

    expect(result.status).toBe('ready')
    expect(result.reasons.join(' ')).toContain('human triage sign-off')
  })

  test('classifyTask treats a human-approved label as ready', () => {
    const task = refactorTask({
      labels: ['refactor', 'api-public', 'human-approved'],
      description: `${refactorTask().description}

This is a public-surface contract change needing owner confirmation.`,
    })

    expect(classifyTask(task, extractTaskFields(task)).status).toBe('ready')
  })

  test('classifyTask still blocks an approved task with an unsafe latest comment', () => {
    const task = refactorTask({
      specification: '## APPROVED — proceed',
      comments: [{ body: 'UNSAFE to merge — observable behavior changed; do not implement.' }],
    })

    expect(classifyTask(task, extractTaskFields(task)).status).toBe('blocked')
  })

  test('renderPacket includes the archive command for no-longer-valid tasks', () => {
    const task = refactorTask()
    const fields = extractTaskFields(task)
    const rendered = renderPacket({
      task,
      fields,
      location: {
        path: fields.location,
        exists: true,
        trackedCount: 1,
        note: 'Location exists.',
      },
      reportExists: true,
      classification: classifyTask(task, fields),
      skippedBlocked: 0,
      skippedReviewRequired: 0,
    })

    expect(rendered).toContain('If no longer valid, archive it with:')
    expect(rendered).toContain('wrkq-refactor.ts archive --task T-00001 --reason "<why>"')
    expect(rendered).toContain('If review-gated, unsafe, or otherwise choosing not to proceed')
    expect(rendered).toContain('wrkq-refactor.ts block --task T-00001 --reason "<why>"')
    expect(rendered).toContain(
      'Commit and push with: bun scripts/wrkq-refactor.ts publish --message "<commit message>"'
    )
  })

  test('scheduled wrapper emails the final result with gog', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('send_result_email')
    expect(script).toContain('EMAIL_PREFIX="${WRKQ_REFACTOR_EMAIL_PREFIX:-ACP refactor}"')
    expect(script).toContain('agent_email_topic')
    expect(script).toContain('Topic: ${topic}')
    expect(script).toContain('local subject="${EMAIL_PREFIX}: ${topic}"')
    expect(script).toContain('gog "${gog_args[@]}"')
    expect(script).toContain('--body-file "$body_path"')
    expect(script).toContain('WRKQ_REFACTOR_SCHEDULED_DRY_RUN')
    expect(script).not.toContain('ACP wrkq refactor automation: ${status}')
  })

  test('scheduled prompt requires an agent-authored email topic', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain(
      'Your final response MUST include a single line starting with `EMAIL_TOPIC:`'
    )
    expect(script).toContain(
      'EMAIL_TOPIC: <agent action> <final task state> - <task id> <short detail>'
    )
    expect(script).toContain(
      'EMAIL_TOPIC: implemented complete - T-04576 narrow public index exports'
    )
    expect(script).toContain(
      'EMAIL_TOPIC: already done archive - T-04579 renderToDiscord was already removed'
    )
    expect(script).toContain('EMAIL_TOPIC: needs review blocked - T-04521')
  })

  test('scheduled wrapper blocks no-proceed tasks instead of leaving them open', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('wrkq-refactor.ts block --task <task-id> --reason "<why>"')
    expect(script).toContain('Do not leave the selected task open')
    expect(script).toContain('block it with the command above')
    expect(script).not.toContain('leave the task untouched')
  })

  test('scheduled wrapper skips HRC turn when no refactor task is selected', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('bun scripts/wrkq-refactor.ts next --json')
    expect(script).toContain('No open tasks found under')
    expect(script).toContain('no open refactor task selected; skipping HRC turn')
    expect(script).toContain('send_result_email "skipped-no-task"')
  })

  test('scheduled prompt tells ready tasks to proceed', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('If `next` reports `Safety: ready`, start the selected task')
    expect(script).toContain('do not stop solely because the historical report says')
    expect(script).not.toContain('Do not force review-required tasks')
  })

  test('scheduled prompt can force approved review-required tasks', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('task specification explicitly says `APPROVED` / proceed')
    expect(script).toContain('start --task <task-id> --force-review')
    expect(script).toContain('do not block solely because the selector saw old deferral')
  })

  test('scheduled prompt tells publish to stage the whole worktree without scoping', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('stages the entire worktree with `git add -A` by design')
    expect(script).toContain('do NOT hand-roll a narrower `git add`/commit')
    expect(script).toContain('do NOT skip or refuse publish because unrelated changes are present')
  })

  test('scheduled wrapper uses a fresh HRC task scope per run', () => {
    const script = readFileSync(resolve(import.meta.dir, 'wrkq-refactor-scheduled.sh'), 'utf8')

    expect(script).toContain('TARGET_TASK="wrkq-refactor-${RUN_ID}"')
    expect(script).toContain('TARGET="cody@agent-control-plane:${TARGET_TASK}"')
    expect(script).toContain(
      'TARGET_SCOPE_REF="agent:cody:project:agent-control-plane:task:${TARGET_TASK}"'
    )
    expect(script).toContain('hrcchat turn --fresh-context --wait final')
    expect(script).not.toContain('cody@agent-control-plane:primary')
    expect(script).not.toContain('task:primary')
  })

  test('scheduled LaunchAgent runs every 20 minutes', () => {
    const plist = readFileSync(
      resolve(import.meta.dir, '../launchd/com.praesidium.acp-wrkq-refactor.plist'),
      'utf8'
    )

    expect(plist).toContain('<key>StartInterval</key>')
    expect(plist).toContain('<integer>1200</integer>')
  })
})
