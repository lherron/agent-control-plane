"""Behaviour of the Python port of the injector's SQLite store.

Every test builds its own fixture database in a temporary directory; none
reads the live injector database or a scratch copy of it.
"""

import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from mail_delivery.store import (
    WRKQ_ENVELOPE_STREAM,
    iso_timestamp,
    normalize_target,
    open_store,
)

START = datetime(2026, 11, 10, 23, 42, 59, 576000, tzinfo=timezone.utc)
TARGET = 'agent:cody:project:agent-control-plane:primary/lane:main'


class TickingClock:
    """Each read is one millisecond later, so call counts are observable."""

    def __init__(self, start=START):
        self.now = start
        self.reads = 0

    def __call__(self):
        value = self.now
        self.now += timedelta(milliseconds=1)
        self.reads += 1
        return value


def stamp(ms):
    return iso_timestamp(START + timedelta(milliseconds=ms))


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / 'nested' / 'injector.sqlite'
        self.clock = TickingClock()
        self.store = open_store(self.path, clock=self.clock)
        self.mail = self.store.mail_delivery

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def raw(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def intent(self, envelope_id='EN-1', **changes):
        values = dict(envelope_id=envelope_id, target_session_ref=TARGET, door='enqueue',
                      form='full', presentation_id=f'present-{envelope_id}', submitted_hrc_seq=10)
        values.update(changes)
        return self.mail.open_intent(**values)

    def presentation(self, envelope_id='EN-1', runtime_id='rt-1', seq=100, **changes):
        values = dict(envelope_id=envelope_id, runtime_id=runtime_id, target_session_ref=TARGET,
                      presentation_id=f'present-{envelope_id}', delivery_outcome='accepted',
                      landing_hrc_seq=seq)
        values.update(changes)
        return self.mail.record_presentation(**values)


class Formatting(unittest.TestCase):
    def test_timestamps_have_javascript_iso_form(self):
        self.assertEqual(iso_timestamp(START), '2026-11-10T23:42:59.576Z')
        local = datetime(2026, 11, 10, 17, 42, 59, 576999, tzinfo=timezone(timedelta(hours=-6)))
        self.assertEqual(iso_timestamp(local), '2026-11-10T23:42:59.576Z')

    def test_normalize_target_trims_and_refuses_blank(self):
        self.assertEqual(normalize_target('  a:b  '), 'a:b')
        with self.assertRaisesRegex(ValueError, '^targetSessionRef must be a non-empty string$'):
            normalize_target(' \t ')


class Opening(StoreCase):
    def test_open_creates_parent_and_sets_pragmas(self):
        self.assertTrue(self.path.exists())
        db = self.raw()
        self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertEqual(tables, {
            'injector_store_imports', 'hrcmail_delivery_intents', 'hrcmail_presentations',
            'hrcmail_birth_refusals', 'hrcmail_delivery_expiries', 'hrcmail_failure_notices',
            'wrkq_ledger_cursors', 'hrcmail_drive_diagnostics', 'hrcmail_launch_failures'})
        columns = [row[1] for row in db.execute('PRAGMA table_info(hrcmail_launch_failures)')]
        self.assertEqual(columns[-1], 'participant_host_since_ms')
        db.close()
        conn = self.store.connection
        self.assertEqual(conn.execute('PRAGMA busy_timeout').fetchone()[0], 5000)
        self.assertEqual(conn.execute('PRAGMA foreign_keys').fetchone()[0], 1)

    def test_reopen_changes_nothing(self):
        self.intent()
        self.store.close()
        db = self.raw()
        before = list(db.execute('SELECT type, name, sql FROM sqlite_master ORDER BY name'))
        db.close()
        open_store(self.path, clock=self.clock).close()
        db = self.raw()
        after = list(db.execute('SELECT type, name, sql FROM sqlite_master ORDER BY name'))
        db.close()
        self.assertEqual([tuple(r) for r in before], [tuple(r) for r in after])
        self.store = open_store(self.path, clock=self.clock)

    def test_old_launch_failures_table_gains_column(self):
        self.store.close()
        path = Path(self.dir.name) / 'old.sqlite'
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE hrcmail_launch_failures (envelope_id TEXT PRIMARY KEY, '
                   'presentation_id TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT NOT NULL)')
        db.execute("INSERT INTO hrcmail_launch_failures VALUES ('EN-1', 'p', 2, 'boom')")
        db.commit()
        db.close()
        self.store = open_store(path, clock=self.clock)
        self.assertEqual(self.store.launch_failures.get('EN-1').attempts, 2)
        self.assertIsNone(self.store.launch_failures.get('EN-1').participant_host_since_ms)

    def test_connection_is_autocommit(self):
        self.intent()
        db = self.raw()
        self.assertEqual(db.execute('SELECT COUNT(*) FROM hrcmail_delivery_intents').fetchone()[0], 1)
        db.close()
        self.assertFalse(self.store.connection.in_transaction)


class Intents(StoreCase):
    def test_open_intent_first_write_then_repeat_is_refused(self):
        created = self.intent(target_session_ref=f'  {TARGET} ', runtime_id='rt-1', generation=2,
                              broker_after_seq=7)
        self.assertEqual(created.target_session_ref, TARGET)
        self.assertEqual(created.submitted_at, stamp(0))
        self.assertEqual(created.updated_at, stamp(0))
        self.assertIsNone(created.submission_id)
        self.assertEqual((created.runtime_id, created.generation, created.broker_after_seq),
                         ('rt-1', 2, 7))
        self.assertIsNone(self.intent(door='launch'))
        self.assertEqual(self.mail.get_intent('EN-1').door, 'enqueue')

    def test_open_intent_refusals(self):
        with self.assertRaisesRegex(ValueError, 'non-empty'):
            self.intent(target_session_ref='  ')
        self.assertEqual(self.clock.reads, 1)  # clock is read before normalisation
        # INSERT OR IGNORE also ignores CHECK violations: the TypeScript reports
        # an invalid door or generation exactly as it reports an open intent.
        self.assertIsNone(self.intent(door='walk'))
        self.assertIsNone(self.intent(generation=0))
        self.assertEqual(self.mail.list_open_intents(), [])

    def test_attach_admission_keeps_unpatched_fields(self):
        self.assertIsNone(self.mail.attach_admission('EN-missing', submission_id='s'))
        self.intent(runtime_id='rt-1', delivery_outcome='held')
        patched = self.mail.attach_admission('EN-1', submission_id='sub-1', generation=3)
        self.assertEqual((patched.door, patched.submission_id, patched.runtime_id,
                          patched.generation, patched.delivery_outcome),
                         ('enqueue', 'sub-1', 'rt-1', 3, 'held'))
        self.assertEqual(patched.updated_at, stamp(1))
        self.assertEqual(self.mail.get_intent_by_submission_id('sub-1').envelope_id, 'EN-1')
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'CHECK'):
            self.mail.attach_admission('EN-1', generation=0)

    def test_clear_intent_is_idempotent(self):
        self.intent()
        self.assertTrue(self.mail.clear_intent('EN-1'))
        self.assertFalse(self.mail.clear_intent('EN-1'))
        self.assertIsNone(self.mail.get_intent('EN-1'))

    def test_listing_order_and_filters(self):
        self.intent('EN-b')
        self.intent('EN-a', door='launch', runtime_id='rt-9')
        self.intent('EN-c', target_session_ref='agent:x/lane:main')
        self.assertEqual([i.envelope_id for i in self.mail.list_open_intents()], ['EN-b', 'EN-a', 'EN-c'])
        self.assertEqual([i.envelope_id for i in self.mail.list_open_intents(f' {TARGET}')], ['EN-b', 'EN-a'])
        with self.assertRaisesRegex(ValueError, 'non-empty'):
            self.mail.list_open_intents('')
        self.assertEqual([i.envelope_id for i in self.mail.list_launch_intents_for_runtime('rt-9')], ['EN-a'])
        self.mail.mark_terminal_envelope('EN-b', 'withdrawn')
        self.assertEqual([i.envelope_id for i in self.mail.list_active_open_intents()], ['EN-a', 'EN-c'])
        self.assertEqual(self.mail.list_intent_targets(), [TARGET, 'agent:x/lane:main'])
        self.assertEqual([i.envelope_id for i in self.mail.list_expired_intents(stamp(1))], ['EN-a'])

    def test_mark_uncertain_reads_clock_three_times_and_keeps_first_time(self):
        self.intent()
        first = self.mail.mark_uncertain('EN-1', 'ttl', 'broker')
        self.assertEqual((first.uncertain_cause, first.uncertain_at, first.last_evidence_kind,
                          first.last_evidence_at, first.updated_at),
                         ('ttl', stamp(1), 'broker', stamp(2), stamp(3)))
        second = self.mail.mark_uncertain('EN-1', 'again')
        self.assertEqual((second.uncertain_cause, second.uncertain_at, second.last_evidence_kind,
                          second.last_evidence_at), ('again', stamp(1), 'broker', stamp(5)))
        self.assertIsNone(self.mail.mark_uncertain('EN-none', 'x'))

    def test_terminal_and_cleanup_keep_first_values(self):
        self.intent()
        self.mail.mark_terminal_envelope('EN-1', 'acked')
        later = self.mail.mark_terminal_envelope('EN-1', 'failed')
        self.assertEqual((later.terminal_envelope_cause, later.terminal_envelope_at), ('failed', stamp(1)))
        self.mail.record_terminal_cleanup('EN-1', 'withdrawn')
        cleaned = self.mail.record_terminal_cleanup('EN-1', 'other')
        self.assertEqual((cleaned.cleanup_outcome, cleaned.cleanup_at, cleaned.updated_at),
                         ('withdrawn', stamp(3), stamp(4)))
        self.assertIsNone(self.mail.record_terminal_cleanup('EN-none', 'x'))


