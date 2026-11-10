"""Scoring contract based on the real max3 table schema observed 2026-11-10.

Synthetic SQLite files only exercise scoring; acceptance also reads the live DB.
"""
import json
import sqlite3
import tempfile
from pathlib import Path
from unittest import TestCase
from mail_delivery.score import score, write_report, open_injector


class Scoring(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.db = self.root / 'injector.sqlite'
        c = sqlite3.connect(self.db)
        c.executescript('''
          CREATE TABLE hrcmail_delivery_intents (
            envelope_id TEXT PRIMARY KEY, door TEXT, runtime_id TEXT,
            generation INTEGER, delivery_outcome TEXT, submitted_at TEXT);
          CREATE TABLE hrcmail_drive_diagnostics (
            envelope_id TEXT PRIMARY KEY, target_session_ref TEXT, wake_reason TEXT,
            outcome TEXT, observed_seat_state TEXT, runtime_id TEXT, created_at TEXT);
        ''')
        for n in range(1, 7):
            c.execute('INSERT INTO hrcmail_delivery_intents VALUES (?, ?, ?, ?, ?, ?)',
                      (f'EN-{n}', 'steer', 'rt-1', 1, 'executed', '2026-11-10T12:00:02Z'))
        c.execute('INSERT INTO hrcmail_drive_diagnostics VALUES (?,?,?,?,?,?,?)',
                  ('EN-7', 'target', 'insert', 'seat_unavailable', 'unavailable', None,
                   '2026-11-10T12:00:02Z'))
        c.execute('INSERT INTO hrcmail_drive_diagnostics VALUES (?,?,?,?,?,?,?)',
                  ('EN-8', 'target', 'insert', 'future_unknown', None, None,
                   '2026-11-10T12:00:02Z'))
        c.commit()
        c.close()

    def row(self, n, action='steer', **kw):
        return dict(envelope_id=f'EN-{n}', appeared_at='2026-11-10T12:00:00Z',
                    decided_at='2026-11-10T12:00:01Z', decision={'action': action, 'reason': 'test'},
                    kernel_socket=str(Path.home()/'praesidium/var/run/praesidium/kernel.sock'), pid=999, **kw)

    def run_score(self, rows):
        log = self.root / 'shadow.jsonl'
        log.write_text(''.join(json.dumps(row)+'\n' for row in rows))
        return score(log, self.db, '2026-11-10')

    def test_five_classes_timing_and_real_rows_retained(self):
        rows = [self.row(1), self.row(2, 'enqueue', difference={'kind': 'design', 'reason': 'approved_change'}),
                self.row(3, 'enqueue', difference={'kind': 'missing_data', 'field': 'seat.steer_capable'}),
                self.row(4, 'enqueue'), self.row(5, 'cannot_decide')]
        rows[-1]['decision']['missing_fact'] = 'seat.state'
        report = self.run_score(rows)
        self.assertEqual([r['classification'] for r in report['rows']], [
            'agreed', 'differed_by_design', 'differed_missing_data', 'differed_defect', 'cannot_decide'])
        self.assertEqual(report['rows'][0]['shadow_latency_ms'], 1000)
        self.assertEqual(report['rows'][0]['injector_latency_ms'], 2000)
        self.assertEqual(report['rows'][0]['latency_delta_ms'], -1000)
        self.assertEqual(report['rows'][2]['missing_field'], 'seat.steer_capable')
        self.assertEqual(report['rows'][0]['injector_intent']['door'], 'steer')
        write_report(report, self.root / 'out')
        self.assertTrue((self.root / 'out/score-2026-11-10.md').is_file())
        self.assertEqual(json.loads((self.root / 'out/score-2026-11-10.json').read_text()), report)

    def test_kernel_log_wrap_daily_missing_inventory_and_early_injector_flag(self):
        observed = self.row(1)
        observed['decided_at'] = '2026-11-10T11:55:00Z'
        observed['appeared_at'] = '2026-11-10T11:54:59Z'
        observed['missing_fields'] = ['seat.home', 'envelope.intent']
        maintenance = dict(ts='2026-11-10T12:00:00Z', event='envelope.expired',
                           data={'actor': 'agent:mail-delivery', 'envelope_id': 'EN-9',
                                 'kernel_socket': observed['kernel_socket']})
        report = self.run_score([maintenance, dict(ts=observed['decided_at'],
                    event='shadow.decision', data=observed),
                    dict(ts=observed['decided_at'], event='shadow.started', data={})])
        self.assertEqual(report['envelopes'], 1)
        self.assertEqual(report['excluded_read_maintenance'], 1)
        self.assertEqual(report['missing_fields'], ['envelope.intent', 'seat.home'])
        self.assertTrue(report['rows'][0]['shadow_well_before_injector'])
        self.assertEqual(report['early_injector_count'], 1)
        md, _ = write_report(report, self.root / 'out')
        self.assertIn('seat.home', md.read_text())

    def test_first_hour_window_excludes_later_decisions(self):
        later = self.row(2)
        later['decided_at'] = '2026-11-10T13:00:00Z'
        log = self.root / 'shadow.jsonl'
        log.write_text('\n'.join(json.dumps(r) for r in [self.row(1), later]))
        report = score(log, self.db, '2026-11-10',
                       since='2026-11-10T12:00:00Z', until='2026-11-10T13:00:00Z')
        self.assertEqual(report['envelopes'], 1)

    def test_live_log_partial_final_line_is_left_for_next_run(self):
        log = self.root / 'shadow.jsonl'
        log.write_text(json.dumps(self.row(1))+'\n{"event":')
        self.assertEqual(score(log, self.db, '2026-11-10')['envelopes'], 1)

    def test_only_canonical_kernel_socket_can_contribute_a_score(self):
        good = self.row(1)
        stray = dict(self.row(2), kernel_socket='/tmp/test-kernel.sock')
        unstamped = self.row(3)
        unstamped.pop('kernel_socket')
        report = self.run_score([good, stray, unstamped])
        self.assertEqual(report['envelopes'], 1)
        self.assertEqual(report['excluded_kernel_sources'], 2)

    def test_read_only_connection_refuses_writes_and_missing_store(self):
        with open_injector(self.db) as c:
            with self.assertRaises(sqlite3.OperationalError):
                c.execute('CREATE TABLE should_never_exist (id TEXT)')
        with self.assertRaises(sqlite3.OperationalError):
            open_injector(self.root / 'missing.sqlite')
        self.assertFalse((self.root / 'missing.sqlite').exists())

    def test_diagnostics_and_unknown_are_not_guessed(self):
        report = self.run_score([self.row(7, 'defer'), self.row(8, 'steer'), self.row(9)])
        self.assertEqual(report['rows'][0]['classification'], 'agreed')
        self.assertEqual(report['rows'][1]['classification'], 'cannot_decide')
        self.assertEqual(report['rows'][1]['missing_field'], 'injector.outcome_mapping')
        self.assertEqual(report['rows'][2]['missing_field'], 'injector.evidence')
        self.assertEqual(report['unmapped_outcomes'], ['future_unknown'])

    def test_latest_per_envelope_within_utc_day(self):
        early = self.row(1, 'enqueue')
        early['decided_at'] = '2026-11-10T11:59:59Z'
        outside = self.row(2)
        outside['decided_at'] = '2026-11-11T00:00:00Z'
        report = self.run_score([early, self.row(1), outside])
        self.assertEqual(len(report['rows']), 1)
        self.assertEqual(report['rows'][0]['classification'], 'agreed')
        self.assertEqual(report['shadow_observations'], 2)
        self.assertEqual(len(report['rows'][0]['shadow_history']), 2)

    def test_design_and_missing_data_require_explanation(self):
        with self.assertRaisesRegex(ValueError, 'reason'):
            self.run_score([self.row(2, 'enqueue', difference={'kind': 'design'})])
        with self.assertRaisesRegex(ValueError, 'field'):
            self.run_score([self.row(2, 'enqueue', difference={'kind': 'missing_data'})])

    def test_admitted_is_ambiguous_without_same_runtime_intent(self):
        c = sqlite3.connect(self.db)
        c.execute('INSERT INTO hrcmail_drive_diagnostics VALUES (?,?,?,?,?,?,?)',
                  ('EN-6', 'target', 'insert', 'admitted', 'idle', 'rt-other', '2026-11-10T12:00:01Z'))
        c.commit()
        c.close()
        report = self.run_score([self.row(6)])
        self.assertEqual(report['rows'][0]['classification'], 'cannot_decide')
        self.assertIn('admitted', report['unmapped_outcomes'])
