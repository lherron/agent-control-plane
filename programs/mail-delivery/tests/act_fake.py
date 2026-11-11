"""Recording fake owner seams; real SQLite store, fixed clock and ids."""
import asyncio
import copy
from datetime import datetime, timezone
import json
import tempfile
from mail_delivery.store import open_store

SCOPE = 'agent:clod:project:hrc-runtime:task:T-08094'
TARGET = SCOPE + '/lane:main'
NOW = 1794355200000
ISO = '2026-11-11T00:00:00.000Z'


class FakePort:
    def __init__(self, context):
        self.context = context
        self.session = dict(hostSessionId='host', generation=1, scopeRef=SCOPE, laneRef='main', lastAppliedIntentJson={})
        self.runtimes = [dict(runtimeId='rt', hostSessionId='host', generation=1, scopeRef=SCOPE, laneRef='main',
                              controllerKind='harness-broker', activeInvocationId='inv', status='ready', createdAt=ISO)]
        self.probe = dict(runtimeId='rt', invocationId='inv', generation=1, currentBrokerSeq=0,
                          admissionClasses=['steer'], probe={'seat': {'state': 'idle'}}, probeError=None)
        self.replies = {}
        self.events = []
        self.dispatch_result = dict(submissionId='sub-1', admission='admitted', runtimeId='rt', hostSessionId='host', generation=1)

    async def call(self, name, *args):
        self.context.transcript.append(dict(seam='port', method=name, args=copy.deepcopy(args)))
        if self.replies.get(name):
            reply = self.replies[name].pop(0)
            if isinstance(reply, Exception): raise reply
            return reply
        if name == 'target_by_session_ref': return self.session
        if name == 'runtimes_by_host_session': return self.runtimes
        if name == 'runtime': return next((r for r in self.runtimes if r['runtimeId'] == args[0]), None)
        if name in ('resolve_foreign_home', 'locate'): return None
        if name == 'federated_live_runtimes': return dict(localNodeId='max3', liveNodeIds=[], unansweredNodeIds=[])
        if name == 'local_placement_bindings': return dict(localNodeId='max3', bindings=[])
        if name == 'unborn_designations': return dict(localNodeId='max3', designations=[])
        if name == 'resolve_runtime_intent': return {}
        if name == 'ensure_target_session': return self.session
        if name == 'seat': return self.probe
        if name == 'events_head': return dict(hrcSeq=1, brokerCommit=0)
        if name == 'lifecycle_events': return self.events
        if name == 'broker_events_query': return {'result': None}
        if name == 'preempt_admission': return 'authority-denied'
        if name in ('steer', 'enqueue', 'invoke', 'preempt'): return self.dispatch_result
        if name in ('live_runtimes', 'live_session_refs'): return []
        raise AssertionError(name)

    def __getattr__(self, name):
        async def method(*args): return await self.call(name, *args)
        return method


