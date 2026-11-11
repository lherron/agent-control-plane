"""Actionable envelope forms; translation of policy/drive/presentation.ts."""
from datetime import datetime, timezone
from .act_hrc_facts import hrc_facts
from .act_scope import target_session_ref_for_ledger_scope
from .act_types import newest_presentation_receipt, obligation_summons
from .presentation_text import _ms


async def read_actionable_envelopes(server, target_session_ref):
    view = await server.ledger.pending_view(dict(scopes=[target_session_ref], includeFyi=True))
    if view['repended'] > 0:
        server.log('INFO', 'wrkq.kicker.deferrals_repended', dict(targetSessionRef=target_session_ref, repended=view['repended']))
    outstanding = {intent.envelope_id for intent in server.store.mail_delivery.list_open_intents(target_session_ref)}
    due = {presentation.envelope_id: presentation for presentation in server.store.mail_delivery.list_due_reminders(
        target_session_ref, datetime.fromtimestamp(server.now_ms()/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))}
    actionable = []
    claimed_reminders = set()
    for envelope in view['items']:
        if envelope['id'] in outstanding:
            continue
        if envelope['state'] == 'pending':
            form = 'full' if len(envelope['presentedTo']) == 0 else 'defer-retry'
            actionable.append(dict(envelope=envelope, form=form))
            continue
        if envelope['state'] != 'presented':
            continue
        presentation = due.get(envelope['id'])
        if presentation is None:
            continue
        if (newest_presentation_receipt(envelope) or {}).get('runtimeId') != presentation.runtime_id:
            continue
        claimed_reminders.add(presentation.envelope_id)
        actionable.append(dict(envelope=envelope, form='reminder', presentation=presentation))
    for presentation in due.values():
        if presentation.envelope_id in claimed_reminders:
            continue
        if presentation.envelope_id in outstanding:
            continue
        if not server.store.mail_delivery.retire_reminder(presentation.envelope_id, presentation.runtime_id):
            continue
        server.log('INFO', 'wrkq.kicker.reminder_retired', dict(targetSessionRef=target_session_ref,
                  envelope=presentation.envelope_id, runtimeId=presentation.runtime_id))
    return actionable


BACKLOG_FYI_AGE_MS = 15 * 60_000


def is_backlog_fyi(item, options):
    envelope = item['envelope']
    if item['form'] != 'full' or envelope['obligation'] != 'fyi' or envelope['state'] != 'pending':
        return False
    created = _ms(envelope['createdAt'])
    if created is None:
        return False
    now = _ms(options['now'])
    if now - created > BACKLOG_FYI_AGE_MS:
        return True
    born = _ms(options.get('runtimeBornAt'))
    return born is not None and created < born


def classify_backlog_fyi(actionable, options):
    return [dict(item, form='digest') if is_backlog_fyi(item, options) else item for item in actionable]


def summons_a_turn(envelope):
    return obligation_summons(envelope['obligation'])


def actionable_directives(actionable):
    for item in actionable:
        raw = item['envelope'].get('materializationIntent')
        raw = raw.strip() if raw is not None else None
        if raw is not None and len(raw) > 0:
            return raw
    return None


async def sender_generation_for(server, envelope):
    scope_ref = envelope['from'].get('scopeRef')
    if scope_ref is None:
        return {}
    session_ref = target_session_ref_for_ledger_scope(scope_ref)
    if session_ref is None:
        return {}
    session = await hrc_facts(server).target(session_ref)
    return {} if session is None else {'senderGeneration': session['generation']}
