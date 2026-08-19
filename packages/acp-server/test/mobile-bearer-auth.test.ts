/**
 * Mobile-surface bearer auth matrix — spec §7 phase 1.
 *
 * Covers the §1 gate table over the real router: peer tier × credential state ×
 * route class, for both `/v1` and `/v2` mobile paths, plus the WS upgrade
 * decision (which `cli.ts` takes from the same function this exercises).
 */
import { describe, expect, test } from 'bun:test'

import {
  authorizeMobileRequest,
  classifyMobileRoute,
  parseBearerToken,
} from '../src/mobile-auth/gate.js'
import { type MobileAuthStore, createMobileAuthStore } from '../src/mobile-auth/store.js'

import { type WiredServerFixture, withWiredServer } from './fixtures/wired-server.js'

const LOOPBACK = { address: '127.0.0.1', family: 'IPv4', port: 51234 }
const LOOPBACK_V6 = { address: '::1', family: 'IPv6', port: 51236 }
const TAILSCALE = { address: '100.73.60.81', family: 'IPv4', port: 51235 }

/** A route in the bearer tier that answers deterministically with no deps wired. */
const GUARDED_PATH = '/v1/mobile/dashboard'
const GUARDED_V2_PATH = '/v2/mobile/dashboard'
const UNAUTHORIZED_BODY = { ok: false, code: 'unauthorized' }

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

/** Pair one device and arm enforcement, returning the device's live token. */
function armedStore(): { store: MobileAuthStore; token: string; deviceId: string } {
  const store = createMobileAuthStore()
  const redeemed = store.redeemPairingCode(store.mintPairingCode().code, 'test-device')
  if (redeemed === undefined) {
    throw new Error('fixture pairing failed')
  }
  store.setEnforce(true)
  return { store, token: redeemed.token, deviceId: redeemed.device.deviceId }
}

async function withArmedServer<T>(
  run: (fixture: WiredServerFixture, auth: ReturnType<typeof armedStore>) => Promise<T> | T
): Promise<T> {
  const auth = armedStore()
  return withWiredServer((fixture) => run(fixture, auth), { mobileAuthStore: auth.store })
}

describe('mobile route classification (spec §1)', () => {
  test('exempt routes are an explicit allowlist, not a prefix', () => {
    expect(classifyMobileRoute('/v1/mobile/health')).toBe('exempt')
    expect(classifyMobileRoute('/v1/mobile/pairing')).toBe('exempt')
    expect(classifyMobileRoute('/v1/mobile/pair')).toBe('pair')
    expect(classifyMobileRoute('/v1/mobile/health/extra')).toBe('bearer')
  })

  test('every mobile API version lands in the bearer tier by default', () => {
    expect(classifyMobileRoute('/v1/mobile/dashboard')).toBe('bearer')
    expect(classifyMobileRoute('/v2/mobile/sessions')).toBe('bearer')
    expect(classifyMobileRoute('/v2/mobile/dashboard')).toBe('bearer')
    expect(classifyMobileRoute('/v9/mobile/whatever')).toBe('bearer')
  })

  test('non-mobile routes are outside the gate entirely', () => {
    expect(classifyMobileRoute('/v1/sessions')).toBeUndefined()
    expect(classifyMobileRoute('/v1/admin/agents')).toBeUndefined()
    expect(classifyMobileRoute('/v1/mobile')).toBeUndefined()
    expect(classifyMobileRoute('/mobile/dashboard')).toBeUndefined()
  })

  test('bearer parsing accepts only a well-formed Bearer header', () => {
    expect(parseBearerToken('Bearer abc')).toBe('abc')
    expect(parseBearerToken('bearer abc')).toBe('abc')
    expect(parseBearerToken('Basic abc')).toBeUndefined()
    expect(parseBearerToken('abc')).toBeUndefined()
    expect(parseBearerToken(null)).toBeUndefined()
  })
})

describe('dark ship: enforce=false is zero behavior change (spec §4 step 1)', () => {
  test('a tokenless tailnet caller reaches every route class', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request }) => {
        for (const path of [
          '/v1/mobile/health',
          '/v1/mobile/pairing',
          GUARDED_PATH,
          GUARDED_V2_PATH,
        ]) {
          const response = await request({ method: 'GET', path, peer: TAILSCALE })
          expect(response.status).not.toBe(401)
        }

        // The shipped iOS client pairs with no code today; denying that here
        // would break it on the dark ship rather than at activation.
        const pair = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: {},
          peer: TAILSCALE,
        })
        expect(pair.status).toBe(200)
      },
      { mobileAuthStore: store }
    )
  })

  test('code redemption is honored while dark — issuance is never gated by enforce', async () => {
    const store = createMobileAuthStore()
    const { code } = store.mintPairingCode()
    await withWiredServer(
      async ({ request, json }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: code, deviceName: 'dark-phone' },
          peer: TAILSCALE,
        })
        expect(response.status).toBe(200)
        const body = await json<{ token: string }>(response)
        expect(store.verifyToken(body.token)).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })
})

