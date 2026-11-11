"""Resolve every OPEN delivery intent against committed broker evidence
(spec T-08092 rev 4, D2 step 5); translation of policy/drive/reconcile.ts.
"""
import asyncio
import json
import math
from weakref import WeakKeyDictionary
from .act_contracts import HrcDomainError, HrcErrorCode
from .act_digest_group import digest_members
from .act_hrc_facts import hrc_facts
from .act_internal import (KICKER_SUBMISSION_TTL_MS, PERIODIC_QUIET_BACKSTOP_MS, RECONCILE_RUNTIME_READ_DEADLINE_MS,
                           STEER_WRITE_RECONCILE_GRACE_MS, error_text, is_record)
from .act_js import date_parse
from .act_landing import commit_landing_for_submission, land_launch_if_started, refuse_intent
from .act_runtime_status import is_runtime_terminal

LANDED_EVENT_TYPES = {'submission.absorbed', 'submission.executed'}

# `runtime()` is a broad read in the active socket port. A timeout cannot
# cancel that public port call, so retain one read until it settles.
outstanding_runtime_reads = WeakKeyDictionary()


def outstanding_runtime_read(server, runtime_id):
    existing = outstanding_runtime_reads.get(server)
    if existing is not None:
        return (dict(kind='read', read=existing['read']) if existing['runtimeId'] == runtime_id
                else dict(kind='busy', runtimeId=existing['runtimeId']))

    async def read_body():
        await asyncio.sleep(0)  # Promise.resolve().then(...): the read starts on the next turn
        return await server.port.runtime(runtime_id)
    read = asyncio.get_running_loop().create_task(read_body())
    outstanding = dict(runtimeId=runtime_id, read=read)
    outstanding_runtime_reads[server] = outstanding

    def settled(task):
        if outstanding_runtime_reads.get(server) is outstanding:
            outstanding_runtime_reads.pop(server, None)
        if not task.cancelled():
            task.exception()  # observed: a rejection here is handled by its awaiter
    read.add_done_callback(settled)
    return dict(kind='read', read=read)


async def read_runtime_within_deadline(server, runtime_id):
    outstanding = outstanding_runtime_read(server, runtime_id)
    if outstanding['kind'] == 'busy':
        return dict(timedOut=True)
    done, _ = await asyncio.wait([outstanding['read']], timeout=RECONCILE_RUNTIME_READ_DEADLINE_MS / 1000)
    if not done:
        return dict(timedOut=True)
    try:
        runtime = outstanding['read'].result()
    except HrcDomainError as error:
        if error.code == HrcErrorCode.UNKNOWN_RUNTIME:
            return dict(timedOut=False, runtime=None)
        raise
    return dict(timedOut=False, runtime=runtime)


async def reconcile_intent(server, intent, now=None):
    """One intent, resolved or left alone."""
    if now is None:
        now = server.now_ms()
    if intent.terminal_envelope_at is not None:
        return 'open'
    runtime_id = intent.runtime_id
    if runtime_id is not None:
        try:
            members = digest_members(server, intent)
            submission_id = intent.submission_id
            if submission_id is None:
                submission_id = next((member.submission_id for member in members if member.submission_id), None)
            if submission_id is None and intent.invocation_id is not None and intent.broker_after_seq is not None:
                for member in members:
                    discovered = await server.port.broker_events_query(dict(
                        op='unique-submission-after', runtimeId=runtime_id, invocationId=intent.invocation_id,
                        envelopeId=member.envelope_id, afterSeq=intent.broker_after_seq))
                    result = discovered.get('result')
                    if result is not None and result.get('op') == 'unique-submission-after':
                        submission_id = result['submissionId']
                        break
            if submission_id is not None:
                for member in members:
                    if member.submission_id is None:
                        server.store.mail_delivery.attach_admission(member.envelope_id, submission_id=submission_id)
                disposition_result = await server.port.broker_events_query(dict(
                    op='disposition', runtimeId=runtime_id, submissionId=submission_id))
                disposition = disposition_result.get('result')
                if disposition is not None and disposition.get('op') != 'disposition':
                    disposition = None
                if disposition is not None and disposition['type'] in LANDED_EVENT_TYPES:
                    return await land_from_stream(server, intent, runtime_id, disposition['type'])
                if disposition is not None:
                    evidence_result = await server.port.broker_events_query(dict(
                        op='input-rejection-evidence', runtimeId=runtime_id, submissionId=submission_id))
                    evidence = _rejection_evidence(evidence_result)
                    if evidence != 'not_written':
                        server.store.mail_delivery.mark_uncertain(
                            intent.envelope_id,
                            disposition.get('reason') if disposition.get('reason') is not None else disposition['type'],
                            'possibly_written' if evidence == 'possibly_written' else 'refusal_without_no_write_proof')
                        return 'open'
                    return await refuse_intent(
                        server, intent,
                        disposition.get('reason') if disposition.get('reason') is not None else disposition['type'])
                evidence_result = await server.port.broker_events_query(dict(
                    op='input-rejection-evidence', runtimeId=runtime_id, submissionId=submission_id))
                evidence = _rejection_evidence(evidence_result)
                if evidence == 'not_written':
                    return await refuse_intent(server, intent, 'input.rejected')
                if evidence is None and await was_written_mid_turn(server, intent, runtime_id, submission_id, now):
                    return await land_from_stream(server, intent, runtime_id, 'input.accepted')
                if evidence == 'possibly_written':
                    server.store.mail_delivery.mark_uncertain(intent.envelope_id, 'input.rejected', 'possibly_written')
                    return 'open'
            elif intent.door == 'launch':
                commit = await land_launch_if_started(server, intent)
                if commit == 'committed':
                    return 'landed'
                if commit == 'disposed':
                    return 'disposed'
        except Exception as error:
            if not isinstance(error, HrcDomainError) or error.code != HrcErrorCode.UNKNOWN_RUNTIME:
                raise
            return await reconcile_gone_runtime(server, intent)

        runtime_read = await read_runtime_within_deadline(server, runtime_id)
        if runtime_read['timedOut']:
            server.store.mail_delivery.mark_uncertain(
                intent.envelope_id, 'reconcile_runtime_read_timeout', 'runtime_read_timeout')
            server.log('WARN', 'wrkq.kicker.intent_reconcile_runtime_timeout', dict(
                targetSessionRef=intent.target_session_ref, envelope=intent.envelope_id, runtimeId=runtime_id,
                deadlineMs=RECONCILE_RUNTIME_READ_DEADLINE_MS))
            return 'open'
        runtime = runtime_read['runtime']
        if runtime is None or is_runtime_terminal(runtime['status']):
            return await reconcile_gone_runtime(server, intent)

    submitted = date_parse(intent.submitted_at)
    age = None if submitted is None else now - submitted
    if age is not None and math.isfinite(age) and age >= KICKER_SUBMISSION_TTL_MS:
        server.store.mail_delivery.mark_uncertain(intent.envelope_id, 'ttl_without_landing', 'ttl')
    return 'open'


