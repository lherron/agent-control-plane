import type { CaptureRecord } from './participant-output.js'

export interface PbcRouteIdempotencyStore {
  check(
    key: string,
    bodyHash: string
  ): Promise<
    | { state: 'fresh' }
    | { state: 'replay'; result: unknown }
    | { state: 'conflict' }
  >
  persist(key: string, bodyHash: string, result: unknown): Promise<void>
}

export interface PbcCaptureStore {
  get(captureKey: string): Promise<CaptureRecord | undefined>
  set(captureKey: string, record: CaptureRecord): Promise<void>
}

export class InMemoryPbcIdempotencyStore implements PbcRouteIdempotencyStore {
  private readonly records = new Map<string, { bodyHash: string; result: unknown }>()

  async check(
    key: string,
    bodyHash: string
  ): Promise<
    | { state: 'fresh' }
    | { state: 'replay'; result: unknown }
    | { state: 'conflict' }
  > {
    const record = this.records.get(key)
    if (record === undefined) {
      return { state: 'fresh' }
    }
    if (record.bodyHash !== bodyHash) {
      return { state: 'conflict' }
    }
    return { state: 'replay', result: record.result }
  }

  async persist(key: string, bodyHash: string, result: unknown): Promise<void> {
    this.records.set(key, { bodyHash, result })
  }
}

export class InMemoryPbcCaptureStore implements PbcCaptureStore {
  private readonly records = new Map<string, CaptureRecord>()

  async get(captureKey: string): Promise<CaptureRecord | undefined> {
    return this.records.get(captureKey)
  }

  async set(captureKey: string, record: CaptureRecord): Promise<void> {
    this.records.set(captureKey, record)
  }
}
