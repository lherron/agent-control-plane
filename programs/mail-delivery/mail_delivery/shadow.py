"""Read-only live observer. All state is disposable; watches re-list on reset."""
# Source replacement is owned by the kernel's stable-tree scanner.
from dataclasses import asdict
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


class Shadow:
    def __init__(self, client, source, store):
        self.client = client
        self.source = source
        self.store = store
        self.views = {kind: View() for kind in TYPES}
        self.last = {}
        self.details = {}
        self.signals = {}
        self.refresh = set()

    def apply(self, kind, change):
        self.views[kind].apply(change)

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
                cached = self.details.get(identifier)
                detail_key = (mail.get('state'), mail.get('presentedAt'), mail.get('deferred'))
                if cached is None or cached[0] != detail_key:
                    # These details are missing from the document; read each only
                    # on the first observation of an envelope state transition.
                    detail = self.read('room.mail.get', envelope=identifier)
                    self.details[identifier] = (detail_key, detail)
                else:
                    _, detail = cached
                if snapshots is None:
                    snapshots = self.store(mail_rows)
                envelope, observed, context, tags = self.source.gather(mail, detail, snapshots[identifier], now)
                decided_now = clock() if clock else now
                key = json.dumps((mail, seat_state, asdict(envelope), asdict(observed), asdict(context),
                                  temporal_state(envelope, observed, decided_now)), sort_keys=True)
                self.signals[identifier] = signal
                self.refresh.discard(identifier)
                if self.last.get(identifier) == key:
                    continue
                decision = decide(envelope, observed, context, decided_now)
                self.client.log('shadow.decision', envelope_id=identifier, target=target,
                    envelope_state=envelope.state, document_envelope_state=mail.get('state'),
                    observed_seat_state=observed.state,
                    envelope_state_at=detail.get('updatedAt') or mail.get('createdAt'),
                    seat_summary_state=seat.get('status'), runtime_id=context.id,
                    decision=asdict(decision), reason=decision.reason,
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
        if periodic:
            deadline = time.monotonic() + SWEEP_SECONDS
