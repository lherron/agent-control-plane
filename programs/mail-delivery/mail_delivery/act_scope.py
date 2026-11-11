"""Translation between ledger handles and canonical HRC target refs."""
import re
from .act_internal import normalize_target_session_ref


def target_session_ref_for_ledger_scope(scope_ref):
    value = scope_ref.strip()
    if not value:
        return None
    for candidate in (value, f'{value}/lane:main'):
        try:
            return normalize_target_session_ref(candidate)
        except ValueError:
            pass
    try:
        match = re.fullmatch(r'([A-Za-z0-9._-]{1,64})(?:@([A-Za-z0-9._-]{1,64})(?::([A-Za-z0-9._-]{1,64}))?(?:/([A-Za-z0-9._-]{1,64}))?)?', value)
        if match is None:
            return None
        agent, project, task, role = match.groups()
        scope = f'agent:{agent}' + (f':project:{project}' if project else '') + (f':task:{task}' if task else '') + (f':role:{role}' if role else '')
        return normalize_target_session_ref(f'{scope}/lane:main')
    except ValueError:
        return None
