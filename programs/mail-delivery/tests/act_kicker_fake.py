"""The T-08094 harness (policy/__tests__/t08094-harness.ts and
fake-injection-facts.ts) over the real `MailKicker`.

One session, one runtime, a fake wrkq ledger and HRC port whose every seam is
an instance attribute a test may replace, as the TypeScript tests reassign
`context.port.x`. The context is a real `MailKicker`; like the TypeScript
harness context, `wake` only records and `drain_target` does nothing unless a
test replaces them. The clock is injected and moves with real time from a fixed
base, so `advance(ms)` stands in for `setSystemTime`.
"""
import asyncio
import copy
import json
import tempfile
import time
from datetime import datetime, timezone

from mail_delivery.act_controller import MailKicker
from mail_delivery.act_hrc_port import TERMINAL_RUNTIME_STATUSES
from mail_delivery.act_js import iso_from_ms
from mail_delivery.store import open_store

SCOPE_REF = 'agent:clod:project:hrc-runtime:task:T-08094'
TARGET_REF = SCOPE_REF + '/lane:main'
RUNTIME_ID = 'rt-t08094'
HOST_SESSION_ID = 'hsid-t08094'
BASE_MS = 1794355200000

DISPOSITION_TYPES = ('submission.absorbed', 'submission.executed', 'submission.rejected', 'submission.expired',
                     'submission.withdrawn', 'submission.cancelled', 'submission.lost')


class FakeInjectionFacts:
    """Test-owned facts behind the fake HRC port; no HRC database or writer."""

    def __init__(self):
        self.sessions = {}
        self.runtimes = {}
        self.invocations = {}
        self.events = []
        self.bindings = {}

    def insert_session(self, record):
        self.sessions[record['hostSessionId']] = copy.deepcopy(record)

    def insert_runtime(self, record):
        self.runtimes[record['runtimeId']] = copy.deepcopy(record)

    def get_runtime(self, runtime_id):
        return copy.deepcopy(self.runtimes.get(runtime_id))

    def update_runtime(self, runtime_id, **patch):
        self.runtimes[runtime_id].update(patch)

    def list_runtimes(self):
        return copy.deepcopy(list(self.runtimes.values()))

    def runtimes_by_host_session(self, host_session_id):
        return sorted((row for row in self.list_runtimes() if row['hostSessionId'] == host_session_id),
                      key=lambda row: (row['createdAt'], row['runtimeId']))

    def live_session_refs(self):
        return sorted(set(f"{row['scopeRef']}/lane:{row['laneRef']}" for row in self.list_runtimes()
                          if row['scopeRef'].startswith('agent:')
                          and row['status'] in ('starting', 'ready', 'busy', 'awaiting_input', 'stopping')))

    def append_event(self, row):
        prior = next((item for item in self.events
                      if item['invocationId'] == row['invocationId'] and item['seq'] == row['seq']), None)
        if prior is not None:
            if prior['payload'] != row['payload']:
                raise AssertionError('conflicting fake broker event')
            return
        self.events.append(copy.deepcopy(row))

    def events_for(self, runtime_id):
        return sorted((row for row in self.events if row['runtimeId'] == runtime_id
                       and row.get('evidenceOrigin') != 'retained'), key=lambda row: (row['time'], row['seq']))

    def broker_events_query(self, op):
        rows = self.events_for(op['runtimeId'])
        kind = op['op']
        if kind == 'admission-rejection':
            row = next((row for row in reversed(rows) if row['type'] == 'admission.rejected'
                        and row['payload'].get('submissionId') == op['submissionId']), None)
            if row is None or row['payload'].get('layer') is None:
                return {'result': None}
            return {'result': dict(op=kind, layer=row['payload']['layer'], reason=row['payload'].get('reason', ''))}
        if kind == 'input-accepted':
            return {'result': dict(op=kind, accepted=any(
                row['type'] == 'input.accepted' and row['payload'].get('inputId') == op['inputId'] for row in rows))}
        if kind == 'unique-submission-after':
            ids = set(row['payload'].get('submissionId') for row in rows
                      if row['invocationId'] == op['invocationId'] and row['seq'] > op['afterSeq']
                      and row['type'] == 'admission.requested'
                      and (row['payload'].get('origin') or {}).get('envelopeId') == op['envelopeId']
                      and isinstance(row['payload'].get('submissionId'), str))
            return {'result': dict(op=kind, submissionId=next(iter(ids))) if len(ids) == 1 else None}
        if kind == 'disposition':
            row = next((row for row in rows if row['type'] in DISPOSITION_TYPES
                        and row['payload'].get('submissionId') == op['submissionId']), None)
            return {'result': None if row is None else dict(op=kind, type=row['type'], **row['payload'])}
        if kind == 'input-rejection-evidence':
            row = next((row for row in rows if row['type'] == 'input.rejected'
                        and row['payload'].get('inputId') == op['submissionId']), None)
            evidence = None if row is None else row['payload'].get('deliveryEvidence')
            return {'result': dict(op=kind, deliveryEvidence=evidence)
                    if evidence in ('not_written', 'possibly_written') else None}
        raise AssertionError(kind)

    def install_active_binding(self, scope_ref, home_node_id, updated_at):
        self.bindings[scope_ref] = dict(scopeRef=scope_ref, homeNodeId=home_node_id, updatedAt=updated_at,
                                        state='active')


