"""Parked-reader steer holds; translation of policy/drive/steer-hold.ts."""
from .act_internal import STEER_HOLD_MAX_MS, error_text


async def arm_quiet_pane_hold(server, runtime_id, observed=None):
    at = observed
    if at is None:
        try:
            seat = await server.port.seat(runtime_id)
            if seat['invocationId'] is None or seat['currentBrokerSeq'] is None:
                return
            at = dict(invocationId=seat['invocationId'], brokerSeq=seat['currentBrokerSeq'])
        except Exception as error:
            server.log('INFO', 'wrkq.kicker.steer_hold_unarmed', dict(runtimeId=runtime_id, error=error_text(error)))
            return
    prior = server.mail_kicker_steer_hold.get(runtime_id)
    if (prior is not None and prior['reason'] == 'pane_not_quiescent'
            and prior['invocationId'] == at['invocationId'] and prior['brokerSeq'] >= at['brokerSeq']):
        return
    server.mail_kicker_steer_hold[runtime_id] = dict(
        reason='pane_not_quiescent', invocationId=at['invocationId'], brokerSeq=at['brokerSeq'],
        since=(prior['since'] if prior is not None and prior['reason'] == 'pane_not_quiescent'
               and prior['invocationId'] == at['invocationId'] else server.now_ms()),
        announced=prior['announced'] if prior is not None and prior['reason'] == 'pane_not_quiescent' else False)


def clear_steer_hold(server, runtime_id):
    server.mail_kicker_steer_hold.pop(runtime_id, None)


def steer_hold_for(server, seat):
    if seat['state'] not in ('idle', 'turn-active') or not seat['steerCapable']:
        return
    runtime_id = seat['runtimeId']
    hold = server.mail_kicker_steer_hold.get(runtime_id)
    if seat.get('awaitingInput') is True:
        if hold is None or hold['reason'] != 'awaiting_input':
            server.mail_kicker_steer_hold[runtime_id] = dict(reason='awaiting_input', invocationId=None,
                                                          brokerSeq=0, since=server.now_ms(), announced=True)
            server.log('INFO', 'wrkq.kicker.steer_held', dict(runtimeId=runtime_id, hold='awaiting_input'))
        return 'awaiting_input'
    if hold is None:
        return
    def release(cause):
        server.mail_kicker_steer_hold.pop(runtime_id, None)
        server.log('INFO', 'wrkq.kicker.steer_hold_released', dict(runtimeId=runtime_id, hold=hold['reason'],
                                                                cause=cause, heldMs=server.now_ms()-hold['since']))
    if hold['reason'] == 'awaiting_input':
        release('input_resumed')
        return
    if server.now_ms() - hold['since'] >= STEER_HOLD_MAX_MS:
        release('ceiling')
        return
    if not hold['announced']:
        hold['announced'] = True
        server.log('INFO', 'wrkq.kicker.steer_held', dict(runtimeId=runtime_id, hold=hold['reason'],
                                                       invocationId=hold['invocationId'], brokerSeq=hold['brokerSeq']))
    return 'pane_not_quiescent'


NOT_SEAT_MOVEMENT = {'admission.requested', 'admission.admitted', 'admission.rejected',
                     'input.rejected', 'submission.rejected', 'driver.notice'}


def observe_seat_activity(server, record):
    hold = server.mail_kicker_steer_hold.get(record['runtimeId'])
    if hold is None or hold['reason'] != 'pane_not_quiescent':
        return
    if record['invocationId'] == hold['invocationId']:
        if record['seq'] <= hold['brokerSeq'] or record['type'] in NOT_SEAT_MOVEMENT:
            return
    server.mail_kicker_steer_hold.pop(record['runtimeId'], None)
    server.log('INFO', 'wrkq.kicker.steer_hold_released', dict(
        runtimeId=record['runtimeId'], hold=hold['reason'],
        cause='seat_moved' if record['invocationId'] == hold['invocationId'] else 'invocation_changed',
        brokerEventType=record['type'], brokerSeq=record['seq'], heldAtSeq=hold['brokerSeq'],
        heldMs=server.now_ms()-hold['since']))
