"""State-aware injector log evidence for the comparison harness, not policy."""
from collections import defaultdict
import json
from pathlib import Path
from .score import epoch_ms, _door
from . import timings as t


DOORS = frozenset(('steer', 'enqueue', 'launch', 'preempt'))
EVENTS = frozenset(('drive_completed', 'drive_phase', 'delivery_intent',
    'seat_not_ready', 'foreign_home_skipped', 'steer_held', 'steer_hold_released',
    'target_task_terminal', 'envelope_failed', 'obligation_held', 'reminder_armed'))


def target_ref(value):
    return value if not value or '/lane:' in value else value + '/lane:main'


class InjectorEvidence:
    def __init__(self, path):
        self.by_envelope = defaultdict(list)
        self.by_target = defaultdict(list)
        self.by_runtime = defaultdict(list)
        groups = defaultdict(list)
        if path is None:
            return
        with Path(path).open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                name = row.get('event', '').removeprefix('wrkq.kicker.')
                if name not in EVENTS:
                    continue
                data = row.get('data', {})
                # Phase and completion records for one drive carry envelope
                # membership in different lines. Retain the whole joined drive.
                drive = data.get('driveAttemptId')
                groups[('drive', drive) if drive else ('line', len(groups))].append(row)
        for records in groups.values():
            identifiers = set()
            for row in records:
                data = row.get('data', {})
                if data.get('envelope'):
                    identifiers.add(data['envelope'])
                identifiers.update(data.get('envelopeIds', []))
                identifiers.update(data.get('envelopes', []))
            for row in records:
                data = row.get('data', {})
                action = self.action(row)
                candidate = dict(at=row['ts'], action=action,
                    source='injector_log', label=row['event'], data=data,
                    records=records, explicit=bool(identifiers))
                # A completed multi-envelope drive says no per-envelope door;
                # its delivery_intent records do. Do not spread one member's
                # intent door to every other envelope in the same drive.
                own_ids = ({data['envelope']} if data.get('envelope') else identifiers)
                for identifier in own_ids:
                    self.by_envelope[identifier].append(candidate)
                if not identifiers and data.get('targetSessionRef'):
                    self.by_target[target_ref(data['targetSessionRef'])].append(candidate)
                if row['event'].endswith('steer_held') and data.get('runtimeId'):
                    self.by_runtime[data['runtimeId']].append(candidate)

    @staticmethod
    def action(row):
        name = row['event'].removeprefix('wrkq.kicker.')
        data = row.get('data', {})
        if name == 'delivery_intent':
            return _door(data.get('door'))
        if name in ('steer_held', 'obligation_held'):
            return 'hold'
        if name == 'foreign_home_skipped':
            return 'skip'
        if name == 'seat_not_ready':
            return 'defer'
        if name in ('target_task_terminal', 'envelope_failed'):
            return 'fail'
        if name == 'reminder_armed':
            return 'defer'
        if name == 'drive_phase':
            if data.get('phase') == 'home_resolution' and data.get('outcome') == 'skipped':
                return 'skip'
            return None
        if name == 'drive_completed':
            return {'empty': 'hold', 'skipped': 'skip', 'steer_held': 'hold',
                    'deferred': 'defer', 'birth_backoff': 'defer', 'birth-refused': 'defer',
                    'birth_deferred': 'defer', 'not_placeable_here': 'defer',
                    'target_task_terminal': 'fail', 'undeliverable': 'fail'}.get(data.get('outcome'))
        return None

    def match(self, shadow, db_candidates, state_until=None):
        state = shadow['envelope_state']
        begin_value = shadow.get('envelope_state_at')
        if not begin_value:
            # No state-transition time means we cannot prove same-state
            # comparison. Absence never authorizes matching an old row.
            return None
        begin = epoch_ms(begin_value)
        end = epoch_ms(state_until) if state_until else float('inf')
        decided = epoch_ms(shadow['decided_at'])
        reason = shadow['decision']['reason']
        candidates = list(self.by_envelope[shadow['envelope_id']])
        candidates += self.by_target[target_ref(shadow.get('target'))]
        candidates += self.by_runtime[shadow.get('runtime_id')]
        for at, action, source, label in db_candidates:
            candidates.append(dict(at=at, action=action, source=source, label=label,
                                   data={}, records=[], explicit=True))
        comparable = []
        for candidate in candidates:
            at = epoch_ms(candidate['at'])
            window = (t.LEDGER_SWEEP_TICKS if candidate['explicit'] else t.REMINDER_CHECK_TICKS) * 1000
            if not begin <= at < end or abs(at - decided) > window:
                continue
            action = candidate['action']
            data = candidate['data']
            if state == 'presented' and action in DOORS:
                if candidate['source'] != 'injector_log' or data.get('form') != 'reminder':
                    continue
            if state == 'deferred' and action in DOORS:
                continue
            if reason in ('intent_open', 'no_due_reminder', 'awaiting_turn',
                          'awaiting_operator', 'reminder_pending') and action in DOORS:
                continue  # an earlier admission is a different policy phase
            # Only decision-bearing phases count. A successful home/probe
            # phase is not an unmapped decision. An unknown completion is.
            if candidate['label'].endswith('drive_phase') and action is None:
                continue
            if candidate['label'].endswith('drive_completed') and data.get('outcome') == 'completed':
                continue
            comparable.append(candidate)
        if not comparable:
            return None
        return min(comparable, key=lambda c: (abs(epoch_ms(c['at']) - decided),
                                               c['action'] is None,
                                               c['source'] != 'injector_log'))