describe('enforced gate: bearer tier (spec §1 row 3)', () => {
  test('loopback needs no bearer, over IPv4 and IPv6 alike', async () => {
    await withArmedServer(async ({ request }) => {
      for (const peer of [LOOPBACK, LOOPBACK_V6]) {
        const response = await request({ method: 'GET', path: GUARDED_PATH, peer })
        expect(response.status).toBe(426)
      }
    })
  })

  test('a valid bearer admits a tailnet caller', async () => {
    await withArmedServer(async ({ request }, { token }) => {
      const response = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(response.status).toBe(426)
    })
  })

  test('missing and invalid bearers get byte-identical 401s', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const missing = await request({ method: 'GET', path: GUARDED_PATH, peer: TAILSCALE })
      const invalid = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(`${token}x`),
      })
      const malformed = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { authorization: token },
      })

      for (const response of [missing, invalid, malformed]) {
        expect(response.status).toBe(401)
        expect(await json(response)).toEqual(UNAUTHORIZED_BODY)
      }
    })
  })

  test('a revoked device is refused', async () => {
    await withArmedServer(async ({ request, json }, { store, token, deviceId }) => {
      expect(
        (
          await request({
            method: 'GET',
            path: GUARDED_PATH,
            peer: TAILSCALE,
            headers: bearer(token),
          })
        ).status
      ).toBe(426)

      store.revokeDevice(deviceId)
      const response = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(response.status).toBe(401)
      expect(await json(response)).toEqual(UNAUTHORIZED_BODY)
    })
  })

  test('an unobservable peer is not loopback — the gate fails closed', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const response = await request({ method: 'GET', path: GUARDED_PATH })
      expect(response.status).toBe(401)
      expect(await json(response)).toEqual(UNAUTHORIZED_BODY)

      // ...but a valid bearer still gets in without an observable peer.
      expect(
        (await request({ method: 'GET', path: GUARDED_PATH, headers: bearer(token) })).status
      ).toBe(426)
    })
  })

  test('X-Forwarded-For cannot launder a tailnet caller into the loopback tier', async () => {
    await withArmedServer(async ({ request }) => {
      const response = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' },
      })
      expect(response.status).toBe(401)
    })
  })

  test('GET /v2/mobile/sessions is gated (named by spec rev 4 §7)', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const denied = await request({ method: 'GET', path: '/v2/mobile/sessions', peer: TAILSCALE })
      expect(denied.status).toBe(401)
      expect(await json(denied)).toEqual(UNAUTHORIZED_BODY)

      const admitted = await request({
        method: 'GET',
        path: '/v2/mobile/sessions',
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(admitted.status).not.toBe(401)

      expect(
        (await request({ method: 'GET', path: '/v2/mobile/sessions', peer: LOOPBACK })).status
      ).not.toBe(401)
    })
  })

  test('/v2 mobile routes are gated identically to /v1', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const denied = await request({ method: 'GET', path: GUARDED_V2_PATH, peer: TAILSCALE })
      expect(denied.status).toBe(401)
      expect(await json(denied)).toEqual(UNAUTHORIZED_BODY)

      expect(
        (
          await request({
            method: 'GET',
            path: GUARDED_V2_PATH,
            peer: TAILSCALE,
            headers: bearer(token),
          })
        ).status
      ).toBe(426)
    })
  })

  test('the /v2/mobile/dashboard WS upgrade is gated (named by spec rev 4 §7)', () => {
    const { store, token } = armedStore()
    const pathname = '/v2/mobile/dashboard'
    expect(authorizeMobileRequest({ pathname, peer: TAILSCALE, authorization: null, store })).toBe(
      'unauthorized'
    )
    expect(
      authorizeMobileRequest({
        pathname,
        peer: TAILSCALE,
        authorization: `Bearer ${token}`,
        store,
      })
    ).toBe('allow')
  })

  test('WS upgrade paths take the same decision as HTTP (spec §3)', () => {
    const { store, token } = armedStore()
    const wsPaths = [
      '/v1/mobile/dashboard',
      '/v2/mobile/dashboard',
      '/v1/mobile/messages/watch',
      '/v1/mobile/sessions/hsid-1/timeline',
      '/v1/mobile/sessions/hsid-1/diagnostics',
    ]

    for (const pathname of wsPaths) {
      expect(
        authorizeMobileRequest({ pathname, peer: TAILSCALE, authorization: null, store })
      ).toBe('unauthorized')
      expect(
        authorizeMobileRequest({ pathname, peer: undefined, authorization: null, store })
      ).toBe('unauthorized')
      expect(
        authorizeMobileRequest({
          pathname,
          peer: TAILSCALE,
          authorization: `Bearer ${token}xyz`,
          store,
        })
      ).toBe('unauthorized')
      expect(authorizeMobileRequest({ pathname, peer: LOOPBACK, authorization: null, store })).toBe(
        'allow'
      )
      expect(
        authorizeMobileRequest({
          pathname,
          peer: TAILSCALE,
          authorization: `Bearer ${token}`,
          store,
        })
      ).toBe('allow')
    }
  })
})

