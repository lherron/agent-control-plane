"""The one-time cold-start catch-up (T-07643); translation of policy/wake/cold-start.ts.

It DISCOVERS; it does not deliver. THROWS on a ledger failure, deliberately,
so the caller keeps the catch-up armed and retries on the next tick.
"""
from .act_hrc_facts import hrc_facts
from .act_internal import LEDGER_SWEEP_SCOPE_BATCH
from .act_js import OrderedSet
from .act_scope import target_session_ref_for_ledger_scope


def chunk(values, size):
    return [values[index:index + size] for index in range(0, len(values), size)]


def collect_pending_targets(items, targets):
    """The drive targets a `pending_view` page names, added to an existing set."""
    for envelope in items:
        scope_ref = (envelope.get('to') or {}).get('scopeRef')
        if scope_ref is None:
            continue
        session_ref = target_session_ref_for_ledger_scope(scope_ref)
        if session_ref is not None:
            targets.add(session_ref)


async def homed_target_session_refs(server):
    """Every scope this node HOMES, seated or not, from the placement ledger."""
    refs = {}
    for record in (await hrc_facts(server).local_placement_bindings())['bindings']:
        if record['state'] != 'active':
            continue
        if record['homeNodeId'] != server.node_id:
            continue
        session_ref = target_session_ref_for_ledger_scope(record['scopeRef'])
        if session_ref is not None:
            refs[session_ref] = None
    return list(refs)


async def run_mail_kicker_cold_start_catchup(server):
    homed = await homed_target_session_refs(server)
    targets = OrderedSet()
    for batch in chunk(homed, LEDGER_SWEEP_SCOPE_BATCH):
        view = await server.ledger.pending_view(dict(scopes=batch, includeFyi=True))
        if view['repended'] > 0:
            server.log('INFO', 'wrkq.kicker.deferrals_repended', dict(repended=view['repended']))
        collect_pending_targets(view['items'], targets)
    server.log('INFO', 'wrkq.kicker.cold_start_catchup', dict(homedScopes=len(homed), targets=list(targets)))
    for target_session_ref in targets:
        server.wake(target_session_ref, 'recovery')

