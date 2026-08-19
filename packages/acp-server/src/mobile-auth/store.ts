/**
 * Mobile-surface bearer auth state.
 *
 * Spec: `docs/mobile-surface-bearer-auth-spec.md` §2/§4. Two pieces of state live
 * here and nowhere else:
 *
 *  - the durable device roster + `enforce` flag, persisted as flat JSON under the
 *    acp state dir (`mobile-auth.json`). **The server is the file's only writer** —
 *    the CLI mutates it exclusively through the loopback admin routes, so there is
 *    never a second process racing on the same file.
 *  - the at-most-one outstanding pairing code, held in memory only. A code is a
 *    5-minute single-use credential; surviving a daemon restart buys nothing and
 *    would put a live credential on disk.
 *
 * Every credential comparison here is constant-time over SHA-256 digests: token
 * verification walks the whole roster without short-circuiting, so a caller cannot
 * learn how far down the list a near-match sat.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_MOBILE_AUTH_PATH = join(
  '/Users/lherron/praesidium/var/state/acp-server',
  'mobile-auth.json'
)

/** Single-use pairing code lifetime (spec §2). */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000
export const PAIRING_CODE_LENGTH = 8

/**
 * Unambiguous code alphabet: no 0/O, no 1/I/L, no U (reads as V when spoken).
 * Codes are read off a terminal and typed into a phone, so shape-collisions cost
 * a re-mint every time.
 */
const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

export type MobileAuthDevice = {
  /**
   * Short random operator handle for `acp mobile devices list|revoke`
   * (deviceName is not unique). NOT a credential: it is never accepted as auth,
   * and knowing it grants nothing.
   */
  deviceId: string
  /** Hex SHA-256 of the bearer token. The token itself is never stored. */
  tokenHash: string
  deviceName?: string | undefined
  pairedAt: string
}

export type MobileAuthState = {
  enforce: boolean
  devices: MobileAuthDevice[]
}

export type MobileAuthPublicDevice = {
  deviceId: string
  deviceName?: string | undefined
  pairedAt: string
}

export type MintedPairingCode = {
  code: string
  expiresAt: string
}

export type RedeemedPairing = {
  /** Returned to the client exactly once; only its hash is retained. */
  token: string
  device: MobileAuthDevice
}

export class MobileAuthEmptyRosterError extends Error {
  constructor() {
    super(
      'refusing to enable mobile bearer enforcement with no paired devices: the surface would be unreachable from every non-loopback client until a device pairs. Re-run with --force if that is intended.'
    )
    this.name = 'MobileAuthEmptyRosterError'
  }
}

export interface MobileAuthStore {
  /** Roster + flag, safe to render (no hashes). */
  readPublicState(): { enforce: boolean; devices: MobileAuthPublicDevice[] }
  isEnforcing(): boolean
  /** Constant-time membership test of `token` against every stored hash. */
  verifyToken(token: string): boolean
  mintPairingCode(): MintedPairingCode
  /** Consumes the outstanding code on first success only. */
  redeemPairingCode(code: string, deviceName?: string | undefined): RedeemedPairing | undefined
  revokeDevice(deviceId: string): MobileAuthPublicDevice | undefined
  /** Throws `MobileAuthEmptyRosterError` when enabling against an empty roster without `force`. */
  setEnforce(enforce: boolean, options?: { force?: boolean | undefined }): { enforce: boolean }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Constant-time equality for two hex digests. Length mismatch is rejected before
 * `timingSafeEqual` (which throws on unequal buffers) — digests here are always
 * the same width, so a mismatch means malformed state, not a near-miss.
 */
function hexDigestEquals(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false
  }
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) {
    return false
  }
  return timingSafeEqual(left, right)
}

function randomFromAlphabet(length: number, alphabet: string): string {
  // Rejection-free: 256 % alphabet.length would bias, so draw a fresh byte for
  // any value in the biased tail.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length
  let out = ''
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) {
        continue
      }
      out += alphabet[byte % alphabet.length]
      if (out.length === length) {
        break
      }
    }
  }
  return out
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '')
}

function isMobileAuthDevice(value: unknown): value is MobileAuthDevice {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record['deviceId'] === 'string' &&
    typeof record['tokenHash'] === 'string' &&
    typeof record['pairedAt'] === 'string' &&
    (record['deviceName'] === undefined || typeof record['deviceName'] === 'string')
  )
}

function parseState(raw: string): MobileAuthState {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    return { enforce: false, devices: [] }
  }
  const record = parsed as Record<string, unknown>
  const devices = Array.isArray(record['devices'])
    ? record['devices'].filter(isMobileAuthDevice)
    : []
  return { enforce: record['enforce'] === true, devices }
}

type Clock = () => number

export type MobileAuthStoreOptions = {
  /** Omit for a memory-only store (tests); the daemon always passes a path. */
  path?: string | undefined
  now?: Clock | undefined
}