class Presentations(StoreCase):
    def test_later_landing_replaces_and_replay_changes_nothing(self):
        first = self.presentation(generation=1, input_id='in-1')
        self.assertTrue(first.recorded)
        self.assertTrue(self.mail.mark_receipt_committed('EN-1', 'rt-1'))
        self.mail.arm_reminder(envelope_id='EN-1', runtime_id='rt-1', turn_ended_at='t', remind_at='r')
        replay = self.presentation(seq=100, delivery_outcome='other')
        self.assertFalse(replay.recorded)
        self.assertEqual(replay.presentation.reminder_due_at, 'r')
        later = self.presentation(seq=101)
        self.assertTrue(later.recorded)
        fresh = later.presentation
        self.assertEqual((fresh.landing_hrc_seq, fresh.receipt_committed_at, fresh.reminder_due_at,
                          fresh.turn_ended_at, fresh.generation, fresh.input_id), (101, None, None, None, None, None))

    def test_record_presentation_refusal_rolls_back(self):
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'CHECK'):
            self.presentation(generation=0)
        with self.assertRaisesRegex(ValueError, 'non-empty'):
            self.presentation(target_session_ref=' ')
        self.assertFalse(self.store.connection.in_transaction)
        self.assertIsNone(self.mail.get_presentation('EN-1', 'rt-1'))

    def test_receipt_reminder_and_disposition(self):
        self.assertFalse(self.mail.mark_receipt_committed('EN-1', 'rt-1'))
        self.presentation()
        arm = dict(envelope_id='EN-1', runtime_id='rt-1', turn_ended_at=stamp(50), remind_at=stamp(60))
        self.assertFalse(self.mail.arm_reminder(**arm))  # receipt not committed yet
        self.mail.mark_receipt_committed('EN-1', 'rt-1')
        self.assertTrue(self.mail.arm_reminder(**arm))
        self.assertFalse(self.mail.arm_reminder(**arm))
        self.assertEqual(self.mail.list_due_reminders(TARGET, stamp(59)), [])
        self.assertEqual([p.envelope_id for p in self.mail.list_due_reminders(f' {TARGET}', stamp(60))], ['EN-1'])
        self.assertEqual(self.mail.list_due_reminder_targets(stamp(60)), [TARGET])
        self.assertTrue(self.mail.record_reminder_landing('EN-1', 'rt-1', 120))
        self.assertFalse(self.mail.record_reminder_landing('EN-1', 'rt-1', 121))
        self.assertFalse(self.mail.retire_reminder('EN-1', 'rt-1'))
        self.assertEqual(self.mail.list_undisposed_for_runtime('rt-1')[0].reminder_landing_hrc_seq, 120)
        self.assertTrue(self.mail.record_disposition('EN-1', 'rt-1', 'pre_migration_unknown'))
        self.assertFalse(self.mail.record_disposition('EN-1', 'rt-1', 'acked'))
        self.assertEqual(self.mail.count_pre_migration_unknown_presentations(), 1)
        self.assertEqual(self.mail.list_undisposed_presentations(), [])

    def test_retire_reminder(self):
        self.presentation()
        self.mail.mark_receipt_committed('EN-1', 'rt-1')
        self.mail.arm_reminder(envelope_id='EN-1', runtime_id='rt-1', turn_ended_at='t', remind_at='r')
        self.assertTrue(self.mail.retire_reminder('EN-1', 'rt-1'))
        self.assertFalse(self.mail.retire_reminder('EN-1', 'rt-1'))
        self.assertIsNone(self.mail.get_presentation('EN-1', 'rt-1').reminder_due_at)

    def test_presentation_listings(self):
        self.presentation('EN-1', 'rt-1')
        self.presentation('EN-2', 'rt-1', target_session_ref='agent:x')
        self.presentation('EN-1', 'rt-2')
        self.assertEqual([p.runtime_id for p in self.mail.presentations_for_envelope('EN-1')], ['rt-1', 'rt-2'])
        self.assertEqual([p.envelope_id for p in self.mail.presentations_for_runtime('rt-1')], ['EN-1', 'EN-2'])
        self.assertEqual([(p.envelope_id, p.runtime_id) for p in self.mail.presentations_for_target(TARGET)],
                         [('EN-1', 'rt-2'), ('EN-1', 'rt-1')])
        self.assertEqual(len(self.mail.presentations_for_target(TARGET, 1)), 1)
        self.assertEqual([(b.target_session_ref, b.runtime_id)
                          for b in self.mail.list_runtime_bound_targets(stamp(1))],
                         [(TARGET, 'rt-2'), ('agent:x', 'rt-1')])
        self.mail.mark_receipt_committed('EN-2', 'rt-1')
        self.assertEqual([p.envelope_id for p in self.mail.list_undisposed_presentations(5)], ['EN-2'])


