import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '..')
const manifestPath = join(root, 'praesidium.toml')

describe('praesidium batch-drain manifest', () => {
  test('declares the worktree-local enablement commands used by batch preflight', () => {
    // T-05830: the drain only reads praesidium.toml, so the unit bar pins the
    // bounded manifest contract before the heavier detached-worktree smoke runs.
    expect(existsSync(manifestPath)).toBe(true)

    const manifestText = readFileSync(manifestPath, 'utf8')
    const manifest = Bun.TOML.parse(manifestText) as {
      commands?: {
        prep?: unknown
        install?: unknown
        test?: unknown
      }
    }

    expect(manifest.commands).toBeDefined()
    expect(manifest.commands?.prep).toBe('bun run install:hooks')
    expect(manifest.commands?.install).toBe(
      'PRAESIDIUM_SYNC_NO_COMMIT=1 bun install && PRAESIDIUM_SYNC_NO_COMMIT=1 bun run build'
    )
    expect(manifest.commands?.test).toBe('bun test')

    expect(manifest.commands?.install).not.toContain('just install')
    expect(manifest.commands?.install).not.toContain('publish-local-verdaccio')
    expect(manifest.commands?.install).not.toContain('bun link')
    expect(manifest.commands?.test).not.toContain('ASP_PROJECT=agent-control-plane bun run test')
  })
})
