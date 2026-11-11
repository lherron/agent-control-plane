"""The kicker's scheduler, process-local state and target-drive
serialization; translation of policy/controller.ts.

One asyncio loop. Every `(async () => ...)()` / `void promise` of the
TypeScript is a task started eagerly (`eager_start=True`, so its synchronous
prefix runs at the call as a JavaScript async function's does) and tracked, so
`stop()` can end it: the TypeScript abandons promises its bounded drain did not
settle; here the stop path cancels them once the drain bound is reached, so
nothing of this controller can write the store or call an owner after `stop()`.
"""
import asyncio
import time
import uuid
from .act_birth_retry import (charge_birth_sweep_refusal, fail_undeliverable_mail, next_birth_retry_at,
                              schedule_participant_host_retry, wake_due_birth_retries)
from .act_authority import kicker_scope_ref_for
from .act_deferred import next_deferred_wake_at, stop_deferred_wakes
from .act_disposal import dispose_runtime_obligations
from .act_envelope_terminal import fail_envelope_with_audit
from .act_failure_notices import deliver_failure_notices
from .act_hrc_facts import hrc_facts
from .act_internal import (DISPOSAL_DRAIN_DEADLINE_MS, LEDGER_SWEEP_TICKS, MAIL_DRIVE_TERMINAL_EVENTS,
                           MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES, REMINDER_CHECK_TICKS, RUNTIME_TERMINAL_EVENTS,
                           error_text, format_session_ref)
from .act_js import INFINITY, OrderedSet, date_parse, iso_from_ms
from .act_landing import commit_landing, observe_broker_landing
from .act_ledger_tail import run_wrkq_ledger_tail
from .act_quiet_targets import record_periodic_drive
from .act_reconcile import note_broker_evidence, outstanding_runtime_reads, reconcile_open_intents
from .act_runtime_lapse import fail_lapsed_obligations
from .act_runtime_status import is_runtime_terminal
from .act_sweep import run_mail_kicker_sweep
from .act_target_driver import drive_mail_target_once
from .presentation_text import RecipientHints

APP_SESSION_SCOPE_PREFIX = 'app:'


def parse_app_session_scope_ref(scope_ref):
    """hrc-core `parseAppSessionScopeRef`."""
    if not scope_ref.startswith(APP_SESSION_SCOPE_PREFIX):
        return None
    app_id = scope_ref[len(APP_SESSION_SCOPE_PREFIX):]
    return dict(appId=app_id) if len(app_id) > 0 else None


def _wall_now_ms():
    return time.time_ns() // 1_000_000


def _random_uuid():
    return str(uuid.uuid4())


