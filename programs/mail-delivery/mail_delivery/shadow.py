"""Read-only live observer. All state is disposable; watches re-list on reset."""
# Source replacement is owned by the kernel's stable-tree scanner.
from dataclasses import asdict
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import time
import traceback

from .decision import Decision, decide
from . import timings as t


# One wait loop: log outcomes are checked each second, reminders and broker
# evidence at most 30 seconds apart, recovery at the injector's 300 seconds.
SWEEP_SECONDS = t.REMINDER_CHECK_TICKS
TYPES = ('room.mail', 'seat', 'runtime')
OPEN = ('pending', 'presented', 'deferred')


class ContextClient:
    """Every program-owned log carries its host, including startup/errors."""
    def __init__(self, client, config):
        self.client = client
        self.socket = config['socket']
        self.pid = os.getpid()

    def __getattr__(self, name):
        return getattr(self.client, name)

    def log(self, event, **data):
        self.client.log(event, pid=self.pid, kernel_socket=self.socket, **data)


class View:
    def __init__(self):
        self.rows = {}
        self.ready = False

    def apply(self, change):
        if change.reset:
            self.rows = {row['id']: row for row in change.rows}
            self.ready = True
        else:
            for identifier in change.remove:
                self.rows.pop(identifier, None)
            for row in change.upsert:
                self.rows[row['id']] = row

    def payloads(self):
        return (row['payload'] for row in self.rows.values())


