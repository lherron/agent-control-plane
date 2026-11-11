"""Structural wrkq wire subsets, ported from policy/ledger/types.ts.

Wire dictionaries retain their original keys. Functions use snake_case.
"""
from __future__ import annotations
import re
from datetime import datetime
from typing import Any, Literal, TypedDict, NotRequired

WrkqEnvelopeObligation = Literal['reply_required', 'notify', 'fyi', 'note', 'none']

WrkqEnvelopeState = Literal['pending', 'presented', 'acked', 'deferred', 'failed', 'expired', 'withdrawn']

WrkqEnvelopeFailureReason = Literal['runtime_terminated', 'ignored', 'undeliverable', 'legacy']

WrkqEnvelopeDelivery = Literal['queue', 'hold']

WrkqRoomKind = Literal['campaign', 'task', 'project', 'adhoc']

WrkqEnvelopeParty = TypedDict('WrkqEnvelopeParty', {
    'principalRef': str,
    'scopeRef': NotRequired[str],
})

WrkqEnvelopePresentation = TypedDict('WrkqEnvelopePresentation', {
    'memberRef': str,
    'node': NotRequired[str],
    'runtimeId': NotRequired[str],
    'hostSessionId': NotRequired[str],
    'generation': NotRequired[str],
    'runId': NotRequired[str],
    'inputId': NotRequired[str],
    'driveAttemptId': NotRequired[str],
    'deliveryOutcome': NotRequired[str],
    'presentedAt': str,
})

WrkqEnvelope = TypedDict('WrkqEnvelope', {
    'uuid': str,
    'id': str,
    'roomUuid': str,
    'roomKey': str,
    'roomKind': WrkqRoomKind,
    'groupId': NotRequired[str],
    'from': WrkqEnvelopeParty,
    'to': Any,
    'replyTo': NotRequired[str],
    'obligation': WrkqEnvelopeObligation,
    'delivery': WrkqEnvelopeDelivery,
    'expiresAt': NotRequired[str],
    'body': str,
    'taskId': NotRequired[str],
    'state': WrkqEnvelopeState,
    'terminal': bool,
    'failureReason': NotRequired[Any],
    'reason': NotRequired[str],
    'deferReason': NotRequired[str],
    'retryAt': NotRequired[str],
    'materializationIntent': NotRequired[str],
    'idempotencyKey': NotRequired[str],
    'meta': NotRequired[Any],
    'presentedTo': Any,
    'createdAt': str,
    'updatedAt': str,
})

WrkqRoomShowParams = TypedDict('WrkqRoomShowParams', {
    'room': str,
    'principalRef': NotRequired[str],
})

WrkqRoomView = TypedDict('WrkqRoomView', {
    'key': str,
    'kind': WrkqRoomKind,
})

WrkqRoomLogViewParams = TypedDict('WrkqRoomLogViewParams', {
    'room': str,
    'task': NotRequired[str],
    'limit': NotRequired[int],
    'principalRef': NotRequired[str],
    'scopeRef': NotRequired[str],
})

WrkqRoomLogView = TypedDict('WrkqRoomLogView', {
    'room': WrkqRoomView,
    'items': Any,
})

WrkqRoomSayParams = TypedDict('WrkqRoomSayParams', {
    'ref': NotRequired[str],
    'body': str,
    'to': NotRequired[list[str]],
    'fyi': NotRequired[bool],
    'idempotencyKey': NotRequired[str],
    'dischargeEnvelopeIds': NotRequired[list[str]],
    'meta': NotRequired[Any],
    'principalRef': NotRequired[str],
    'scopeRef': NotRequired[str],
})

WrkqRoomSayResult = TypedDict('WrkqRoomSayResult', {
    'room': WrkqRoomView,
    'groupId': str,
    'envelopes': Any,
    'acked': list[str],
    'notices': NotRequired[list[str]],
})

WrkqEnvelopePendingViewParams = TypedDict('WrkqEnvelopePendingViewParams', {
    'scopes': NotRequired[list[str]],
    'includeFyi': NotRequired[bool],
    'principalRef': NotRequired[str],
    'scopeRef': NotRequired[str],
})