class MailKicker:
    """Owns the kicker's scheduler, process-local state, and target-drive serialization."""

    def __init__(self, dependencies, options):
        self.dependencies = dependencies
        self.recipient_hints = RecipientHints(lambda level, event, detail: self.log(level, event, detail))
        self.store = dependencies['store']
        self.port = dependencies['port']
        self.ledger = dependencies['ledger']
        self.node_id = dependencies['node_id']
        self.foreign_home_memo = dependencies['foreign_home_memo']
        self.enabled = options['enabled']
        self.sweep_interval_ms = options['sweep_interval_ms']
        self._now_ms = dependencies.get('now_ms') or _wall_now_ms
        self._new_uuid = dependencies.get('new_uuid') or _random_uuid

        self.stopping = False
        self.mail_kicker_sweep_in_flight = None
        self.wrkq_ledger_tail_in_flight = None
        self.mail_kicker_deferral_wake_in_flight = None
        self.mail_kicker_cold_start_catchup_pending = False
        self.mail_kicker_pending_targets = {}
        self.mail_kicker_target_operations = {}
        self.mail_kicker_foreign_home_announced = {}
        self.mail_kicker_birth_deferred_announced = {}
        self.mail_kicker_birth_sweep_backoff = {}
        self.mail_kicker_failure_notice_backoff = {}
        self.mail_kicker_lapsed_runtimes = set()
        self.mail_kicker_disposals_pending = OrderedSet()
        self.landing_observer_operations = OrderedSet()
        self.active_target_drives = 0
        self.target_drive_waiters = []
        self.mail_kicker_boot_reconcile_pending = True
        self.mail_kicker_stalled_delivery_announced = set()
        self.mail_kicker_steer_refused = set()
        self.mail_kicker_steer_fallback = set()
        self.mail_kicker_delivery_backoff = {}
        self.mail_kicker_steer_hold = {}
        self.mail_kicker_quiet_targets = {}
        self.mail_kicker_reconcile_examined_at = {}
        self.mail_kicker_live_runtime_seen_at = {}
        self.ledger_loop = None
        self.ledger_stop = asyncio.Event()
        self.lifecycle_unsubscribe = None
        self.broker_unsubscribe = None
        # Every task this controller starts, so stop() can end the survivors.
        self.tasks = set()

    # ── injected clock and ids ─────────────────────────────────────────────
    def now_ms(self):
        return self._now_ms()

    def new_uuid(self):
        return self._new_uuid()

    def log(self, level, event, detail):
        self.dependencies['log'](level, event, detail)

    def spawn(self, coroutine):
        """`void (async () => ...)()`: start now, run to its first suspension, track it."""
        task = asyncio.get_running_loop().create_task(coroutine, eager_start=True)
        if not task.done():
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        return task

    async def start(self):
        if not self.enabled or self.ledger_loop is not None or self.stopping:
            return

        async def start_reconcile():
            try:
                await reconcile_open_intents(self, dict(reason='daemon_start'))
            except Exception as error:
                self.log('WARN', 'wrkq.kicker.start_reconcile_failed', dict(error=error_text(error)))
        self.spawn(start_reconcile())
        facts = hrc_facts(self)
        try:
            head = await self.port.events_head()
            hrc_seq, broker_commit = head['hrcSeq'], head['brokerCommit']

            def lifecycle_state(state):
                facts.lifecycle_stream_state(state)
                self.log('INFO', 'wrkq.kicker.lifecycle_stream', dict(state=state, epoch=facts.epoch))
            self.lifecycle_unsubscribe = await self.port.subscribe_lifecycle(dict(
                afterSeq=hrc_seq, onEvent=self.observe_lifecycle_event, onStreamState=lifecycle_state))
            facts.attach_lifecycle()

            def broker_state(state):
                facts.broker_stream_state(state)
                self.log('INFO', 'wrkq.kicker.broker_stream', dict(state=state, epoch=facts.epoch))
            self.broker_unsubscribe = await self.port.subscribe_broker(dict(
                afterCommit=broker_commit, onEvent=self.observe_broker_event, onStreamState=broker_state))
            facts.attach_broker()
        except Exception as error:
            self.log('WARN', 'wrkq.kicker.subscription_start_failed', dict(error=error_text(error)))
        self.ledger_loop = self.spawn(self.follow_ledger())

    async def follow_ledger(self):
        """Commit tokens are wake hints; only run_tail_once advances the durable cursor."""
        token = None
        next_sweep_at = self.now_ms() + LEDGER_SWEEP_TICKS * 1000
        reminder_retry_at = 0
        while not self.stopping:
            try:
                if token is None:
                    initial = await self.until_stopped(self.ledger.commit_wait(dict(timeoutMs=25000)))
                    if initial is None:
                        return
                    token = initial['token']
                await self.until_stopped(self.run_tail_once())
                if self.stopping:
                    return
                now = self.now_ms()
                if now >= reminder_retry_at:
                    due = self.store.mail_delivery.list_due_reminder_targets(iso_from_ms(now))
                    for target in due:
                        self.wake(target, 'periodic')
                    reminder_retry_at = now + REMINDER_CHECK_TICKS * 1000 if len(due) > 0 else 0
                wake_due_birth_retries(self, now)
                if now >= next_sweep_at:
                    await self.until_stopped(self.run_sweep_once())
                    next_sweep_at = self.now_ms() + LEDGER_SWEEP_TICKS * 1000
                if self.stopping:
                    return
                reminder_at = INFINITY
                for target in self.store.mail_delivery.list_due_reminder_targets('9999-12-31T23:59:59.999Z'):
                    for reminder in self.store.mail_delivery.list_due_reminders(target, '9999-12-31T23:59:59.999Z'):
                        if reminder.reminder_due_at is not None:
                            due_ms = date_parse(reminder.reminder_due_at)
                            if due_ms is not None:
                                reminder_at = min(reminder_at, max(due_ms, reminder_retry_at))
                timeout_ms = int(max(1000, min(25000, min(next_sweep_at, reminder_at, next_deferred_wake_at(self),
                                                          next_birth_retry_at(self)) - self.now_ms())))
                started = self.now_ms()
                result = await self.until_stopped(self.ledger.commit_wait(dict(since=token, timeoutMs=timeout_ms)))
                if result is None:
                    return
                token = result['token']
                changed = result['changed']
                if not changed and self.now_ms() - started < min(1000, timeout_ms):
                    await self.pause(self.sweep_interval_ms)
            except Exception as error:
                if self.stopping:
                    return
                self.log('WARN', 'wrkq.kicker.commit_follow_failed', dict(error=error_text(error)))
                token = None
                await self.pause(self.sweep_interval_ms)

    async def until_stopped(self, operation):
        if self.stopping:
            if asyncio.iscoroutine(operation):
                operation.close()
            return None
        # A JavaScript call starts its promise at once: start a coroutine eagerly.
        work = (asyncio.get_running_loop().create_task(operation, eager_start=True)
                if asyncio.iscoroutine(operation) else asyncio.ensure_future(operation))
        if not work.done():
            self.tasks.add(work)
            work.add_done_callback(self.tasks.discard)
        stop = asyncio.ensure_future(self.ledger_stop.wait())
        try:
            done, _ = await asyncio.wait([work, stop], return_when=asyncio.FIRST_COMPLETED)
            if work in done:
                return work.result()
            return None
        finally:
            stop.cancel()

    async def pause(self, ms):
        await self.until_stopped(asyncio.sleep(ms / 1000))

    async def stop(self):
        """Stop the controller. The store is closed by the caller after the HRC
        port is stopped and the wrkq client closed (start_mail_injector's stop)."""
        if self.stopping:
            return
        self.stopping = True
        self.ledger_stop.set()
        if self.ledger_loop is not None:
            await asyncio.wait([self.ledger_loop])
        hrc_facts(self).detach()
        stop_deferred_wakes(self)
        for waiter in self.target_drive_waiters[:]:
            if not waiter['future'].done():
                waiter['future'].set_result(False)
        self.target_drive_waiters.clear()
        if self.lifecycle_unsubscribe is not None:
            await self.lifecycle_unsubscribe()
        self.lifecycle_unsubscribe = None
        if self.broker_unsubscribe is not None:
            await self.broker_unsubscribe()
        self.broker_unsubscribe = None
        self.mail_kicker_pending_targets.clear()
        self.mail_kicker_quiet_targets.clear()
        # T-07963: a FIXED POINT, not one snapshot, DEADLINED.
        deadline = self.now_ms() + DISPOSAL_DRAIN_DEADLINE_MS
        while True:
            operations = [operation for operation in [
                self.mail_kicker_sweep_in_flight,
                self.wrkq_ledger_tail_in_flight,
                self.mail_kicker_deferral_wake_in_flight,
                *self.mail_kicker_target_operations.values(),
                *self.mail_kicker_disposals_pending,
                *self.landing_observer_operations,
            ] if operation is not None and not operation.done()]
            if len(operations) == 0:
                break
            remaining = deadline - self.now_ms()
            if remaining <= 0:
                break
            _, pending = await asyncio.wait(operations, timeout=remaining / 1000)
            if pending:
                break
        await self.cancel_survivors()

    async def cancel_survivors(self):
        """Past the drain bound, end every task this controller started. A task
        cancelled mid-act leaves its intent open for the next start's reconcile."""
        survivors = set(self.tasks)
        for operation in [self.mail_kicker_sweep_in_flight, self.wrkq_ledger_tail_in_flight,
                          self.mail_kicker_deferral_wake_in_flight, *self.mail_kicker_target_operations.values(),
                          *self.mail_kicker_disposals_pending, *self.landing_observer_operations]:
            if operation is not None:
                survivors.add(operation)
        survivors.update(hrc_facts(self).inflight.values())
        runtime_read = outstanding_runtime_reads.get(self)
        if runtime_read is not None:
            survivors.add(runtime_read['read'])
        current = asyncio.current_task()
        survivors = [task for task in survivors if task is not current and not task.done()]
        for task in survivors:
            task.cancel()
        if survivors:
            await asyncio.wait(survivors)

    def wake(self, target_session_ref, wake_reason):
        if not self.enabled or self.stopping:
            return
        self.mail_kicker_pending_targets[target_session_ref] = wake_reason

        async def drain():
            try:
                await self.drain_target(target_session_ref)
            except Exception as error:
                if self.stopping:
                    return
                self.log('WARN', 'wrkq.kicker.wake_failed', dict(
                    targetSessionRef=target_session_ref, wakeReason=wake_reason, error=error_text(error)))
        asyncio.get_running_loop().call_soon(lambda: self.spawn(drain()))

    def drain_target(self, target_session_ref):
        existing = self.mail_kicker_target_operations.get(target_session_ref)
        if existing is not None:
            return asyncio.shield(existing)

        async def operation_body():
            admitted = await self.acquire_target_drive_slot(target_session_ref)
            if not admitted:
                return
            try:
                while not self.stopping and self.enabled:
                    reason = self.mail_kicker_pending_targets.get(target_session_ref)
                    if reason is None:
                        return
                    self.mail_kicker_pending_targets.pop(target_session_ref, None)
                    result = await drive_mail_target_once(self, target_session_ref, reason)
                    if reason == 'periodic':
                        record_periodic_drive(self, target_session_ref, result)
                    if (reason == 'periodic' and result is not None and result.get('outcome') == 'birth-refused'
                            and result.get('launchRetry') is not True):
                        await charge_birth_sweep_refusal(self, target_session_ref, dict(
                            notPlaceableHere=result.get('notPlaceableHere') is True))
            finally:
                self.release_target_drive_slot()

        operation = self.spawn(operation_body())

        def finished(_task):
            if self.mail_kicker_target_operations.get(target_session_ref) is operation:
                self.mail_kicker_target_operations.pop(target_session_ref, None)
            if target_session_ref in self.mail_kicker_pending_targets and not self.stopping:
                async def rekick():
                    try:
                        await self.drain_target(target_session_ref)
                    except Exception as error:
                        self.log('WARN', 'wrkq.kicker.rekick_failed', dict(
                            targetSessionRef=target_session_ref, error=error_text(error)))
                asyncio.get_running_loop().call_soon(lambda: self.spawn(rekick()))
        operation.add_done_callback(finished)
        self.mail_kicker_target_operations[target_session_ref] = operation
        return asyncio.shield(operation)

    async def acquire_target_drive_slot(self, target_session_ref):
        if self.stopping or not self.enabled:
            return False
        if self.active_target_drives < MAIL_KICKER_MAX_CONCURRENT_TARGET_DRIVES:
            self.active_target_drives += 1
            return True
        future = asyncio.get_running_loop().create_future()
        self.target_drive_waiters.append(dict(targetSessionRef=target_session_ref, future=future))
        return await future

    def release_target_drive_slot(self):
        self.active_target_drives -= 1
        while len(self.target_drive_waiters) > 0:
            priority_index = next((index for index, waiter in enumerate(self.target_drive_waiters)
                                   if self.mail_kicker_pending_targets.get(waiter['targetSessionRef']) != 'periodic'),
                                  -1)
            waiter = self.target_drive_waiters.pop(0 if priority_index < 0 else priority_index)
            if waiter['future'].done():
                continue  # its drive was cancelled while it waited
            if self.stopping or not self.enabled:
                waiter['future'].set_result(False)
                continue
            self.active_target_drives += 1
            waiter['future'].set_result(True)
            return

    def run_sweep_once(self):
        return run_mail_kicker_sweep(self)

    def run_tail_once(self):
        return run_wrkq_ledger_tail(self)

    def observe_lifecycle_event(self, event):
        if self.stopping:
            return
        hrc_facts(self).observe(event)
        observe_mail_drive_lifecycle_event(self, event)

    def observe_broker_event(self, record):
        if self.stopping:
            return
        note_broker_evidence(self, record)

        async def observe():
            try:
                await observe_broker_landing(self, record)
            except Exception as error:
                self.log('WARN', 'wrkq.kicker.landing_observer_failed', dict(
                    invocationId=record.get('invocationId'), runtimeId=record.get('runtimeId'),
                    brokerEventType=record.get('type'), error=error_text(error)))
        operation = self.spawn(observe())
        if not operation.done():
            self.landing_observer_operations.add(operation)
            operation.add_done_callback(self.landing_observer_operations.discard)

    # ── context operations the drive calls (TS imports these as functions) ──
    async def fail_envelope_with_audit(self, input):
        return await fail_envelope_with_audit(self, input)

    async def deliver_failure_notices(self, target_session_ref, seat_session):
        return await deliver_failure_notices(self, target_session_ref, seat_session)

    async def fail_undeliverable_mail(self, target_session_ref, options):
        return await fail_undeliverable_mail(self, target_session_ref, options)

    def schedule_participant_host_retry(self, target_session_ref, reason):
        schedule_participant_host_retry(self, target_session_ref, reason)