class NonLanding(StoreCase):
    def test_strikes_count_per_runtime_and_clear_per_envelope(self):
        self.assertEqual(self.mail.non_landing_strikes('EN-1', 'rt-1'), 0)
        self.assertEqual(self.mail.record_non_landing_strike('EN-1', 'rt-1'), 1)
        self.assertEqual(self.mail.record_non_landing_strike('EN-1', 'rt-1'), 2)
        self.assertEqual(self.mail.record_non_landing_strike('EN-1', 'rt-2'), 1)
        db = self.raw()
        row = db.execute("SELECT * FROM hrcmail_delivery_expiries WHERE runtime_id = 'rt-1'").fetchone()
        self.assertEqual((row['first_expired_at'], row['last_expired_at']), (stamp(0), stamp(1)))
        db.close()
        self.assertIsNone(self.mail.clear_non_landing_strikes('EN-1'))
        self.assertEqual(self.mail.non_landing_strikes('EN-1', 'rt-1'), 0)

    def test_refusal_window_opens_once_and_closes(self):
        self.assertIsNone(self.mail.refusal_window_opened_at('EN-1', 'rt-1'))
        self.assertEqual(self.mail.open_refusal_window('EN-1', 'rt-1'), stamp(0))
        self.assertEqual(self.mail.open_refusal_window('EN-1', 'rt-1', 'later'), stamp(0))
        self.assertEqual(self.mail.non_landing_strikes('EN-1', 'rt-1'), 0)
        self.assertIsNone(self.mail.close_refusal_window('EN-1', 'rt-1'))
        self.assertIsNone(self.mail.refusal_window_opened_at('EN-1', 'rt-1'))
        self.assertEqual(self.mail.open_refusal_window('EN-1', 'rt-1', 'explicit'), 'explicit')
        self.assertEqual(self.clock.reads, 1)


