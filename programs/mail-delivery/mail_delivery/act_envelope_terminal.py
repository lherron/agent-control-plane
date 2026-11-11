"""The one HRC boundary for an unsuccessful envelope terminal transition;
translation of policy/terminal/envelope-terminal.ts."""
import os
import sys
from weakref import WeakKeyDictionary
from .act_hrc_port import TERMINAL_RUNTIME_STATUSES
from .act_internal import parse_session_ref

server_instance_ids = WeakKeyDictionary()


def terminal_actor_identity(server):
    """Process-local identity for a terminal RPC attempt."""
    server_instance_id = server_instance_ids.get(server)
    if server_instance_id is None:
        server_instance_id = server.new_uuid()
        server_instance_ids[server] = server_instance_id
    entry = sys.argv[0].split('/')[-1] if len(sys.argv) > 0 and sys.argv[0] else 'unknown-entry'
    command = ' '.join(sys.argv[1:3])
    return dict(processId=os.getpid(), processArgv0=sys.orig_argv[0] if sys.orig_argv else '',
                processRole=entry if command == '' else f'{entry}:{command}', serverInstanceId=server_instance_id)


async def live_runtime_for_target(server, target_session_ref):
    """A local runtime row is live until monitor truth classifies it runtime-dead."""
    try:
        target = parse_session_ref(target_session_ref)
    except Exception:
        return None
    return next((runtime for runtime in await server.port.live_runtimes(target['scopeRef'])
                 if runtime.get('scopeRef') == target['scopeRef'] and runtime.get('laneRef') == target['laneRef']
                 and runtime.get('status') not in TERMINAL_RUNTIME_STATUSES), None)


async def fail_envelope_with_audit(server, input):
    actor = terminal_actor_identity(server)
    if (input['reason'] == 'undeliverable' and
            input['callSite'] != 'non_landing_strikes_exhausted' and
            input['callSite'] != 'launch_birth_exhausted' and
            input['callSite'] != 'target_task_terminal' and
            input['callSite'] != 'launch_cwd_missing'):
        live = await live_runtime_for_target(server, input['targetSessionRef'])
        if live is not None:
            server.log('WARN', 'wrkq.kicker.envelope_terminal_suppressed', dict(
                **actor, operation='fail', callSite=input['callSite'], targetSessionRef=input['targetSessionRef'],
                envelope=input['envelope'], reason=input['reason'], runtimeId=live['runtimeId'],
                runtimeStatus=live['status'], suppression='live_target'))
            return dict(outcome='suppressed_live_target', runtimeId=live['runtimeId'], runtimeStatus=live['status'])

    server.log('INFO', 'wrkq.kicker.envelope_terminal_call', dict(
        **actor, operation='fail', callSite=input['callSite'], targetSessionRef=input['targetSessionRef'],
        **({} if input.get('presentationId') is None else {'presentationId': input['presentationId']}),
        envelope=input['envelope'], reason=input['reason'],
        **({} if input.get('runtime') is None else {'runtime': input['runtime']}),
        phase='before_rpc'))
    failed = await server.ledger.fail(dict(
        envelope=input['envelope'], reason=input['reason'],
        **({} if input.get('detail') is None else {'detail': input['detail']}),
        **({} if input.get('runtime') is None else {'runtime': input['runtime']})))
    server.log('INFO', 'wrkq.kicker.envelope_failed', dict(
        **actor, callSite=input['callSite'], targetSessionRef=input['targetSessionRef'],
        **({} if input.get('presentationId') is None else {'presentationId': input['presentationId']}),
        envelope=input['envelope'], reason=input['reason'],
        **({} if input.get('runtime') is None else {'runtime': input['runtime']}),
        state=failed['state']))
    return dict(outcome='failed', envelope=failed)
