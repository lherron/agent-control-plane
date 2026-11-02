/**
 * `GET /v1/mobile/c2/v2/artifacts/:id` (card contract rev 4.1 §12.2, §5 Elucidate): a row's `c2.detail` HTML.
 * The id is opaque, bound to {sessionRef, rowId}; ACP re-reads the view and takes the path only from that
 * row's detail, realpaths it, and requires containment under the configured roots. Codes:
 * `artifact_missing` (404), `artifact_refused` (403: off-root, symlink escape, traversal, non-HTML),
 * `artifact_too_large` (413), `invalid_artifact_id` (400).
 */
import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type C2Acp, SEAT, SEAT_REF, settle, snapshotEntry, withC2Acp } from './c2-acp.js'

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"
const forge = (sessionRef: string, rowId: string) =>
  Buffer.from(JSON.stringify({ sessionRef, rowId })).toString('base64url')

async function refusal(acp: C2Acp, id: string): Promise<{ status: number; code: unknown }> {
  const response = await acp.get(`/v1/mobile/c2/v2/artifacts/${id}`)
  const body = (await response.json()) as { ok?: boolean; code?: unknown }
  expect(body.ok).toBe(false)
  return { status: response.status, code: body.code }
}

function repoint(acp: C2Acp, path: string): void {
  acp.fake.put({
    scopeRef: SEAT,
    subject: 'seat',
    kind: 'detail',
    id: 'ship',
    body: { v: 1, detailRef: path, at: 'x' },
    by: 'agent:vesta',
  })
}

describe('row explanations', () => {
  test('the detail is HTML with the restrictive CSP and nosniff', async () => {
    await withC2Acp(async (acp) => {
      const { entry } = await snapshotEntry(acp)
      const id = entry.rows[0]?.detail.artifact
      expect(id).toBeString()
      const response = await acp.get(`/v1/mobile/c2/v2/artifacts/${id}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('content-security-policy')).toBe(CSP)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await response.text()).toContain('Because it is disposable.')
    })
  })

  test('a path outside the roots, a symlink escape, a traversal and a sibling prefix are refused', async () => {
    await withC2Acp(async (acp) => {
      const outside = join(acp.roots.outside, 'x.html')
      writeFileSync(outside, '<p>no</p>')
      const id = forge(SEAT_REF, 'ship')
      const cases: string[] = [outside]
      const link = join(acp.roots.scratchC2, 'link.html')
      symlinkSync(outside, link)
      cases.push(link, join(acp.roots.scratchC2, '..', '..', 'outside', 'x.html'))
      const sibling = `${acp.roots.scratchC2}-evil`
      mkdirSync(sibling, { recursive: true })
      writeFileSync(join(sibling, 'y.html'), '<p>no</p>')
      cases.push(join(sibling, 'y.html'))
      for (const path of cases) {
        repoint(acp, path)
        await settle(150)
        expect(await refusal(acp, id)).toEqual({ status: 403, code: 'artifact_refused' })
      }
    })
  })

  test('non-HTML is refused; HTML over 64 KB is too large', async () => {
    await withC2Acp(async (acp) => {
      const id = forge(SEAT_REF, 'ship')
      const png = join(acp.roots.scratchC2, 'x.png')
      writeFileSync(png, 'png')
      repoint(acp, png)
      await settle(150)
      expect(await refusal(acp, id)).toEqual({ status: 403, code: 'artifact_refused' })
      const big = join(acp.roots.scratchC2, 'big.html')
      writeFileSync(big, 'x'.repeat(64 * 1024 + 1))
      repoint(acp, big)
      await settle(150)
      expect(await refusal(acp, id)).toEqual({ status: 413, code: 'artifact_too_large' })
    })
  })

  test('a row without a detail, an unknown row and a malformed id are refused', async () => {
    await withC2Acp(async (acp) => {
      expect(await refusal(acp, forge(SEAT_REF, 'nope'))).toEqual({
        status: 404,
        code: 'artifact_missing',
      })
      expect(await refusal(acp, 'not-base64-json')).toEqual({
        status: 400,
        code: 'invalid_artifact_id',
      })
    })
  })
})
