import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

type CommandName = 'next' | 'start' | 'finish' | 'archive' | 'block' | 'publish'
type SafetyStatus = 'ready' | 'review_required' | 'blocked'

type Options = {
  command: CommandName
  project: string
  container: string
  limit: number
  taskId: string | undefined
  json: boolean
  forceReview: boolean
  dryRun: boolean
  summary: string | undefined
  reason: string | undefined
  message: string | undefined
  validation: string[]
  bodyFile: string | undefined
}

type WrkqListTask = {
  id: string
  title: string
  path: string
  state: string
  kind?: string
  updated_at?: string
}

type WrkqComment = {
  body?: string
  created_at?: string
  actor_slug?: string
}

type WrkqTask = WrkqListTask & {
  description?: string
  specification?: string
  labels?: string | string[]
  comments?: WrkqComment[]
}

type TaskFields = {
  packageName: string | undefined
  location: string | undefined
  risk: string | undefined
  apiImpact: string | undefined
  reportPath: string | undefined
  recommendedAction: string | undefined
}

type LocationCheck = {
  path: string | undefined
  exists: boolean | undefined
  trackedCount: number | undefined
  note: string
}

type Classification = {
  status: SafetyStatus
  reasons: string[]
}

type WorkPacket = {
  task: WrkqTask
  fields: TaskFields
  location: LocationCheck
  reportExists: boolean | undefined
  classification: Classification
  skippedBlocked: number
  skippedReviewRequired: number
}

const DEFAULT_CONTAINER = 'refactor-deferred'
const ROOT = resolve(import.meta.dir, '..')
const REPO_PROJECT = readRepoProjectId() ?? 'agent-control-plane'
const DEFAULT_PROJECT = resolveDefaultProject()

const unsafePatterns = [
  /\bUNSAFE\b/i,
  /unsafe to merge/i,
  /no code change made/i,
  /do not implement/i,
  /not valid/i,
]

const reviewPatterns = [
  /needs human/i,
  /human decision/i,
  /human sign-?off/i,
  /owner confirmation/i,
  /public-surface/i,
  /not auto-applied/i,
  /out of scope/i,
  /not strictly behavior-preserving/i,
  /could change/i,
  /contract change/i,
]

export function resolveDefaultProject(envProject = process.env.ASP_PROJECT): string {
  return normalizeProjectCandidate(envProject, REPO_PROJECT) ?? REPO_PROJECT
}

function normalizeProjectCandidate(
  value: string | undefined,
  repoProject: string
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }
  if (trimmed.startsWith(`${repoProject}-T-`)) {
    return repoProject
  }
  return trimmed
}

function readRepoProjectId(): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      name?: unknown
    }
    return typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : undefined
  } catch {
    return undefined
  }
}

