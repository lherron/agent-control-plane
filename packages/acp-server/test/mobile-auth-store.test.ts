import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMobileAuthStore, resolveMobileAuthStore } from '../src/mobile-auth/store.js'

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-auth-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mobile auth store — persistence', () => {
  test('roster and flag survive a fresh store over the same file; the token does not land on disk', () => {
    withTempDir((dir) => {
      const path = join(dir, 'mobile-auth.json')
      const store = createMobileAuthStore({ path })
      const redeemed = store.redeemPairingCode(store.mintPairingCode().code, 'phone')
      const token = redeemed?.token ?? ''
      store.setEnforce(true)

      const raw = readFileSync(path, 'utf8')
      expect(raw).not.toContain(token)
      expect(JSON.parse(raw)).toEqual({
        enforce: true,
        devices: [
          {
            deviceId: redeemed?.device.deviceId as string,
            tokenHash: redeemed?.device.tokenHash as string,
            deviceName: 'phone',
            pairedAt: redeemed?.device.pairedAt as string,
          },
        ],
      })

      const reopened = createMobileAuthStore({ path })
      expect(reopened.isEnforcing()).toBe(true)
      expect(reopened.verifyToken(token)).toBe(true)
    })
  })

  test('an outstanding pairing code does not survive a restart (codes are memory-only)', () => {
    withTempDir((dir) => {
      const path = join(dir, 'mobile-auth.json')
      const { code } = createMobileAuthStore({ path }).mintPairingCode()
      expect(createMobileAuthStore({ path }).redeemPairingCode(code)).toBeUndefined()
    })
  })

  test('a missing or corrupt state file cold-starts dark rather than throwing', () => {
    withTempDir((dir) => {
      const missing = createMobileAuthStore({ path: join(dir, 'nope', 'mobile-auth.json') })
      expect(missing.readPublicState()).toEqual({ enforce: false, devices: [] })

      const path = join(dir, 'corrupt.json')
      Bun.write(path, 'not json at all')
      expect(createMobileAuthStore({ path }).isEnforcing()).toBe(false)
    })
  })

  test('resolveMobileAuthStore returns one instance per path (single writer)', () => {
    withTempDir((dir) => {
      const env = { ACP_MOBILE_AUTH_PATH: join(dir, 'mobile-auth.json') } as NodeJS.ProcessEnv
      expect(resolveMobileAuthStore(env)).toBe(resolveMobileAuthStore(env))
    })
  })

  test('a test runner with no explicit path never touches the operator state file', () => {
    const store = resolveMobileAuthStore({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)
    store.setEnforce(true, { force: true })
    // Memory-only: a second resolve is a fresh store, so nothing leaked to disk.
    expect(resolveMobileAuthStore({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).isEnforcing()).toBe(
      false
    )
  })
})
