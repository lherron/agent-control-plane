import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

export type BoundaryViolation = {
  file: string
  specifier: string
}

export type BoundaryWarning = {
  file: string
  specifier: string
  message: string
}

export type BoundaryCheckReport = {
  violationsByLayer: Map<string, BoundaryViolation[]>
  warningFindings: BoundaryWarning[]
  layers: Layer[]
}

type BoundaryCheckOptions = {
  rootDir?: string
  layers?: Layer[]
}

type RenderedDiagnostics = {
  stdout: string
  stderr: string
  exitCode: 0 | 1
}

const aspPackages = [
  'agent-scope',
  'cli-kit',
  'config',
  'runtime',
  'execution',
  'harness-claude',
  'harness-codex',
  'harness-pi',
  'harness-pi-sdk',
  'agent-spaces',
  'cli',
]

const hrcPackages = [
  'agent-action-render',
  'hrc-core',
  'hrc-events',
  'hrc-store-sqlite',
  'hrc-server',
  'hrc-sdk',
  'hrc-cli',
  'hrcchat-cli',
  'hrc-frame-render',
]

const acpPackages = [
  'acp-core',
  'acp-state-store',
  'acp-admin-store',
  'acp-interface-store',
  'acp-conversation',
  'acp-jobs-store',
  'acp-server',
  'acp-cli',
  'acp-e2e',
  'acp-ops-projection',
  'acp-ops-reducer',
  'acp-viewer',
  'gateway-discord',
  'gateway-ios',
  'coordination-substrate',
  'wrkq-lib',
  'wlearn',
]

const layers: Layer[] = [
  {
    name: 'ASP',
    roots: [...aspPackages.map((name) => `packages/${name}`), 'integration-tests'],
    forbidden: ['hrc-', 'acp-', 'gateway-', 'coordination-substrate', 'wrkq-lib', 'wlearn'],
  },
  {
    name: 'HRC',
    roots: hrcPackages.map((name) => `packages/${name}`),
    forbidden: [
      'acp-',
      'gateway-discord',
      'gateway-ios',
      'coordination-substrate',
      'wrkq-lib',
      'wlearn',
    ],
  },
  // ACP is allowed to import HRC packages by name. What ACP must NOT do is
  // reach into HRC implementation internals via a subpath like 'hrc-server/src/...'.
  // The brain-enricher content scan below catches the other half — coupling to
  // HRC-only features.
  {
    name: 'ACP',
    roots: acpPackages.map((name) => `packages/${name}`),
    forbidden: [
      'hrc-server/src',
      'hrc-frame-render/src',
      'hrc-core/src',
      'hrc-events/src',
      'hrc-sdk/src',
      'hrc-store-sqlite/src',
      'agent-action-render/src',
    ],
  },
]

const retiredBrainRuntimeName = ['g', 'brain'].join('')
const acpInternalForbiddenContent = [
  'enrichTurnPromptForBrain',
  'brain-enricher',
  retiredBrainRuntimeName,
]

const ignoredDirectories = new Set([
  '.git',
  'asp_modules',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
])

const importPattern = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const durableKernelPattern = /\bwithDurableWorkflowKernel\b/g

async function collectTsFiles(rootDir: string, sourceRoot: string): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await walk(path)
        }
        continue
      }

      if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        files.push(path)
      }
    }
  }

  await walk(join(rootDir, sourceRoot))
  return files
}

function isForbidden(specifier: string, token: string): boolean {
  if (token.endsWith('-')) {
    return specifier.startsWith(token)
  }
  return specifier === token || specifier.startsWith(`${token}/`)
}

function packageGroup(file: string): string {
  const parts = file.split('/')
  if (parts[0] === 'packages' && parts[1]) {
    return `packages/${parts[1]}`
  }
  return parts[0] ?? dirname(file)
}

function repoRelative(rootDir: string, file: string): string {
  return relative(rootDir, file).replaceAll('\\', '/')
}

function groupBy<T>(items: T[], keyFor: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFor(item)
    const group = grouped.get(key) ?? []
    group.push(item)
    grouped.set(key, group)
  }
  return grouped
}

async function findViolations(rootDir: string, layer: Layer): Promise<BoundaryViolation[]> {
  const violations: BoundaryViolation[] = []
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(rootDir, root)))).flat()

  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      if (layer.forbidden.some((token) => isForbidden(specifier, token))) {
        violations.push({ file: repoRelative(rootDir, file), specifier })
      }
    }
  }

  return violations
}

