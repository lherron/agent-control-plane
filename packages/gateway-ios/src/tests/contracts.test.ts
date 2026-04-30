import { describe, expect, it } from 'bun:test'

import type {
  ControlMessage,
  GatewayWsMessage,
  HistoryPage,
  InputRequest,
  InputResponse,
  InterruptRequest,
  InterruptResponse,
  MobileFence,
  MobileSessionMode,
  SnapshotHighWater,
  TimelineBlockKind,
  TimelineFrameKind,
} from '../contracts.js'

import type { ReducerInput } from '../types.js'

// ---------- TimelineFrameKind exhaustiveness ---------------------------------

describe('TimelineFrameKind', () => {
  it('includes all expected frame kinds', () => {
    const kinds: TimelineFrameKind[] = [
      'user_prompt',
      'assistant_message',
      'tool_call',
      'tool_result',
      'tool_batch',
      'patch_summary',
      'diff_summary',
      'turn_status',
      'session_status',
      'input_ack',
      'error',
    ]
    expect(kinds).toHaveLength(11)
    // Each kind is a valid TimelineFrameKind (compile-time check)
    for (const k of kinds) {
      expect(typeof k).toBe('string')
    }
  })

  it('rejects invalid frame kinds at compile time', () => {
    // This function exhaustively switches on TimelineFrameKind.
    // If a new kind is added to the union and not handled here,
    // TypeScript will report an error on the default branch.
    function assertExhaustive(kind: TimelineFrameKind): string {
      switch (kind) {
        case 'user_prompt':
          return 'user_prompt'
        case 'assistant_message':
          return 'assistant_message'
        case 'tool_call':
          return 'tool_call'
        case 'tool_result':
          return 'tool_result'
        case 'tool_batch':
          return 'tool_batch'
        case 'patch_summary':
          return 'patch_summary'
        case 'diff_summary':
          return 'diff_summary'
        case 'turn_status':
          return 'turn_status'
        case 'session_status':
          return 'session_status'
        case 'input_ack':
          return 'input_ack'
        case 'error':
          return 'error'
        default: {
          const _exhaustive: never = kind
          throw new Error(`Unhandled frame kind: ${_exhaustive}`)
        }
      }
    }

    expect(assertExhaustive('user_prompt')).toBe('user_prompt')
    expect(assertExhaustive('error')).toBe('error')
  })
})

// ---------- TimelineBlockKind exhaustiveness ---------------------------------

describe('TimelineBlockKind', () => {
  it('includes all expected block kinds', () => {
    const kinds: TimelineBlockKind[] = [
      'markdown',
      'mono',
      'tool_call',
      'tool_result',
      'command_ledger',
      'patch_summary',
      'diff_summary',
      'status',
      'raw_json',
    ]
    expect(kinds).toHaveLength(9)
  })

  it('rejects invalid block kinds at compile time', () => {
    function assertExhaustive(kind: TimelineBlockKind): string {
      switch (kind) {
        case 'markdown':
          return 'markdown'
        case 'mono':
          return 'mono'
        case 'tool_call':
          return 'tool_call'
        case 'tool_result':
          return 'tool_result'
        case 'command_ledger':
          return 'command_ledger'
        case 'patch_summary':
          return 'patch_summary'
        case 'diff_summary':
          return 'diff_summary'
        case 'status':
          return 'status'
        case 'raw_json':
          return 'raw_json'
        default: {
          const _exhaustive: never = kind
          throw new Error(`Unhandled block kind: ${_exhaustive}`)
        }
      }
    }

    expect(assertExhaustive('markdown')).toBe('markdown')
    expect(assertExhaustive('raw_json')).toBe('raw_json')
  })
})

// ---------- GatewayWsMessage discriminated union -----------------------------

