"""Exact deferral wake timers; translation of policy/wake/deferred.ts.

Existing envelope.deferred evidence supplies both recipient and retry clock.
"""
import asyncio
import math
from weakref import WeakKeyDictionary
from .act_authority import kicker_scope_ref_for
from .act_hrc_facts import hrc_facts
from .act_internal import error_text
from .act_js import INFINITY, OrderedSet, date_parse
from .act_scope import target_session_ref_for_ledger_scope

MAX_TIMER_MS = 2_147_483_647
RETRY_MS = 30_000

REPEND_BACKOFF_MS = (1000, 2000, 5000)

wakes = WeakKeyDictionary()


async def observe_deferred_wake(server, envelope_id):
    forget_deferred_wake(server, envelope_id)
    envelope = await server.ledger.envelope_show({'envelope': envelope_id})
    if server.stopping or envelope.get('state') != 'deferred' or envelope.get('retryAt') is None:
        return
    scope_ref = (envelope.get('to') or {}).get('scopeRef')
    if scope_ref is None:
        return
    target = target_session_ref_for_ledger_scope(scope_ref)
    canonical_scope = None if target is None else kicker_scope_ref_for(target)
    if target is None or canonical_scope is None:
        return
    if (await hrc_facts(server).foreign_home(canonical_scope, {'fresh': True})) is not None:
        return
    if server.stopping:
        return
    at_ms = date_parse(envelope['retryAt'])
    if at_ms is None or not math.isfinite(at_ms):
        return
    state = wakes.get(server)
    if state is None:
        state = dict(deadlines={}, timer=None, retryAtMs=0)
        wakes[server] = state
    # wrkq compares due times at whole-second precision. Give its whole-second
    # due check one full second beyond that boundary.
    state['deadlines'][envelope_id] = dict(target=target, atMs=math.ceil(at_ms / 1_000) * 1_000 + 1000, attempts=0)
    arm(server, state)


def forget_deferred_wake(server, envelope_id):
    state = wakes.get(server)
    if state is None:
        return
    state['deadlines'].pop(envelope_id, None)
    arm(server, state)


def stop_deferred_wakes(server):
    """Cancel clocks now; the controller includes the outstanding read in its bounded drain."""
    state = wakes.get(server)
    if state is not None and state['timer'] is not None:
        state['timer'].cancel()
    if state is not None:
        state['deadlines'].clear()
    wakes.pop(server, None)
    return server.mail_kicker_deferral_wake_in_flight


def next_deferred_wake_at(server):
    """The existing exact timer remains the owner of repending due deferrals."""
    state = wakes.get(server)
    if state is None or server.mail_kicker_deferral_wake_in_flight is not None:
        return INFINITY
    next = INFINITY
    for deadline in state['deadlines'].values():
        next = min(next, deadline['atMs'])
    return max(next, state['retryAtMs'])


def arm(server, state):
    if state['timer'] is not None:
        state['timer'].cancel()
    state['timer'] = None
    if (server.stopping or server.mail_kicker_deferral_wake_in_flight is not None or
            len(state['deadlines']) == 0):
        return
    next_at_ms = INFINITY
    for deadline in state['deadlines'].values():
        next_at_ms = min(next_at_ms, deadline['atMs'])
    delay = max(0, max(next_at_ms, state['retryAtMs']) - server.now_ms())

    def fire():
        state['timer'] = None
        due = [(id, deadline) for id, deadline in state['deadlines'].items()
               if deadline['atMs'] <= server.now_ms()]
        if len(due) == 0:
            arm(server, state)
            return

        async def operation_body():
            try:
                view = await server.ledger.pending_view(dict(
                    scopes=list(OrderedSet(deadline['target'] for _, deadline in due)), includeFyi=True))
                if server.stopping:
                    return
                pending = set(envelope.get('id') for envelope in view['items'] if envelope.get('state') == 'pending')
                targets = OrderedSet()
                for id, deadline in due:
                    if state['deadlines'].get(id) is not deadline:
                        continue
                    if id in pending:
                        state['deadlines'].pop(id, None)
                        targets.add(deadline['target'])
                        continue
                    backoff = REPEND_BACKOFF_MS[deadline['attempts']] if deadline['attempts'] < len(REPEND_BACKOFF_MS) else None
                    if backoff is None:
                        state['deadlines'].pop(id, None)
                        server.log('WARN', 'wrkq.kicker.deferral_wake_exhausted', dict(envelope=id))
                    else:
                        deadline['attempts'] += 1
                        deadline['atMs'] = server.now_ms() + backoff
                state['retryAtMs'] = 0
                for target in targets:
                    server.wake(target, 'periodic')
            except Exception as error:
                state['retryAtMs'] = server.now_ms() + RETRY_MS
                server.log('WARN', 'wrkq.kicker.deferral_wake_failed', dict(error=error_text(error)))

        operation = asyncio.get_running_loop().create_task(operation_body(), eager_start=True)

        def finished(_task):
            if server.mail_kicker_deferral_wake_in_flight is operation:
                server.mail_kicker_deferral_wake_in_flight = None
            arm(server, state)
        operation.add_done_callback(finished)
        server.mail_kicker_deferral_wake_in_flight = operation

    state['timer'] = asyncio.get_running_loop().call_later(min(delay, MAX_TIMER_MS) / 1000, fire)