def observe_mail_drive_lifecycle_event(server, event):
    """The lifecycle seam, and the whole of D3's trigger. NO `runId` guard."""
    runtime_id = event.get('runtimeId')
    if event['eventKind'] == 'turn.started':
        if runtime_id is None:
            return
        intents = server.store.mail_delivery.list_launch_intents_for_runtime(runtime_id)
        for intent in intents:
            async def land(intent=intent):
                try:
                    await commit_landing(server, intent, dict(
                        runtimeId=runtime_id, eventType='turn.started', landingHrcSeq=event['hrcSeq']))
                except Exception as error:
                    server.log('WARN', 'wrkq.kicker.launch_landing_failed', dict(
                        targetSessionRef=intent.target_session_ref, envelope=intent.envelope_id,
                        runtimeId=runtime_id, error=error_text(error)))
            server.spawn(land())
        return
    if event['eventKind'] == 'turn.failed':
        record_delivery_broker_start_refusal(server, event)
    if event['eventKind'] in RUNTIME_TERMINAL_EVENTS:
        if runtime_id is None or runtime_id in server.mail_kicker_lapsed_runtimes:
            return
        target_session_ref = format_session_ref(event['scopeRef'], event['laneRef'])

        async def lapse():
            try:
                runtime = await server.port.runtime(runtime_id)
                if runtime is None or not is_runtime_terminal(runtime['status']):
                    return
                await reconcile_open_intents(server, dict(runtimeIds={runtime_id}, reason='runtime_terminated'))
                if parse_app_session_scope_ref(event['scopeRef']) is not None:
                    return
                if await fail_lapsed_obligations(server, target_session_ref, {runtime_id}):
                    server.mail_kicker_lapsed_runtimes.add(runtime_id)
            except Exception as error:
                server.log('WARN', 'wrkq.kicker.terminal_lapse_failed', dict(
                    targetSessionRef=target_session_ref, runtimeId=runtime_id, error=error_text(error)))
        server.spawn(lapse())
        return
    if event['eventKind'] not in MAIL_DRIVE_TERMINAL_EVENTS:
        return
    target_session_ref = format_session_ref(event['scopeRef'], event['laneRef'])
    if runtime_id is not None:
        dispose_runtime_obligations(server, dict(
            runtimeId=runtime_id, targetSessionRef=target_session_ref, terminalHrcSeq=event['hrcSeq'],
            terminalEventKind=event['eventKind'], turnEndedAt=event['ts']))
    if parse_app_session_scope_ref(event['scopeRef']) is not None:
        return
    server.wake(target_session_ref, 'turn_completion')


