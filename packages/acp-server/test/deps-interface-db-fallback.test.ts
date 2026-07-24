/**
 * T-06914 finding D — regression guard.
 *
 * `resolveAcpServerDeps` opens an interface store when the caller supplies none,
 * and its default path is the OPERATOR'S LIVE PRODUCTION DATABASE. A test that
 * forgot to name a store therefore did not fail — it wrote its fixture bindings
 * into the running system's `acp-interface.db` and passed. The bug was visible
 * only in-container, as `EACCES: mkdir '/Users'`, which is the harmless half.
 *
 * These tests pin the fix: under a test runner the fallback is REFUSED, and an
 * explicit `ACP_INTERFACE_DB_PATH` is still honoured. The point is the class, not
 * the one known caller — anything that forgets now fails loudly everywhere.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_INTERFACE_DB_PATH, resolveAcpServerDeps } from '../src/deps.js'

const originalInterfaceDbPath = process.env['ACP_INTERFACE_DB_PATH']
let tempDirs: string[] = []

function restoreEnv(): void {
  if (originalInterfaceDbPath === undefined) {
    Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')
  } else {
    process.env['ACP_INTERFACE_DB_PATH'] = originalInterfaceDbPath
  }
}

afterEach(() => {
  restoreEnv()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('interface-store default path under a test runner', () => {
  test('refuses the production-database fallback when no store and no path are given', () => {
    Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')
    expect(process.env['NODE_ENV']).toBe('test')

    expect(() => resolveAcpServerDeps({})).toThrow(
      /refusing to open the default interface DB under a test runner/
    )
  })

  test('names the production path in the failure so the caller can see what it dodged', () => {
    Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')

    expect(() => resolveAcpServerDeps({})).toThrow(DEFAULT_INTERFACE_DB_PATH)
  })

  test('honours an explicit ACP_INTERFACE_DB_PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-deps-interface-'))
    tempDirs.push(dir)
    process.env['ACP_INTERFACE_DB_PATH'] = join(dir, 'interface.db')

    const resolved = resolveAcpServerDeps({})

    expect(resolved.interfaceStore).toBeDefined()
  })

  test('an injected interfaceStore never reaches the path resolver at all', () => {
    Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')
    const dir = mkdtempSync(join(tmpdir(), 'acp-deps-interface-'))
    tempDirs.push(dir)
    process.env['ACP_INTERFACE_DB_PATH'] = join(dir, 'injected-source.db')
    const injected = resolveAcpServerDeps({}).interfaceStore
    Reflect.deleteProperty(process.env, 'ACP_INTERFACE_DB_PATH')

    const resolved = resolveAcpServerDeps({ interfaceStore: injected })

    expect(resolved.interfaceStore).toBe(injected)
  })
})
