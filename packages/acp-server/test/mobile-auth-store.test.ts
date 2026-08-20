import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MobileAuthEmptyRosterError,
  PAIRING_CODE_TTL_MS,
  createMobileAuthStore,
  resolveMobileAuthStore,
} from '../src/mobile-auth/store.js'

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'mobile-auth-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('mobile auth store — pairing codes', () => {
  test('a minted code redeems once for a token that verifies', () => {
    const store = createMobileAuthStore()
    const minted = store.mintPairingCode()
    expect(minted.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)

    const redeemed = store.redeemPairingCode(minted.code, 'lance-iphone')
    expect(redeemed).toBeDefined()
    expect(store.verifyToken(redeemed?.token ?? '')).toBe(true)
    expect(store.readPublicState().devices).toEqual([
      {
        deviceId: redeemed?.device.deviceId as string,
        deviceName: 'lance-iphone',
        pairedAt: redeemed?.device.pairedAt as string,
      },
    ])
  })

  test('single use: a replayed code is refused and mints nothing', () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()

    expect(store.redeemPairingCode(code)).toBeDefined()
    expect(store.redeemPairingCode(code)).toBeUndefined()
    expect(store.readPublicState().devices).toHaveLength(1)
  })

  test('minting voids the previous outstanding code', () => {
    const store = createMobileAuthStore()
    const first = store.mintPairingCode()
    const second = store.mintPairingCode()

    expect(store.redeemPairingCode(first.code)).toBeUndefined()
    expect(store.redeemPairingCode(second.code)).toBeDefined()
  })

  test('a code past its TTL is refused', () => {
    let now = 1_000_000
    const store = createMobileAuthStore({ now: () => now })
    const { code, expiresAt } = store.mintPairingCode()
    expect(Date.parse(expiresAt)).toBe(now + PAIRING_CODE_TTL_MS)

    now += PAIRING_CODE_TTL_MS + 1
    expect(store.redeemPairingCode(code)).toBeUndefined()
    expect(store.readPublicState().devices).toHaveLength(0)
  })

  test('a wrong code is refused without burning the live one (a typo is not fatal)', () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()

    expect(store.redeemPairingCode('AAAAAAAA')).toBeUndefined()
    expect(store.redeemPairingCode(code)).toBeDefined()
  })

  test('redeeming with no outstanding code is refused', () => {
    expect(createMobileAuthStore().redeemPairingCode('AAAAAAAA')).toBeUndefined()
  })

  test('codes are matched case- and separator-insensitively (they are typed by hand)', () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()
    expect(store.redeemPairingCode(` ${code.toLowerCase()} `)).toBeDefined()
  })
})

describe('mobile auth store — devices and enforcement', () => {
  test('revoking a device invalidates its token', () => {
    const store = createMobileAuthStore()
    const redeemed = store.redeemPairingCode(store.mintPairingCode().code)
    const token = redeemed?.token ?? ''
    const deviceId = redeemed?.device.deviceId ?? ''

    expect(store.verifyToken(token)).toBe(true)
    expect(store.revokeDevice(deviceId)?.deviceId).toBe(deviceId)
    expect(store.verifyToken(token)).toBe(false)
    expect(store.readPublicState().devices).toHaveLength(0)
    expect(store.revokeDevice(deviceId)).toBeUndefined()
  })

  test('deviceId is an operator handle, never a credential', () => {
    const store = createMobileAuthStore()
    const redeemed = store.redeemPairingCode(store.mintPairingCode().code)
    const deviceId = redeemed?.device.deviceId ?? ''

    expect(deviceId.length).toBeGreaterThan(0)
    expect(store.verifyToken(deviceId)).toBe(false)
    // Nor is the stored hash itself usable as a bearer.
    expect(store.verifyToken(redeemed?.device.tokenHash ?? '')).toBe(false)
  })

  test('empty tokens never verify', () => {
    const store = createMobileAuthStore()
    store.redeemPairingCode(store.mintPairingCode().code)
    expect(store.verifyToken('')).toBe(false)
    expect(store.verifyToken('   ')).toBe(false)
  })

  test('enabling enforcement against an empty roster refuses without force (lockout guard)', () => {
    const store = createMobileAuthStore()
    expect(() => store.setEnforce(true)).toThrow(MobileAuthEmptyRosterError)
    expect(store.isEnforcing()).toBe(false)

    expect(store.setEnforce(true, { force: true })).toEqual({ enforce: true })
    expect(store.isEnforcing()).toBe(true)
  })

  test('enabling enforcement with a paired device needs no force, and disabling never does', () => {
    const store = createMobileAuthStore()
    store.redeemPairingCode(store.mintPairingCode().code)

    store.setEnforce(true)
    expect(store.isEnforcing()).toBe(true)
    store.setEnforce(false)
    expect(store.isEnforcing()).toBe(false)
  })
})

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