class BirthRefusals(StoreCase):
    def test_record_counts_and_resolve(self):
        first = self.mail.record_birth_refusal(target_session_ref=f' {TARGET}', scope_ref='s', reason='r1')
        self.assertEqual((first.refusals, first.last_reason, first.created_at), (1, 'r1', stamp(0)))
        again = self.mail.record_birth_refusal(target_session_ref=TARGET, scope_ref='s2', reason='r2')
        self.assertEqual((again.refusals, again.scope_ref, again.created_at, again.updated_at),
                         (2, 's2', stamp(0), stamp(1)))
        self.assertEqual(self.mail.list_refused_birth_targets(), [TARGET])
        self.assertTrue(self.mail.resolve_birth_refusal(TARGET, 'born'))
        self.assertFalse(self.mail.resolve_birth_refusal(TARGET, 'born'))
        resolved = self.mail.get_birth_refusal(TARGET)
        self.assertEqual((resolved.resolved_at, resolved.updated_at, resolved.last_reason),
                         (stamp(2), stamp(3), 'born'))
        self.assertEqual(self.mail.list_refused_birth_targets(), [])
        reopened = self.mail.record_birth_refusal(target_session_ref=TARGET, scope_ref='s', reason='r3')
        self.assertEqual((reopened.refusals, reopened.resolved_at), (3, None))

    def test_resolve_reads_clock_before_refusing_blank_target(self):
        with self.assertRaisesRegex(ValueError, 'non-empty'):
            self.mail.resolve_birth_refusal(' ', 'x')
        self.assertEqual(self.clock.reads, 2)


