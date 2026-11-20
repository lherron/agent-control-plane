/**
 * Fixtures for the plugin-page relay: a Loggia config naming temporary plugin roots,
 * plugin packages in Loggia's `<root>/<id>/mac/` layout, a stand-in schema, and a fake
 * `cardo` executable whose reply lines mirror the keys of a real `cardo jobhunt request`
 * (generation, id, ok, result; discovery's operations[].{name, holds, timeout} and
 * batch_seconds_max), recorded 2026-11-20 against the live jobhunt kernel.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PluginPagesOptions } from '../../src/plugin-pages/options.js'

/**
 * A stand-in for Loggia's schemas/plugin-mobile.schema.json, which ACP reads from the
 * loggia checkout at runtime; these tests prove ACP applies whatever schema it is given.
 */
const TEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['pages'],
  properties: {
    pages: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['title', 'icon', 'mounts'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          icon: { type: 'string', minLength: 1 },
          mounts: {
            type: 'object',
            propertyNames: { not: { enum: ['ui', 'cardo-ui'] } },
            additionalProperties: {
              type: 'object',
              required: ['ops'],
              properties: { ops: { type: 'array', items: { type: 'string' } } },
            },
          },
          assets: {
            type: 'object',
            required: ['origin', 'prefix'],
            properties: {
              origin: {
                type: 'string',
                pattern: '^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):[0-9]+$',
              },
              prefix: { type: 'string', pattern: '^/' },
            },
          },
        },
      },
    },
  },
}

export const DISCOVERY_LINE = `${JSON.stringify({
  generation: 1,
  id: 2,
  ok: true,
  result: {
    batch_seconds_max: 30,
    operations: [
      { name: 'hunt.pipeline', effect: 'read', holds: false, timeout: null },
      { name: 'lifecycle.describe', effect: 'read', holds: false, timeout: null },
      { name: 'render.long', effect: 'write', holds: true, timeout: 120 },
      { name: 'graph.batch', effect: 'write', holds: false, timeout: null },
    ],
  },
})}\n`

/** A reply with odd spacing, so a re-serialised line would not compare equal. */
export function echoLine(stdin: string): string {
  return `{"generation":1,  "id":3,"ok":true,"result":{"echo":${stdin.trim()}}}\n`
}

const FAKE_CARDO = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = ${JSON.stringify('__DIR__')}
const argv = Bun.argv.slice(2)
const stdin = await Bun.stdin.text()
appendFileSync(join(dir, 'calls.ndjson'), JSON.stringify({ argv, stdin }) + '\\n')
const [address, verb] = argv
const mount = address.split(/[@/]/)[0]
if (mount === 'gone') process.exit(75)
if (verb === 'watch') {
  writeFileSync(join(dir, 'watch.pid'), String(process.pid))
  process.stdout.write('{"generation":1,"id":1,"ok":true,"result":{"cursor":7,"rows":[]}}\\n')
  process.stdout.write('{"event":{"cursor":8,"diff":[{"id":"n1"}]}}\\n')
  setInterval(() => {}, 1 << 30)
} else {
  const request = JSON.parse(stdin)
  if (request.op === 'registry.discover') process.stdout.write(${JSON.stringify(DISCOVERY_LINE)})
  else if (request.op === 'lost.write') process.exit(7)
  else if (request.op === 'slow.read') process.exit(3)
  else if (request.op === 'hang.op') setInterval(() => {}, 1 << 30)
  else process.stdout.write(${'`'}{"generation":1,  "id":3,"ok":true,"result":{"echo":\${stdin.trim()}}}\\n${'`'})
}
`

export type PluginFixture = {
  dir: string
  options: PluginPagesOptions
  /** `<root>/<id>` for a plugin in the first root. */
  pluginDir(id: string): string
  writePlugin(id: string, mobile: unknown, pages?: Record<string, Record<string, string>>): string
  calls(): { argv: string[]; stdin: string }[]
  watchPid(): number
  setRoots(roots: string[]): void
  root: string
  cleanup(): void
}

export function createPluginFixture(): PluginFixture {
  const dir = mkdtempSync(join(tmpdir(), 'acp-plugin-pages-'))
  const root = join(dir, 'root-a')
  mkdirSync(root, { recursive: true })
  const configPath = join(dir, 'Loggia', 'config.json')
  const schemaPath = join(dir, 'plugin-mobile.schema.json')
  const cardoBin = join(dir, 'cardo')
  writeFileSync(schemaPath, JSON.stringify(TEST_SCHEMA))
  writeFileSync(cardoBin, FAKE_CARDO.replace('"__DIR__"', JSON.stringify(dir)))
  chmodSync(cardoBin, 0o755)
  const setRoots = (roots: string[]) => {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ 'plugins.roots': roots, 'theme.active': 'x' }))
  }
  setRoots([root])
  const fixture: PluginFixture = {
    dir,
    root,
    options: { loggiaConfigPath: configPath, schemaPath, cardoBin },
    pluginDir: (id) => join(root, id),
    writePlugin(id, mobile, pages = {}) {
      const mac = join(root, id, 'mac')
      mkdirSync(mac, { recursive: true })
      writeFileSync(join(mac, 'plugin.json'), JSON.stringify({ id, name: id, mobile }))
      for (const [name, files] of Object.entries(pages)) {
        for (const [path, content] of Object.entries(files)) {
          const file = join(mac, 'mobile', 'pages', name, path)
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, content)
        }
      }
      return mac
    },
    calls() {
      try {
        return readFileSync(join(dir, 'calls.ndjson'), 'utf8')
          .trim()
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line))
      } catch {
        return []
      }
    },
    watchPid: () => Number(readFileSync(join(dir, 'watch.pid'), 'utf8')),
    setRoots,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
  return fixture
}
