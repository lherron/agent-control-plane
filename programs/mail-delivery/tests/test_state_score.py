import json
from unittest import TestCase
from mail_delivery.score import score
from tests import test_score


class StateScoring(TestCase):
    setUp = test_score.Scoring.setUp
    row = test_score.Scoring.row

    def run_state_score(self, rows, events):
        log = self.root / 'shadow.jsonl'
        log.write_text(''.join(json.dumps(r)+'\n' for r in rows))
        injector = self.root / 'injector.log'
        injector.write_text(''.join(json.dumps(r)+'\n' for r in events))
        return score(log, self.db, '2026-11-10', injector_log=injector)

    def observation(self, action='hold'):
        r = self.row(1, action)
        r.update(target='agent:cody:project:acp:task:primary', envelope_state='presented',
                 envelope_state_at='2026-11-10T12:00:50Z', decided_at='2026-11-10T12:01:00Z')
        return r

    def event(self, name, at='2026-11-10T12:01:02Z', **data):
        return dict(event='wrkq.kicker.'+name, ts=at, data=dict(
            targetSessionRef='agent:cody:project:acp:task:primary/lane:main', **data))

    def test_old_admission_never_compares_with_current_hold(self):
        report = self.run_state_score([self.observation()], [])
        self.assertEqual(report['rows'][0]['classification'], 'pending_evidence')
        self.assertEqual(report['counts']['pending_evidence'], 1)

    def test_each_bucket_splits_new_envelopes_from_backlog_by_utc_creation_day(self):
        new = self.observation()
        old = dict(new, envelope_id='EN-2', appeared_at='2026-10-01T12:00:00Z')
        report = self.run_state_score([new, old], [])
        self.assertEqual(report['counts_by_cohort']['new']['pending_evidence'], 1)
        self.assertEqual(report['counts_by_cohort']['backlog']['pending_evidence'], 1)
        self.assertEqual(report['gate_cohort'], 'new')

    def test_target_time_join_of_empty_drive_is_hold_and_retains_evidence(self):
        event = self.event('drive_completed', outcome='empty', driveAttemptId='drive-1')
        report = self.run_state_score([self.observation()], [event])
        row = report['rows'][0]
        self.assertEqual(row['classification'], 'agreed')
        self.assertEqual(row['injector_log_evidence'], [event])
        self.assertEqual(row['matched_source'], 'injector_log')

    def test_state_boundary_and_target_window_are_enforced(self):
        old = self.event('drive_completed', at='2026-11-10T12:00:40Z', outcome='empty')
        late = self.event('drive_completed', at='2026-11-10T12:02:00Z', outcome='empty')
        report = self.run_state_score([self.observation()], [old, late])
        self.assertEqual(report['rows'][0]['classification'], 'pending_evidence')

    def test_envelope_membership_phase_join_and_presented_requires_reminder_door(self):
        phase = self.event('drive_phase', phase='pending_view', envelopeIds=['EN-1'], driveAttemptId='drive-1')
        full = self.event('delivery_intent', envelope='EN-1', door='steer', form='full', driveAttemptId='drive-1')
        report = self.run_state_score([self.observation('steer')], [phase, full])
        self.assertEqual(report['rows'][0]['classification'], 'pending_evidence')
        reminder = self.event('delivery_intent', envelope='EN-1', door='steer', form='reminder', driveAttemptId='drive-2')
        report = self.run_state_score([self.observation('steer')], [phase, reminder])
        self.assertEqual(report['rows'][0]['classification'], 'agreed')

    def test_cannot_decide_splits_port_input_gap_from_evidence_mapping_gap(self):
        missing = self.observation('cannot_decide')
        missing['decision']['missing_fact'] = 'seat.quiet_since'
        unknown = self.observation()
        unknown['envelope_id'] = 'EN-2'
        event = self.event('drive_completed', outcome='future_unknown')
        report = self.run_state_score([missing, unknown], [event])
        self.assertEqual(report['cannot_decide_counts'], dict(shadow_input_gap=1, injector_evidence_unmapped=1))
        self.assertEqual(report['port_defect_count'], 1)
