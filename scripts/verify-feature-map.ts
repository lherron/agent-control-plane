#!/usr/bin/env bun
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { buildCliSurface } from './check-cli-surface.ts'
import { packageSurface } from './check-public-surface.ts'
import { collectRouteSummaries, repoRoot } from './lib/live-discovery.ts'

const skillRel = 'spaces/verify-agent-control-plane/skills/verify-agent-control-plane'
const headings = ['Sub-features', 'How to get to it', 'Driving it', 'Gotchas', 'Proven when']

async function inventory(): Promise<string[]> {
  const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: repoRoot })
    .stdout.toString()
    .split('\n')
  const operational = tracked.filter((path) =>
    /^(launchd\/|\.githooks\/|\.github\/workflows\/)/.test(path)
  )
  const recipes = [
    ...(await readFile(join(repoRoot, 'justfile'), 'utf8')).matchAll(
      /^([\w-]+)(?:\s+[^\n:]*)?:[^=\n]*$/gm
    ),
  ].map((match) => `recipe:${match[1]}`)
  return [
    ...Object.keys(await packageSurface(repoRoot)).map((name) => `package:${name}`),
    ...buildCliSurface().map((entry) => `cli:${entry.path} [${entry.flags.join(' ')}]`),
    ...(await collectRouteSummaries(repoRoot)).map(
      (route) => `route:${route.key} @ ${route.source}`
    ),
    ...operational.map((path) => `file:${path}`),
    ...recipes,
  ].sort()
}

async function check(mapRoot: string, expected: string[]): Promise<void> {
  const index = await readFile(join(mapRoot, 'features/README.md'), 'utf8')
  const skill = await readFile(join(mapRoot, 'SKILL.md'), 'utf8')
  if (!skill.startsWith('---\nname: verify-agent-control-plane\n'))
    throw new Error('invalid skill name')
  for (const heading of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Helpers']) {
    if (!skill.includes(`## ${heading}\n`)) throw new Error(`skill missing ${heading}`)
  }
  const covered = new Set<string>()
  const files = (await readdir(join(mapRoot, 'features'))).filter(
    (file) => file.endsWith('.md') && file !== 'README.md'
  )
  if (files.length === 0) throw new Error('no feature maps')
  for (const file of files) {
    if (!index.includes(`](${file})`)) throw new Error(`unindexed map: ${file}`)
    const body = await readFile(join(mapRoot, 'features', file), 'utf8')
    for (const heading of headings) {
      if (!new RegExp(`^## ${heading}\\n\\n\\S`, 'm').test(body))
        throw new Error(`${file}: missing/empty ${heading}`)
    }
    const surfaces = [...body.matchAll(/^- Surface: `([^`]+)`$/gm)]
    if (surfaces.length === 0) throw new Error(`${file}: no surfaces`)
    for (const match of surfaces) {
      const key = match[1] as string
      if (covered.has(key)) throw new Error(`duplicate surface: ${key}`)
      covered.add(key)
    }
  }
  const wanted = new Set(expected)
  const missing = expected.filter((key) => !covered.has(key))
  const stale = [...covered].filter((key) => !wanted.has(key))
  if (missing.length || stale.length)
    throw new Error(`surface drift: missing=${missing.join(', ')}; stale=${stale.join(', ')}`)
  // Check local Markdown reachability from the skill and each map; external URLs and anchors are not fetched.
  for (const path of [
    'SKILL.md',
    'features/README.md',
    ...files.map((file) => `features/${file}`),
  ]) {
    const body = await readFile(join(mapRoot, path), 'utf8')
    for (const match of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1] as string
      if (/^[a-z]+:/.test(target)) continue
      if (!(await Bun.file(resolve(mapRoot, dirname(path), target)).exists()))
        throw new Error(`${path}: broken link ${target}`)
    }
  }
}

async function selfTest(mapRoot: string, expected: string[]): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'acp-feature-map-'))
  try {
    await cp(mapRoot, scratch, { recursive: true })
    const files = (await readdir(join(scratch, 'features'))).filter(
      (file) => file !== 'README.md' && file.endsWith('.md')
    )
    const path = join(scratch, 'features', files[0] as string)
    const original = await readFile(path, 'utf8')
    for (const [label, broken, diagnostic] of [
      ['missing-feature', original.replace(/^- Surface: `[^`]+`\n/m, ''), 'surface drift'],
      ['invalid-map', original.replace('## Gotchas', '## Removed'), 'missing/empty Gotchas'],
    ]) {
      await writeFile(path, broken as string)
      let rejected = false
      try {
        await check(scratch, expected)
      } catch (error) {
        if (!String(error).includes(diagnostic as string)) throw error
        rejected = true
      }
      if (!rejected) throw new Error(`negative fixture accepted: ${label}`)
      console.log(`PASS isolated ${label} rejected`)
      await writeFile(path, original)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let mapRoot = join(repoRoot, skillRel)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--map-root' && args[index + 1]) mapRoot = resolve(args[++index] as string)
    else if (!['--inventory', '--self-test'].includes(arg as string))
      throw new Error(`unknown argument: ${arg}`)
  }
  const expected = await inventory()
  if (args.includes('--inventory')) {
    console.log(JSON.stringify(expected, null, 2))
    return
  }
  if (args.includes('--self-test')) await selfTest(mapRoot, expected)
  await check(mapRoot, expected)
  const docs = await readFile(join(repoRoot, 'docs/README.md'), 'utf8')
  if (!docs.includes(`../${skillRel}/SKILL.md`)) throw new Error('docs index does not reach skill')
  console.log(
    `PASS feature-map: ${expected.length} source surfaces mapped; structural coverage only, no runtime proof`
  )
}

if (import.meta.main) await main()