def record_delivery_broker_start_refusal(server, event):
    """T-08139 — preserve a wake source when a delivery-triggered broker birth dies."""
    if event['eventKind'] != 'turn.failed':
        return
    payload = event.get('payload') if isinstance(event.get('payload'), dict) else None
    if payload is None or payload.get('phase') != 'broker-invocation-start':
        return
    target_session_ref = format_session_ref(event['scopeRef'], event['laneRef'])
    candidates = [candidate for candidate in server.store.mail_delivery.list_open_intents(target_session_ref)
                  if candidate.submitted_hrc_seq <= event['hrcSeq']]
    intent = candidates[-1] if candidates else None
    scope_ref = kicker_scope_ref_for(target_session_ref)
    if intent is None or scope_ref is None:
        return
    failure = (payload['message'] if isinstance(payload.get('message'), str) else
               payload['code'] if isinstance(payload.get('code'), str) else 'broker start failed')
    reason = f'{intent.envelope_id}: broker-invocation-start: {failure}'
    server.store.mail_delivery.record_birth_refusal(target_session_ref=target_session_ref, scope_ref=scope_ref,
                                                    reason=reason)
    server.log('WARN', 'wrkq.kicker.delivery_birth_refused', dict(
        targetSessionRef=target_session_ref, envelope=intent.envelope_id,
        **({} if event.get('runtimeId') is None else {'runtimeId': event['runtimeId']}),
        reason='broker-invocation-start', error=failure, hrcSeq=event['hrcSeq']))


def create_mail_kicker(dependencies, options):
    return MailKicker(dependencies, options)