export async function runBoundaryCheck(
  options: BoundaryCheckOptions = {}
): Promise<BoundaryCheckReport> {
  const rootDir = options.rootDir ?? process.cwd()
  const activeLayers = options.layers ?? layers
  const violationsByLayer = new Map<string, BoundaryViolation[]>()

  for (const layer of activeLayers) {
    const violations = await findViolations(rootDir, layer)
    if (violations.length > 0) {
      violationsByLayer.set(layer.name, violations)
    }
  }

  // Content scan: ACP source must not reference HRC-only feature names.
  const acpRoots = acpPackages.map((name) => `packages/${name}`)
  const acpFiles = (await Promise.all(acpRoots.map((root) => collectTsFiles(rootDir, root)))).flat()
  const contentViolations: BoundaryViolation[] = []
  for (const file of acpFiles.sort()) {
    const content = await readFile(file, 'utf8')
    for (const token of acpInternalForbiddenContent) {
      if (content.includes(token)) {
        contentViolations.push({ file: repoRelative(rootDir, file), specifier: token })
      }
    }
  }
  if (contentViolations.length > 0) {
    violationsByLayer.set('ACP (content)', contentViolations)
  }

  const warningFindings: BoundaryWarning[] = []
  const acpServerSrcFiles = (await collectTsFiles(rootDir, 'packages/acp-server/src')).filter(
    (file) => !file.includes('/__tests__/') && !file.endsWith('.test.ts')
  )

  for (const file of acpServerSrcFiles.sort()) {
    const relativeFile = repoRelative(rootDir, file)
    const content = await readFile(file, 'utf8')

    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (specifier !== '@wrkf/client') {
        continue
      }

      if (!relativeFile.startsWith('packages/acp-server/src/wrkf/')) {
        warningFindings.push({
          file: relativeFile,
          specifier,
          message: '@wrkf/client production import outside packages/acp-server/src/wrkf/',
        })
      }
    }

    if (durableKernelPattern.test(content)) {
      warningFindings.push({
        file: relativeFile,
        specifier: 'withDurableWorkflowKernel',
        message: 'durable workflow kernel call site present; W7 will flip new call sites to error',
      })
    }
    durableKernelPattern.lastIndex = 0
  }

  return { violationsByLayer, warningFindings, layers: activeLayers }
}

function renderWarningDiagnostics(warningFindings: BoundaryWarning[]): string[] {
  if (warningFindings.length === 0) {
    return []
  }

  const lines = [
    'Boundary warnings (non-fatal):',
    '',
    'What failed:',
    '  Existing ACP W7 migration-risk call sites are still present.',
    'Why it matters:',
    '  New call sites would deepen the durable-workflow coupling that W7 is removing.',
    'How to fix:',
    '  Route new workflow code through packages/acp-server/src/wrkf/ or remove the direct kernel/client edge.',
    'Exception path:',
    '  Keep only the known baseline warning until W7 removes it; any new warning must carry an explicit task/spec rationale.',
    '',
    'Warning details:',
  ]
  const groupedWarnings = groupBy(warningFindings, (warning) => packageGroup(warning.file))
  for (const [group, groupWarnings] of groupedWarnings) {
    lines.push(`  ${group}`)
    for (const warning of groupWarnings) {
      lines.push(`    ${warning.file}: ${warning.message} (${warning.specifier})`)
    }
  }
  lines.push('')
  return lines
}

export function renderBoundaryDiagnostics(report: BoundaryCheckReport): RenderedDiagnostics {
  const stderrLines = renderWarningDiagnostics(report.warningFindings)

  if (report.violationsByLayer.size === 0) {
    return {
      stdout: 'Boundary check passed.\n',
      stderr: stderrLines.length > 0 ? `${stderrLines.join('\n')}\n` : '',
      exitCode: 0,
    }
  }

  stderrLines.push(
    'Boundary check failed: forbidden layer imports found.',
    '',
    'What failed:',
    '  Source files imported package layers or implementation subpaths that this repository split forbids.',
    'Why it matters:',
    '  The ASP, HRC, and ACP packages must stay independently buildable and coupled only through public contracts.',
    'How to fix:',
    '  Import from the owning package public entrypoint, move shared contracts to an allowed lower-level package, or invert the dependency so the lower layer does not reach upward.',
    'Exception path:',
    '  Do not suppress the file locally. If the architecture intentionally changes, update scripts/check-boundaries.ts in the same change with the approved rationale and a planted-negative fixture.',
    '',
    'Violation details:'
  )

  for (const [layerName, violations] of report.violationsByLayer) {
    const layer = report.layers.find((candidate) => candidate.name === layerName)
    stderrLines.push('', `${layerName} layer violations:`)
    if (layer) {
      stderrLines.push(`  Rule: ${layerName} roots cannot import ${layer.forbidden.join(', ')}`)
    }

    const grouped = groupBy(violations, (violation) => packageGroup(violation.file))
    for (const [group, groupViolations] of grouped) {
      stderrLines.push(`  ${group}`)
      for (const violation of groupViolations) {
        stderrLines.push(`    ${violation.file}: forbidden '${violation.specifier}'`)
      }
    }
  }

  return { stdout: '', stderr: `${stderrLines.join('\n')}\n`, exitCode: 1 }
}

if (import.meta.main) {
  const rendered = renderBoundaryDiagnostics(await runBoundaryCheck())
  if (rendered.stderr) {
    console.error(rendered.stderr.trimEnd())
  }
  if (rendered.stdout) {
    console.log(rendered.stdout.trimEnd())
  }
  process.exit(rendered.exitCode)
}
