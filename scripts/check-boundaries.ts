import type { Dirent } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

type Layer = {
  name: string
  roots: string[]
  forbidden: string[]
}

type Violation = {
  file: string
  specifier: string
}

type Warning = {
  file: string
  specifier: string
  message: string
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

async function collectTsFiles(root: string): Promise<string[]> {
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

  await walk(root)
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

async function findViolations(layer: Layer): Promise<Violation[]> {
  const violations: Violation[] = []
  const files = (await Promise.all(layer.roots.map((root) => collectTsFiles(root)))).flat()

  for (const file of files.sort()) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) {
        continue
      }

      if (layer.forbidden.some((token) => isForbidden(specifier, token))) {
        violations.push({ file: relative(process.cwd(), file), specifier })
      }
    }
  }

  return violations
}

const violationsByLayer = new Map<string, Violation[]>()

for (const layer of layers) {
  const violations = await findViolations(layer)
  if (violations.length > 0) {
    violationsByLayer.set(layer.name, violations)
  }
}

// Content scan: ACP source must not reference HRC-only feature names.
const acpRoots = acpPackages.map((name) => `packages/${name}`)
const acpFiles = (await Promise.all(acpRoots.map((root) => collectTsFiles(root)))).flat()
const contentViolations: Violation[] = []
for (const file of acpFiles.sort()) {
  const content = await readFile(file, 'utf8')
  for (const token of acpInternalForbiddenContent) {
    if (content.includes(token)) {
      contentViolations.push({ file: relative(process.cwd(), file), specifier: token })
    }
  }
}
if (contentViolations.length > 0) {
  violationsByLayer.set('ACP (content)', contentViolations)
}

const warningFindings: Warning[] = []
const acpServerSrcFiles = (await collectTsFiles('packages/acp-server/src')).filter(
  (file) => !file.includes('/__tests__/') && !file.endsWith('.test.ts')
)

for (const file of acpServerSrcFiles.sort()) {
  const relativeFile = relative(process.cwd(), file)
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

if (warningFindings.length > 0) {
  console.warn('Boundary warnings:')
  const groupedWarnings = Map.groupBy(warningFindings, (warning) => packageGroup(warning.file))
  for (const [group, groupWarnings] of groupedWarnings) {
    console.warn(`  ${group}`)
    for (const warning of groupWarnings) {
      console.warn(`    ${warning.file}: ${warning.message} (${warning.specifier})`)
    }
  }
  console.warn('')
}

if (violationsByLayer.size === 0) {
  console.log('Boundary check passed.')
  process.exit(0)
}

console.error('Boundary check failed: forbidden layer imports found.')

for (const [layerName, violations] of violationsByLayer) {
  console.error('')
  console.error(`${layerName} layer violations:`)

  const grouped = Map.groupBy(violations, (violation) => packageGroup(violation.file))
  for (const [group, groupViolations] of grouped) {
    console.error(`  ${group}`)
    for (const violation of groupViolations) {
      console.error(`    ${violation.file}: forbidden '${violation.specifier}'`)
    }
  }
}

process.exit(1)
