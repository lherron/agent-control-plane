import tempfile
import unittest
from pathlib import Path
from mail_delivery.presentation_text import (
    format_envelope_presentation, format_backlog_digest,
    format_envelope_failure_notice, RecipientHints,
)

NOW = '2026-08-27T12:00:00Z'

def envelope(**changes):
    return dict(id='EN-00042', roomKey='T-07604', roomKind='task',
                **{'from': {'principalRef': 'agent:cody', 'scopeRef': 'cody@hrc-runtime:T-07604'}},
                to={'principalRef': 'agent:clod', 'scopeRef': 'clod@hrc-runtime:T-07604'},
                obligation='reply_required', body='the body', presentedTo=[],
                createdAt='2026-08-27T10:00:00Z') | changes


class PresentationTests(unittest.TestCase):
    def test_full(self):
        self.assertEqual(format_envelope_presentation(dict(envelope=envelope(), delivery='queue',
                         historyHint=True, messageCount=1, lastMessageAt='2026-08-27T10:00:00Z',
                         senderGeneration=3, hintStyle='prae'), NOW),
            "[T-07604 · 05:00A · cody@hrc-runtime:T-07604 (gen 3) → you · reply required]\n"
            "history: prae room history T-07604   (1 message · last 2h ago)\nthe body\n"
            "reply: prae room say EN-00042 --to cody@hrc-runtime:T-07604 - <<'EOF'\n…\nEOF")

    def test_reminder(self):
        self.assertEqual(format_envelope_presentation(dict(envelope=envelope(), form='reminder',
                         turnEndedAt='2026-08-27T11:56:00Z'), NOW),
            "[T-07604 · 05:00A · cody@hrc-runtime:T-07604 → you · reply required · still owed — your turn ended 4m ago without a reply]\n"
            "read: wrkc show EN-00042   ·   thread: wrkc log T-07604\n"
            "reply: wrkc say EN-00042 --to cody@hrc-runtime:T-07604 --as agent:clod - <<'EOF'\n…\nEOF")

    def test_defer_and_empty(self):
        self.assertEqual(format_envelope_presentation(dict(envelope=envelope(obligation='fyi',
                         deferReason=' wait ', retryAt='bad'), form='defer-retry', delivery='hold'), NOW),
            '[T-07604 · 05:00A · cody@hrc-runtime:T-07604 → you · preempt · you deferred this: "wait"]\n'
            'read: wrkc show EN-00042   ·   thread: wrkc log T-07604')
        self.assertEqual(format_envelope_presentation(dict(envelope=envelope(body='', obligation='notify',
                         createdAt='bad')), NOW), '[T-07604 · cody@hrc-runtime:T-07604 → you]\n')

    def test_digest(self):
        self.assertEqual(format_backlog_digest([envelope(body=' first\nsecond')], NOW),
            '[while you were away — 1 fyi, oldest 2h ago]\n'
            'EN-00042 · 05:00A · cody@hrc-runtime:T-07604 · 2h ago · first\n'
            'full text: wrkc show <EN-id>')

    def test_failure_tie(self):
        e = envelope(presentedTo=[dict(presentedAt='2026-08-27T11:58:59Z', runtimeId=r)
                                 for r in ['old', 'new']])
        self.assertEqual(format_envelope_failure_notice(e, 'runtime_terminated', dict(now=NOW, detail=' why ')),
            '[T-07604 · 05:00A · your EN-00042 → clod@hrc-runtime:T-07604 · failed: runtime_terminated]\n'
            'presented 61s, undisposed; runtime new ended. Resend: wrkc say T-07604 --to clod@hrc-runtime:T-07604 -\nWhy: why')

    def test_utf16_split(self):
        text = format_envelope_presentation(dict(envelope=envelope(body='x'*3999+'😀tail')), NOW)
        self.assertIn('x\ud83d…\n[body clipped at 4,000 of 4,005 chars', text)

    def test_hints_cache_and_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root, 'cody', 'agent-profile.toml')
            path.parent.mkdir()
            path.write_text('[spaces]\nbase=["spaces:path:./Prae Tools@custom"]\n')
            logs = []
            hints = RecipientHints(lambda *args: logs.append(args), lambda project=None: [root])
            self.assertEqual(hints.for_recipient('cody'), 'prae')
            self.assertEqual(hints.for_recipient('cody'), 'prae')
            self.assertEqual(len(logs), 1)
            path.write_text('[spaces]\nbase=[]\n')
            self.assertEqual(hints.for_recipient('cody'), 'legacy')
            self.assertEqual(hints.for_recipient('../bad'), 'legacy')
            self.assertEqual(logs[-1][2]['reason'], 'invalid recipient agent id')

    def test_chicago_daylight_saving_and_midnight(self):
        for at, clock in [('2026-11-01T06:59:00Z', '01:59A'),
                          ('2026-11-01T07:00:00Z', '01:00A'),
                          ('2026-03-08T08:00:00Z', '03:00A'),
                          ('2026-12-15T06:00:00Z', '12:00A'),
                          ('2026-12-15T18:00:00Z', '12:00P')]:
            self.assertIn(f' · {clock} · ', format_envelope_presentation(
                dict(envelope=envelope(createdAt=at)), NOW))

    def test_root_exception_is_fallback(self):
        def unavailable(project):
            raise RuntimeError('no root')
        logs = []
        hints = RecipientHints(lambda *args: logs.append(args), unavailable)
        self.assertEqual(hints.for_recipient('cody'), 'legacy')
        self.assertEqual(logs, [('WARN', 'wrkq.kicker.recipient_hint_fallback',
                                dict(agentId='cody', reason='no root'))])
