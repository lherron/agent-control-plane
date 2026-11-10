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
        self.assertEqual(report['rows'][0]['classification'], 'cannot_decide')
        self.assertEqual(report['counts']['cannot_decide'], 1)

    def test_each_bucket_splits_new_envelopes_from_backlog_by_utc_creation_day(self):
        new = self.observation()
        old = dict(new, envelope_id='EN-2', appeared_at='2026-10-01T12:00:00Z')
        report = self.run_state_score([new, old], [])
        self.assertEqual(report['counts_by_cohort']['new']['cannot_decide'], 1)
        self.assertEqual(report['counts_by_cohort']['backlog']['cannot_decide'], 1)
        self.assertEqual(report['gate_cohort'], 'new')

    def test_target_time_join_of_empty_drive_is_hold_and_retains_evidence(self):
        event = self.event('drive_completed', outcome='empty', driveAttemptId='drive-1')
        report = self.run_state_score([self.observation()], [event])
        row = report['rows'][0]
        self.assertEqual(row['classification'], 'cannot_decide')
        self.assertEqual(row['injector_log_evidence'], [event])
        self.assertEqual(row['matched_source'], 'injector_log')

    def test_state_boundary_and_target_window_are_enforced(self):
        old = self.event('drive_completed', at='2026-11-10T12:00:40Z', outcome='empty')
        late = self.event('drive_completed', at='2026-11-10T12:02:00Z', outcome='empty')
        report = self.run_state_score([self.observation()], [old, late])
        self.assertEqual(report['rows'][0]['classification'], 'cannot_decide')

    def test_envelope_membership_phase_join_and_presented_requires_reminder_door(self):
        phase = self.event('drive_phase', phase='pending_view', envelopeIds=['EN-1'], driveAttemptId='drive-1')
        full = self.event('delivery_intent', envelope='EN-1', door='steer', form='full', driveAttemptId='drive-1')
        report = self.run_state_score([self.observation('steer')], [phase, full])
        self.assertEqual(report['rows'][0]['classification'], 'differed_defect')
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

    def test_full_door_after_presented_log_is_defect_even_when_later_held(self):
        stale = self.observation('steer')
        stale.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z', runtime_id='rt-1')
        stale['decision']['form'] = 'full'
        later = dict(stale, decided_at='2026-11-10T12:01:03Z', decision=dict(action='hold', reason='intent_open'))
        presented = self.event('presented', at='2026-11-10T12:00:59Z', envelope='EN-1',
            runtimeId='rt-1', door='steer', form='full')
        report = self.run_state_score([stale, later], [presented])
        scored = report['rows'][0]
        self.assertEqual(scored['classification'], 'differed_defect')
        self.assertEqual(scored['classifying_observation']['decided_at'], stale['decided_at'])
        self.assertEqual(scored['classifying_observation']['cause'], 'stale_pending_after_delivery')

    def test_admission_and_refusal_phases_do_not_compare_with_later_fences(self):
        for reason, action, event in (
            ('intent_open', 'hold', self.event('drive_completed', outcome='deferred')),
            ('envelope_terminal', 'hold', self.event('delivery_admitted', envelope='EN-1', runtimeId='rt-1', door='steer')),
            ('birth_backoff', 'defer', self.event('delivery_intent', envelope='EN-1', runtimeId='rt-1', door='enqueue'))):
            with self.subTest(reason=reason):
                observation = self.observation(action)
                observation.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z')
                observation['decision']['reason'] = reason
                self.assertEqual(self.run_state_score([observation], [event])['rows'][0]['observation_scores'][0]['classification'], 'differed_defect' if reason == 'birth_backoff' else 'agreed_by_inaction')

    def test_first_delivery_comparison_and_gate_numbers_are_explicit(self):
        observed = self.observation()
        observed.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z', runtime_id='rt-1')
        observed['decision']['reason'] = 'intent_open'
        observed['first_delivery'] = dict(at='2026-11-10T12:00:01Z', runtime_id='rt-1', basis='reconstructed',
            decision=dict(action='steer', reason='steer_capable'), capability_source='port_probe', capability_differed=False)
        events = [self.event('delivery_intent', at='2026-11-10T12:00:01Z', envelope='EN-1', runtimeId='rt-1', door='steer'),
                  self.event('delivery_admitted', at='2026-11-10T12:00:02Z', envelope='EN-1', runtimeId='rt-1', door='steer')]
        report = self.run_state_score([observed], events)
        self.assertEqual(report['rows'][0]['first_delivery_comparison']['classification'], 'agreed')
        self.assertEqual(report['gate']['new_injector_delivered'], 1)
        self.assertEqual(report['gate']['new_compared_and_agreed'], 1)
        self.assertEqual(report['gate']['capability_sources'], {'port_probe': 1})

    def test_log_capability_fallback_is_labelled_and_derivation_disagreement_is_defect(self):
        observed = self.observation()
        observed.update(envelope_state='pending', runtime_id='rt-1')
        observed['decision']['reason'] = 'intent_open'
        observed['first_delivery'] = dict(at='2026-11-10T12:00:58Z', runtime_id='rt-1', basis='reconstructed',
            decision=dict(action='steer', reason='steer_capable'), capability_source='port_probe', capability_differed=True)
        events = [self.event('delivery_intent', at='2026-11-10T12:00:58Z', envelope='EN-1', runtimeId='rt-1', door='steer'),
                  self.event('delivery_admitted', envelope='EN-1', runtimeId='rt-1', door='steer')]
        report = self.run_state_score([observed], events)
        self.assertEqual(report['rows'][0]['classification'], 'differed_defect')
        self.assertEqual(report['rows'][0]['classifying_observation']['cause'], 'capability_derivation_differed')
        self.assertEqual(report['gate']['capability_differences'], ['EN-1'])

    def test_missing_historical_first_delivery_field_is_named_and_uncompared(self):
        observed = self.observation()
        observed.update(envelope_state='pending', runtime_id='rt-1')
        observed['decision']['reason'] = 'intent_open'
        events = [self.event('delivery_intent', at='2026-11-10T12:00:01Z', envelope='EN-1', runtimeId='rt-1', door='steer'),
                  self.event('delivery_admitted', at='2026-11-10T12:00:02Z', envelope='EN-1', runtimeId='rt-1', door='steer')]
        report = self.run_state_score([observed], events)
        self.assertEqual(report['rows'][0]['classification'], 'cannot_decide')
        self.assertEqual(report['gate']['new_uncompared'], 1)
        self.assertEqual(report['gate']['new_uncompared_share'], 1.0)
        self.assertEqual(report['rows'][0]['first_delivery_comparison']['missing_field'], 'first_delivery.snapshot_missing')

    def test_deleted_intent_diagnostic_gets_door_from_matched_log(self):
        import sqlite3
        c = sqlite3.connect(self.db)
        c.execute('DELETE FROM hrcmail_delivery_intents WHERE envelope_id=?', ('EN-1',))
        c.execute('INSERT INTO hrcmail_drive_diagnostics VALUES (?,?,?,?,?,?,?)',
            ('EN-1', 'target', 'insert', 'admitted', 'turn-active', 'rt-1', '2026-11-10T12:01:00Z'))
        c.commit(); c.close()
        observed = self.observation('steer')
        observed.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z')
        events = [self.event('delivery_intent', at='2026-11-10T12:00:58Z', envelope='EN-1', runtimeId='rt-1', door='steer'),
                  self.event('delivery_admitted', at='2026-11-10T12:00:59Z', envelope='EN-1', runtimeId='rt-1', door='steer')]
        scored = self.run_state_score([observed], events)['rows'][0]['observation_scores'][0]
        self.assertEqual(scored['injector_decision'], 'steer')
        self.assertEqual(scored['classification'], 'agreed')

    def test_future_presented_log_bounds_pending_phase_before_later_empty_drive(self):
        observed = self.observation('defer')
        observed.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z', runtime_id='rt-1')
        observed['decision']['reason'] = 'birth_backoff'
        events = [self.event('presented', at='2026-11-10T12:01:10Z', envelope='EN-1', runtimeId='rt-1'),
                  self.event('drive_completed', at='2026-11-10T12:01:15Z', outcome='empty')]
        scored = self.run_state_score([observed], events)['rows'][0]['observation_scores'][0]
        self.assertEqual(scored['classification'], 'agreed_by_inaction')

    def test_real_launch_decision_before_admission_is_compared_even_after_intent_opened(self):
        observed = self.observation('launch')
        observed.update(envelope_state='pending', envelope_state_at='2026-11-10T12:00:00Z')
        events = [self.event('delivery_intent', at='2026-11-10T12:00:59Z', envelope='EN-1', door='launch', presentationId='p-1'),
                  self.event('delivery_admitted', at='2026-11-10T12:01:01Z', envelope='EN-1', runtimeId='born', door='invoke'),
                  self.event('presented', at='2026-11-10T12:01:02Z', envelope='EN-1', runtimeId='born', door='invoke', presentationId='p-1')]
        first = self.run_state_score([observed], events)['rows'][0]['first_delivery_comparison']
        self.assertEqual(first['classification'], 'agreed')
        self.assertEqual(first['injector_decision'], 'launch')

    def test_closed_inaction_is_counted_separately_from_door_agreement(self):
        observed = self.observation('hold')
        report = self.run_state_score([observed], [])
        first_observation = report['rows'][0]['observation_scores'][0]
        self.assertEqual(first_observation['classification'], 'agreed_by_inaction')
        self.assertEqual(report['agreed_by_inaction_observations'], 1)

    def test_act_without_injector_act_is_defect_only_after_window_closes(self):
        observed = self.observation('steer')
        observed.update(envelope_state='pending')
        log = self.root/'shadow.jsonl'; log.write_text(json.dumps(observed)+'\n')
        injector = self.root/'injector.log'; injector.write_text('')
        open_window = score(log, self.db, '2026-11-10', until='2026-11-10T12:01:10Z', injector_log=injector)
        pending = open_window['rows'][0]['observation_scores'][0]
        self.assertEqual(pending['classification'], 'pending_evidence')
        self.assertEqual(pending['cause'], 'evidence_window_open')
        closed_window = score(log, self.db, '2026-11-10', until='2026-11-10T12:07:00Z', injector_log=injector)
        self.assertEqual(closed_window['rows'][0]['observation_scores'][0]['classification'], 'differed_defect')

    def test_later_retry_act_does_not_disagree_with_valid_backoff_interval(self):
        observed = self.observation('defer')
        observed.update(envelope_state='pending')
        observed['decision'].update(reason='birth_backoff', retry_at=1794312065000)
        events = [self.event('delivery_intent', at='2026-11-10T12:01:10Z', envelope='EN-1', runtimeId='rt-1', door='enqueue')]
        report = self.run_state_score([observed], events)
        self.assertEqual(report['rows'][0]['observation_scores'][0]['classification'], 'agreed_by_inaction')

    def test_act_keeps_full_evidence_window_across_next_observation(self):
        first = self.observation('steer')
        first.update(envelope_state='pending')
        later = dict(first, decided_at='2026-11-10T12:01:01Z', decision=dict(action='hold', reason='intent_open'))
        events = [self.event('delivery_intent', at='2026-11-10T12:01:02Z', envelope='EN-1', runtimeId='rt-1', door='steer')]
        scores = self.run_state_score([first, later], events)['rows'][0]['observation_scores']
        self.assertEqual(scores[0]['classification'], 'agreed')

    def test_completion_uses_drive_start_state_across_second_resolution_presentation(self):
        observed = self.observation('hold')
        observed.update(envelope_state_at='2026-11-10T12:01:00Z', decided_at='2026-11-10T12:01:01Z')
        observed['decision']['reason'] = 'awaiting_turn'
        events = [self.event('drive_phase', at='2026-11-10T12:00:59.500Z', phase='pending_view', envelopeIds=['EN-1'], driveAttemptId='d'),
                  self.event('presented', at='2026-11-10T12:01:00.200Z', envelope='EN-1', runtimeId='rt'),
                  self.event('drive_completed', at='2026-11-10T12:01:00.800Z', outcome='birth_deferred', driveAttemptId='d')]
        scored=self.run_state_score([observed],events)['rows'][0]['observation_scores'][0]
        self.assertEqual(scored['classification'],'agreed_by_inaction')

    def test_separate_first_delivery_event_scores_even_without_observed_open_mail(self):
        from mail_delivery.score import write_report
        from pathlib import Path
        observed=self.observation('steer')
        observed['first_delivery']=dict(basis='reconstructed',at='2026-11-10T12:00:58Z',runtime_id='rt-1',
            decision=dict(action='steer',reason='steer_capable'),capability_source='port_probe')
        observed['comparison_only']=True
        logrow=dict(event='shadow.first_delivery',ts=observed['decided_at'],data=observed)
        events=[self.event('delivery_intent',at='2026-11-10T12:00:58Z',envelope='EN-1',runtimeId='rt-1',door='steer'),
                self.event('delivery_admitted',at='2026-11-10T12:00:59Z',envelope='EN-1',runtimeId='rt-1',door='steer')]
        report=self.run_state_score([logrow],events)
        self.assertEqual(report['gate']['new_compared_and_agreed'],1)
        self.assertEqual(report['rows'][0]['classification'],'agreed')
        self.assertEqual(len(report['rows'][0]['observation_scores']),1)

    def test_observed_first_action_compares_with_same_state_intent_before_later_retry(self):
        observed=self.observation('steer')
        observed.update(envelope_state='pending',envelope_state_at='2026-11-10T12:00:00Z')
        events=[self.event('delivery_intent',at='2026-11-10T12:00:58Z',envelope='EN-1',runtimeId='rt-1',door='steer'),
                self.event('delivery_intent',at='2026-11-10T12:01:02Z',envelope='EN-1',runtimeId='rt-1',door='enqueue'),
                self.event('delivery_admitted',at='2026-11-10T12:01:03Z',envelope='EN-1',runtimeId='rt-1',door='enqueue')]
        first=self.run_state_score([observed],events)['rows'][0]['first_delivery_comparison']
        self.assertEqual(first['classification'],'agreed')
        self.assertEqual(first['injector_decision'],'steer')
