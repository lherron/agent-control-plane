"""Keyed HRC facts; translation of policy/facts/hrc-facts.ts."""
import asyncio
from weakref import WeakKeyDictionary
from .act_internal import format_session_ref

FOREIGN_HOME_TTL_MS = 5 * 60_000
DESIGNATIONS_TTL_MS = 5 * 60_000
BENIGN_PREFIXES = ['turn.', 'broker.', 'submission.']
BENIGN_KINDS = {'runtime.context.updated', 'runtime.presentation', 'session.annotation.changed', 'target.literal-input'}
INCARNATION_PREFIX = 'server.'
INCARNATION_KINDS = {'store.migrated'}


def is_structural_lifecycle_kind(event_kind):
    if event_kind in BENIGN_KINDS:
        return False
    return not any(event_kind.startswith(prefix) for prefix in BENIGN_PREFIXES)


class HrcFacts:
    def __init__(self, port, now):
        self.lifecycle_attached = False
        self.lifecycle_up = True
        self.broker_attached = False
        self.broker_up = True
        self.lifecycle_epoch = 0
        self.broker_epoch = 0
        self.next_tick = 1
        self.versions = {}
        self.entries = {}
        self.inflight = {}
        self.reads = dict(home=0, locate=0, target=0, live=0, designations=0, bindings=0)
        self.dirty_envelopes = {}
        self.dirty_runtimes = {}
        self.reconcile_memo = {}
        self.live_runtime_memo = {}
        self.stalled_launch_memo = {}
        self.port = port
        self.now = now

    @property
    def serving(self):
        return self.lifecycle_attached and self.lifecycle_up

    @property
    def broker_keyed(self):
        return self.serving and self.broker_attached and self.broker_up

    @property
    def epoch(self):
        return f'{self.lifecycle_epoch}:{self.broker_epoch}'

    def tick(self):
        tick = self.next_tick
        self.next_tick += 1
        return tick

    def attach_lifecycle(self):
        self.lifecycle_attached = True
        self.lifecycle_up = True

    def attach_broker(self):
        self.broker_attached = True
        self.broker_up = True

    def detach(self):
        self.lifecycle_attached = False
        self.broker_attached = False
        self.reset()

    def lifecycle_stream_state(self, state):
        if state == 'down':
            self.lifecycle_up = False
            return
        self.reset()
        self.lifecycle_up = True

    def broker_stream_state(self, state):
        if state == 'down':
            self.broker_up = False
            return
        self.broker_epoch += 1
        self.broker_up = True

    def reset(self):
        self.lifecycle_epoch += 1
        self.entries.clear()
        self.versions.clear()
        self.live_runtime_memo.clear()
        self.stalled_launch_memo.clear()

    def scope_version(self, scope_ref):
        return f"{self.lifecycle_epoch}:{self.versions.get(f'scope:{scope_ref}', 0)}"

    def runtime_version(self, runtime_id):
        return f"{self.lifecycle_epoch}:{self.versions.get(f'runtime:{runtime_id}', 0)}"

    async def foreign_home(self, scope_ref, options=None):
        return await self.read(f'home:{scope_ref}', 'home',
                               lambda: self.port().resolve_foreign_home(scope_ref), options or {},
                               lambda value: None if value is None else FOREIGN_HOME_TTL_MS)

    async def locate(self, scope_ref, options=None):
        return await self.read(f'locate:{scope_ref}', 'locate',
                               lambda: self.port().locate(scope_ref), options or {},
                               lambda value: None if value is None else FOREIGN_HOME_TTL_MS)

    async def target(self, target_session_ref, options=None):
        async def load():
            target = await self.port().target_by_session_ref(target_session_ref)
            if target is None:
                try:
                    await self.unborn_designations({'fresh': True})
                except Exception:
                    pass
            return target
        return await self.read(f'target:{target_session_ref}', 'target', load, options or {})

    async def live_session_refs(self):
        return await self.read('live', 'live', lambda: self.port().live_session_refs(), {})

    async def unborn_designations(self, options=None):
        return await self.read('designations', 'designations', lambda: self.port().unborn_designations(),
                               options or {}, lambda value: DESIGNATIONS_TTL_MS)

    async def local_placement_bindings(self):
        return await self.read('bindings', 'bindings', lambda: self.port().local_placement_bindings(),
                               {}, lambda value: DESIGNATIONS_TTL_MS)

    def invalidate_target(self, target_session_ref):
        scope_ref = scope_of(target_session_ref)
        self.bump(f'target:{target_session_ref}')
        if scope_ref is not None:
            self.dirty_scope(scope_ref)
        self.bump('live')
        self.bump('designations')
        self.bump('bindings')

    def observe(self, event):
        kind = event['eventKind']
        if kind.startswith(INCARNATION_PREFIX) or kind in INCARNATION_KINDS:
            self.reset()
            return
        target_session_ref = (format_session_ref(event['scopeRef'], event['laneRef'])
                              if event.get('scopeRef') is not None and event.get('laneRef') is not None else None)
        if is_structural_lifecycle_kind(kind):
            if target_session_ref is not None:
                self.invalidate_target(target_session_ref)
            else:
                self.bump('live')
                self.bump('designations')
                self.bump('bindings')
            if event.get('runtimeId') is not None:
                self.bump(f"runtime:{event['runtimeId']}")
            return
        if target_session_ref is None or event.get('hostSessionId') is None:
            return
        cached = self.entries.get(f'target:{target_session_ref}')
        if cached is None:
            return
        session = cached['value']
        if (session is None or session['hostSessionId'] != event['hostSessionId'] or
                (event.get('generation') is not None and event['generation'] > session['generation'])):
            self.invalidate_target(target_session_ref)

    def dirty_scope(self, scope_ref):
        self.bump(f'scope:{scope_ref}')
        self.bump(f'home:{scope_ref}')
        self.bump(f'locate:{scope_ref}')

    def bump(self, key):
        self.versions[key] = self.versions.get(key, 0) + 1
        self.entries.pop(key, None)

    async def read(self, key, counter, load, options, ttl_ms=None):
        if not self.serving:
            self.reads[counter] += 1
            return await load()
        if options.get('fresh') is True:
            self.bump(key)
        entry = self.entries.get(key)
        version = self.versions.get(key, 0)
        if entry is not None and entry['epoch'] == self.lifecycle_epoch and entry['version'] == version:
            ttl = ttl_ms(entry['value']) if ttl_ms is not None else None
            if ttl is None or self.now() - entry['atMs'] < ttl:
                return entry['value']
            self.entries.pop(key, None)
        pending = self.inflight.get(key)
        if pending is not None and options.get('fresh') is not True:
            return await asyncio.shield(pending)
        epoch = self.lifecycle_epoch
        async def perform_read():
            self.reads[counter] += 1
            value = await load()
            if self.lifecycle_epoch == epoch and self.versions.get(key, 0) == version:
                self.entries[key] = dict(value=value, epoch=epoch, version=version, atMs=self.now())
            return value
        read = asyncio.create_task(perform_read(), eager_start=True)
        self.inflight[key] = read
        try:
            return await asyncio.shield(read)
        finally:
            def release(done):
                if self.inflight.get(key) is done:
                    self.inflight.pop(key, None)
            if read.done():
                release(read)
            else:
                # Cancelling a waiter must neither cancel nor unshare the load.
                read.add_done_callback(release)


def scope_of(target_session_ref):
    index = target_session_ref.rfind('/lane:')
    return target_session_ref[:index] if index > 0 else None


facts_by_context = WeakKeyDictionary()


def hrc_facts(server):
    facts = facts_by_context.get(server)
    if facts is None:
        facts = HrcFacts(lambda: server.port, server.now_ms)
        facts_by_context[server] = facts
    return facts