class FakeLedger:
    def __init__(self, context):
        self.context = context
        self.rows = {}
        self.replies = {}
        self.task_state = 'open'

    def say(self, **changes):
        identifier = f'EN-{len(self.rows)+1:05}'
        row = dict(uuid='uuid-'+identifier, id=identifier, roomUuid='room', roomKey='T-08094', roomKind='task',
                   to=dict(principalRef='agent:clod', scopeRef=SCOPE), obligation='reply_required', delivery='queue',
                   body='the body', state='pending', terminal=False, presentedTo=[], createdAt=ISO, updatedAt=ISO,
                   **{'from': dict(principalRef='agent:chief', scopeRef='chief@hcs:T-07987')})
        row.update(changes)
        self.rows[row['id']] = row
        return row

    async def call(self, name, params):
        self.context.transcript.append(dict(seam='ledger', method=name, args=[copy.deepcopy(params)]))
        if self.replies.get(name):
            reply = self.replies[name].pop(0)
            if isinstance(reply, Exception): raise reply
            return reply
        if name == 'pending_view':
            return dict(items=[copy.deepcopy(row) for row in self.rows.values() if not row['terminal']], blocking=[], repended=0)
        if name == 'task_show': return dict(id=params['task'], state=self.task_state)
        row = self.rows[params['envelope']]
        if name == 'envelope_show': return copy.deepcopy(row)
        if name == 'fail':
            row.update(state='failed', terminal=True, failureReason=params['reason'])
            return copy.deepcopy(row)
        if name == 'present':
            if params.get('preview') is not True:
                if row['terminal']: raise Exception('wrong_state: envelope is terminal')
                already = any(r.get('driveAttemptId') == params.get('driveAttemptId') for r in row['presentedTo'])
                if not already:
                    row['presentedTo'].append(dict(memberRef=SCOPE, presentedAt=ISO,
                        **{k: v for k, v in params.items() if k in ('runtimeId', 'inputId', 'driveAttemptId', 'deliveryOutcome')}))
                    row['state'] = 'presented'
                return dict(envelope=copy.deepcopy(row), recorded=not already, historyHint=False, messageCount=1)
            return dict(envelope=copy.deepcopy(row), recorded=False, historyHint=False, messageCount=1)
        raise AssertionError(name)

    def __getattr__(self, name):
        async def method(params): return await self.call(name, params)
        return method


class FakeContext:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clock = NOW
        self.uuid_seq = 0
        self.store = open_store(self.tmp.name+'/state.sqlite', lambda: datetime.fromtimestamp(self.clock/1000, timezone.utc))
        self.logs = []
        self.transcript = []
        self.wakes = []
        self.port = FakePort(self)
        self.ledger = FakeLedger(self)
        self.node_id = 'max3'
        self.recipient_hints = None
        self.foreign_home_memo = {}
        self.enabled = True
        self.stopping = False
        self.sweep_interval_ms = 60000
        for name in ('pending_targets', 'target_operations', 'foreign_home_announced', 'birth_deferred_announced',
                     'birth_sweep_backoff', 'failure_notice_backoff', 'failure_notice_outstanding', 'delivery_backoff', 'steer_hold',
                     'quiet_targets', 'reconcile_examined_at', 'live_runtime_seen_at'):
            setattr(self, 'mail_kicker_'+name, {})
        for name in ('lapsed_runtimes', 'disposals_pending', 'stalled_delivery_announced', 'steer_refused', 'steer_fallback',
                     'failure_notice_steer_fallback'):
            setattr(self, 'mail_kicker_'+name, set())

    def now_ms(self): return self.clock
    def new_uuid(self):
        self.uuid_seq += 1
        return f'00000000-0000-4000-8000-{self.uuid_seq:012}'
    def log(self, level, event, detail): self.logs.append(dict(level=level, event=event, detail=copy.deepcopy(detail)))
    def wake(self, target, reason): self.wakes.append(dict(target=target, reason=reason))
    def spawn(self, coroutine): return asyncio.get_running_loop().create_task(coroutine, eager_start=True)
    async def deliver_failure_notices(self, target, session): pass
    async def fail_envelope_with_audit(self, input):
        row = await self.ledger.fail({k: v for k, v in input.items() if k in ('envelope', 'reason', 'runtime', 'detail')})
        return dict(outcome='failed', envelope=row)
    async def fail_undeliverable_mail(self, target, options):
        failed = 0
        for row in list(self.ledger.rows.values()):
            if row['state'] == 'pending' and not row['terminal'] and not row['presentedTo']:
                await self.fail_envelope_with_audit(dict(envelope=row['id'], reason='undeliverable', detail=options.get('detail')))
                failed += 1
        return dict(failed=failed)
    def schedule_participant_host_retry(self, target, reason): pass
    def close(self):
        self.stopping = True
        self.store.close()
        self.tmp.cleanup()


def broker_record(kind, payload, seq=1):
    return dict(runtimeId='rt', invocationId='inv', seq=seq, type=kind, brokerEventJson=json.dumps(payload),
                time=ISO, createdAt=ISO, projectionStatus='projected')
