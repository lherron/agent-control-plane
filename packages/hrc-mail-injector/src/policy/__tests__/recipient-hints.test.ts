import { describe, expect, it } from 'bun:test'
import { formatBacklogDigest, formatEnvelopePresentation } from '../ledger/presentation.js'
import type { PresentableEnvelope } from '../ledger/presentation.js'
import type { WrkqEnvelope } from '../ledger/types.js'

const now = new Date('2026-11-02T10:00:00Z')
const envelope: WrkqEnvelope = {
  uuid: 'uuid-EN-00042',
  id: 'EN-00042',
  roomUuid: 'room-1',
  roomKey: ['campaign', 'rev1'].join('/'),
  roomKind: 'campaign',
  from: { principalRef: 'agent:mable', scopeRef: 'mable@hrc-runtime:primary' },
  to: { principalRef: 'agent:cody', scopeRef: 'cody@agent-control-plane:T-12320' },
  obligation: 'reply_required',
  delivery: 'queue',
  body: 'First line\nSecond line',
  state: 'presented',
  terminal: false,
  presentedTo: [],
  createdAt: '2026-11-02T09:00:00Z',
  updatedAt: '2026-11-02T09:00:00Z',
}
const base: PresentableEnvelope = {
  envelope,
  delivery: 'queue',
  historyHint: true,
  messageCount: 4,
  lastMessageAt: '2026-11-02T09:00:00Z',
  senderGeneration: 3,
}

describe('recipient hints legacy golden captured before implementation', () => {
  for (const agent of ['cody', 'mable', 'unknown']) {
    for (const form of ['full', 'reminder', 'defer-retry'] as const) {
      for (const body of [envelope.body, 'x'.repeat(4001)]) {
        it(`${agent} ${form} ${body.length}`, () => {
          expect(
            formatEnvelopePresentation(
              {
                ...base,
                form,
                envelope: {
                  ...envelope,
                  body,
                  to: {
                    principalRef: `agent:${agent}`,
                    scopeRef: `${agent}@agent-control-plane:primary`,
                  },
                  deferReason: 'waiting',
                  retryAt: '2026-11-02T09:30:00Z',
                },
              },
              now
            )
          ).toMatchSnapshot()
        })
      }
    }
  }
  it('backlog digest', () => expect(formatBacklogDigest([envelope], now)).toMatchSnapshot())
})

describe('prae recipient hints', () => {
  it('renders the exact reply heredoc without the legacy identity flag', () => {
    expect(formatEnvelopePresentation({ ...base, hintStyle: 'prae' }, now)).toBe(
      [
        '[campaign/rev1 · 03:00A · mable@hrc-runtime:primary (gen 3) → you · reply required]',
        'history: prae room history campaign/rev1   (4 messages · last 1h ago)',
        'First line',
        'Second line',
        "reply: prae room say EN-00042 --to mable@hrc-runtime:primary - <<'EOF'",
        '…',
        'EOF',
      ].join('\n')
    )
  })
  it('uses prae reads for reminders, defer retries, clipped bodies and digests', () => {
    for (const form of ['reminder', 'defer-retry'] as const) {
      expect(formatEnvelopePresentation({ ...base, form, hintStyle: 'prae' }, now)).toContain(
        'read: prae room mail get EN-00042   ·   thread: prae room history campaign/rev1'
      )
    }
    expect(
      formatEnvelopePresentation(
        { ...base, hintStyle: 'prae', envelope: { ...envelope, body: 'x'.repeat(4001) } },
        now
      )
    ).toContain('full body: prae room mail get EN-00042]')
    expect(formatBacklogDigest([envelope], now, 'prae')).toContain(
      'full text: prae room mail get <EN-id>'
    )
  })
})
