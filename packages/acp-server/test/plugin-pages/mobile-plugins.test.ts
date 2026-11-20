import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withWiredServer } from '../fixtures/wired-server.js'
import { DISCOVERY_LINE, type PluginFixture, createPluginFixture, echoLine } from './fixtures.js'

const local = { address: '127.0.0.1' }
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

const PIPELINE = {
  title: 'Pipeline',
  icon: 'list.bullet.rectangle',
  mounts: {
    jobhunt: {
      ops: [
        'hunt.pipeline',
        'lifecycle.describe',
        'lost.write',
        'slow.read',
        'hang.op',
        'render.long',
      ],
    },
    gone: { ops: ['hunt.pipeline'] },
  },
}

let fx: PluginFixture
beforeEach(() => {
  fx = createPluginFixture()
})
afterEach(() => fx.cleanup())

async function withServer(
  run: (
    request: (method: string, path: string, init?: RequestInit) => Promise<Response>
  ) => Promise<void>,
  extra: Record<string, unknown> = {}
) {
  await withWiredServer(
    async ({ server }) => {
      await run((method, path, init = {}) =>
        server.handler(new Request(`http://acp.test${path}`, { method, ...init }), { peer: local })
      )
    },
    { pluginPages: { ...fx.options, ...extra } }
  )
}

const callPath = '/v1/mobile/plugins/jobhunt/pages/pipeline/call'
const post = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

describe('plugin catalog', () => {
  test('lists valid pages with op deadlines from discovery and re-reads roots on every read', async () => {
    fx.writePlugin(
      'jobhunt',
      { pages: { pipeline: PIPELINE } },
      { pipeline: { 'index.html': '<p>hi</p>' } }
    )
    await withServer(async (request) => {
      const first = (await (await request('GET', '/v1/mobile/plugins')).json()) as any
      expect(first.pages).toHaveLength(1)
      const page = first.pages[0]
      expect(page).toMatchObject({
        id: 'jobhunt:pipeline',
        title: 'Pipeline',
        icon: 'list.bullet.rectangle',
      })
      expect(page.pageRevision).toMatch(/^[0-9a-f]{64}$/)
      expect(page.mounts.jobhunt.available).toBe(true)
      expect(page.mounts.jobhunt.ops['hunt.pipeline']).toEqual({
        holds: false,
        timeout: null,
        deadlineSeconds: 65,
      })
      expect(page.mounts.jobhunt.ops['render.long']).toEqual({
        holds: true,
        timeout: 120,
        deadlineSeconds: 135,
      })
      // An op the kernel does not declare is listed with no declaration.
      expect(page.mounts.jobhunt.ops['lost.write']).toBeNull()
      // A mount with no live kernel (cardo exit 75) is reported unavailable, the page kept.
      expect(page.mounts.gone).toEqual({ available: false, ops: { 'hunt.pipeline': null } })
      expect(first.revision).toMatch(/^[0-9a-f]{64}$/)

      // A second root added to Loggia's config shows up on the next read, no restart.
      const rootB = join(fx.dir, 'root-b')
      mkdirSync(join(rootB, 'sp', 'mac', 'mobile', 'pages', 'read-aloud'), { recursive: true })
      writeFileSync(
        join(rootB, 'sp', 'mac', 'plugin.json'),
        JSON.stringify({
          id: 'sp',
          mobile: {
            pages: {
              'read-aloud': {
                title: 'Read aloud',
                icon: 'waveform',
                mounts: { sp: { ops: ['a'] } },
              },
            },
          },
        })
      )
      writeFileSync(join(rootB, 'sp', 'mac', 'mobile', 'pages', 'read-aloud', 'index.html'), 'x')
      fx.setRoots([fx.root, rootB])
      const second = (await (await request('GET', '/v1/mobile/plugins')).json()) as any
      expect(second.pages.map((p: any) => p.id)).toEqual(['jobhunt:pipeline', 'sp:read-aloud'])
      expect(second.revision).not.toBe(first.revision)
    })
  })

  test('a bad page is refused alone; the plugin’s other pages stay', async () => {
    const ok = { title: 'Ok', icon: 'a', mounts: { jobhunt: { ops: ['hunt.pipeline'] } } }
    fx.writePlugin(
      'jobhunt',
      {
        pages: {
          ok,
          noindex: ok,
          badschema: { ...ok, extra: true },
          uimount: { ...ok, mounts: { ui: { ops: ['x'] } } },
          big: ok,
          escape: ok,
          remote: { ...ok, assets: { origin: 'http://example.com:80', prefix: '/a/' } },
        },
      },
      {
        ok: { 'index.html': 'x' },
        noindex: { 'main.js': 'x' },
        badschema: { 'index.html': 'x' },
        uimount: { 'index.html': 'x' },
        big: { 'index.html': 'x', 'blob.bin': 'x'.repeat(1024 * 1024) },
        escape: { 'index.html': 'x' },
        remote: { 'index.html': 'x' },
      }
    )
    symlinkSync(
      fx.dir,
      join(fx.pluginDir('jobhunt'), 'mac', 'mobile', 'pages', 'escape', 'outside')
    )
    await withServer(async (request) => {
      const catalog = (await (await request('GET', '/v1/mobile/plugins')).json()) as any
      expect(catalog.pages.map((p: any) => p.id)).toEqual(['jobhunt:ok'])
      for (const name of ['noindex', 'badschema', 'big', 'escape']) {
        expect((await request('GET', `/v1/mobile/plugins/jobhunt/pages/${name}`)).status).toBe(404)
      }
    })
  })
})