export function createMobileAuthStore(options: MobileAuthStoreOptions = {}): MobileAuthStore {
  const path = options.path
  const now = options.now ?? (() => Date.now())

  let state: MobileAuthState = load()
  let outstandingCode: { codeHash: string; expiresAtMs: number } | undefined

  function load(): MobileAuthState {
    if (path === undefined) {
      return { enforce: false, devices: [] }
    }
    try {
      return parseState(readFileSync(path, 'utf8'))
    } catch {
      // Absent or unreadable file is the cold-start posture: dark, no devices.
      return { enforce: false, devices: [] }
    }
  }

  function persist(): void {
    if (path === undefined) {
      return
    }
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename: a torn read of this file would silently disarm the gate
    // or drop the roster.
    const temp = `${path}.tmp-${process.pid}`
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  }

  function publicDevice(device: MobileAuthDevice): MobileAuthPublicDevice {
    return {
      deviceId: device.deviceId,
      ...(device.deviceName !== undefined ? { deviceName: device.deviceName } : {}),
      pairedAt: device.pairedAt,
    }
  }

  return {
    readPublicState() {
      return { enforce: state.enforce, devices: state.devices.map(publicDevice) }
    },

    isEnforcing() {
      return state.enforce
    },

    verifyToken(token) {
      const candidate = token.trim()
      if (candidate.length === 0) {
        return false
      }
      const hash = sha256Hex(candidate)
      // Deliberately non-short-circuiting: every device costs the same compare.
      let matched = false
      for (const device of state.devices) {
        if (hexDigestEquals(hash, device.tokenHash)) {
          matched = true
        }
      }
      return matched
    },

    mintPairingCode() {
      const code = randomFromAlphabet(PAIRING_CODE_LENGTH, PAIRING_CODE_ALPHABET)
      const expiresAtMs = now() + PAIRING_CODE_TTL_MS
      // At most one outstanding code: minting voids whatever was outstanding.
      outstandingCode = { codeHash: sha256Hex(code), expiresAtMs }
      return { code, expiresAt: new Date(expiresAtMs).toISOString() }
    },

    redeemPairingCode(code, deviceName) {
      const presented = normalizeCode(code)
      if (presented.length === 0) {
        return undefined
      }
      const presentedHash = sha256Hex(presented)
      const outstanding = outstandingCode
      // Compare even when nothing is outstanding, so "no code minted" and "wrong
      // code" cost the same.
      const matches = hexDigestEquals(
        presentedHash,
        outstanding?.codeHash ??
          sha256Hex(randomFromAlphabet(PAIRING_CODE_LENGTH, PAIRING_CODE_ALPHABET))
      )
      if (outstanding === undefined || !matches) {
        return undefined
      }
      if (now() > outstanding.expiresAtMs) {
        outstandingCode = undefined
        return undefined
      }

      // Single use: consumed on first success only (a failed redeem above leaves
      // the code live so a typo does not force a re-mint).
      outstandingCode = undefined
      const token = randomBytes(32).toString('base64url')
      const device: MobileAuthDevice = {
        deviceId: randomBytes(6).toString('hex'),
        tokenHash: sha256Hex(token),
        ...(deviceName !== undefined && deviceName.length > 0 ? { deviceName } : {}),
        pairedAt: new Date(now()).toISOString(),
      }
      state = { ...state, devices: [...state.devices, device] }
      persist()
      return { token, device }
    },

    revokeDevice(deviceId) {
      const found = state.devices.find((device) => device.deviceId === deviceId)
      if (found === undefined) {
        return undefined
      }
      state = { ...state, devices: state.devices.filter((device) => device !== found) }
      persist()
      return publicDevice(found)
    },

    setEnforce(enforce, setOptions = {}) {
      if (enforce && state.devices.length === 0 && setOptions.force !== true) {
        throw new MobileAuthEmptyRosterError()
      }
      state = { ...state, enforce }
      persist()
      return { enforce }
    },
  }
}

const storesByPath = new Map<string, MobileAuthStore>()

/**
 * Process-wide store for a given file path.
 *
 * `cli.ts` resolves server deps twice (once for the HTTP router, once for the WS
 * upgrade path); two independent stores over one flat file would mean two writers
 * and a gate that disagrees with itself between HTTP and WS. Caching by path makes
 * that impossible rather than merely unlikely.
 */
export function resolveMobileAuthStore(env: NodeJS.ProcessEnv = process.env): MobileAuthStore {
  const configured = env['ACP_MOBILE_AUTH_PATH']?.trim()
  if (configured === undefined || configured.length === 0) {
    if (env['NODE_ENV'] === 'test') {
      // Never touch the operator's live auth state from a test runner: an
      // unscoped default here could disarm (or arm) the real gate. Tests that
      // exercise persistence pass an explicit path.
      return createMobileAuthStore()
    }
    return resolveMobileAuthStore({ ...env, ACP_MOBILE_AUTH_PATH: DEFAULT_MOBILE_AUTH_PATH })
  }

  const existing = storesByPath.get(configured)
  if (existing !== undefined) {
    return existing
  }
  const store = createMobileAuthStore({ path: configured })
  storesByPath.set(configured, store)
  return store
}
