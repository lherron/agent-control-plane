/**
 * Reading installed plugin pages (features/mobile-plugin-pages.md; Loggia schemas/plugin-mobile.schema.json). Loggia owns the
 * meaning of a plugin's `mobile` block: ACP validates it against Loggia's JSON Schema,
 * read from the loggia checkout on every read, and enforces only the two rules a schema
 * cannot express (index.html exists; the page totals at most 1 MiB, symlink targets
 * included). A failing page is refused alone and logged.
 *
 * Roots come from Loggia's config (`plugins.roots`) and are re-read on every call, so
 * publishing a page is a commit and install in the plugin's repo, never an ACP restart.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { writeLogLine } from 'acp-core'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'

import { loopbackUpstreamRefusal } from '../loopback-upstream.js'
import type { ResolvedPluginPagesOptions } from './options.js'

export const PAGE_BYTES_MAX = 1024 * 1024

export type PageMounts = Record<string, { ops: string[] }>

export type PluginPage = {
  id: string
  plugin: string
  name: string
  title: string
  icon: string
  mounts: PageMounts
  assets?: { origin: string; prefix: string } | undefined
  files: Map<string, Buffer>
  revision: string
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** SHA-256 over the sorted list of `<path>\0<sha256(file)>\n` lines. */
export function bundleRevision(files: Map<string, Buffer>): string {
  return sha256(
    [...files.keys()]
      .sort()
      .map((path) => `${path}\0${sha256(files.get(path) as Buffer)}\n`)
      .join('')
  )
}

let compiled: { source: string; validate: ValidateFunction } | undefined

async function schemaValidator(path: string): Promise<ValidateFunction> {
  const source = await readFile(path, 'utf8')
  if (compiled?.source !== source) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    compiled = { source, validate: ajv.compile(JSON.parse(source)) }
  }
  return compiled.validate
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

async function readRoots(configPath: string): Promise<string[]> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  // Loggia's default when the key is absent (MacHostConfig.swift).
  const roots = config['plugins.roots'] ?? ['~/.loggia/plugins']
  return Array.isArray(roots) ? roots.filter((r) => typeof r === 'string').map(expandHome) : []
}

const isDirectory = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )
const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

/** The directory holding the package's plugin.json: the package itself or one child of it. */
async function pluginDirectory(packageDir: string): Promise<string | undefined> {
  if (await isFile(join(packageDir, 'plugin.json'))) return packageDir
  const holders: string[] = []
  for (const entry of await readdir(packageDir).catch(() => [] as string[])) {
    if (await isFile(join(packageDir, entry, 'plugin.json'))) holders.push(join(packageDir, entry))
  }
  return holders.length === 1 ? holders[0] : undefined
}

class PageRefused extends Error {}

/**
 * Every file under `pageDir`, keyed by its path relative to the page. A symlink is
 * followed only when its real path stays inside `boundary` and is served under the
 * link's own path.
 */
async function collectFiles(pageDir: string, boundary: string): Promise<Map<string, Buffer>> {
  const realBoundary = await realpath(boundary)
  const inside = (real: string) => real === realBoundary || real.startsWith(realBoundary + sep)
  const files = new Map<string, Buffer>()
  let total = 0
  const visit = async (path: string, chain: Set<string>): Promise<void> => {
    const link = await lstat(path)
    const real = await realpath(path).catch(() => {
      throw new PageRefused(`dangling symlink ${relative(pageDir, path)}`)
    })
    if (link.isSymbolicLink() && !inside(real)) {
      throw new PageRefused(
        `symlink ${relative(pageDir, path)} resolves outside the plugin directory`
      )
    }
    const target = await stat(real)
    if (target.isDirectory()) {
      if (chain.has(real)) throw new PageRefused(`symlink cycle at ${relative(pageDir, path)}`)
      const next = new Set(chain).add(real)
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry), next)
      return
    }
    if (!target.isFile()) return
    total += target.size
    if (total > PAGE_BYTES_MAX) throw new PageRefused('page exceeds 1 MiB')
    files.set(relative(pageDir, path).split(sep).join('/'), await readFile(real))
  }
  await visit(pageDir, new Set())
  return files
}

function refuse(page: string, reason: string, details?: unknown): void {
  writeLogLine({
    level: 'warn',
    component: 'mobile-plugins',
    event: 'plugin.page_refused',
    data: { page, reason, ...(details !== undefined ? { details } : {}) },
  })
}

type Only = { plugin: string; name: string }

async function scan(options: ResolvedPluginPagesOptions, only?: Only): Promise<PluginPage[]> {
  const validate = await schemaValidator(options.schemaPath)
  const pages: PluginPage[] = []
  for (const root of await readRoots(options.loggiaConfigPath)) {
    for (const entry of (await readdir(root).catch(() => [] as string[])).sort()) {
      if (only !== undefined && entry !== only.plugin) continue
      const packageDir = join(root, entry)
      if (!(await isDirectory(packageDir))) continue
      const dir = await pluginDirectory(packageDir)
      if (dir === undefined) continue
      let manifest: Record<string, unknown>
      try {
        manifest = JSON.parse(await readFile(join(dir, 'plugin.json'), 'utf8'))
      } catch {
        continue
      }
      // Loggia's rule: the package folder is named after the manifest id.
      if (manifest['id'] !== entry || manifest['mobile'] === undefined) continue
      const mobile = manifest['mobile'] as Record<string, unknown>
      const declared = mobile['pages']
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        validate(mobile)
        refuse(`${entry}:*`, 'schema', validate.errors)
        continue
      }
      for (const name of Object.keys(declared).sort()) {
        if (only !== undefined && name !== only.name) continue
        const id = `${entry}:${name}`
        const page = (declared as Record<string, Record<string, unknown>>)[name] as Record<
          string,
          unknown
        >
        // Each page is validated as a block of its own, so one bad page leaves the rest.
        if (!validate({ ...mobile, pages: { [name]: page } })) {
          refuse(id, 'schema', validate.errors)
          continue
        }
        const pageDir = join(dir, 'mobile', 'pages', name)
        try {
          const assets = page['assets'] as PluginPage['assets']
          if (
            assets !== undefined &&
            loopbackUpstreamRefusal(new URL(assets.origin)) !== undefined
          ) {
            throw new PageRefused('assets.origin is not a loopback origin')
          }
          if (!(await isFile(join(pageDir, 'index.html')))) throw new PageRefused('no index.html')
          const files = await collectFiles(pageDir, dir)
          pages.push({
            id,
            plugin: entry,
            name,
            title: page['title'] as string,
            icon: page['icon'] as string,
            mounts: page['mounts'] as PageMounts,
            assets: page['assets'] as PluginPage['assets'],
            files,
            revision: bundleRevision(files),
          })
        } catch (error) {
          refuse(id, error instanceof Error ? error.message : String(error))
        }
      }
    }
  }
  // A plugin id installed under two roots: the first root wins.
  const unique = pages.filter((page, index) => pages.findIndex((p) => p.id === page.id) === index)
  return unique.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Every valid page of every installed plugin, sorted by id. */
export function readPluginPages(options: ResolvedPluginPagesOptions): Promise<PluginPage[]> {
  return scan(options)
}

/** One page, read fresh; the first package in root order wins, as in Loggia. */
export async function readPluginPage(
  options: ResolvedPluginPagesOptions,
  plugin: string,
  name: string
): Promise<PluginPage | undefined> {
  return (await scan(options, { plugin, name }))[0]
}
