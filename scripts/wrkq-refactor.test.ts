import { describe, expect, test } from 'bun:test'

async function loadWrkqRefactor() {
  const ambientProject = process.env.ASP_PROJECT
  process.env.ASP_PROJECT = 'agent-control-plane-T-00000'

  try {
    return await import('./wrkq-refactor')
  } finally {
    if (ambientProject === undefined) {
      Reflect.deleteProperty(process.env, 'ASP_PROJECT')
    } else {
      process.env.ASP_PROJECT = ambientProject
    }
  }
}

const { classifyTask, extractTaskFields, normalizeRefactorTaskList, parseArgs, renderPacket } =
  await loadWrkqRefactor()

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

Source: refactor-workflow auto-deferred item. Full audit detail: \`/tmp/wrkq-artifacts/T-02029/refactor-analysis/acp-core-report.md\`.
`,
    comments: [],
    ...overrides,
  }
}

describe('wrkq-refactor automation helpers', () => {
  test('parseArgs defaults to next against the refactor-deferred container', () => {
    // T-05830 red: drain-depth worktrees may export a worktree-derived
    // ASP_PROJECT. The refactor helper must still target the repo project.
    const options = parseArgs([])

    expect(options.command).toBe('next')
    expect(options.project).toBe('agent-control-plane')
    expect(options.container).toBe('refactor-deferred')
    expect(options.limit).toBe(80)
  })

  test.each([
    {
      command: 'archive',
      argv: [
        'archive',
        '--task',
        'T-00001',
        '--reason',
        'Current source no longer contains the stale export.',
        '--dry-run',
      ],
      expected: {
        taskId: 'T-00001',
        reason: 'Current source no longer contains the stale export.',
      },
    },
    {
      command: 'block',
      argv: [
        'block',
        '--task',
        'T-00001',
        '--reason',
        'Review-required public CLI contract change.',
        '--dry-run',
      ],
      expected: { taskId: 'T-00001', reason: 'Review-required public CLI contract change.' },
    },
    {
      command: 'publish',
      argv: ['publish', '--message', 'chore(acp): automate wrkq refactor loop', '--dry-run'],
      expected: { message: 'chore(acp): automate wrkq refactor loop' },
    },
  ])(
    'parseArgs reads the $command subcommand with its required value and --dry-run',
    ({ command, argv, expected }) => {
      expect(parseArgs(argv)).toMatchObject({ command, dryRun: true, ...expected })
    }
  )

  test('wrkq printing null for the refactor list is an empty queue, not a crash', () => {
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
    expect(fields.reportPath).toBe(
      '/tmp/wrkq-artifacts/T-02029/refactor-analysis/acp-core-report.md'
    )
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
})