WrkqEnvelopeBirthEnvelopeParams = TypedDict('WrkqEnvelopeBirthEnvelopeParams', {
    'scopeRef': str,
})

WrkqEnvelopeBirth = TypedDict('WrkqEnvelopeBirth', {
    'envelopeId': str,
    'seq': int,
    'from': Any,
})

WrkqEnvelopePendingView = TypedDict('WrkqEnvelopePendingView', {
    'items': Any,
    'blocking': list[str],
    'repended': int,
})

WrkqEnvelopePresentParams = TypedDict('WrkqEnvelopePresentParams', {
    'envelope': str,
    'preview': NotRequired[bool],
    'memberRef': NotRequired[str],
    'node': NotRequired[str],
    'runtimeId': NotRequired[str],
    'hostSessionId': NotRequired[str],
    'generation': NotRequired[str],
    'runId': NotRequired[str],
    'inputId': NotRequired[str],
    'driveAttemptId': NotRequired[str],
    'deliveryOutcome': NotRequired[str],
    'principalRef': NotRequired[str],
})

WrkqEnvelopePresentResult = TypedDict('WrkqEnvelopePresentResult', {
    'envelope': WrkqEnvelope,
    'recorded': bool,
    'historyHint': bool,
    'messageCount': int,
    'lastMessageAt': NotRequired[str],
})

WrkqEnvelopeFailParams = TypedDict('WrkqEnvelopeFailParams', {
    'envelope': str,
    'reason': Any,
    'detail': NotRequired[str],
    'runtime': NotRequired[str],
    'principalRef': NotRequired[str],
})

WrkqEnvelopeShowParams = TypedDict('WrkqEnvelopeShowParams', {
    'envelope': str,
    'principalRef': NotRequired[str],
})

WrkqMonitorEvent = TypedDict('WrkqMonitorEvent', {
    'id': int,
    'timestamp': str,
    'resourceType': str,
    'resourceUuid': NotRequired[str],
    'resourceId': NotRequired[str],
    'eventType': str,
    'payload': NotRequired[str],
})

WrkqMonitorEventsView = TypedDict('WrkqMonitorEventsView', {
    'items': Any,
    'highWater': int,
})

WrkqMonitorEventsViewParams = TypedDict('WrkqMonitorEventsViewParams', {
    'cursor': int,
    'eventTypes': NotRequired[list[str]],
    'limit': NotRequired[int],
    'lastN': NotRequired[int],
    'principalRef': NotRequired[str],
})

WrkqEnvelopeFailedPayload = TypedDict('WrkqEnvelopeFailedPayload', {
    'state': NotRequired[str],
    'reason': NotRequired[str],
    'room_uuid': NotRequired[str],
    'runtime_id': NotRequired[str],
    'detail': NotRequired[str],
})

WrkqEnvelopeCreatedPayload = TypedDict('WrkqEnvelopeCreatedPayload', {
    'id': NotRequired[str],
    'to_scope_ref': NotRequired[str],
    'to_principal_ref': NotRequired[str],
    'obligation': NotRequired[str],
    'materialization_intent': NotRequired[str],
})

def obligation_summons(obligation: str | None) -> bool:
    return obligation == 'reply_required' or obligation == 'notify'


def obligation_owes_reply(obligation: WrkqEnvelopeObligation) -> bool:
    return obligation == 'reply_required'


def newest_presentation_receipt(envelope):
    newest = None
    newest_at = float('-inf')
    for receipt in envelope['presentedTo']:
        try:
            at = datetime.fromisoformat(receipt['presentedAt'].replace('Z', '+00:00')).timestamp()
        except (ValueError, TypeError, KeyError):
            at = float('-inf')
        rank = at
        if rank >= newest_at:
            newest_at = rank
            newest = receipt
    return newest


def envelope_id_sequence(envelope_id: str) -> int:
    match = re.fullmatch(r'EN-([0-9]+)', envelope_id.strip())
    if match is None:
        return 0
    parsed = int(match[1])
    return parsed if 0 <= parsed <= 2 ** 53 - 1 else 0