class FakeLedger:
    """The harness ledger: envelopes by id, recorded present/fail requests."""

    def __init__(self, clock):
        self.clock = clock
        self.envelopes = {}
        self.present_requests = []
        self.fail_requests = []
        self.auto_ack_fyi = False
        self.seq = 0
        self.task_states = {}
        self.task_show_requests = []
        self.task_show_error = None

    def say(self, **overrides):
        self.seq += 1
        identifier = overrides.get('id', f'EN-{self.seq:05}')
        now = iso_from_ms(self.clock())
        envelope = {'uuid': f'uuid-{identifier}', 'id': identifier, 'roomUuid': 'room-T-08094',
                    'roomKey': 'T-08094', 'roomKind': 'task',
                    'from': dict(principalRef='agent:chief', scopeRef='chief@hcs:T-07987'),
                    'to': dict(principalRef='agent:clod', scopeRef=SCOPE_REF), 'obligation': 'reply_required',
                    'delivery': 'queue', 'body': 'the body', 'state': 'pending', 'terminal': False,
                    'presentedTo': [], 'createdAt': now, 'updatedAt': now}
        envelope.update(overrides)
        self.envelopes[identifier] = envelope
        return envelope

    async def commit_wait(self, params):
        return dict(token='test', changed=False)

    async def pending_view(self, params):
        items = [envelope for envelope in self.envelopes.values() if not envelope['terminal']]
        return dict(items=items, blocking=[item['id'] for item in items if item['state'] == 'presented'], repended=0)

    async def present(self, params):
        envelope = self.envelopes.get(params['envelope'])
        if envelope is None:
            raise Exception(f"unknown envelope {params['envelope']}")
        self.present_requests.append(params)
        if params.get('preview') is not True and envelope['terminal']:
            raise Exception('wrong_state: envelope is terminal')
        if params.get('preview') is True:
            return dict(envelope=envelope, recorded=False, historyHint=False, messageCount=1)
        already = any(receipt.get('driveAttemptId') == params.get('driveAttemptId')
                      for receipt in envelope['presentedTo'])
        if not already:
            envelope['presentedTo'].append(dict(
                memberRef=SCOPE_REF,
                **{key: params[key] for key in ('runtimeId', 'inputId', 'driveAttemptId', 'deliveryOutcome')
                   if params.get(key) is not None},
                presentedAt=iso_from_ms(self.clock())))
            envelope['state'] = 'presented'
            if self.auto_ack_fyi and envelope['obligation'] in ('fyi', 'notify'):
                envelope.update(state='acked', terminal=True, reason='fyi_presented')
        return dict(envelope=envelope, recorded=not already, historyHint=False, messageCount=1)

    async def fail(self, params):
        envelope = self.envelopes.get(params['envelope'])
        if envelope is None:
            raise Exception(f"unknown envelope {params['envelope']}")
        self.fail_requests.append(dict(envelope=params['envelope'], reason=params['reason'],
                                       **({} if params.get('detail') is None else {'detail': params['detail']})))
        envelope.update(state='failed', terminal=True, failureReason=params['reason'])
        return envelope

    async def envelope_show(self, params):
        envelope = self.envelopes.get(params['envelope'])
        if envelope is None:
            raise Exception(f"unknown envelope {params['envelope']}")
        return envelope

    async def events_view(self, params):
        return dict(items=[], highWater=0)

    async def task_show(self, params):
        self.task_show_requests.append(params['task'])
        if self.task_show_error is not None:
            raise self.task_show_error
        return dict(id=params['task'], state=self.task_states.get(params['task'], 'open'))


