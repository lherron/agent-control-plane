"""Boot-reconcile and stalled-delivery reports the periodic sweep runs;
translation of policy/diagnostics/stranded.ts (the sweep's two callees only;
`diagnostics/inspect.ts` is not ported).
"""
from .act_hrc_facts import hrc_facts
from .act_internal import STALLED_DELIVERY_THRESHOLD_MS, error_text, parse_session_ref
from .act_js import date_parse, iso_from_ms
from .act_launch_recovery import recover_failed_launch
from .act_runtime_status import is_runtime_terminal
from .act_types import newest_presentation_receipt

STRANDED_LEDGER_READ_CAP = 25
BOOT_RECONCILE_CANDIDATE_LIMIT = 200


async def confirm_stranded(server, candidates, cap=STRANDED_LEDGER_READ_CAP):
    stranded = []
    awaiting_disposal = []
    ledger_errors = 0
    for candidate in candidates[:cap]:
        try:
            row = await server.ledger.envelope_show({'envelope': candidate.envelope_id})
            if row['state'] != 'presented':
                continue
            newest = newest_presentation_receipt(row)
            if (newest or {}).get('runtimeId') != candidate.runtime_id:
                continue
            runtime = await server.port.runtime(candidate.runtime_id)
            entry = dict(
                envelope=candidate.envelope_id, presentationId=candidate.presentation_id,
                targetSessionRef=candidate.target_session_ref, runtimeId=candidate.runtime_id,
                runtimeStatus='absent' if runtime is None else runtime['status'],
                deliveryOutcome=candidate.delivery_outcome, landedAt=candidate.landed_at,
                **({} if candidate.reminder_armed_at is None else {'reminderArmedAt': candidate.reminder_armed_at}))
            if runtime is not None and not is_runtime_terminal(runtime['status']):
                awaiting_disposal.append(entry)
                continue
            stranded.append(entry)
        except Exception:
            ledger_errors += 1
    return dict(stranded=stranded, awaitingDisposal=awaiting_disposal, ledgerErrors=ledger_errors)


def find_stalled_deliveries(server):
    now = server.now_ms()
    threshold = iso_from_ms(now - STALLED_DELIVERY_THRESHOLD_MS)
    stalled = []
    for intent in server.store.mail_delivery.list_expired_intents(threshold):
        submitted_ms = date_parse(intent.submitted_at)
        stalled.append(dict(
            envelope=intent.envelope_id, targetSessionRef=intent.target_session_ref, door=intent.door,
            presentationId=intent.presentation_id,
            **({} if intent.runtime_id is None else {'runtimeId': intent.runtime_id}),
            **({} if intent.submission_id is None else {'submissionId': intent.submission_id}),
            submittedAt=intent.submitted_at,
            ageMs=0 if submitted_ms is None else max(now - submitted_ms, 0)))
    return stalled


async def report_stalled_deliveries(server):
    live_by_scope = {}
    facts = hrc_facts(server)
    stalled = find_stalled_deliveries(server)
    stalled_ids = set(delivery['envelope'] for delivery in stalled)
    for envelope_id in list(facts.stalled_launch_memo.keys()):
        if envelope_id not in stalled_ids:
            facts.stalled_launch_memo.pop(envelope_id, None)
    for delivery in stalled:
        if delivery['door'] == 'launch':
            target = parse_session_ref(delivery['targetSessionRef'])
            version = facts.scope_version(target['scopeRef'])
            if facts.serving and facts.stalled_launch_memo.get(delivery['envelope']) == version:
                continue
            runtimes = live_by_scope.get(target['scopeRef'])
            if runtimes is None:
                runtimes = await server.port.live_runtimes(target['scopeRef'])
                live_by_scope[target['scopeRef']] = runtimes
            live = any(runtime.get('scopeRef') == target['scopeRef'] and runtime.get('laneRef') == target['laneRef']
                       and not is_runtime_terminal(runtime['status']) for runtime in runtimes)
            if not live:
                intent = server.store.mail_delivery.get_intent(delivery['envelope'])
                if intent is not None:
                    await recover_failed_launch(server, intent, 'stalled_delivery: scope has no live runtime')
                facts.stalled_launch_memo[delivery['envelope']] = version
                continue
            facts.stalled_launch_memo[delivery['envelope']] = version
        if delivery['envelope'] in server.mail_kicker_stalled_delivery_announced:
            continue
        server.mail_kicker_stalled_delivery_announced.add(delivery['envelope'])
        server.log('WARN', 'wrkq.kicker.stalled_delivery', dict(
            targetSessionRef=delivery['targetSessionRef'], envelope=delivery['envelope'], door=delivery['door'],
            presentationId=delivery['presentationId'],
            **({} if delivery.get('runtimeId') is None else {'runtimeId': delivery['runtimeId']}),
            **({} if delivery.get('submissionId') is None else {'submissionId': delivery['submissionId']}),
            ageMs=delivery['ageMs'], thresholdMs=STALLED_DELIVERY_THRESHOLD_MS,
            reason='submission admitted but no landing fact observed',
            recovery='reconcile landing evidence; retry stalled launches only after the runtime ends'))


async def report_boot_reconcile(server):
    candidates = server.store.mail_delivery.list_undisposed_presentations(BOOT_RECONCILE_CANDIDATE_LIMIT)
    confirmed = await confirm_stranded(server, candidates)
    stranded, awaiting_disposal, ledger_errors = (
        confirmed['stranded'], confirmed['awaitingDisposal'], confirmed['ledgerErrors'])
    stalled = find_stalled_deliveries(server)
    open_intents = len(server.store.mail_delivery.list_open_intents())
    server.log('WARN' if len(stranded) > 0 or len(stalled) > 0 else 'INFO', 'wrkq.kicker.boot_reconcile', dict(
        nodeId=server.node_id,
        candidatesExamined=min(len(candidates), STRANDED_LEDGER_READ_CAP),
        candidatesFound=len(candidates),
        strandedCount=len(stranded), stranded=stranded,
        awaitingDisposalCount=len(awaiting_disposal), awaitingDisposal=awaiting_disposal,
        preMigrationUnknown=server.store.mail_delivery.count_pre_migration_unknown_presentations(),
        openIntents=open_intents,
        stalledCount=len(stalled), stalled=stalled, stalledThresholdMs=STALLED_DELIVERY_THRESHOLD_MS,
        **({'ledgerErrors': ledger_errors} if ledger_errors > 0 else {})))


async def report_boot_reconcile_once(server):
    if not server.mail_kicker_boot_reconcile_pending:
        return
    server.mail_kicker_boot_reconcile_pending = False
    try:
        await report_boot_reconcile(server)
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.boot_reconcile_failed', dict(error=error_text(error)))
