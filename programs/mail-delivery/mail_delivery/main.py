"""Kernel entry: desired owner selects mode; only the exclusive lock admits acts."""
import asyncio
import os
from pathlib import Path
import time

from .delivery_owner import DeliveryOwner
from .deliverer_lock import DelivererLock

# The program shell calls os._exit after main returns. Retain the transaction
# through asyncio cleanup and local-frame disposal, until that actual exit.
_exit_lock = None


class EntryLoop:
    def __init__(self, program, flag, lock, start, log):
        self.program, self.flag, self.lock = program, flag, lock
        self.start, self.log = start, log
        self.controller = None
        self.waiting = False
        self.clock = time.monotonic
        self.last_owner = None
        self.retry_at = 0
        self.retry_delay = 1

    async def shutdown(self):
        if self.controller is not None:
            await self.controller.stop()
            self.controller = None
        if self.lock.held:
            self.flag.clear()
        # Never release the lock here: the program shell exits the process.

    async def step(self):
        if self.program.stopping:
            await self.shutdown()
            return
        owner = self.flag.read()['owner']
        if owner != self.last_owner:
            self.last_owner = owner
            self.retry_at, self.retry_delay = 0, 1
        if owner == 'port' and self.controller is None:
            if self.clock() < self.retry_at:
                return
            if not self.lock.try_acquire():
                if not self.waiting:
                    self.log('mail_delivery.lock_wait', holder_pid=self.flag.read()['delivering_pid'])
                    self.waiting = True
                return
            self.waiting = False
            try:
                self.flag.report('port', os.getpid())
                self.controller = await self.start()
            except Exception as error:
                # start() closes all opened clients/store before it raises.
                delay = self.retry_delay
                self.retry_at = self.clock() + delay
                self.retry_delay = min(30, delay * 2)
                self.log('mail_delivery.start_failed', level='error', message=str(error),
                         retry_in_seconds=delay)
                if not self.program.stopping:
                    self.flag.clear()
                    self.lock.release()
                return
            self.retry_at, self.retry_delay = 0, 1
            if self.program.stopping:
                await self.shutdown()
                return
            self.log('mail_injector.started', status='running', delivering=True, subscriber='mail',
                     statePath=self.controller.state_path, importMarker=self.controller.import_marker)
            self.log('mail_delivery.mode', mode='acting')
        elif owner == 'injector' and self.controller is not None:
            await self.controller.stop()
            if self.program.stopping:
                self.flag.clear()
                self.controller = None
                return
            self.flag.clear()
            self.controller = None
            self.lock.release()
            self.log('mail_delivery.mode', mode='shadow')
        elif owner == 'injector':
            self.waiting = False


class ShadowLoop:
    """Cooperative shell for the existing shadow operations, all on this thread.

    Uses the same setup and tick as shadow.main; no acting policy uses decide().
    Keeps the original bounded shadow wait; never runs beside an acting controller.
    """
    def __init__(self, program, state_path, socket_path, client):
        from .shadow import Shadow, TYPES, SWEEP_SECONDS
        from .hrc_read import HrcRead
        from .memos import Memos, InjectorLogFeeder
        from .port_inputs import PortInputs, store_batch
        self.program = program
        self.client = client
        self.memos = Memos()
        root = Path.home() / 'praesidium/var'
        self.feeder = InjectorLogFeeder(Path(os.environ.get('HRC_MAIL_INJECTOR_LOG_PATH', str(root / 'logs/hrc-runtime/hrc-mail-injector.log'))), self.memos)
        self.source = PortInputs(HrcRead(socket_path), self.memos, alive=program.alive)
        self.shadow = Shadow(self.client, self.source, lambda rows: store_batch(state_path, rows))
        self.source.read_owner = self.shadow.read
        self.watches = {self.client.open_watch(kind): kind for kind in TYPES}
        self.deadline = time.monotonic() + SWEEP_SECONDS
        self.client.log('shadow.started', sweep_seconds=SWEEP_SECONDS, recovery_seconds=300)

    def close(self):
        for watch in self.watches:
            watch.close()

    def tick(self):
        from .shadow import SWEEP_SECONDS
        ready = self.client.wait(self.watches, timeout=min(1, max(0, self.deadline - time.monotonic())))
        if ready is not None:
            watch, change = ready
            self.shadow.apply(self.watches[watch], change)
        previous = self.memos.signature()
        self.feeder.poll(self.program.alive)
        periodic = time.monotonic() >= self.deadline
        self.shadow.sweep(int(time.time()*1000), self.program.alive,
                          force=periodic or self.memos.signature() != previous,
                          clock=lambda: int(time.time()*1000), budget_seconds=2)
        self.shadow.process_first_deliveries(int(time.time()*1000), self.program.alive)
        if periodic:
            self.deadline = time.monotonic() + SWEEP_SECONDS


async def run(program):
    from .node_config import load_node_config, plist_path
    # Kernel children inherit kernel settings, not the injector's launchd env.
    # Apply the node plist before constructing any delivery path or client.
    configured = load_node_config()
    from praesidium_kernel import Client
    from .shadow import ContextClient
    from .act_wrkq_ledger import WrkqLedger
    from .act_injector import start_mail_injector
    from .build_info import ACP_COMMIT
    root = Path.home() / 'praesidium/var'
    path = os.environ.get('HRC_MAIL_INJECTOR_STATE_PATH', str(root / 'state/acp/hrc-mail-injector.sqlite'))
    socket_path = os.environ.get('HRC_SOCKET_PATH', str(root / 'run/hrc/hrc.sock'))
    client = ContextClient(Client(program), program.config)
    log = client.log
    if not configured:
        log('mail_delivery.node_config_missing', level='error', plist=str(plist_path()))
    shadow = None

    async def start():
        nonlocal shadow
        verifier = WrkqLedger()
        try:
            pin = await verifier.verify()
            if not pin['matchesPin']:
                log('mail_delivery.wrkq_pin_differs', level='warn', **pin)
        finally:
            await verifier.close()
        if program.stopping:
            raise RuntimeError('program stopping')
        if shadow is not None:
            shadow.close()
            shadow = None
        return await start_mail_injector(dict(
            socket_path=socket_path, state_path=path,
            node_id=os.environ.get('HRC_NODE_ID', 'max3'),
            user_agent=f'hrc-mail-injector/py-{ACP_COMMIT}',
            log=lambda level, event, detail: log(event, level=level.lower(), **detail)))

    loop = None
    if configured:
        flag, lock = DeliveryOwner(path), DelivererLock(path)
        global _exit_lock
        _exit_lock = lock
        loop = EntryLoop(program, flag, lock, start, log)
    log('mail_delivery.mode', mode='shadow')
    next_poll = 0
    while True:
        if program.stopping:
            if shadow is not None:
                shadow.close()
            if loop is not None:
                await loop.shutdown()
            return
        if loop is not None and time.monotonic() >= next_poll:
            await loop.step()
            next_poll = time.monotonic() + 1
        if (loop is None or loop.controller is None) and not program.stopping:
            if shadow is None:
                shadow = ShadowLoop(program, path, socket_path, client)
            shadow.tick()
        await asyncio.sleep(0.05)
    # No finally that closes the lock: program.stopping holds it until exit.


async def host(program):
    async def alive():
        while not program.stopping:
            program.alive()
            await asyncio.sleep(1)
    liveness = asyncio.create_task(alive())
    try:
        await run(program)
    finally:
        liveness.cancel()
        await asyncio.gather(liveness, return_exceptions=True)


def main(program):
    asyncio.run(host(program))