describe('enforced gate: exempt and pair rows (spec §1 rows 1-2)', () => {
  test('health and the pairing descriptor stay open to any peer', async () => {
    await withArmedServer(async ({ request }) => {
      expect(
        (await request({ method: 'GET', path: '/v1/mobile/health', peer: TAILSCALE })).status
      ).not.toBe(401)
      expect(
        (await request({ method: 'GET', path: '/v1/mobile/pairing', peer: TAILSCALE })).status
      ).toBe(200)
    })
  })

  test('the descriptor MUST NOT carry a pairing code (spec §2, normative)', async () => {
    await withArmedServer(async ({ request, json }) => {
      const body = await json<Record<string, unknown>>(
        await request({ method: 'GET', path: '/v1/mobile/pairing', peer: TAILSCALE })
      )
      expect(body).not.toHaveProperty('pairingCode')
      expect(JSON.stringify(body)).not.toContain('pairingCode')
    })
  })

  test('a valid code redeems from the tailnet and mints a usable token', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const { code } = store.mintPairingCode()
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/pair',
        body: { pairingCode: code, deviceName: 'lance-iphone' },
        peer: TAILSCALE,
      })
      expect(response.status).toBe(200)

      const body = await json<{ ok: boolean; token: string; deviceId: string }>(response)
      expect(body.ok).toBe(true)
      expect(store.verifyToken(body.token)).toBe(true)

      const admitted = await request({
        method: 'GET',
        path: GUARDED_PATH,
        peer: TAILSCALE,
        headers: bearer(body.token),
      })
      expect(admitted.status).toBe(426)
    })
  })

  test('a bad, replayed, or absent code from the tailnet gets the same 401', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const { code } = store.mintPairingCode()
      const pair = (body: Record<string, unknown>) =>
        request({ method: 'POST', path: '/v1/mobile/pair', body, peer: TAILSCALE })

      const wrong = await pair({ pairingCode: 'AAAAAAAA' })
      expect(wrong.status).toBe(401)
      expect(await json(wrong)).toEqual(UNAUTHORIZED_BODY)

      expect((await pair({ pairingCode: code })).status).toBe(200)

      const replayed = await pair({ pairingCode: code })
      expect(replayed.status).toBe(401)
      expect(await json(replayed)).toEqual(UNAUTHORIZED_BODY)

      const codeless = await pair({})
      expect(codeless.status).toBe(401)
      expect(await json(codeless)).toEqual(UNAUTHORIZED_BODY)
    })
  })

  test('the codeless no-op ack survives for loopback callers, minting nothing', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const before = store.readPublicState().devices.length
      const response = await request({
        method: 'POST',
        path: '/v1/mobile/pair',
        body: {},
        peer: LOOPBACK,
      })
      expect(response.status).toBe(200)

      const body = await json<Record<string, unknown>>(response)
      expect(body['ok']).toBe(true)
      expect(body).not.toHaveProperty('token')
      expect(store.readPublicState().devices).toHaveLength(before)
    })
  })

  test('a loopback caller may also redeem a code (spec §1 pair row)', async () => {
    await withArmedServer(async ({ request, json }, { store }) => {
      const { code } = store.mintPairingCode()
      const body = await json<{ token: string }>(
        await request({
          method: 'POST',
          path: '/v1/mobile/pair',
          body: { pairingCode: code },
          peer: LOOPBACK,
        })
      )
      expect(store.verifyToken(body.token)).toBe(true)
    })
  })
})