class FailureNotices(StoreCase):
    def test_record_once_list_and_deliver(self):
        self.assertTrue(self.mail.record_failure_notice(envelope_id='EN-2', target_session_ref=TARGET, notice='n2'))
        self.assertFalse(self.mail.record_failure_notice(envelope_id='EN-2', target_session_ref=TARGET, notice='x'))
        self.mail.record_failure_notice(envelope_id='EN-1', target_session_ref=TARGET, notice='n1')
        self.mail.record_failure_notice(envelope_id='EN-1', target_session_ref='agent:y', notice='n1')
        self.assertEqual([n.envelope_id for n in self.mail.list_undelivered_failure_notices(TARGET)], ['EN-2', 'EN-1'])
        self.assertEqual(self.mail.list_failure_notice_targets(), [TARGET, 'agent:y'])
        self.assertIsNone(self.mail.mark_failure_notices_delivered(f' {TARGET} ', ['EN-2', 'EN-1', 'EN-x']))
        self.assertEqual(self.mail.list_failure_notice_targets(), ['agent:y'])
        self.assertEqual([n.delivered_at for n in self.mail.failure_notices_for_envelope('EN-1')],
                         [stamp(4), None])

    def test_empty_delivery_returns_before_normalising(self):
        self.assertIsNone(self.mail.mark_failure_notices_delivered('', []))
        self.assertEqual(self.clock.reads, 0)
        with self.assertRaisesRegex(ValueError, 'non-empty'):
            self.mail.mark_failure_notices_delivered('', ['EN-1'])
        self.assertEqual(self.clock.reads, 1)


