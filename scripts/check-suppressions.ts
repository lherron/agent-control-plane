import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

type SuppressionKind =
  | '@ts-expect-error'
  | '@ts-ignore'
  | '@ts-nocheck'
  | 'biome-ignore'
  | 'eslint-disable'
  | 'test-only'
  | 'test-skip'

type CommentLine = {
  line: number
  text: string
}

type Suppression = {
  kind: SuppressionKind
  file: string
  line: number
  text: string
  commentText?: string
}

type BaselineEntry = {
  kind: SuppressionKind
  count: number
  file: string
  text: string
  review: string
}

type Finding = {
  file: string
  line: number
  message: string
}

const baselinePath = 'scripts/suppression-baseline.tsv'
const reviewedPattern = /\bSUPPRESSION-REVIEWED\[T-\d{5}\]:\s*\S.+/
const reviewedFormat = 'SUPPRESSION-REVIEWED[T-xxxxx]: rationale'
const sourceExtensions = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']
const ignoredDirectories = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'tmp',
])
const ignoredFiles = new Set(['scripts/check-suppressions.ts'])

function toSlash(path: string): string {
  return path.split('\\').join('/')
}

function extensionOf(path: string): string {
  const lower = path.toLowerCase()
  return sourceExtensions.find((extension) => lower.endsWith(extension)) ?? ''
}

function shouldScanFile(root: string, file: string): boolean {
  const relativeFile = toSlash(relative(root, file))
  if (ignoredFiles.has(relativeFile)) {
    return false
  }
  return sourceExtensions.includes(extensionOf(file))
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && shouldScanFile(root, path)) {
        files.push(path)
      }
    }
  }

  await walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

function cleanCommentText(text: string): string {
  return text
    .replace(/^\s*\/\//, '')
    .replace(/^\s*\/\*/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*/, '')
    .trim()
}

function collectCommentLines(content: string): CommentLine[] {
  const comments: CommentLine[] = []
  const lines = content.split(/\n/)
  let inBlockComment = false
  let stringQuote: "'" | '"' | '`' | undefined

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    const lineNumber = lineIndex + 1
    let column = 0

    while (column < line.length) {
      if (inBlockComment) {
        const end = line.indexOf('*/', column)
        if (end === -1) {
          comments.push({ line: lineNumber, text: line.slice(column) })
          break
        }

        comments.push({ line: lineNumber, text: line.slice(column, end + 2) })
        column = end + 2
        inBlockComment = false
        continue
      }

      if (stringQuote) {
        const char = line[column]
        if (char === '\\') {
          column += 2
          continue
        }
        if (char === stringQuote) {
          stringQuote = undefined
        }
        column += 1
        continue
      }

      const char = line[column]
      const next = line[column + 1]
      if (char === "'" || char === '"' || char === '`') {
        stringQuote = char
        column += 1
        continue
      }

      if (char === '/' && next === '/') {
        comments.push({ line: lineNumber, text: line.slice(column) })
        break
      }

      if (char === '/' && next === '*') {
        const end = line.indexOf('*/', column + 2)
        if (end === -1) {
          comments.push({ line: lineNumber, text: line.slice(column) })
          inBlockComment = true
          break
        }

        comments.push({ line: lineNumber, text: line.slice(column, end + 2) })
        column = end + 2
        continue
      }

      column += 1
    }
  }

  return comments
}

function parseCommentSuppressions(file: string, comment: CommentLine): Suppression[] {
  const cleaned = cleanCommentText(comment.text)
  const suppressions: Suppression[] = []

  const biome = cleaned.match(/\bbiome-ignore(?:-(?:all|start|end))?\b[^\n\r]*/)
  if (biome) {
    suppressions.push({
      kind: 'biome-ignore',
      file,
      line: comment.line,
      text: normalizeText(comment.text),
      commentText: comment.text,
    })
  }

  const eslint = cleaned.match(/\beslint-disable(?:-(?:next-line|line))?\b[^\n\r]*/)
  if (eslint) {
    suppressions.push({
      kind: 'eslint-disable',
      file,
      line: comment.line,
      text: normalizeText(comment.text),
      commentText: comment.text,
    })
  }

  for (const match of cleaned.matchAll(/@ts-(expect-error|ignore|nocheck)\b[^\n\r]*/g)) {
    suppressions.push({
      kind: `@ts-${match[1]}` as SuppressionKind,
      file,
      line: comment.line,
      text: normalizeText(comment.text),
      commentText: comment.text,
    })
  }

  return suppressions
}