function usage(): string {
  return `Usage:
  bun scripts/wrkq-refactor.ts next [--project <id>] [--container <path>] [--limit <n>] [--task <id>] [--json]
  bun scripts/wrkq-refactor.ts start [--task <id>] [--force-review] [--dry-run] [--json]
  bun scripts/wrkq-refactor.ts finish --task <id> (--summary <text> | --body-file <file>) [--validation <text> ...] [--dry-run]
  bun scripts/wrkq-refactor.ts archive --task <id> --reason <text> [--dry-run]
  bun scripts/wrkq-refactor.ts block --task <id> --reason <text> [--dry-run]
  bun scripts/wrkq-refactor.ts publish --message <commit-message> [--dry-run]

Commands:
  next     Select the next open refactor-deferred task and print a work packet.
  start    Select/read a task, add a starting comment, and mark it in_progress.
  finish   Add a final summary comment and mark the task completed.
  archive  Comment and archive a task that live validation proved no longer valid.
  block    Comment and block a task that automation should not proceed with.
  publish  Run checks, commit all local changes, push, and verify origin/<branch>.

Defaults:
  --project    ${DEFAULT_PROJECT}
  --container  ${DEFAULT_CONTAINER}
  --limit      80
`
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value`)
  }
  return value
}

export function parseArgs(argv: string[]): Options {
  let command: CommandName = 'next'
  let index = 0

  const first = argv[0]
  if (first && !first.startsWith('--')) {
    if (
      first !== 'next' &&
      first !== 'start' &&
      first !== 'finish' &&
      first !== 'archive' &&
      first !== 'block' &&
      first !== 'publish'
    ) {
      fail(`Unknown command: ${first}\n\n${usage()}`)
    }
    command = first
    index = 1
  }

  const options: Options = {
    command,
    project: DEFAULT_PROJECT,
    container: DEFAULT_CONTAINER,
    limit: 80,
    taskId: undefined,
    json: false,
    forceReview: false,
    dryRun: false,
    summary: undefined,
    reason: undefined,
    message: undefined,
    validation: [],
    bodyFile: undefined,
  }

  while (index < argv.length) {
    const arg = argv[index]
    if (!arg) {
      index += 1
      continue
    }

    switch (arg) {
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
        return options
      case '--project':
        index += 1
        options.project = requireValue(argv, index, arg)
        break
      case '--container':
        index += 1
        options.container = requireValue(argv, index, arg)
        break
      case '--limit': {
        index += 1
        const raw = requireValue(argv, index, arg)
        const limit = Number.parseInt(raw, 10)
        if (!Number.isFinite(limit) || limit < 1) {
          fail('--limit must be a positive integer')
        }
        options.limit = limit
        break
      }
      case '--task':
        index += 1
        options.taskId = requireValue(argv, index, arg)
        break
      case '--json':
        options.json = true
        break
      case '--force-review':
        options.forceReview = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--summary':
        index += 1
        options.summary = requireValue(argv, index, arg)
        break
      case '--reason':
        index += 1
        options.reason = requireValue(argv, index, arg)
        break
      case '--message':
        index += 1
        options.message = requireValue(argv, index, arg)
        break
      case '--validation':
        index += 1
        options.validation.push(requireValue(argv, index, arg))
        break
      case '--body-file':
        index += 1
        options.bodyFile = requireValue(argv, index, arg)
        break
      default:
        fail(`Unknown option: ${arg}\n\n${usage()}`)
    }

    index += 1
  }

  return options
}

function run(cmd: string, args: string[]): { status: number; out: string } {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  })
  return {
    status: result.status ?? -1,
    out: `${result.stdout || ''}${result.stderr || ''}`,
  }
}

function commandLine(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ')
}

function runChecked(cmd: string, args: string[]): string {
  const result = run(cmd, args)
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.out}`)
  }
  return result.out
}

function runStep(cmd: string, args: string[], dryRun: boolean): string {
  if (dryRun) {
    console.log(`DRY RUN: ${commandLine(cmd, args)}`)
    return ''
  }

  console.log(`$ ${commandLine(cmd, args)}`)
  const output = runChecked(cmd, args)
  if (output.trim()) {
    process.stdout.write(output)
    if (!output.endsWith('\n')) process.stdout.write('\n')
  }
  return output
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`Failed to parse ${label} JSON: ${(error as Error).message}\n${raw}`)
  }
}

function readTask(taskId: string): WrkqTask {
  const raw = runChecked('wrkq', ['cat', taskId, '--json'])
  const parsed = parseJson<unknown>(raw, `wrkq cat ${taskId}`)
  const task = Array.isArray(parsed) ? parsed[0] : parsed
  if (!isTask(task)) {
    throw new Error(`wrkq cat ${taskId} did not return a task`)
  }
  return task
}

function isTask(value: unknown): value is WrkqTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<WrkqTask>
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.state === 'string'
  )
}

export function normalizeRefactorTaskList(parsed: unknown): WrkqListTask[] {
  const tasks = Array.isArray(parsed) ? parsed : []

  return tasks
    .filter(isTask)
    .filter((task) => task.state === 'open')
    .map((task) => ({
      id: task.id,
      title: task.title,
      path: task.path,
      state: task.state,
      kind: task.kind,
      updated_at: task.updated_at,
    }))
}

