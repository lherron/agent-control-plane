"""State-aware injector log evidence for the comparison harness, not policy."""
from collections import defaultdict
import json
from pathlib import Path
from .score import epoch_ms, _door
from . import timings as t


DOORS = frozenset(('steer', 'enqueue', 'launch', 'preempt'))
EVENTS = frozenset(('drive_completed', 'drive_phase', 'delivery_intent',
    'delivery_admitted', 'presented', 'seat_not_ready', 'foreign_home_skipped', 'steer_held', 'steer_hold_released',
    'target_task_terminal', 'envelope_failed', 'obligation_held', 'reminder_armed'))


def target_ref(value):
    return value if not value or '/lane:' in value else value + '/lane:main'


class DeliveryHistory:
    """Explicit envelope/runtime joins, independent of mutable SQLite rows."""
    def __init__(self):
        self.intents = defaultdict(list)
        self.admitted = defaultdict(list)
        self.presented = defaultdict(list)

    def accept(self, row, memo=None):
        name = row.get('event', '').removeprefix('wrkq.kicker.')
        data = row.get('data', {})
        if name not in ('delivery_intent', 'delivery_admitted', 'presented'):
            return
        identifiers = [data['envelope']] if data.get('envelope') else data.get('envelopes', [])
        for identifier in identifiers:
            if name == 'delivery_intent':
                self.intents[identifier].append(dict(row=row, memo=memo))
            elif name == 'delivery_admitted':
                self.admitted[identifier].append(row)
            else:
                self.presented[identifier].append(row)

    def first_intent(self, identifier):
        records = self.intents.get(identifier, [])
        return min((r['row'] for r in records), key=lambda r: epoch_ms(r['ts']), default=None)

    def admissions(self, identifier):
        joined = []
        for admitted in self.admitted.get(identifier, []):
            data = admitted['data']
            runtime = data.get('runtimeId')
            if not runtime:
                continue  # an admission without runtime cannot prove the join
            for candidate in reversed(self.intents.get(identifier, [])):
                intent = candidate['row']
                source = intent['data']
                delay = epoch_ms(admitted['ts']) - epoch_ms(intent['ts'])
                if not 0 <= delay <= 300000 or _door(source.get('door')) != _door(data.get('door')):
                    continue
                proof = [intent, admitted]
                if source.get('runtimeId') != runtime:
                    # A cold launch has no runtime yet. Bind it through the
                    # SAME presentation identity, never a missing-ID wildcard.
                    birth = next((r for r in self.presented.get(identifier, [])
                        if source.get('door') == 'launch' and source.get('runtimeId') is None
                        and source.get('presentationId') and
                        r['data'].get('presentationId') == source['presentationId'] and
                        r['data'].get('runtimeId') == runtime), None)
                    if birth is None:
                        continue
                    proof.append(birth)
                joined.append(dict(door=_door(data.get('door')), runtime_id=runtime,
                    at=intent['ts'], admitted_at=admitted['ts'], intent=intent,
                    admitted=admitted, records=proof, memo=candidate['memo']))
                break
        return sorted(joined, key=lambda r: epoch_ms(r['admitted_at']))

    def first_admission(self, identifier):
        return next(iter(self.admissions(identifier)), None)

    def for_diagnostic(self, identifier, runtime, at):
        candidates = [r for r in self.admissions(identifier) if r['runtime_id'] == runtime
                      and abs(epoch_ms(r['admitted_at']) - epoch_ms(at)) <= 300000]
        return min(candidates, key=lambda r: abs(epoch_ms(r['admitted_at']) - epoch_ms(at)), default=None)

    def delivered_envelopes(self):
        return set(self.admitted) | set(self.presented)

    def landed_before(self, shadow):
        if (shadow.get('envelope_state') != 'pending' or shadow['decision'].get('form', 'full') != 'full'
                or shadow['decision']['action'] not in DOORS):
            return None
        begin = epoch_ms(shadow.get('envelope_state_at') or shadow['appeared_at'])
        end = epoch_ms(shadow['decided_at'])
        rows = [r for r in self.presented.get(shadow['envelope_id'], [])
                if begin <= epoch_ms(r['ts']) <= end and
                r['data'].get('runtimeId') == shadow.get('runtime_id')]
        return max(rows, key=lambda r: epoch_ms(r['ts']), default=None)


class InjectorEvidence:
    def __init__(self, path):
        self.deliveries = DeliveryHistory()
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
                self.deliveries.accept(row)
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
        if name in ('delivery_intent', 'delivery_admitted'):
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
        if state == 'pending':
            # The watch can miss a short presented state before an ack. Its
            # explicit receipt log still ends the preceding pending phase.
            transitions = [epoch_ms(r['ts']) for r in self.deliveries.presented.get(shadow['envelope_id'], [])
                           if epoch_ms(r['ts']) > decided]
            if transitions:
                end = min(end, min(transitions))
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
                          'awaiting_operator', 'reminder_pending', 'envelope_terminal',
                          'birth_backoff') and action in DOORS:
                continue  # an earlier admission is a different policy phase
            if reason == 'intent_open' and action not in (None, 'hold'):
                continue  # a later attempt/refusal is not the open-intent fence
            # Only decision-bearing phases count. A successful home/probe
            # phase is not an unmapped decision. An unknown completion is.
            if candidate['label'].endswith('presented') and action is None:
                continue
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
