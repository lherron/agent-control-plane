import { afterEach, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecipientHints } from '../../recipient-hints.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup(content: string) {
  const root = mkdtempSync(join(tmpdir(), 'recipient-hints-'))
  dirs.push(root)
  mkdirSync(join(root, 'any-agent'))
  const path = join(root, 'any-agent', 'agent-profile.toml')
  writeFileSync(path, content)
  const logs: Record<string, unknown>[] = []
  const hints = new RecipientHints(
    (_level, _event, detail) => logs.push(detail),
    () => [root]
  )
  return { path, logs, hints, style: () => hints.forRecipient('any-agent', undefined) }
}
it('uses only declared base spaces and accepts any selector without name matching', () => {
  for (const ref of ['space:prae-tools@dev', 'space:prae-tools@1.2.3']) {
    expect(setup(`[spaces]\nbase = ["${ref}"]`).style()).toBe('prae')
  }
  for (const content of [
    '',
    '[spaces]\nbase = ["space:other@dev"]',
    '[spaces]\nextra = ["space:prae-tools@dev"]',
    '[spaces]\nbase = [42, "not a ref"]',
  ]) {
    expect(setup(content).style()).toBe('legacy')
  }
})
it('caches the decision by profile stat, logs the hash once, and invalidates on change', () => {
  const fixture = setup('[spaces]\nbase = ["space:prae-tools@dev"]')
  expect(fixture.style()).toBe('prae')
  expect(fixture.style()).toBe('prae')
  expect(fixture.logs).toHaveLength(1)
  expect(fixture.logs[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
  writeFileSync(fixture.path, '[spaces]\nbase = []')
  expect(fixture.style()).toBe('legacy')
  expect(fixture.logs).toHaveLength(2)
})
it('falls back and logs on malformed, missing or unreadable roots; recovers after repair', () => {
  const fixture = setup('[spaces')
  expect(fixture.style()).toBe('legacy')
  expect(fixture.logs[0]?.reason).toBeDefined()
  writeFileSync(fixture.path, '[spaces]\nbase = ["space:prae-tools@dev"]')
  expect(fixture.style()).toBe('prae')
  rmSync(fixture.path)
  expect(fixture.style()).toBe('legacy')
  expect(
    new RecipientHints(
      () => {},
      () => {
        throw new Error('no root')
      }
    ).forRecipient('any-agent')
  ).toBe('legacy')
})
it('honors root precedence and isolates per-agent profile paths', () => {
  const first = setup('')
  const second = setup('[spaces]\nbase = ["space:prae-tools@dev"]')
  const hints = new RecipientHints(
    () => {},
    () => [join(first.path, '../..'), join(second.path, '../..')]
  )
  expect(hints.forRecipient('any-agent')).toBe('legacy')
  expect(hints.forRecipient('missing')).toBe('legacy')
})