function listOpenRefactorTasks(options: Options): WrkqListTask[] {
  const raw = runChecked('wrkq', [
    'ls',
    '--project',
    options.project,
    options.container,
    '--type',
    't',
    '--sort',
    'updated_at',
    '--reverse',
    '--limit',
    String(options.limit),
    '--json',
  ])
  const parsed = parseJson<unknown>(raw, 'wrkq ls')

  return normalizeRefactorTaskList(parsed)
}

function extractLineField(description: string, label: string): string | undefined {
  const pattern = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+?)\\s*$`, 'im')
  const match = description.match(pattern)
  return match?.[1]?.trim()
}

function extractRecommendedAction(description: string): string | undefined {
  const match = description.match(/\*\*Recommended action:\*\*\s*(.+?)(?:\n\n|\nSource:|$)/is)
  return match?.[1]?.replace(/\s+/g, ' ').trim()
}

function cleanInlineMarkdown(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\*\*/g, '').trim()
  return cleaned || undefined
}

function extractReportPath(description: string): string | undefined {
  const match = description.match(/Full audit detail:\s*`([^`]+)`/i)
  return match?.[1]?.trim()
}

export function extractTaskFields(task: Pick<WrkqTask, 'description'>): TaskFields {
  const description = task.description ?? ''
  const riskLine = extractLineField(description, 'Risk')
  const riskParts = riskLine?.split('·') ?? []
  const apiImpact = riskLine?.match(/API-impact:\*\*?\s*(.+)$/i)?.[1]

  return {
    packageName: extractLineField(description, 'Package'),
    location: extractLineField(description, 'Location'),
    risk: cleanInlineMarkdown(riskParts[0]),
    apiImpact: cleanInlineMarkdown(apiImpact),
    reportPath: extractReportPath(description),
    recommendedAction: extractRecommendedAction(description),
  }
}

function gitTrackedCount(path: string): number {
  const raw = runChecked('git', ['ls-files', path])
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean).length
}