class FakePort:
    """Every HRC seam as a replaceable instance attribute."""

    def __init__(self, h):
        db = h.db

        def dispatcher(door):
            async def dispatch(session, intent, prompt, options):
                h.dispatches.append(dict(options, submissionDoor=door))
                return h.dispatch_result()
            return dispatch

        async def none(*_args):
            return None

        async def runtime(runtime_id):
            return db.get_runtime(runtime_id)

        async def runtimes_by_host_session(host_session_id):
            return db.runtimes_by_host_session(host_session_id)

        async def live_runtimes(scope_ref):
            return [row for row in db.list_runtimes() if row['scopeRef'].startswith(scope_ref)
                    and row['status'] not in TERMINAL_RUNTIME_STATUSES]

        async def live_session_refs():
            return db.live_session_refs()

        async def target_by_session_ref(_target):
            return h.session

        async def ensure_target_session(*_args):
            return h.session

        async def seat(runtime_id):
            row = db.get_runtime(runtime_id)
            invocation_id = None if row is None else row.get('activeInvocationId')
            capabilities = json.loads((db.invocations.get(invocation_id) or {}).get('capabilitiesJson') or '{}')
            return dict(runtimeId=runtime_id, invocationId=invocation_id,
                        generation=0 if row is None else row['generation'],
                        admissionClasses=(capabilities.get('admission') or {}).get('classes'),
                        currentBrokerSeq=None if invocation_id is None else max(
                            [0] + [e['seq'] for e in db.events if e['invocationId'] == invocation_id]),
                        probe=None, probeError=dict(code='test_probe_failed', message='not configured'))

        async def events_head():
            return dict(hrcSeq=0, brokerCommit=0)

        async def lifecycle_events(_input):
            return []

        async def broker_events_query(op):
            return db.broker_events_query(op)

        async def local_placement_bindings():
            return dict(localNodeId='max3', bindings=[b for b in db.bindings.values() if b['state'] == 'active'])

        async def unborn_designations():
            return dict(localNodeId='max3', designations=[])

        async def federated_live_runtimes(_scope_ref):
            return dict(localNodeId='max3', liveNodeIds=[], unansweredNodeIds=[])

        async def resolve_runtime_intent(*_args):
            return {}

        async def subscribe(_input):
            async def unsubscribe():
                return None
            return unsubscribe

        async def withdraw(_input):
            return dict(ok=False, error=dict(message='not used'))

        async def preempt_admission(*_args):
            return 'authority-denied'

        self.runtime = runtime
        self.runtimes_by_host_session = runtimes_by_host_session
        self.live_runtimes = live_runtimes
        self.live_session_refs = live_session_refs
        self.target_by_session_ref = target_by_session_ref
        self.ensure_target_session = ensure_target_session
        self.seat = seat
        self.events_head = events_head
        self.lifecycle_events = lifecycle_events
        self.broker_events_query = broker_events_query
        self.local_placement_bindings = local_placement_bindings
        self.locate = none
        self.resolve_foreign_home = none
        self.unborn_designations = unborn_designations
        self.federated_live_runtimes = federated_live_runtimes
        self.resolve_runtime_intent = resolve_runtime_intent
        self.subscribe_lifecycle = subscribe
        self.subscribe_broker = subscribe
        self.withdraw = withdraw
        self.preempt_admission = preempt_admission
        for door in ('steer', 'enqueue', 'invoke', 'preempt'):
            setattr(self, door, dispatcher(door))