def _rejection_evidence(evidence_result):
    result = evidence_result.get('result')
    if result is not None and result.get('op') == 'input-rejection-evidence':
        return result.get('deliveryEvidence')
    return None


async def reconcile_gone_runtime(server, intent):
    """Retire terminal mail or preserve a live envelope's no-second-write fence."""
    envelope = await server.ledger.envelope_show({'envelope': intent.envelope_id})
    if envelope['terminal']:
        server.store.mail_delivery.mark_terminal_envelope(intent.envelope_id, envelope['state'])
        return 'runtime_gone'
    server.store.mail_delivery.mark_uncertain(
        intent.envelope_id, 'runtime_terminated_before_landing', 'runtime_terminal')
    return 'open'


async def land_from_stream(server, intent, runtime_id, event_type):
    """Commit a landing the mirrored stream proves."""
    current = server.store.mail_delivery.get_intent(intent.envelope_id)
    if current is None:
        current = intent
    commit = await commit_landing_for_submission(server, current, dict(
        runtimeId=runtime_id, eventType=event_type, landingHrcSeq=(await server.port.events_head())['hrcSeq']))
    return 'landed' if commit == 'committed' else 'disposed' if commit == 'disposed' else 'open'


async def was_written_mid_turn(server, intent, runtime_id, submission_id, now):
    if intent.door != 'steer':
        return False
    submitted = date_parse(intent.submitted_at)
    if submitted is not None and now - submitted < STEER_WRITE_RECONCILE_GRACE_MS:
        return False
    result = (await server.port.broker_events_query(dict(
        op='input-accepted', runtimeId=runtime_id, inputId=submission_id))).get('result')
    if result is None or result.get('op') != 'input-accepted' or not result.get('accepted'):
        return False
    row = await server.ledger.envelope_show({'envelope': intent.envelope_id})
    return row['state'] != 'deferred'


async def reconcile_open_intents(server, options=None):
    """Reconcile every open intent, or only those bound to named runtimes."""
    if options is None:
        options = dict(reason='periodic')
    counts = dict(landed=0, disposed=0, refused=0, runtime_gone=0, expired=0, undeliverable=0, open=0)
    open = server.store.mail_delivery.list_active_open_intents()
    runtime_ids = options.get('runtimeIds')
    periodic = options['reason'] == 'periodic' and runtime_ids is None
    now_ms = server.now_ms()
    facts = hrc_facts(server)
    keyed = facts.broker_keyed
    if periodic:
        prune_reconcile_memo(server, facts, open)
    intents = [intent for intent in open
               if (runtime_ids is None or (intent.runtime_id is not None and intent.runtime_id in runtime_ids)) and
               (not periodic or (keyed_reconcile_due(facts, intent, now_ms) if keyed
                                 else periodic_reconcile_due(server, intent, now_ms)))]
    if len(intents) == 0:
        return counts
    for listed in intents:
        intent = server.store.mail_delivery.get_intent(listed.envelope_id)
        if intent is None:
            continue
        if periodic:
            server.mail_kicker_reconcile_examined_at[intent.envelope_id] = now_ms
        tick = facts.tick()
        try:
            counts[await reconcile_intent(server, intent)] += 1
            after = server.store.mail_delivery.get_intent(intent.envelope_id)
            if after is None:
                facts.reconcile_memo.pop(intent.envelope_id, None)
            else:
                facts.reconcile_memo[intent.envelope_id] = dict(
                    fingerprint=reconcile_fingerprint(after), epoch=facts.epoch, tick=tick, examinedAtMs=now_ms)
        except Exception as error:
            facts.reconcile_memo.pop(intent.envelope_id, None)
            counts['open'] += 1
            server.log('WARN', 'wrkq.kicker.intent_reconcile_failed', dict(
                targetSessionRef=intent.target_session_ref, envelope=intent.envelope_id, error=error_text(error)))
    resolved = (counts['landed'] + counts['disposed'] + counts['refused'] + counts['runtime_gone'] +
                counts['expired'] + counts['undeliverable'])
    if resolved > 0:
        server.log('INFO', 'wrkq.kicker.intent_reconciled', dict(
            nodeId=server.node_id, reason=options['reason'], examined=len(intents), **counts))
    return counts


