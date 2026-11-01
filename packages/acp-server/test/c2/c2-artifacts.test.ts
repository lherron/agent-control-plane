/**
 * T-12207 Work step 5/6: `GET /v1/mobile/c2/artifacts/:id`. The id is opaque,
 * bound to {key, updatedAt, field, index}; ACP re-reads the card and takes the
 * path only from that body, realpaths it, and requires containment under the
 * configured roots. Refusal codes are ACP's: `artifact_stale` (409: the card
 * changed or is gone; the client refreshes), `artifact_refused` (403: off-root,
 * symlink escape, traversal, or a field/index the card does not link),
 * `artifact_too_large` (413), `invalid_artifact_id` (400).
 */
import { describe, expect, test } from 'bun:test'
import { closeSync, ftruncateSync, mkdirSync, openSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type C2Acp, SEAT, cardBody, forgeArtifactId, snapshotCard, withC2Acp } from './c2-acp.js'

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'"

async function refusal(acp: C2Acp, id: string): Promise<{ status: number; code: unknown }> {
  const response = await acp.get(`/v1/mobile/c2/artifacts/${id}`)
  const body = (await response.json()) as { ok?: boolean; code?: unknown }
  expect(body.ok).toBe(false)
  return { status: response.status, code: body.code }
}

/** Re-put the fixture card with the evidence image pointing at `image`. */
function repoint(acp: C2Acp, image: string, html = acp.htmlPath): void {
  acp.fake.put({
    scopeRef: SEAT,
    generation: 2,
    kind: 'card',
    id: acp.card().id,
    body: cardBody({ image, html }),
  })
}

async function forgedEvidence(acp: C2Acp): Promise<string> {
  const { card } = await snapshotCard(acp)
  return forgeArtifactId({ key: card.key, updatedAt: card.updatedAt, field: 'evidence', index: 1 })
}

describe('positive control', () => {
  test('an evidence image is served at full resolution, byte for byte', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const id = card.evidence.find((item) => item.label === 'look')?.image?.artifact
      expect(typeof id).toBe('string')
      const response = await acp.get(`/v1/mobile/c2/artifacts/${id}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      const bytes = new Uint8Array(await response.arrayBuffer())
      expect(bytes.length).toBe(acp.imageBytes.length)
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(acp.imageBytes))).toBe(0)
    })
  })

  test('the detail explanation is HTML with the restrictive CSP and nosniff', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const response = await acp.get(`/v1/mobile/c2/artifacts/${card.detail.artifact}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toStartWith('text/html')
      expect(response.headers.get('content-security-policy')).toBe(CSP)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await response.text()).toContain('Because it is disposable.')
    })
  })
})

describe('refusals', () => {
  test('a changed card invalidates its old artifact id; the refreshed id works', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      const oldId = card.evidence.find((item) => item.label === 'look')?.image?.artifact ?? ''
      acp.fake.put({
        scopeRef: SEAT,
        generation: 2,
        kind: 'card',
        id: card.key.id,
        body: { ...acp.card().body, title: 'Revised' },
      })
      expect(await refusal(acp, oldId)).toEqual({ status: 409, code: 'artifact_stale' })
      const { card: fresh } = await snapshotCard(acp)
      const newId = fresh.evidence.find((item) => item.label === 'look')?.image?.artifact
      expect(newId).not.toBe(oldId)
      expect((await acp.get(`/v1/mobile/c2/artifacts/${newId}`)).status).toBe(200)
    })
  })

  test('a card path outside the roots is refused', async () => {
    await withC2Acp(async (acp) => {
      const outside = join(acp.roots.outside, 'secret.png')
      writeFileSync(outside, 'not for the phone')
      repoint(acp, outside)
      expect(await refusal(acp, await forgedEvidence(acp))).toEqual({
        status: 403,
        code: 'artifact_refused',
      })
    })
  })

  test('a symlink under a root that escapes it is refused', async () => {
    await withC2Acp(async (acp) => {
      const outside = join(acp.roots.outside, 'secret.png')
      writeFileSync(outside, 'not for the phone')
      const link = join(acp.roots.wrkqArtifacts, 'T-00000', 'escape.png')
      symlinkSync(outside, link)
      repoint(acp, link)
      expect(await refusal(acp, await forgedEvidence(acp))).toEqual({
        status: 403,
        code: 'artifact_refused',
      })
    })
  })

  test('a traversal path that lexically starts under a root is refused', async () => {
    await withC2Acp(async (acp) => {
      writeFileSync(join(acp.roots.outside, 'secret.png'), 'not for the phone')
      repoint(acp, join(acp.roots.wrkqArtifacts, '..', 'outside', 'secret.png'))
      expect(await refusal(acp, await forgedEvidence(acp))).toEqual({
        status: 403,
        code: 'artifact_refused',
      })
    })
  })

  test('a sibling directory sharing a root prefix is refused', async () => {
    await withC2Acp(async (acp) => {
      const sibling = `${acp.roots.wrkqArtifacts}-evil`
      mkdirSync(sibling, { recursive: true })
      writeFileSync(join(sibling, 'x.png'), 'prefix trick')
      repoint(acp, join(sibling, 'x.png'))
      expect(await refusal(acp, await forgedEvidence(acp))).toEqual({
        status: 403,
        code: 'artifact_refused',
      })
    })
  })

  test('an index or field the card does not link is refused', async () => {
    await withC2Acp(async (acp) => {
      const { card } = await snapshotCard(acp)
      // evidence[0] is a text item, evidence[9] does not exist.
      for (const index of [0, 9]) {
        const id = forgeArtifactId({
          key: card.key,
          updatedAt: card.updatedAt,
          field: 'evidence',
          index,
        })
        expect(await refusal(acp, id)).toEqual({ status: 403, code: 'artifact_refused' })
      }
    })
  })

  test('an image over 20 MB is refused', async () => {
    await withC2Acp(async (acp) => {
      const big = join(acp.roots.wrkqArtifacts, 'T-00000', 'huge.png')
      const fd = openSync(big, 'w')
      ftruncateSync(fd, 20 * 1024 * 1024 + 1)
      closeSync(fd)
      repoint(acp, big)
      expect(await refusal(acp, await forgedEvidence(acp))).toEqual({
        status: 413,
        code: 'artifact_too_large',
      })
    })
  })

  test('HTML over 64 KB is refused', async () => {
    await withC2Acp(async (acp) => {
      const fat = join(acp.roots.scratchC2, 'fat.html')
      writeFileSync(fat, `<p>${'x'.repeat(64 * 1024)}</p>`)
      repoint(acp, acp.imagePath, fat)
      const { card } = await snapshotCard(acp)
      expect(await refusal(acp, card.detail.artifact ?? '')).toEqual({
        status: 413,
        code: 'artifact_too_large',
      })
    })
  })

  test('a malformed id is 400', async () => {
    await withC2Acp(async (acp) => {
      expect(await refusal(acp, 'not-base64url-json')).toEqual({
        status: 400,
        code: 'invalid_artifact_id',
      })
    })
  })
})