function checkLocation(location: string | undefined): LocationCheck {
  if (!location) {
    return {
      path: undefined,
      exists: undefined,
      trackedCount: undefined,
      note: 'No location field found in task description.',
    }
  }

  const normalized = location.replace(/`/g, '').trim()
  const absolute = resolve(ROOT, normalized)
  const exists = existsSync(absolute)
  const trackedCount = gitTrackedCount(normalized)
  const displayPath = relative(ROOT, absolute) || '.'

  if (!exists && trackedCount === 0) {
    return {
      path: displayPath,
      exists,
      trackedCount,
      note: 'Location does not exist and has no tracked files; this can be valid for residue-removal tasks only.',
    }
  }

  if (!exists) {
    return {
      path: displayPath,
      exists,
      trackedCount,
      note: 'Location is absent but git still tracks matching paths; inspect before editing.',
    }
  }

  return {
    path: displayPath,
    exists,
    trackedCount,
    note: trackedCount === 0 ? 'Location exists but has zero tracked files.' : 'Location exists.',
  }
}

function checkReport(reportPath: string | undefined): boolean | undefined {
  if (!reportPath) return undefined
  return existsSync(resolve(ROOT, reportPath))
}

function allText(task: WrkqTask): string {
  const comments = task.comments?.map((comment) => comment.body ?? '').join('\n\n') ?? ''
  return [task.title, task.description ?? '', task.specification ?? '', comments].join('\n\n')
}

function taskLabels(task: Pick<WrkqTask, 'labels'>): string[] {
  const raw = task.labels
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : []
  return list.map((label) => label.trim().toLowerCase()).filter(Boolean)
}

// A task carries human triage sign-off when an operator either tagged it
// `human-approved` or wrote an `APPROVED` directive into the specification.
// This is the durable override: it lets an explicitly-approved task proceed
// even though its historical body/comments still carry the public-surface or
// contract-change wording that the review heuristics key on.
export function isHumanApproved(task: Pick<WrkqTask, 'labels' | 'specification'>): boolean {
  if (taskLabels(task).includes('human-approved')) return true
  const spec = task.specification ?? ''
  return /^[ \t]*#{0,6}[ \t]*APPROVED\b/im.test(spec)
}

export function classifyTask(task: WrkqTask, fields: TaskFields): Classification {
  const reasons: string[] = []
  const text = allText(task)
  const latestComment = task.comments?.[task.comments.length - 1]?.body ?? ''

  if (unsafePatterns.some((pattern) => pattern.test(latestComment))) {
    reasons.push('Latest task comment contains an unsafe/blocking marker.')
    return { status: 'blocked', reasons }
  }

  if (unsafePatterns.some((pattern) => pattern.test(text))) {
    reasons.push('Task body/comments contain an unsafe/blocking marker.')
    return { status: 'blocked', reasons }
  }

  // Human triage sign-off overrides the review-required heuristics below, so an
  // approved task stays `ready` and the scheduled automation stops re-blocking
  // it on every cycle. Genuine unsafe markers (handled above) still win.
  if (isHumanApproved(task)) {
    return {
      status: 'ready',
      reasons: [
        'Task carries human triage sign-off (human-approved label or APPROVED specification).',
      ],
    }
  }

  if (reviewPatterns.some((pattern) => pattern.test(text))) {
    reasons.push('Task body asks for human/owner review or describes a non-trivial contract risk.')
  }

  if (!fields.recommendedAction?.toLowerCase().includes('implement directly')) {
    reasons.push('Recommended action is missing or does not say to implement directly.')
  }

  if (fields.apiImpact?.toLowerCase().includes('public')) {
    reasons.push('Task is public-surface/API-impacting; do not auto-start without review.')
  }

  if (reasons.length > 0) {
    return { status: 'review_required', reasons }
  }

  return {
    status: 'ready',
    reasons: ['Task says implement directly and no unsafe/review markers were detected.'],
  }
}

function buildPacket(task: WrkqTask, skippedBlocked = 0, skippedReviewRequired = 0): WorkPacket {
  const fields = extractTaskFields(task)
  return {
    task,
    fields,
    location: checkLocation(fields.location),
    reportExists: checkReport(fields.reportPath),
    classification: classifyTask(task, fields),
    skippedBlocked,
    skippedReviewRequired,
  }
}

function selectPacket(options: Options): WorkPacket {
  if (options.taskId) {
    return buildPacket(readTask(options.taskId))
  }

  const tasks = listOpenRefactorTasks(options)
  let firstReviewPacket: WorkPacket | undefined
  let skippedBlocked = 0
  let skippedReviewRequired = 0

  for (const listTask of tasks) {
    const packet = buildPacket(readTask(listTask.id), skippedBlocked, skippedReviewRequired)
    if (packet.classification.status === 'ready') {
      packet.skippedBlocked = skippedBlocked
      packet.skippedReviewRequired = skippedReviewRequired
      return packet
    }
    if (packet.classification.status === 'review_required') {
      skippedReviewRequired += 1
      firstReviewPacket ??= packet
      continue
    }
    skippedBlocked += 1
  }

  if (firstReviewPacket) {
    firstReviewPacket.skippedBlocked = skippedBlocked
    firstReviewPacket.skippedReviewRequired = skippedReviewRequired - 1
    return firstReviewPacket
  }

  throw new Error(`No open tasks found under ${options.project}/${options.container}`)
}

export function renderPacket(packet: WorkPacket): string {
  const reportLine =
    packet.fields.reportPath === undefined
      ? 'not declared'
      : `${packet.fields.reportPath} (${packet.reportExists ? 'exists' : 'missing'})`

  const lines = [
    `Task: ${packet.task.id} — ${packet.task.title}`,
    `Path: ${packet.task.path}`,
    `State: ${packet.task.state}`,
    `Package: ${packet.fields.packageName ?? '(unknown)'}`,
    `Location: ${packet.location.path ?? '(unknown)'}`,
    `Location check: ${packet.location.note}`,
    `Tracked files at location: ${packet.location.trackedCount ?? 'unknown'}`,
    `Report: ${reportLine}`,
    `Recommended action: ${packet.fields.recommendedAction ?? '(missing)'}`,
    `Safety: ${packet.classification.status}`,
    ...packet.classification.reasons.map((reason) => `  - ${reason}`),
    '',
    'Agent work packet:',
    `1. Read: wrkq cat ${packet.task.id} --json`,
  ]

  if (packet.fields.reportPath) {
    lines.push(`2. Read: ${packet.fields.reportPath}`)
  } else {
    lines.push('2. No report path was declared; inspect task history before editing.')
  }

  lines.push(
    `3. Confirm the finding still matches current source at ${packet.location.path ?? 'the task location'}.`,
    '4. If valid, implement the smallest behavior-preserving edit.',
    `5. If no longer valid, archive it with: bun scripts/wrkq-refactor.ts archive --task ${packet.task.id} --reason "<why>"`,
    `6. If review-gated, unsafe, or otherwise choosing not to proceed, block it with: bun scripts/wrkq-refactor.ts block --task ${packet.task.id} --reason "<why>"`,
    '7. Run scoped tests/typecheck first, then repo-level checks appropriate to the touched surface.',
    `8. Finish with: bun scripts/wrkq-refactor.ts finish --task ${packet.task.id} --summary "<changes>" --validation "<checks>"`,
    '9. Commit and push with: bun scripts/wrkq-refactor.ts publish --message "<commit message>"'
  )

  if (packet.classification.status === 'review_required') {
    lines.push(
      '',
      'This task requires review confirmation before start. Use --force-review only after live source inspection confirms it is still valid.'
    )
  }

  if (packet.skippedBlocked > 0 || packet.skippedReviewRequired > 0) {
    lines.push(
      '',
      `Selection note: skipped ${packet.skippedBlocked} blocked task(s) and ${packet.skippedReviewRequired} review-required task(s) before this packet.`
    )
  }

  return `${lines.join('\n')}\n`
}

function startingComment(packet: WorkPacket): string {
  const report = packet.fields.reportPath ? ` Report: ${packet.fields.reportPath}.` : ''
  const location = packet.location.path ? ` Location: ${packet.location.path}.` : ''
  return [
    'Starting refactor automation pass.',
    `Safety classification: ${packet.classification.status}.`,
    `Initial read: ${packet.task.title}.${location}${report}`,
    `Validity gates: ${packet.classification.reasons.join(' ')}`,
  ].join(' ')
}

function runWrkqMutation(args: string[], dryRun: boolean): void {
  if (dryRun) {
    console.log(`DRY RUN: wrkq ${args.join(' ')}`)
    return
  }
  process.stdout.write(runChecked('wrkq', args))
}

function startTask(packet: WorkPacket, options: Options): void {
  if (packet.task.state !== 'open') {
    fail(`Refusing to start ${packet.task.id}: expected state open, got ${packet.task.state}`)
  }
  if (packet.classification.status === 'blocked') {
    fail(
      `Refusing to start blocked task ${packet.task.id}: ${packet.classification.reasons.join(' ')}`
    )
  }
  if (packet.classification.status === 'review_required' && !options.forceReview) {
    fail(
      `Refusing to start review-required task ${packet.task.id}. Re-run with --force-review after live validation.`
    )
  }

  runWrkqMutation(['set', packet.task.id, '--state', 'in_progress'], options.dryRun)
  runWrkqMutation(['comment', 'add', packet.task.id, '-m', startingComment(packet)], options.dryRun)
}

function finishBody(options: Options): string {
  if (options.bodyFile) {
    return readFileSync(resolve(ROOT, options.bodyFile), 'utf8').trim()
  }

  if (!options.summary) {
    fail('finish requires --summary or --body-file')
  }

  const validationLines =
    options.validation.length > 0
      ? options.validation.map((line) => `- ${line}`).join('\n')
      : '- Not specified'

  return `Completed.

Changes:
- ${options.summary}

Verification:
${validationLines}`
}

function finishTask(options: Options): void {
  if (!options.taskId) {
    fail('finish requires --task <id>')
  }
  const task = readTask(options.taskId)
  if (task.state === 'completed') {
    fail(`Refusing to finish ${options.taskId}: task is already completed`)
  }
  const body = finishBody(options)
  runWrkqMutation(['comment', 'add', options.taskId, '-m', body], options.dryRun)
  runWrkqMutation(['set', options.taskId, '--state', 'completed'], options.dryRun)
}

function archiveBody(reason: string): string {
  return `Archived by refactor automation: task is no longer valid.

Reason:
${reason}`
}

function archiveTask(options: Options): void {
  if (!options.taskId) {
    fail('archive requires --task <id>')
  }
  if (!options.reason) {
    fail('archive requires --reason <text>')
  }

  const task = readTask(options.taskId)
  if (task.state === 'completed' || task.state === 'archived') {
    fail(`Refusing to archive ${options.taskId}: task is already ${task.state}`)
  }

  runWrkqMutation(
    ['comment', 'add', options.taskId, '-m', archiveBody(options.reason)],
    options.dryRun
  )
  runWrkqMutation(['set', options.taskId, '--state', 'archived'], options.dryRun)
}

function blockBody(reason: string): string {
  return `Blocked by refactor automation: not safe to proceed automatically.

Reason:
${reason}`
}

function blockTask(options: Options): void {
  if (!options.taskId) {
    fail('block requires --task <id>')
  }
  if (!options.reason) {
    fail('block requires --reason <text>')
  }

  const task = readTask(options.taskId)
  if (task.state === 'completed' || task.state === 'archived' || task.state === 'blocked') {
    fail(`Refusing to block ${options.taskId}: task is already ${task.state}`)
  }

  runWrkqMutation(
    ['comment', 'add', options.taskId, '-m', blockBody(options.reason)],
    options.dryRun
  )
  runWrkqMutation(['set', options.taskId, '--state', 'blocked'], options.dryRun)
}

function gitOutput(args: string[]): string {
  return runChecked('git', args).trim()
}

function hasStagedChanges(): boolean {
  return runChecked('git', ['diff', '--cached', '--name-only']).trim().length > 0
}

function publishChanges(options: Options): void {
  if (!options.message) {
    fail('publish requires --message <commit-message>')
  }

  runStep('git', ['diff', '--check'], options.dryRun)
  runStep('bun', ['run', 'check'], options.dryRun)
  runStep('bun', ['run', 'build'], options.dryRun)
  runStep('git', ['add', '-A'], options.dryRun)

  if (options.dryRun) {
    const branch = gitOutput(['branch', '--show-current']) || '<current-branch>'
    console.log(`DRY RUN: git commit -m ${JSON.stringify(options.message)}`)
    console.log(`DRY RUN: git push -u origin ${branch}`)
    console.log(`DRY RUN: verify HEAD == origin/${branch}`)
    return
  }

  const branch = gitOutput(['branch', '--show-current'])
  if (!branch) {
    fail('Cannot publish from a detached HEAD')
  }

  if (!hasStagedChanges()) {
    console.log('No staged changes to commit after git add -A; verifying branch publication.')
    runStep('git', ['push', '-u', 'origin', branch], false)
    const head = gitOutput(['rev-parse', 'HEAD'])
    const remoteHead = gitOutput(['rev-parse', `origin/${branch}`])
    if (head !== remoteHead) {
      fail(`Push verification failed: HEAD ${head} != origin/${branch} ${remoteHead}`)
    }
    const status = gitOutput(['status', '-sb'])
    console.log(status)
    return
  }

  runStep('git', ['commit', '-m', options.message], false)

  runStep('git', ['push', '-u', 'origin', branch], false)

  const head = gitOutput(['rev-parse', 'HEAD'])
  const remoteHead = gitOutput(['rev-parse', `origin/${branch}`])
  if (head !== remoteHead) {
    fail(`Push verification failed: HEAD ${head} != origin/${branch} ${remoteHead}`)
  }

  const status = gitOutput(['status', '-sb'])
  console.log(status)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === 'publish') {
    publishChanges(options)
    return
  }

  if (options.command === 'finish') {
    finishTask(options)
    return
  }

  if (options.command === 'archive') {
    archiveTask(options)
    return
  }

  if (options.command === 'block') {
    blockTask(options)
    return
  }

  const packet = selectPacket(options)

  if (options.json) {
    console.log(JSON.stringify(packet, null, 2))
  } else {
    process.stdout.write(renderPacket(packet))
  }

  if (options.command === 'start') {
    startTask(packet, options)
  }
}

if (import.meta.main) {
  main().catch((error) => fail((error as Error).message))
}