describe('bearer never substitutes for locality', () => {
  test('attach-info keeps its 404 not_local for a tailnet caller holding a valid token', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const response = await request({
        method: 'GET',
        path: '/v1/mobile/sessions/hsid-1/attach-info',
        peer: TAILSCALE,
        headers: bearer(token),
      })
      expect(response.status).toBe(404)
      expect((await json<{ reason: string }>(response)).reason).toBe('not_local')
    })
  })

  test('the auth admin routes refuse a tailnet caller holding a valid token', async () => {
    await withArmedServer(async ({ request, json }, { token }) => {
      const calls = [
        { method: 'POST', path: '/v1/mobile/auth/pairing-code' },
        { method: 'GET', path: '/v1/mobile/auth/devices' },
        { method: 'POST', path: '/v1/mobile/auth/devices/revoke' },
        { method: 'POST', path: '/v1/mobile/auth/enforce' },
      ] as const

      for (const call of calls) {
        const response = await request({ ...call, peer: TAILSCALE, headers: bearer(token) })
        expect(response.status).toBe(404)
        expect((await json<{ code: string }>(response)).code).toBe('not_local')
      }
    })
  })
})

describe('loopback auth admin routes (spec §4 — the server is the only writer)', () => {
  test('mint → redeem → list → revoke round-trips through the routes alone', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const minted = await json<{ code: string; expiresAt: string }>(
          await request({
            method: 'POST',
            path: '/v1/mobile/auth/pairing-code',
            peer: LOOPBACK,
          })
        )
        expect(minted.code).toHaveLength(8)

        const paired = await json<{ token: string; deviceId: string }>(
          await request({
            method: 'POST',
            path: '/v1/mobile/pair',
            body: { pairingCode: minted.code, deviceName: 'lance-iphone' },
            peer: TAILSCALE,
          })
        )

        const listed = await json<{
          enforce: boolean
          devices: Array<{ deviceId: string; deviceName: string }>
        }>(await request({ method: 'GET', path: '/v1/mobile/auth/devices', peer: LOOPBACK }))
        expect(listed.enforce).toBe(false)
        expect(listed.devices).toEqual([
          {
            deviceId: paired.deviceId,
            deviceName: 'lance-iphone',
            pairedAt: expect.any(String) as unknown as string,
          },
        ])
        // Stored hashes are never rendered back to the operator.
        expect(JSON.stringify(listed)).not.toContain('tokenHash')
        expect(JSON.stringify(listed)).not.toContain(paired.token)

        const revoked = await request({
          method: 'POST',
          path: '/v1/mobile/auth/devices/revoke',
          body: { deviceId: paired.deviceId },
          peer: LOOPBACK,
        })
        expect(revoked.status).toBe(200)
        expect(store.verifyToken(paired.token)).toBe(false)

        const missing = await request({
          method: 'POST',
          path: '/v1/mobile/auth/devices/revoke',
          body: { deviceId: paired.deviceId },
          peer: LOOPBACK,
        })
        expect(missing.status).toBe(404)
      },
      { mobileAuthStore: store }
    )
  })

  test('enable refuses an empty device list without force, then arms with it (spec §8)', async () => {
    const store = createMobileAuthStore()
    await withWiredServer(
      async ({ request, json }) => {
        const enforce = (body: Record<string, unknown>) =>
          request({ method: 'POST', path: '/v1/mobile/auth/enforce', body, peer: LOOPBACK })

        const refused = await enforce({ enforce: true })
        expect(refused.status).toBe(409)
        expect((await json<{ code: string }>(refused)).code).toBe('empty_device_list')
        expect(store.isEnforcing()).toBe(false)

        const forced = await enforce({ enforce: true, force: true })
        expect(forced.status).toBe(200)
        expect(store.isEnforcing()).toBe(true)

        // Disabling is the emergency rollback and never needs a force.
        expect((await enforce({ enforce: false })).status).toBe(200)
        expect(store.isEnforcing()).toBe(false)
      },
      { mobileAuthStore: store }
    )
  })

  test('enable needs no force once a device is paired', async () => {
    const store = createMobileAuthStore()
    store.redeemPairingCode(store.mintPairingCode().code)
    await withWiredServer(
      async ({ request }) => {
        const response = await request({
          method: 'POST',
          path: '/v1/mobile/auth/enforce',
          body: { enforce: true },
          peer: LOOPBACK,
        })
        expect(response.status).toBe(200)
        expect(store.isEnforcing()).toBe(true)
      },
      { mobileAuthStore: store }
    )
  })

  test('enforce requires an explicit boolean', async () => {
    await withWiredServer(
      async ({ request }) => {
        expect(
          (
            await request({
              method: 'POST',
              path: '/v1/mobile/auth/enforce',
              body: { enforce: 'yes' },
              peer: LOOPBACK,
            })
          ).status
        ).toBe(400)
      },
      { mobileAuthStore: createMobileAuthStore() }
    )
  })
})