describe('GatewayWsMessage', () => {
  it('discriminates on type field', () => {
    function handleMessage(msg: GatewayWsMessage): string {
      switch (msg.type) {
        case 'snapshot':
          return `snapshot:${msg.snapshotHighWater.hrcSeq}`
        case 'frame':
          return `frame:${msg.frame.frameId}`
        case 'hrc_event':
          return `hrc_event:${msg.hrcSeq}`
        case 'sessions_refreshed':
          return `refreshed:${msg.refreshedAt}`
        case 'session_updated':
          return `updated:${msg.session.sessionRef}`
        case 'error':
          return `error:${msg.code}`
        case 'ping':
          return 'ping'
        case 'pong':
          return 'pong'
        default: {
          const _exhaustive: never = msg
          throw new Error(`Unhandled message type: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    const ping: ControlMessage = { type: 'ping' }
    expect(handleMessage(ping)).toBe('ping')
  })
})

// ---------- MobileSessionMode ------------------------------------------------

describe('MobileSessionMode', () => {
  it('includes interactive and headless', () => {
    const modes: MobileSessionMode[] = ['interactive', 'headless']
    expect(modes).toHaveLength(2)
  })
})

// ---------- SnapshotHighWater ------------------------------------------------

describe('SnapshotHighWater', () => {
  it('has hrcSeq and messageSeq', () => {
    const hw: SnapshotHighWater = { hrcSeq: 100, messageSeq: 42 }
    expect(hw.hrcSeq).toBe(100)
    expect(hw.messageSeq).toBe(42)
  })
})

// ---------- HistoryPage ------------------------------------------------------

describe('HistoryPage', () => {
  it('has required cursor fields', () => {
    const page: HistoryPage = {
      frames: [],
      oldestCursor: { hrcSeq: 10, messageSeq: 1 },
      newestCursor: { hrcSeq: 100, messageSeq: 20 },
      hasMoreBefore: true,
    }
    expect(page.hasMoreBefore).toBe(true)
    expect(page.frames).toHaveLength(0)
  })
})

// ---------- InputRequest / InputResponse -------------------------------------

describe('InputRequest', () => {
  it('includes fences', () => {
    const req: InputRequest = {
      sessionRef: 'agent:cody:project:agent-spaces/lane:main',
      clientInputId: 'test-1',
      text: 'continue',
      enter: true,
      fences: {
        expectedHostSessionId: 'host-abc',
        expectedGeneration: 3,
      },
    }
    expect(req.fences.expectedHostSessionId).toBe('host-abc')
    expect(req.fences.expectedGeneration).toBe(3)
  })
})

describe('InputResponse', () => {
  it('discriminates success and failure', () => {
    const success: InputResponse = {
      ok: true,
      clientInputId: 'test-1',
      acceptedAt: '2026-04-29T00:00:00Z',
    }
    const failure: InputResponse = {
      ok: false,
      clientInputId: 'test-1',
      code: 'session_not_interactive',
      message: 'Session is headless',
    }
    expect(success.ok).toBe(true)
    expect(failure.ok).toBe(false)
  })
})

// ---------- InterruptRequest / InterruptResponse -----------------------------

describe('InterruptRequest', () => {
  it('includes fences', () => {
    const req: InterruptRequest = {
      sessionRef: 'agent:cody:project:agent-spaces/lane:main',
      clientInputId: 'int-1',
      fences: { expectedGeneration: 5 },
    }
    expect(req.fences.expectedGeneration).toBe(5)
  })
})

describe('InterruptResponse', () => {
  it('discriminates success and failure', () => {
    const success: InterruptResponse = { ok: true, clientInputId: 'int-1' }
    const failure: InterruptResponse = {
      ok: false,
      clientInputId: 'int-1',
      code: 'stale_context',
      message: 'Generation mismatch',
    }
    expect(success.ok).toBe(true)
    expect(failure.ok).toBe(false)
  })
})

// ---------- MobileFence ------------------------------------------------------

describe('MobileFence', () => {
  it('allows partial fences', () => {
    const empty: MobileFence = {}
    const hostOnly: MobileFence = { expectedHostSessionId: 'host-abc' }
    const genOnly: MobileFence = { expectedGeneration: 2 }
    const full: MobileFence = { expectedHostSessionId: 'host-abc', expectedGeneration: 2 }

    expect(empty).toEqual({})
    expect(hostOnly.expectedHostSessionId).toBe('host-abc')
    expect(genOnly.expectedGeneration).toBe(2)
    expect(full.expectedHostSessionId).toBe('host-abc')
  })
})

// ---------- ReducerInput -----------------------------------------------------

describe('ReducerInput', () => {
  it('discriminates event and message kinds', () => {
    function handle(input: ReducerInput): string {
      switch (input.kind) {
        case 'event':
          return `event:${input.event.eventKind}`
        case 'message':
          return `message:${input.message.messageId}`
        default: {
          const _exhaustive: never = input
          throw new Error(`Unhandled: ${JSON.stringify(_exhaustive)}`)
        }
      }
    }

    // We only need to validate the type shape compiles; runtime values
    // are synthetic since we don't import real HRC records here.
    expect(typeof handle).toBe('function')
  })
})

// ---------- Module exports ---------------------------------------------------

describe('module exports', () => {
  it('re-exports createGatewayIosModule', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.createGatewayIosModule).toBe('function')
  })

  it('re-exports resolveConfig', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.resolveConfig).toBe('function')
  })

  it('re-exports createLogger', async () => {
    const mod = await import('../index.js')
    expect(typeof mod.createLogger).toBe('function')
  })

  it('exports default constants', async () => {
    const mod = await import('../index.js')
    expect(mod.DEFAULT_HOST).toBe('127.0.0.1')
    expect(mod.DEFAULT_PORT).toBe(18480)
    expect(mod.DEFAULT_GATEWAY_ID).toBe('ios-local')
  })
})