describe('plugin page bundle', () => {
  test('serves base64 files, follows an in-root symlink under the link path, revision over sorted path digests', async () => {
    const mac = fx.writePlugin(
      'jobhunt',
      { pages: { pipeline: PIPELINE } },
      { pipeline: { 'index.html': '<script src="shared/phase.js"></script>', 'css/a.css': 'b{}' } }
    )
    mkdirSync(join(mac, 'panes', 'shared'), { recursive: true })
    writeFileSync(join(mac, 'panes', 'shared', 'phase.js'), 'export const p = 1')
    symlinkSync('../../../panes/shared', join(mac, 'mobile', 'pages', 'pipeline', 'shared'))
    await withServer(async (request) => {
      const response = await request('GET', '/v1/mobile/plugins/jobhunt/pages/pipeline')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const bundle = (await response.json()) as any
      expect(bundle.schema).toBe(1)
      const files = Object.fromEntries(
        Object.entries(bundle.files as Record<string, string>).map(([k, v]) => [
          k,
          Buffer.from(v, 'base64').toString(),
        ])
      )
      expect(files).toEqual({
        'css/a.css': 'b{}',
        'index.html': '<script src="shared/phase.js"></script>',
        'shared/phase.js': 'export const p = 1',
      })
      const expected = sha(
        Object.keys(files)
          .sort()
          .map((path) => `${path}\0${sha(files[path] as string)}\n`)
          .join('')
      )
      expect(bundle.revision).toBe(expected)
      const catalog = (await (await request('GET', '/v1/mobile/plugins')).json()) as any
      expect(catalog.pages[0].pageRevision).toBe(expected)
      expect((await request('GET', '/v1/mobile/plugins/jobhunt/pages/nope')).status).toBe(404)
    })
  })

  test('a symlink resolving outside <root>/<id> refuses the page', async () => {
    const mac = fx.writePlugin(
      'jobhunt',
      { pages: { pipeline: PIPELINE } },
      { pipeline: { 'index.html': 'x' } }
    )
    mkdirSync(join(fx.root, 'other', 'mac'), { recursive: true })
    writeFileSync(join(fx.root, 'other', 'mac', 'secret.js'), 'secret')
    symlinkSync(
      '../../../../../other/mac/secret.js',
      join(mac, 'mobile', 'pages', 'pipeline', 'secret.js')
    )
    await withServer(async (request) => {
      const response = await request('GET', '/v1/mobile/plugins/jobhunt/pages/pipeline')
      expect(response.status).toBe(404)
      expect(JSON.stringify(await response.json())).not.toContain('secret')
    })
  })
})

