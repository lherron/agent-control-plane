"""Finished-task fyi handling; translation of policy/drive/finished-task.ts."""
import re
from .act_internal import error_text, normalize_target_session_ref

TERMINAL_TASK_STATES = {'completed', 'cancelled', 'archived', 'deleted'}
WRKQ_TASK_ID = re.compile(r'^T-[0-9]+$')


def task_id_of(scope_ref):
    if scope_ref is None:
        return None
    try:
        normalize_target_session_ref(scope_ref+'/lane:main')
        parts = scope_ref.split(':')
        task_id = parts[5] if len(parts) >= 6 and parts[4] == 'task' else None
    except ValueError:
        return None
    return task_id if task_id is not None and WRKQ_TASK_ID.fullmatch(task_id) else None


async def close_fyi_for_finished_task(server, input):
    task_id = task_id_of(input.get('scopeRef'))
    if task_id is None:
        return None
    try:
        state = (await server.ledger.task_show({'task': task_id}))['state']
    except Exception as error:
        server.log('WARN', 'wrkq.kicker.target_task_state_read_failed', dict(
            driveAttemptId=input['driveAttemptId'], targetSessionRef=input['targetSessionRef'], taskId=task_id,
            error=error_text(error), fallback='deliver'))
        return None
    if state not in TERMINAL_TASK_STATES:
        return None
    detail = f"target_task_terminal: {task_id} is {state}; a finished task's seat is not started for an fyi"
    server.log('INFO', 'wrkq.kicker.target_task_terminal', dict(
        driveAttemptId=input['driveAttemptId'], targetSessionRef=input['targetSessionRef'], taskId=task_id,
        taskState=state, envelopeIds=[item['envelope']['id'] for item in input['actionable']]))
    closed = 0
    for item in input['actionable']:
        result = await server.fail_envelope_with_audit(dict(envelope=item['envelope']['id'], reason='undeliverable',
            detail=detail, targetSessionRef=input['targetSessionRef'], callSite='target_task_terminal'))
        if result['outcome'] == 'failed':
            closed += 1
    return closed
