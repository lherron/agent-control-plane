"""The broker's observed seat; translation of policy/drive/seat.ts."""
from .act_internal import is_runtime_unavailable_status


def seat_can_dispatch(seat):
    return seat['state'] == 'idle' or seat['state'] == 'absent'


async def runtime_advertises_steer(server, runtime_id):
    return 'steer' in ((await server.port.seat(runtime_id)).get('admissionClasses') or [])


async def observe_broker_seat(server, session):
    runtimes = await server.port.runtimes_by_host_session(session['hostSessionId'])
    runtime = next((candidate for candidate in reversed(runtimes)
                    if candidate['generation'] == session['generation']
                    and candidate.get('controllerKind') == 'harness-broker'
                    and candidate.get('activeInvocationId') is not None
                    and not is_runtime_unavailable_status(candidate['status'])), None)
    if runtime is None:
        return {'state': 'absent'}
    probe = await server.port.seat(runtime['runtimeId'])
    if probe['probe'] is None:
        return dict(state='unavailable', runtimeId=runtime['runtimeId'], invocationId=probe['invocationId'],
                    generation=probe['generation'], probeDiagnostic=normalize_probe_diagnostic(probe['probeError']))
    seat = probe['probe']['seat']
    steer_capable = 'steer' in (probe.get('admissionClasses') or [])
    created_at = {} if runtime.get('createdAt') is None else {'runtimeCreatedAt': runtime['createdAt']}
    if seat['state'] == 'turn-active':
        return dict(state='turn-active', runtimeId=runtime['runtimeId'], turnId=str(seat['turnId']),
                    steerCapable=steer_capable,
                    **({'awaitingInput': True} if runtime['status'] == 'awaiting_input' else {}), **created_at)
    if seat['state'] == 'turn-observed':
        return dict(state='turn-observed', runtimeId=runtime['runtimeId'], turnId=str(seat['turnId']))
    if seat['state'] == 'idle':
        return dict(state='idle', runtimeId=runtime['runtimeId'], steerCapable=steer_capable,
                    **({'awaitingInput': True} if runtime['status'] == 'awaiting_input' else {}), **created_at)
    return dict(state=seat['state'], runtimeId=runtime['runtimeId'])


MAX_PROBE_MESSAGE_LENGTH = 240


def normalize_probe_diagnostic(probe_error):
    if probe_error is None:
        return dict(boundary='broker_probe', code='missing_probe_diagnostic',
                    message='HRC returned a null seat probe without a diagnostic', phase='seat_probe',
                    retryable=None, transport=None, missing=True)
    code = bounded_text(probe_error['code'], 80) or 'unknown_probe_error'
    message = bounded_text(probe_error['message'], MAX_PROBE_MESSAGE_LENGTH) or 'no probe message supplied'
    return dict(boundary='broker_probe', code=code, message=message, phase='seat_probe',
                retryable=None, transport=None, missing=False)


def bounded_text(value, limit):
    raw = value.encode('utf-16-le', 'surrogatepass')
    return value if len(raw) // 2 <= limit else raw[:max(0, limit - 13) * 2].decode('utf-16-le', 'surrogatepass') + '…[truncated]'