describe('plugin page call relay', () => {
  beforeEach(() => {
    fx.writePlugin(
      'jobhunt',
      { pages: { pipeline: PIPELINE } },
      { pipeline: { 'index.html': 'x' } }
    )
  })

  test('an allowlisted op is relayed through cardo request and the reply line passes through verbatim', async () => {
    await withServer(async (request) => {
      const wire = {
        op: 'hunt.pipeline',
        args: { by: 'human:lance', target: { fence: { revision: 3 } } },
      }
      const response = await request('POST', callPath, post({ mount: 'jobhunt', request: wire }))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(echoLine(JSON.stringify(wire)))
      const call = fx.calls().at(-1)!
      expect(call.argv).toEqual(['jobhunt', 'request', '-'])
      expect(JSON.parse(call.stdin)).toEqual(wire)
    })
  })

  test('query and discover are always allowed; owner and graph shape the cardo address', async () => {
    await withServer(async (request) => {
      for (const op of ['graph.query', 'registry.discover']) {
        const response = await request(
          'POST',
          callPath,
          post({ mount: 'jobhunt:hunt', request: { op, args: {} } })
        )
        expect(response.status).toBe(200)
      }
      expect(fx.calls().at(-2)!.argv).toEqual(['jobhunt/hunt', 'request', '-'])
      expect(
        await (
          await request(
            'POST',
            callPath,
            post({ mount: 'jobhunt', request: { op: 'registry.discover', args: {} } })
          )
        ).text()
      ).toBe(DISCOVERY_LINE)
      await request(
        'POST',
        callPath,
        post({ mount: 'jobhunt', request: { op: 'hunt.pipeline', args: {}, owner: 'max3' } })
      )
      expect(fx.calls().at(-1)!.argv).toEqual(['jobhunt@max3', 'request', '-'])
    })
  })

  test('refusals ACP adds never reach the kernel', async () => {
    await withServer(async (request) => {
      const cases: [unknown, number, string][] = [
        [{ mount: 'jobhunt', request: { op: 'hunt.decide', args: {} } }, 403, 'op_not_allowed'],
        [
          { mount: 'signal-pipeline', request: { op: 'graph.query', args: {} } },
          403,
          'mount_not_allowed',
        ],
        [{ mount: 'ui', request: { op: 'graph.query', args: {} } }, 403, 'mount_not_allowed'],
        [
          { mount: 'cardo-ui:ui', request: { op: 'graph.query', args: {} } },
          403,
          'mount_not_allowed',
        ],
        [
          { mount: 'ui@max3', request: { op: 'registry.discover', args: {} } },
          403,
          'mount_not_allowed',
        ],
        [{ mount: 'jobhunt', request: { args: {} } }, 400, 'invalid_request'],
        [{ mount: 'job hunt', request: { op: 'graph.query', args: {} } }, 400, 'invalid_request'],
      ]
      for (const [body, status, code] of cases) {
        const response = await request('POST', callPath, post(body))
        expect(response.status).toBe(status)
        expect(((await response.json()) as any).error.code).toBe(code)
      }
      expect(fx.calls()).toHaveLength(0)
    })
  })

  test('cardo exit codes map to timeout, outcome unknown and mount_unavailable', async () => {
    await withServer(async (request) => {
      const lost = await request(
        'POST',
        callPath,
        post({ mount: 'jobhunt', request: { op: 'lost.write', args: {} } })
      )
      expect(lost.status).toBe(504)
      expect(await lost.json()).toMatchObject({
        ok: false,
        error: { code: 'timeout', details: { outcome: 'unknown' } },
      })
      const slow = await request(
        'POST',
        callPath,
        post({ mount: 'jobhunt', request: { op: 'slow.read', args: {} } })
      )
      expect(slow.status).toBe(504)
      const slowBody = (await slow.json()) as any
      expect(slowBody.error.code).toBe('timeout')
      expect(slowBody.error.details?.outcome).toBeUndefined()
      const gone = await request(
        'POST',
        callPath,
        post({ mount: 'gone', request: { op: 'hunt.pipeline', args: {} } })
      )
      expect(gone.status).toBe(503)
      expect(await gone.json()).toMatchObject({ ok: false, error: { code: 'mount_unavailable' } })
      // Each was sent exactly once: ACP never resends.
      const sent = fx.calls().filter((c) => JSON.parse(c.stdin).op !== 'registry.discover')
      expect(sent.map((c) => JSON.parse(c.stdin).op)).toEqual([
        'lost.write',
        'slow.read',
        'hunt.pipeline',
      ])
    })
  })

  test('the backstop kills a child that outlives its deadline and answers timeout with an unknown outcome', async () => {
    await withServer(
      async (request) => {
        const response = await request(
          'POST',
          callPath,
          post({ mount: 'jobhunt', request: { op: 'hang.op', args: {} } })
        )
        expect(response.status).toBe(504)
        expect(await response.json()).toMatchObject({
          error: { code: 'timeout', details: { outcome: 'unknown' } },
        })
      },
      { defaultDeadlineSeconds: 0, backstopGraceMs: 50 }
    )
  })
})