class Harness:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.offset_ms = 0
        self.t0 = time.monotonic()
        self.uuid_seq = 0
        self.store_path = self.tmp.name + '/hrc-mail-injector.sqlite'
        self.store = open_store(self.store_path, lambda: datetime.fromtimestamp(self.now_ms() / 1000, timezone.utc))
        self.db = FakeInjectionFacts()
        self.ledger = FakeLedger(self.now_ms)
        self.logs = []
        self.wakes = []
        self.dispatches = []
        now = iso_from_ms(self.now_ms())
        self.db.insert_session(dict(hostSessionId=HOST_SESSION_ID, scopeRef=SCOPE_REF, laneRef='main', generation=1,
                                    status='active', createdAt=now, updatedAt=now))
        self.db.insert_runtime(dict(runtimeId=RUNTIME_ID, hostSessionId=HOST_SESSION_ID, scopeRef=SCOPE_REF,
                                    laneRef='main', generation=1, transport='tmux', harness='claude-code',
                                    provider='anthropic', status='busy', supportsInflightInput=True,
                                    createdAt=now, updatedAt=now))
        self.session = copy.deepcopy(self.db.sessions[HOST_SESSION_ID])
        self.port = FakePort(self)
        self.context = MailKicker(
            dict(store=self.store, port=self.port, ledger=self.ledger, node_id='max3', foreign_home_memo={},
                 log=lambda level, event, detail: self.logs.append(dict(level=level, event=event,
                                                                         detail=copy.deepcopy(detail))),
                 now_ms=self.now_ms, new_uuid=self.new_uuid),
            dict(enabled=True, sweep_interval_ms=60_000))
        self.context.mail_kicker_boot_reconcile_pending = False
        self.context.wake = lambda target, reason=None: self.wakes.append(target)

        async def drain_target(_target):
            return None
        self.context.drain_target = drain_target

    def now_ms(self):
        return BASE_MS + self.offset_ms + int((time.monotonic() - self.t0) * 1000)

    def advance(self, ms):
        self.offset_ms += ms

    def new_uuid(self):
        self.uuid_seq += 1
        return f'00000000-0000-4000-8000-{self.uuid_seq:012}'

    def dispatch_result(self):
        return dict(submissionId='sub-1', admission='admitted', runId='run-ignored', hostSessionId=HOST_SESSION_ID,
                    generation=1, runtimeId=RUNTIME_ID, transport='headless', stage='accepted', status='started',
                    replayed=False, supportsInFlightInput=False,
                    observation=dict(lifecycle=dict(selector=dict(runId='run-ignored', generation=1), fromSeq=0)))

    def events(self, name):
        return [entry for entry in self.logs if entry['event'] == name]

    def sql(self, statement, params=()):
        self.store.connection.execute(statement, params)

    async def close(self):
        # Disposal reminder timers use the production stopping fence before waking.
        self.context.stopping = True
        await self.context.cancel_survivors()
        self.store.close()
        self.tmp.cleanup()


def seat_in(state, steer_capable=True):
    if state == 'turn-active':
        return dict(state=state, runtimeId=RUNTIME_ID, turnId='turn-1', steerCapable=steer_capable)
    if state == 'turn-observed':
        return dict(state=state, runtimeId=RUNTIME_ID, turnId='turn-1')
    return dict(state=state, runtimeId=RUNTIME_ID, steerCapable=steer_capable)


def broker_record(type, payload, clock_ms=BASE_MS):
    now = iso_from_ms(clock_ms)
    return dict(invocationId='inv-t08094', seq=1, time=now, type=type, runtimeId=RUNTIME_ID,
                brokerEventJson=json.dumps(payload), projectionStatus='projected', createdAt=now)


async def deliver_one_to(h, seat, envelope):
    """Deliver ONE envelope to a seat, failing loudly if it was not actionable."""
    from mail_delivery.act_delivery import deliver_to_seat
    from mail_delivery.act_presentation import read_actionable_envelopes
    actionable = await read_actionable_envelopes(h.context, TARGET_REF)
    item = next((candidate for candidate in actionable if candidate['envelope']['id'] == envelope['id']), None)
    if item is None:
        raise AssertionError(f"{envelope['id']} was not actionable")
    return await deliver_to_seat(h.context, TARGET_REF, h.session, seat, item, 'insert')


async def settle(rounds=5):
    for _ in range(rounds):
        await asyncio.sleep(0)