function parseTestSuppressions(file: string, content: string): Suppression[] {
  const suppressions: Suppression[] = []
  const lines = content.replace(/\r\n/g, '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/\b(?:test|it|describe)(?:\.\w+)?\.skip\s*\(/.test(line)) {
      suppressions.push({
        kind: 'test-skip',
        file,
        line: index + 1,
        text: normalizeText(line),
      })
    }
    if (/\b(?:test|it|describe)(?:\.\w+)?\.only\s*\(/.test(line)) {
      suppressions.push({
        kind: 'test-only',
        file,
        line: index + 1,
        text: normalizeText(line),
      })
    }
  }

  return suppressions
}

function commentsByLine(comments: CommentLine[]): Map<number, CommentLine[]> {
  const byLine = new Map<number, CommentLine[]>()
  for (const comment of comments) {
    const entries = byLine.get(comment.line) ?? []
    entries.push(comment)
    byLine.set(comment.line, entries)
  }
  return byLine
}

function hasReviewedMarker(
  suppression: Suppression,
  comments: Map<number, CommentLine[]>
): boolean {
  if (suppression.commentText && reviewedPattern.test(suppression.commentText)) {
    return true
  }

  for (const line of [suppression.line - 1, suppression.line]) {
    const adjacent = comments.get(line) ?? []
    if (adjacent.some((comment) => reviewedPattern.test(comment.text))) {
      return true
    }
  }

  return false
}

function policyFindings(suppression: Suppression): Finding[] {
  const text = cleanCommentText(suppression.text)
  const findings: Finding[] = []

  if (suppression.kind === 'biome-ignore') {
    if (/\bbiome-ignore-(?:all|start|end)\b/.test(text)) {
      findings.push({
        file: suppression.file,
        line: suppression.line,
        message: 'blanket biome suppression is not allowed',
      })
    }
    if (!/\bbiome-ignore\s+lint\/[\w-]+\/[\w-]+/.test(text)) {
      findings.push({
        file: suppression.file,
        line: suppression.line,
        message: 'biome suppression must name one lint rule',
      })
    }
  }

  if (suppression.kind === 'eslint-disable') {
    const match = text.match(/\beslint-disable(?:-next-line|-line)?\s*([^-/\n]*)/)
    if (!match?.[1]?.trim()) {
      findings.push({
        file: suppression.file,
        line: suppression.line,
        message: 'eslint disable must name one or more rules',
      })
    }
  }

  if (suppression.kind === '@ts-nocheck') {
    findings.push({
      file: suppression.file,
      line: suppression.line,
      message: '@ts-nocheck is a blanket typecheck suppression',
    })
  }

  return findings
}

async function collectSuppressions(root: string): Promise<{
  commentsByFile: Map<string, Map<number, CommentLine[]>>
  filesScanned: number
  suppressions: Suppression[]
}> {
  const files = await collectSourceFiles(root)
  const suppressions: Suppression[] = []
  const commentsByFile = new Map<string, Map<number, CommentLine[]>>()

  for (const filePath of files) {
    const relativeFile = toSlash(relative(root, filePath))
    const content = await readFile(filePath, 'utf8')
    const comments = collectCommentLines(content)
    commentsByFile.set(relativeFile, commentsByLine(comments))

    for (const comment of comments) {
      suppressions.push(...parseCommentSuppressions(relativeFile, comment))
    }
    suppressions.push(...parseTestSuppressions(relativeFile, content))
  }

  return {
    commentsByFile,
    filesScanned: files.length,
    suppressions: suppressions.sort((left, right) => {
      const fileOrder = left.file.localeCompare(right.file)
      if (fileOrder !== 0) {
        return fileOrder
      }
      return left.line - right.line
    }),
  }
}

