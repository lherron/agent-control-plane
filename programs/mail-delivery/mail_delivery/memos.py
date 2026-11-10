"""One memo reducer, fed by real outcomes or the injector comparison log.

No log text or runtime credentials are retained. Unknown events are ignored;
missing required outcome fields remain explicitly unknown at the adapter.
"""
import json
from copy import deepcopy
from pathlib import Path
from .score import epoch_ms
from . import timings as t


NOT_MOVEMENT = frozenset(('admission.requested', 'admission.admitted',
    'admission.rejected', 'input.rejected', 'submission.rejected', 'driver.notice'))


class Memos:
    def __init__(self):
        self.reset()

    def reset(self):
        from .evidence import DeliveryHistory
        self.deliveries = DeliveryHistory()
        self.anchored = False
        self.anchor = None
        self.fallback = {}
        self.intents = {}
        self.capability = set()
        self.backoff = {}
        self.quiet = {}
        self.birth = {}
        self.notices = {}
        self.provenance = set()

    def signature(self):
        return json.dumps((self.anchor, self.fallback, sorted(self.capability),
                           self.backoff, self.quiet, self.birth, self.notices,
                           sum(map(len, self.deliveries.admitted.values()))), sort_keys=True)

    def accept(self, row):
        event = row.get('event', '')
        if not isinstance(event, str):
            return
        if event == 'mail_injector.started':
            self.reset()
            self.anchored = True
            self.anchor = row['ts']
            return
        if not self.anchored:
            return
        data = row.get('data', {})
        if not isinstance(data, dict):
            return  # unknown/malformed event payloads are not outcome facts
        runtime = data.get('runtimeId') or self.intents.get(data.get('envelope'))
        target = data.get('targetSessionRef')
        envelope = data.get('envelope')
        at = epoch_ms(row['ts']) if row.get('ts') else None
        name = event.removeprefix('wrkq.kicker.')
        snapshot = None
        if name == 'delivery_intent':
            snapshot = deepcopy(dict(anchor=self.anchor, anchored=self.anchored,
                fallback={envelope: self.fallback[envelope]} if envelope in self.fallback else {},
                capability={runtime} if runtime in self.capability else set(),
                backoff={runtime: self.backoff[runtime]} if runtime in self.backoff else {},
                quiet={runtime: self.quiet[runtime]} if runtime in self.quiet else {},
                birth={target: self.birth[target]} if target in self.birth else {}))
        self.deliveries.accept(row, snapshot)
        if name == 'delivery_intent':
            self.intents[envelope] = runtime
            if data.get('door') == 'enqueue':
                self.fallback.pop(envelope, None)
        elif name == 'landing_refused':
            if data.get('door') == 'steer' and data.get('fallbackDoor') == 'enqueue':
                reason = data.get('reason')
                self.fallback[envelope] = (
                    'capability' if data.get('refusalClass') == 'permanent' or reason in ('steer_not_supported', 'unsupported:steer') else
                    'policy' if reason == 'guarded' else 'authority' if reason == 'authority-denied' else
                    'policy' if data.get('refusalClass') == 'not_written' else None)
                if self.fallback[envelope] == 'capability':
                    self.capability.add(runtime)
                self.backoff.pop(runtime, None)
            elif 'retryInMs' in data:
                # A digest logs one line per member for the SAME refusal.
                # The emitted delay carries the runtime's actual paced state;
                # counting member lines would spend it more than once.
                attempts = next((n for n in range(1, 6)
                                 if t.steer_retry_ms(n) == data['retryInMs']), None)
                self.backoff[runtime] = dict(at=at, delay=data['retryInMs'],
                    attempts=attempts)
            if data.get('reason') == 'pane_not_quiescent' and runtime not in self.quiet:
                self.quiet[runtime] = dict(since=at, invocation=None, seq=None)
            self.provenance.add('steer_refusal')
        elif name == 'steer_held' and data.get('hold') == 'pane_not_quiescent':
            # The hold can be announced after it was armed. If the arming
            # outcome is absent, since is unknown, never the announcement time.
            hold = self.quiet.setdefault(runtime, dict(since=None, invocation=None, seq=None))
            hold.update(invocation=data.get('invocationId'), seq=data.get('brokerSeq'))
        elif name == 'steer_hold_released':
            self.quiet.pop(runtime, None)
        elif name == 'presented':
            self.backoff.pop(runtime, None)
            self.quiet.pop(runtime, None)
        elif name in ('unborn_birth_retry', 'participant_host_retry', 'launch_birth_released'):
            kind = ('launch' if name == 'launch_birth_released' else
                    'participant_turn' if name == 'participant_host_retry' else 'sweep')
            if kind == 'sweep':
                attempts = data.get('attempt')
                delay = data.get('nextAttemptInMs')
                if isinstance(attempts, int) and 1 <= attempts <= t.BIRTH_SWEEP_MAX_REFUSALS:
                    if delay == t.BIRTH_SWEEP_NOT_HOSTED_BASE_MS * 2 ** (attempts - 1):
                        kind = 'not_hosted'
                    elif delay != t.BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** (attempts - 1):
                        kind = None
                else:
                    kind = None
            self.birth[target] = dict(kind=kind,
                attempts=data.get('attempts', data.get('attempt')), at=at,
                delay=data.get('nextAttemptInMs'), reason=data.get('participantHostRefusal'))
            self.provenance.add('birth_retry')
        elif name in ('foreign_home_skipped', 'birth_deferred'):
            self.birth.pop(target, None)
        elif name in ('failure_notice_failed', 'failure_notice_parked'):
            envelopes = data.get('envelopes')
            self.notices[target] = dict(envelopes=sorted(envelopes) if isinstance(envelopes, list) else None,
                attempts=data.get('attempts', data.get('attempt')), at=at,
                parked=runtime if data.get('reason') == 'replayed_non_start' else None,
                delay=data.get('nextAttemptInMs', 0 if name == 'failure_notice_parked' else None))
            self.provenance.add('failure_notice')
        elif name == 'failure_notice_delivered':
            self.notices.pop(target, None)

    def broker(self, runtime, row):
        hold = self.quiet.get(runtime)
        if hold is None or row.get('type') in NOT_MOVEMENT:
            return
        if hold['invocation'] is not None and hold['seq'] is not None:
            # observeSeatActivity needs invocation/sequence, not a timestamp.
            # A log-fed hold may lack its first-refusal clock; committed
            # movement past a known boundary still clears it exactly.
            if row.get('invocationId') != hold['invocation'] or row['seq'] > hold['seq']:
                self.quiet.pop(runtime, None)
            return
        at = epoch_ms(row['time']) if row.get('time') else None
        if hold['since'] is None or at is None:
            return
        if at > hold['since'] and (hold['seq'] is None or
                row.get('invocationId') != hold['invocation'] or row['seq'] > hold['seq']):
            self.quiet.pop(runtime, None)


class OwnOutcomeFeeder:
    """The future acting port feeds its outcomes into the same reducer."""
    def __init__(self, memos):
        self.memos = memos

    def accept(self, outcome):
        self.memos.accept(outcome)


class InjectorLogFeeder(OwnOutcomeFeeder):
    def __init__(self, path, memos):
        super().__init__(memos)
        self.path = Path(path)
        self.identity = None
        self.offset = 0

    def poll(self, alive=lambda: None):
        # Keep the same reducer across rotation; only a started event resets
        # the injector's process-local state. A cold start without an anchor
        # stays unknown, including when rotation discarded that anchor.
        with self.path.open('rb') as stream:
            stat = self.path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if identity != self.identity or stat.st_size < self.offset:
                self.offset = 0
                self.identity = identity
            stream.seek(self.offset)
            while True:
                alive()
                line = stream.readline()
                if not line or not line.endswith(b'\n'):
                    break  # leave a partial last line for the next poll
                self.offset = stream.tell()
                try:
                    row = json.loads(line)
                except (ValueError, UnicodeError):
                    continue
                if isinstance(row, dict):
                    self.accept(row)