class Cursors(StoreCase):
    def test_advance_never_moves_backwards(self):
        cursors = self.store.wrkq_ledger_cursors
        self.assertEqual(WRKQ_ENVELOPE_STREAM, 'envelope')
        self.assertIsNone(cursors.get())
        self.assertEqual(cursors.advance(7), 7)
        self.assertEqual(cursors.advance(3), 7)
        self.assertEqual(cursors.advance(9, 'other'), 9)
        self.assertEqual(cursors.get('envelope'), 7)
        db = self.raw()
        self.assertEqual(db.execute("SELECT updated_at FROM wrkq_ledger_cursors WHERE stream = 'envelope'").fetchone()[0], stamp(1))
        db.close()

    def test_advance_refuses_non_integers(self):
        cursors = self.store.wrkq_ledger_cursors
        for bad in (-1, 1.5, '3', True, None, 2 ** 53):
            with self.assertRaisesRegex(ValueError, '^wrkq ledger high water must be a non-negative integer$'):
                cursors.advance(bad)
        self.assertEqual(cursors.advance(4.0), 4)  # JavaScript has no integer/float split
        self.assertEqual(self.clock.reads, 1)


class Diagnostics(StoreCase):
    def test_record_upserts_latest_and_round_trips_json(self):
        diagnostics = self.store.drive_diagnostics
        probe = {'boundary': 'broker_probe', 'code': 'socket_closed', 'message': 'é closed',
                 'phase': 'seat_probe', 'retryable': None, 'transport': None, 'missing': False}
        base = dict(envelope_id='EN-1', drive_attempt_id='d1', target_session_ref=TARGET,
                    wake_reason='periodic', outcome='seat_unavailable', observed_seat_state=None,
                    runtime_id='rt-1', invocation_id=None, diagnostic=probe,
                    prior_drive_attempt_id=None, recovered_at=None)
        recorded = diagnostics.record(**base)
        self.assertEqual(recorded.created_at, stamp(0))
        self.assertEqual(diagnostics.latest('EN-1'), recorded)
        db = self.raw()
        self.assertEqual(db.execute('SELECT diagnostic_json FROM hrcmail_drive_diagnostics').fetchone()[0],
                         '{"boundary":"broker_probe","code":"socket_closed","message":"é closed",'
                         '"phase":"seat_probe","retryable":null,"transport":null,"missing":false}')
        db.close()
        diagnostics.record(**dict(base, drive_attempt_id='d2', diagnostic=None, prior_drive_attempt_id='d1'))
        latest = diagnostics.latest('EN-1')
        self.assertEqual((latest.drive_attempt_id, latest.diagnostic, latest.prior_drive_attempt_id),
                         ('d2', None, 'd1'))
        self.assertIsNone(diagnostics.latest('EN-none'))

    def test_corrupt_json_reads_as_absent(self):
        db = self.raw()
        for envelope, text in (('EN-a', '{bad'), ('EN-b', 'NaN'), ('EN-c', '[1,2]')):
            db.execute("INSERT INTO hrcmail_drive_diagnostics (envelope_id, drive_attempt_id, "
                       "target_session_ref, wake_reason, outcome, diagnostic_json, created_at) "
                       "VALUES (?, 'd', 't', 'w', 'o', ?, 'c')", (envelope, text))
        db.commit()
        db.close()
        self.assertIsNone(self.store.drive_diagnostics.latest('EN-a').diagnostic)
        self.assertIsNone(self.store.drive_diagnostics.latest('EN-b').diagnostic)
        self.assertEqual(self.store.drive_diagnostics.latest('EN-c').diagnostic, [1, 2])


class LaunchFailures(StoreCase):
    def test_attempts_count_per_presentation_and_participant_window(self):
        failures = self.store.launch_failures
        self.assertIsNone(failures.get('EN-1'))
        self.assertEqual(failures.record('EN-1', 'p1', 'e1'), 1)
        self.assertEqual(failures.record('EN-1', 'p1', 'e2'), 1)
        self.assertEqual(failures.record('EN-1', 'p2', 'e3', 1000), 2)
        self.assertEqual(failures.record('EN-1', 'p2', 'e4', 2000), 2)
        got = failures.get('EN-1')
        self.assertEqual((got.attempts, got.last_error, got.participant_host_since_ms), (2, 'e4', 1000))
        failures.record('EN-1', 'p2', 'e5')
        self.assertIsNone(failures.get('EN-1').participant_host_since_ms)
        self.assertEqual(self.clock.reads, 0)


if __name__ == '__main__':
    unittest.main()
