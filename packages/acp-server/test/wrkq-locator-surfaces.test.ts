import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isSourceLinkedCheckout } from './fixtures/source-linked'

const repoRoot = resolve(import.meta.dir, '../../..')

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('wrkq locator static surfaces', () => {
  test('fleet-neutral launchd has no wrkq locator or path authority', () => {
    const plist = readRepoFile('launchd/com.praesidium.acp-server.plist')

    expect(plist).not.toContain('<key>ACP_WRKQ_DB_PATH</key>')
    expect(plist).not.toContain('<key>WRKQ_DB_PATH</key>')
    expect(plist).not.toContain('rpc://mini')
  })

  test('README and current spec document canonical locators, path-only compatibility, and no WRKF selector', () => {
    for (const path of [
      'packages/acp-server/README.md',
      'docs/agent-control-plane-current-spec.md',
    ]) {
      const contents = readRepoFile(path)
      expect(contents, path).toContain('WRKQ_DB')
      expect(contents, path).toContain('ACP_WRKQ_DB')
      expect(contents, path).toContain('WRKQ_DB_PATH')
      expect(contents, path).toContain('path-only')
      expect(contents, path).toContain('rpc://')
      expect(contents, path).not.toContain('WRKF_DB_PATH')
    }
  })

  test.skipIf(isSourceLinkedCheckout())(
    'manifests stay on latest while lockfile and install agree on the resolved client snapshot',
    () => {
      const rootManifest = JSON.parse(readRepoFile('package.json')) as {
        dependencies?: Record<string, string>
        overrides?: Record<string, string>
      }
      expect(rootManifest.dependencies?.['@wrkq/client']).toBe('latest')
      expect(rootManifest.overrides?.['@wrkq/client']).toBeUndefined()
      const manifestPaths = [
        'packages/acp-cli/package.json',
        'packages/acp-server/package.json',
        'packages/gateway-discord/package.json',
        'packages/gateway-ios/package.json',
        'packages/wrkq-lib/package.json',
      ]

      for (const path of manifestPaths) {
        const manifest = JSON.parse(readRepoFile(path)) as {
          dependencies?: Record<string, string>
        }
        expect(manifest.dependencies?.['@wrkq/client'], path).toBe('latest')
      }

      const lockedVersion = readRepoFile('bun.lock').match(
        /"@wrkq\/client": \["@wrkq\/client@(\d+\.\d+\.\d+-dev\.\d+)"/
      )?.[1]
      expect(lockedVersion, 'bun.lock @wrkq/client resolution').toMatch(/^\d+\.\d+\.\d+-dev\.\d+$/)
      const installed = JSON.parse(readRepoFile('node_modules/@wrkq/client/package.json')) as {
        version: string
      }
      expect(installed.version).toBe(lockedVersion)
      for (const path of manifestPaths) {
        const installedPath = Bun.resolveSync(
          '@wrkq/client/package.json',
          resolve(repoRoot, path, '..')
        )
        const workspaceInstalled = JSON.parse(readFileSync(installedPath, 'utf8')) as {
          version: string
        }
        expect(workspaceInstalled.version, installedPath).toBe(lockedVersion)
      }
    }
  )
})