def stamp(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(
        timespec='milliseconds').replace('+00:00', 'Z')


def temporal_state(envelope, seat, now):
    """Only crossed policy deadlines change the dedup key, never clock ticks."""
    deadlines = []
    if envelope.created_at is not None:
        deadlines.append(envelope.created_at + t.BACKLOG_FYI_AGE_MS + 1)
    if envelope.retry_at is not None:
        deadlines.append(((envelope.retry_at + 999) // 1000 + 1) * 1000)
    if envelope.intent and envelope.intent.submitted_at is not None:
        deadlines.extend(envelope.intent.submitted_at + delay for delay in (
            t.STALLED_DELIVERY_THRESHOLD_MS, t.KICKER_SUBMISSION_TTL_MS))
    if envelope.presentation and envelope.presentation.remind_at is not None:
        deadlines.append(envelope.presentation.remind_at)
    if seat.quiet_since is not None:
        deadlines.append(seat.quiet_since + t.STEER_HOLD_MAX_MS)
    retry = envelope.birth_retry
    if retry and retry.last_at is not None and retry.attempts is not None:
        delay = (t.participant_host_retry_ms(retry.attempts) if retry.host_reason in t.PARTICIPANT_HOST_REASONS
                 else t.BIRTH_SWEEP_BACKOFF_BASE_MS * 2 ** max(retry.attempts - 1, 0))
        deadlines.append(retry.last_at + delay)
    if retry and retry.host_since is not None:
        deadlines.append(retry.host_since + t.PARTICIPANT_HOST_GIVE_UP_MS)
    refusal = envelope.steer_refusal
    if refusal and refusal.last_at is not None and refusal.attempts is not None:
        deadlines.append(refusal.last_at + t.steer_retry_ms(refusal.attempts))
    return [now >= deadline for deadline in deadlines]


class WatchHistory:
    """At most 20 payload changes per key, with separate source/receipt clocks."""
    def __init__(self, limit=20):
        self.limit = limit
        self.ready_at = {kind: None for kind in TYPES}
        self.rows = {kind: {} for kind in TYPES}

    def record(self, kind, payload, received_at):
        key = payload.get({'seat': 'scopeRef', 'runtime': 'runtimeId', 'room.mail': 'id'}[kind])
        if not key:
            return
        records = self.rows[kind].setdefault(key, [])
        if records and records[-1]['payload'] == payload:
            return
        field = next((f for f in ('statusChangedAt', 'updatedAt', 'lastActivityAt', 'createdAt') if payload.get(f)), None)
        from .port_inputs import ms
        records.append(dict(payload=deepcopy(payload), received_at=received_at,
                            changed_at=ms(payload[field]) if field else None, changed_field=field))
        del records[:-self.limit]

    def remove(self, kind, key, received_at):
        if key in self.rows[kind]:
            records = self.rows[kind][key]
            records.append(dict(payload=None, received_at=received_at, changed_at=received_at, changed_field='removed'))
            del records[:-self.limit]

    def as_of(self, kind, key, at):
        entry = next((r for r in reversed(self.rows[kind].get(key, []))
                     if r['received_at'] <= at and (r['changed_at'] is None or r['changed_at'] <= at)), None)
        return entry if entry and entry['payload'] is not None else None

    def latest(self, kind, key):
        return next((r for r in reversed(self.rows[kind].get(key, [])) if r['payload'] is not None), None)


class Shadow:
    def __init__(self, client, source, store):
        self.client = client
        self.source = source
        self.store = store
        self.views = {kind: View() for kind in TYPES}
        self.last = {}
        self.details = {}
        self.first_deliveries = {}
        self.history = WatchHistory()
        self.first_attempted = set()
        self.started_at = int(time.time() * 1000)
        self.recent_details = {}
        self.signals = {}
        self.refresh = set()

    def apply(self, kind, change, received_at=None):
        received_at = int(time.time() * 1000) if received_at is None else received_at
        incoming = change.rows if change.reset else change.upsert
        removed = (self.views[kind].rows.keys() - {r['id'] for r in incoming}) if change.reset else change.remove
        key_field = {'seat': 'scopeRef', 'runtime': 'runtimeId', 'room.mail': 'id'}[kind]
        for identifier in removed:
            old = self.views[kind].rows.get(identifier)
            if old and old['payload'].get(key_field):
                self.history.remove(kind, old['payload'][key_field], received_at)
        for row in incoming:
            self.history.record(kind, row['payload'], received_at)
        self.views[kind].apply(change)
        if change.reset:
            self.history.ready_at[kind] = received_at

    def read(self, op, **args):
        # Only expected owner availability/absence refusals become missing
        # data. Client, admission and protocol defects escape to the host.
        try:
            response = self.client.read(op, **args)
        except Exception as error:
            from praesidium_kernel import Refused
            if not isinstance(error, Refused) or error.code not in ('not_found', 'owner_unreachable', 'owner_timeout'):
                raise
            self.client.log('shadow.read_missing', operation=op, selector=args,
                            code=error.code)
            return {}
        result = response['result']
        return result.get('payload', result)

    def sweep(self, now, alive=lambda: None, force=False, clock=None, budget_seconds=None):
        if not all(view.ready for view in self.views.values()):
            return
        seats = {p['scopeRef']: p for p in self.views['seat'].payloads()}
        runtimes = {p['runtimeId']: p for p in self.views['runtime'].payloads()}
        # Scope-less human/interface mail is delivered by ACP's interface
        # gateways, outside hrc-mail-injector's agent-seat policy.
        mail_rows = [p for p in self.views['room.mail'].payloads()
                     if p.get('state') in OPEN and p.get('to', {}).get('scopeRef')]
        current = {mail['id'] for mail in mail_rows}
        if force:
            self.refresh.update(current)
        started = time.monotonic()
        self.source.begin()
        snapshots = None
        for mail in sorted(mail_rows, key=lambda p: p.get('createdAt', ''), reverse=True):
            if budget_seconds is not None and time.monotonic() - started >= budget_seconds:
                break
            alive()
            if mail.get('state') not in OPEN:
                continue
            identifier = mail['id']
            current.add(identifier)
            target = mail.get('to', {}).get('scopeRef')
            seat = seats.get(target, {})
            runtime = runtimes.get(seat.get('activeRuntimeId'), {})
            # Include policy-relevant summary changes, not activity timestamps,
            # token readings, latest tool previews or source revision churn.
            seat_state = {k: seat.get(k) for k in (
                'status', 'effectiveStatus', 'runtimeStatus', 'sessionStatus',
                'summaryStatus', 'activeRuntimeId', 'disposition')}
            seat_state['runtimeStatusObserved'] = runtime.get('status')
            signal = json.dumps((mail, seat_state), sort_keys=True)
            if identifier not in self.refresh and self.signals.get(identifier) == signal:
                continue
            try:
                if snapshots is None:
                    snapshots = self.store(mail_rows)
                cached = self.details.get(identifier)
                # A landed presentation clears its intent before the document
                # necessarily advances. That local transition invalidates a
                # cached pending owner row just like a watch state change.
                delivery_key = json.dumps((snapshots[identifier].get('intent'),
                                           snapshots[identifier].get('presentations')), sort_keys=True)
                detail_key = (mail.get('state'), mail.get('presentedAt'), mail.get('deferred'), delivery_key)
                if cached is None or cached[0] != detail_key:
                    # These details are missing from the document; read each only
                    # on the first observation of an envelope state transition.
                    detail = self.read('room.mail.get', envelope=identifier)
                    self.details[identifier] = (detail_key, detail)
                    self.recent_details[identifier] = (now, detail)
                else:
                    _, detail = cached
                envelope, observed, context, tags = self.source.gather(mail, detail, snapshots[identifier], now)
                decided_now = clock() if clock else now
                first_delivery = self.first_deliveries.get(identifier)
                reconstruct = getattr(self.source, 'first_delivery', None)
                if first_delivery is None and reconstruct and not hasattr(self.source, 'first_from_intent'):
                    first_delivery = reconstruct(mail, detail, snapshots[identifier], envelope, observed, context, decided_now)
                decision = decide(envelope, observed, context, decided_now)
                if first_delivery is None and envelope.state == 'pending' and decision.action in ('steer', 'enqueue', 'launch', 'preempt'):
                    first_delivery = dict(basis='observed', at=stamp(decided_now), runtime_id=context.id,
                        decision=asdict(decision), capability_source='port_probe' if observed.state in ('idle', 'turn-active') else 'not_needed',
                        port_capability=observed.steer_capable, capability_differed=False, missing_fields=[],
                        home_read_at=tags.get('home_read_at'), home_binding_changed_at=tags.get('home_binding_changed_at'))
                if first_delivery is not None:
                    self.first_deliveries[identifier] = first_delivery
                key = json.dumps((mail, seat_state, asdict(envelope), asdict(observed), asdict(context),
                                  temporal_state(envelope, observed, decided_now)), sort_keys=True)
                self.signals[identifier] = signal
                self.refresh.discard(identifier)
                if self.last.get(identifier) == key:
                    continue
                self.client.log('shadow.decision', envelope_id=identifier, target=target,
                    envelope_state=envelope.state, document_envelope_state=mail.get('state'),
                    observed_seat_state=observed.state,
                    envelope_state_at=detail.get('updatedAt') or mail.get('createdAt'),
                    seat_summary_state=seat.get('status'), runtime_id=context.id,
                    decision=asdict(decision), first_delivery=first_delivery, reason=decision.reason,
                    missing_fact=decision.missing_fact,
                    missing_fields=[decision.missing_fact] if decision.missing_fact else [],
                    appeared_at=mail.get('createdAt') or detail.get('createdAt'),
                    decided_at=stamp(decided_now), **tags)
                self.last[identifier] = key
            except Exception as error:
                # Match the injector's failed-drain boundary: one envelope
                # loses this observation, the process and next envelope run.
                # Retry on the next changed input or periodic sweep.
                self.signals[identifier] = signal
                self.refresh.discard(identifier)
                self.details.pop(identifier, None)
                self.client.log('shadow.decision_failed', envelope_id=identifier,
                    target=target, exception_type=type(error).__name__, message=str(error),
                    traceback=traceback.format_exc(), appeared_at=mail.get('createdAt'),
                    decided_at=stamp(clock() if clock else now))
        for identifier in self.last.keys() - current:
            self.last.pop(identifier, None)
            self.details.pop(identifier, None)
            self.signals.pop(identifier, None)
        self.refresh.intersection_update(current)


    def process_first_deliveries(self, now, alive=lambda: None):
        reconstruct = getattr(self.source, 'first_from_intent', None)
        memos = getattr(self.source, 'memos', None)
        if reconstruct is None or memos is None or not all(v.ready for v in self.views.values()):
            return
        from .score import epoch_ms
        started = time.monotonic()
        # Intent/admission evidence drives this independently of open mail.
        for identifier in list(memos.deliveries.intents):
            admission = memos.deliveries.first_admission(identifier)
            if not admission:
                continue
            key = (identifier, admission['at'])
            at = epoch_ms(admission['at'])
            if at < max(self.started_at, now-900000) or key in self.first_attempted:
                continue
            if time.monotonic()-started >= 2:
                break
            alive()
            target = admission['intent']['data'].get('targetSessionRef', '').removesuffix('/lane:main')
            mail = None
            try:
                record = self.history.latest('room.mail', identifier)
                mail = record['payload'] if record else None
                cached = self.recent_details.get(identifier)
                detail = cached[1] if cached else self.read('room.mail.get', envelope=identifier)
                if mail is None:
                    mail = detail
                if not mail or not mail.get('to', {}).get('scopeRef'):
                    continue  # scope-less interface mail is not an injector target
                # Owner envelope detail uses public handles; watches/HRC use
                # canonical scope refs. The intent carries the resolved target
                # identity the injector actually read, so no resolution/read is
                # needed and no caller identity changes.
                if target:
                    mail = dict(mail, to=dict(mail['to'], scopeRef=target))
                snapshot = self.first_deliveries.get(identifier)
                if snapshot is None or snapshot.get('basis') != 'observed':
                    store = self.store([mail])[identifier]
                    snapshot = reconstruct(mail, detail, store, admission, self.history, now)
                self.first_deliveries[identifier] = snapshot
                self.client.log('shadow.first_delivery', envelope_id=identifier, target=mail['to']['scopeRef'],
                    appeared_at=mail.get('createdAt') or detail.get('createdAt'), decided_at=stamp(now),
                    envelope_state='pending', envelope_state_at=mail.get('createdAt') or detail.get('createdAt'),
                    runtime_id=admission['runtime_id'], decision=snapshot['decision'], first_delivery=snapshot,
                    comparison_only=True, missing_fields=snapshot.get('missing_fields', []),
                    admission_processing_ms=now-epoch_ms(admission['admitted_at']))
            except Exception as error:
                self.client.log('shadow.decision_failed', envelope_id=identifier, target=target,
                    comparison_kind='first_delivery', exception_type=type(error).__name__, message=str(error),
                    traceback=traceback.format_exc(), appeared_at=mail.get('createdAt') if mail else None)
            self.first_attempted.add(key)
        self.recent_details = {k:v for k,v in self.recent_details.items() if now-v[0] <= 900000}
        self.first_deliveries = {k:v for k,v in self.first_deliveries.items() if now-epoch_ms(v['at']) <= 900000}
        self.first_attempted = {k for k in self.first_attempted if now-epoch_ms(k[1]) <= 900000}
        for kind, records in self.history.rows.items():
            active = {r.get({'seat': 'scopeRef', 'runtime': 'runtimeId', 'room.mail': 'id'}[kind]) for r in self.views[kind].payloads()}
            for key in list(records):
                if key not in active and now-records[key][-1]['received_at'] > 900000:
                    del records[key]


def main(program):
    from praesidium_kernel import Client
    from .hrc_read import HrcRead
    from .memos import Memos, InjectorLogFeeder
    from .port_inputs import PortInputs, store_batch
    client = ContextClient(Client(program), program.config)
    memos = Memos()
    root = Path.home() / 'praesidium/var'
    feeder = InjectorLogFeeder(root / 'logs/hrc-runtime/hrc-mail-injector.log', memos)
    source = PortInputs(HrcRead(), memos, alive=program.alive)
    shadow = Shadow(client, source, lambda rows: store_batch(root / 'state/acp/hrc-mail-injector.sqlite', rows))
    source.read_owner = shadow.read
    watches = {client.open_watch(kind): kind for kind in TYPES}
    client.log('shadow.started', sweep_seconds=SWEEP_SECONDS, recovery_seconds=t.LEDGER_SWEEP_TICKS)
    # A deadline also sweeps under continuous feed traffic. The client wait
    # timeout is the ordinary quiet-feed sweep and maintains program liveness.
    deadline = time.monotonic() + SWEEP_SECONDS
    while True:
        ready = client.wait(watches, timeout=min(1, max(0, deadline - time.monotonic())))
        if ready is not None:
            watch, change = ready
            shadow.apply(watches[watch], change)
        previous = memos.signature()
        feeder.poll(program.alive)
        periodic = time.monotonic() >= deadline
        shadow.sweep(int(time.time() * 1000), program.alive,
                     force=periodic or memos.signature() != previous,
                     clock=lambda: int(time.time() * 1000), budget_seconds=2)
        shadow.process_first_deliveries(int(time.time()*1000), program.alive)
        if periodic:
            deadline = time.monotonic() + SWEEP_SECONDS