def periodic_reconcile_due(server, intent, now_ms):
    if intent.uncertain_cause is None:
        return True
    if intent.uncertain_cause == 'reconcile_runtime_read_timeout':
        return True
    examined_at = server.mail_kicker_reconcile_examined_at.get(intent.envelope_id)
    return examined_at is None or now_ms - examined_at >= PERIODIC_QUIET_BACKSTOP_MS


def prune_reconcile_memo(server, facts, open):
    live = set(intent.envelope_id for intent in open)
    runtimes = set(intent.runtime_id for intent in open)
    for envelope_id in list(server.mail_kicker_reconcile_examined_at.keys()):
        if envelope_id not in live:
            server.mail_kicker_reconcile_examined_at.pop(envelope_id, None)
    for envelope_id in list(facts.reconcile_memo.keys()):
        if envelope_id not in live:
            facts.reconcile_memo.pop(envelope_id, None)
    for envelope_id in list(facts.dirty_envelopes.keys()):
        if envelope_id not in live:
            facts.dirty_envelopes.pop(envelope_id, None)
    for runtime_id in list(facts.dirty_runtimes.keys()):
        if runtime_id not in runtimes:
            facts.dirty_runtimes.pop(runtime_id, None)


def keyed_reconcile_due(facts, intent, now_ms):
    if intent.uncertain_cause == 'reconcile_runtime_read_timeout':
        return True
    memo = facts.reconcile_memo.get(intent.envelope_id)
    if memo is None or memo['epoch'] != facts.epoch:
        return True
    if memo['fingerprint'] != reconcile_fingerprint(intent):
        return True
    if facts.dirty_envelopes.get(intent.envelope_id, 0) > memo['tick']:
        return True
    if (intent.submission_id is None and intent.runtime_id is not None and
            facts.dirty_runtimes.get(intent.runtime_id, 0) > memo['tick']):
        return True
    if intent.uncertain_cause is not None:
        return False
    submitted_ms = date_parse(intent.submitted_at)
    if submitted_ms is None or not math.isfinite(submitted_ms):
        return False
    deadlines = [submitted_ms + KICKER_SUBMISSION_TTL_MS]
    if intent.door == 'steer':
        deadlines.append(submitted_ms + STEER_WRITE_RECONCILE_GRACE_MS)
    return any(memo['examinedAtMs'] < deadline <= now_ms for deadline in deadlines)


def _js(value):
    return '' if value is None else str(value)


def reconcile_fingerprint(intent):
    """The intent fields a reconcile verdict depends on; timestamps excluded."""
    return '|'.join(_js(value) for value in (
        intent.door, intent.runtime_id, intent.submission_id, intent.invocation_id, intent.broker_after_seq,
        intent.uncertain_cause, intent.last_evidence_kind, intent.cleanup_outcome, intent.terminal_envelope_at))


EVIDENCE_TYPE_PREFIXES = ['submission.', 'input.', 'admission.']


def note_broker_evidence(server, record):
    """Mark the intents one broker commit may have new evidence for (T-12430)."""
    type = record['type']
    evidence = any(type.startswith(prefix) for prefix in EVIDENCE_TYPE_PREFIXES)
    if not evidence and type != 'turn.started':
        return
    facts = hrc_facts(server)
    tick = facts.tick()
    facts.dirty_runtimes[record['runtimeId']] = tick
    if not evidence:
        return
    try:
        parsed = json.loads(record['brokerEventJson'])
        payload = parsed if is_record(parsed) else None
    except (ValueError, TypeError):
        payload = None
    if payload is None:
        return
    for key in ('submissionId', 'inputId'):
        submission_id = payload.get(key)
        if not isinstance(submission_id, str):
            continue
        intent = server.store.mail_delivery.get_intent_by_submission_id(submission_id)
        if intent is None:
            continue
        for member in digest_members(server, intent):
            facts.dirty_envelopes[member.envelope_id] = tick
    origin = payload.get('origin')
    envelope_id = origin.get('envelopeId') if is_record(origin) else None
    if isinstance(envelope_id, str):
        facts.dirty_envelopes[envelope_id] = tick