function parseKind(value: string): SuppressionKind | undefined {
  const kinds = new Set<SuppressionKind>([
    '@ts-expect-error',
    '@ts-ignore',
    '@ts-nocheck',
    'biome-ignore',
    'eslint-disable',
    'test-only',
    'test-skip',
  ])
  return kinds.has(value as SuppressionKind) ? (value as SuppressionKind) : undefined
}

async function readBaseline(root: string): Promise<BaselineEntry[]> {
  const text = await readFile(join(root, baselinePath), 'utf8')
  const entries: BaselineEntry[] = []

  for (const [index, rawLine] of text.replace(/\r\n/g, '\n').split('\n').entries()) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const [kindValue, countValue, file, suppressionText, review] = rawLine.split('\t')
    const kind = parseKind(kindValue)
    const count = Number(countValue)
    if (!kind || !Number.isInteger(count) || count < 1 || !file || !suppressionText || !review) {
      throw new Error(`${baselinePath}:${index + 1}: invalid baseline row`)
    }
    if (!reviewedPattern.test(review)) {
      throw new Error(`${baselinePath}:${index + 1}: review must use ${reviewedFormat}`)
    }

    entries.push({
      kind,
      count,
      file,
      text: normalizeText(suppressionText),
      review,
    })
  }

  return entries
}

function baselineKey(entry: Pick<BaselineEntry | Suppression, 'kind' | 'file' | 'text'>): string {
  return [entry.kind, entry.file, normalizeText(entry.text)].join('\u0000')
}

function countByKind(suppressions: Suppression[]): Map<SuppressionKind, number> {
  const counts = new Map<SuppressionKind, number>()
  for (const suppression of suppressions) {
    counts.set(suppression.kind, (counts.get(suppression.kind) ?? 0) + 1)
  }
  return counts
}

function renderCounts(suppressions: Suppression[]): string {
  const counts = countByKind(suppressions)
  const parts = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}=${count}`)
  return parts.length > 0 ? parts.join(', ') : 'no suppressions'
}

function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line}: ${finding.message}`
}

async function main(): Promise<number> {
  const root = resolve(process.argv[2] ?? process.cwd())
  const baseline = await readBaseline(root)
  const baselineCounts = new Map<string, number>()
  for (const entry of baseline) {
    const key = baselineKey(entry)
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + entry.count)
  }

  const { commentsByFile, filesScanned, suppressions } = await collectSuppressions(root)
  const findings: Finding[] = []

  for (const suppression of suppressions) {
    findings.push(...policyFindings(suppression))

    const key = baselineKey(suppression)
    const available = baselineCounts.get(key) ?? 0
    if (available > 0) {
      baselineCounts.set(key, available - 1)
      continue
    }

    const comments = commentsByFile.get(suppression.file) ?? new Map()
    const markerAdvice = hasReviewedMarker(suppression, comments)
      ? 'reviewed marker is present, but the baseline budget was not updated'
      : `missing ${reviewedFormat}`
    findings.push({
      file: suppression.file,
      line: suppression.line,
      message: `unreviewed or over-budget ${suppression.kind} suppression (${markerAdvice})`,
    })
  }

  for (const entry of baseline) {
    const remaining = baselineCounts.get(baselineKey(entry)) ?? 0
    if (remaining > 0) {
      findings.push({
        file: entry.file,
        line: 0,
        message: `baseline contains ${remaining} stale ${entry.kind} suppression(s): ${entry.text}`,
      })
    }
  }

  if (findings.length > 0) {
    console.error('suppression-guard: failed')
    for (const finding of findings) {
      console.error(`suppression-guard: ${formatFinding(finding)}`)
    }
    console.error(`suppression-guard: use ${reviewedFormat} and update ${baselinePath}.`)
    console.error(`suppression-guard: current live budget: ${renderCounts(suppressions)}`)
    return 1
  }

  console.log(
    `suppression-guard: OK; ${filesScanned} source file(s); ${renderCounts(suppressions)}.`
  )
  return 0
}

try {
  process.exit(await main())
} catch (error) {
  console.error(`suppression-guard: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
