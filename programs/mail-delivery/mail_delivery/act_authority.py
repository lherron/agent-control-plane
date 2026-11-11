"""Home and birth authority; translation of policy/drive/authority.ts."""
import os
from pathlib import Path
from .act_contracts import HrcDomainError, HrcErrorCode
from .act_internal import is_record, is_runtime_unavailable_status, parse_session_ref


async def presentation_runtime_id_for(server, session):
    runtimes = await server.port.runtimes_by_host_session(session['hostSessionId'])
    for index in range(len(runtimes) - 1, -1, -1):
        runtime = runtimes[index]
        if runtime is None:
            continue
        if runtime['generation'] != session['generation']:
            continue
        if is_runtime_unavailable_status(runtime['status']):
            continue
        return runtime['runtimeId']
    return None


def kicker_scope_ref_for(target_session_ref):
    try:
        return parse_session_ref(target_session_ref)['scopeRef']
    except ValueError:
        return None


def skip_foreign_homed_target(server, target_session_ref, scope_ref, foreign, wake_reason):
    resolved_birth = server.store.mail_delivery.resolve_birth_refusal(
        target_session_ref, f"{scope_ref} is homed on {foreign['homeNodeId']}; this node has no authority to drive it")
    server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)
    announcement = foreign['homeNodeId']
    already_announced = server.mail_kicker_foreign_home_announced.get(scope_ref) == announcement
    server.mail_kicker_foreign_home_announced[scope_ref] = announcement
    if already_announced and not resolved_birth:
        return
    server.log('INFO', 'wrkq.kicker.foreign_home_skipped', dict(
        targetSessionRef=target_session_ref, scopeRef=scope_ref, homeNodeId=foreign['homeNodeId'],
        source=foreign['source'], wakeReason=wake_reason, resolvedBirthRefusal=resolved_birth))


def birth_deferral_for(error):
    if not isinstance(error, HrcDomainError):
        return None
    reason = error.detail.get('reason')
    if reason not in ('birth-designated-elsewhere', 'designated-home-unreachable', 'birth-designation-mismatch'):
        return None
    designation = error.detail.get('birthDesignation')
    if not is_record(designation):
        return None
    home_node_id = designation.get('homeNodeId')
    designation_epoch = designation.get('designationEpoch')
    birth_envelope_id = designation.get('birthEnvelopeId')
    sender_scope_ref = designation.get('senderScopeRef')
    provenance = designation.get('provenance')
    if (not isinstance(home_node_id, str) or type(designation_epoch) not in (int, float)
            or not isinstance(birth_envelope_id, str) or not isinstance(sender_scope_ref, str)
            or not isinstance(provenance, str)):
        return None
    return dict(reason=reason, homeNodeId=home_node_id, designationEpoch=designation_epoch,
                birthEnvelopeId=birth_envelope_id, senderScopeRef=sender_scope_ref, provenance=provenance)


def defer_birth_for_target(server, target_session_ref, scope_ref, deferral, wake_reason):
    resolved_birth = server.store.mail_delivery.resolve_birth_refusal(
        target_session_ref, f"{scope_ref} is designated to be born on {deferral['homeNodeId']}; this node takes no part in the birth")
    server.mail_kicker_birth_sweep_backoff.pop(target_session_ref, None)
    announcement = f"{deferral['homeNodeId']}@{deferral['designationEpoch']}"
    already_announced = server.mail_kicker_birth_deferred_announced.get(scope_ref) == announcement
    server.mail_kicker_birth_deferred_announced[scope_ref] = announcement
    if already_announced:
        return
    server.log('INFO', 'wrkq.kicker.birth_deferred', dict(
        targetSessionRef=target_session_ref, scopeRef=scope_ref, birthEnvelopeId=deferral['birthEnvelopeId'],
        senderScopeRef=deferral['senderScopeRef'], homeNodeId=deferral['homeNodeId'], provenance=deferral['provenance'],
        designationEpoch=deferral['designationEpoch'], reason=deferral['reason'], wakeReason=wake_reason,
        resolvedBirthRefusal=resolved_birth))


def deterministic_birth_refusal_for(error):
    if not isinstance(error, HrcDomainError):
        return None
    if error.code == 'cwd_missing':
        return dict(code='cwd_missing', message=error.message)
    if error.code != HrcErrorCode.DECLARATION_INVALID:
        return None
    if local_placement_refusal_for(error) is not None:
        return None
    source = error.detail.get('source')
    return dict(code=error.code, message=error.message, **({'source': source} if isinstance(source, str) else {}))


def local_placement_refusal_for(error):
    if not isinstance(error, HrcDomainError):
        return None
    if error.code != HrcErrorCode.DECLARATION_INVALID:
        return None
    source = error.detail.get('source')
    if source != 'project-targets':
        return None
    home = error.detail.get('home')
    project_id = error.detail.get('projectId')
    project_root = error.detail.get('projectRoot')
    return dict(source=source, message=error.message,
                home=home if isinstance(home, str) else os.environ.get('HOME', str(Path.home())),
                **({'projectId': project_id} if isinstance(project_id, str) else {}),
                **({'projectRoot': project_root} if isinstance(project_root, str) else {}))


async def live_runtime_home_elsewhere(server, scope_ref):
    report = await server.port.federated_live_runtimes(scope_ref)
    complete = len(report['unansweredNodeIds']) == 0
    def is_local(node_id):
        return node_id == server.node_id or node_id == report['localNodeId']
    if any(is_local(node_id) for node_id in report['liveNodeIds']):
        return dict(home=None, complete=complete)
    home_node_id = next((node_id for node_id in report['liveNodeIds'] if not is_local(node_id)), None)
    if home_node_id is None:
        return dict(home=None, complete=complete)
    bindings = await server.port.local_placement_bindings()
    bound_here = any(binding['scopeRef'] == scope_ref and binding['state'] == 'active'
                     and binding['homeNodeId'] == server.node_id for binding in bindings['bindings'])
    return dict(home=None if bound_here else dict(homeNodeId=home_node_id, source='federated-runtime'), complete=complete)


def participant_only_refusal_for(error):
    if not isinstance(error, HrcDomainError):
        return None
    if error.detail.get('reason') != 'participant-only':
        return None
    return dict(message=error.message)


PARTICIPANT_HOST_REFUSAL_REASONS = {
    'host_absent', 'participant_attempt_absorbing', 'participant_substitution', 'participant_attachment_pending',
    'participant_activation_pending', 'participant_reconnect_in_progress', 'participant_reconnecting',
    'participant_runtime_not_materialized',
}


def participant_host_refusal_for(error):
    if not isinstance(error, HrcDomainError):
        return None
    reason = error.detail.get('reason')
    if not isinstance(reason, str) or reason not in PARTICIPANT_HOST_REFUSAL_REASONS:
        return None
    return dict(reason=reason)
