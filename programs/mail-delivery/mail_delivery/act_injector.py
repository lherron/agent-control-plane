"""Start and stop the mail injector; translation of the body of
packages/hrc-mail-injector/src/index.ts (`startMailInjector`).

`start_mail_injector(options)` is started and stopped by its caller; it does
not decide whether it should run (no flag, no lock). Its `stop()` ends in the
order the handover design depends on: controller stopped (tasks drained to the
bound, then cancelled), HRC port stopped, wrkq client closed, store closed.
After it returns nothing of that controller can write the store or call an
owner. A task cancelled mid-act leaves its intent open for the next start's
reconcile; nothing here finishes or undoes it.

Options (snake_case of `MailInjectorOptions`): socket_path, state_path,
node_id, import_from ({'sourcePath': ...}, optional), sweep_interval_ms
(default 1000), log (optional; default JSON lines on stdout), user_agent
(optional HRC client user agent). Harness-only: now_ms, new_uuid,
wrkq_command.
"""
import asyncio
import json
import os
import sqlite3
import sys
from .act_controller import create_mail_kicker
from .act_hrc_port import CALLER, HrcClient, create_kicker_port
from .act_js import iso_from_ms
from .act_wrkq_ledger import create_wrkq_ledger
from .store import open_store, system_clock

ASSERT_ADMISSIBLE_REFUSAL = 'HRC still owns in-process mail delivery; injector admission refused'


def assert_injector_admissible(posture):
    """hrc-injector-core `assertInjectorAdmissible`."""
    if posture == 'in-process':
        raise RuntimeError(ASSERT_ADMISSIBLE_REFUSAL)


def assert_mail_injector_posture(posture):
    if posture != 'disabled' and posture != 'absent' and posture != 'in-process':
        raise RuntimeError('HRC status has no recognized mailKicker delivery posture')
    assert_injector_admissible(posture)


def read_injector_import_marker(path, source_path=None):
    """hrc-injector-core `readInjectorImportMarker`: the durable provenance marker that gates startup."""
    if not os.path.exists(path):
        return None
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        if source_path is None:
            row = db.execute('SELECT source_path, imported_at FROM injector_store_imports '
                             'ORDER BY imported_at DESC LIMIT 1').fetchone()
        else:
            row = db.execute('SELECT source_path, imported_at FROM injector_store_imports WHERE source_path = ?',
                             (source_path,)).fetchone()
        return None if row is None else dict(sourcePath=row[0], importedAt=row[1])
    finally:
        db.close()


def create_json_line_log(write=None):
    """log-line.ts `createJsonLineLog`."""
    if write is None:
        def write(chunk):
            sys.stdout.write(chunk)
            sys.stdout.flush()

    def log(level, event, detail):
        data = json.loads(json.dumps(detail, default=str))
        line = dict(ts=iso_from_ms(int(system_clock().timestamp() * 1000)), level=level.lower(),
                    component='hrc-mail-injector', event=event, **({'data': data} if len(data) > 0 else {}))
        write(json.dumps(line, ensure_ascii=False, separators=(',', ':')) + '\n')
    return log


class StartedMailInjector:
    def __init__(self, state_path, import_marker, stop):
        self.state_path = state_path
        self.import_marker = import_marker
        self._stop = stop

    async def stop(self):
        await self._stop()


async def start_mail_injector(options):
    """Start the sole external collaboration-mail delivery owner. HRC's status
    is checked before the state database is opened so an in-process writer can
    never race this process."""
    client = HrcClient(options['socket_path'], caller=CALLER,
                       **({} if options.get('user_agent') is None else {'user_agent': options['user_agent']}))
    status = await client.get_status()
    assert_mail_injector_posture(status.get('mailKicker') if isinstance(status, dict) else None)

    store = open_store(options['state_path'])
    import_from = options.get('import_from')
    try:
        # The one-time import from the old private kicker store is not ported
        # (store.py): a source that was never imported has no marker and the
        # start refuses below, as an unproven import does in the TypeScript.
        import_marker = read_injector_import_marker(
            options['state_path'], None if import_from is None else import_from['sourcePath'])
    except BaseException:
        store.close()
        raise
    if import_marker is None:
        store.close()
        raise RuntimeError('mail injector requires a verified private kicker-store import marker')

    log = options.get('log') or create_json_line_log()
    ledger = create_wrkq_ledger(**({} if options.get('wrkq_command') is None
                                   else {'command': options['wrkq_command']}))
    port = create_kicker_port(client)
    kicker = create_mail_kicker(
        dict(store=store, port=port, ledger=ledger, node_id=options['node_id'], foreign_home_memo={}, log=log,
             **({} if options.get('now_ms') is None else {'now_ms': options['now_ms']}),
             **({} if options.get('new_uuid') is None else {'new_uuid': options['new_uuid']})),
        dict(enabled=True, sweep_interval_ms=1_000 if options.get('sweep_interval_ms') is None
             else options['sweep_interval_ms']))
    stopped = None

    async def stop():
        nonlocal stopped
        if stopped is None:
            # Eager: `stopping` is set before stop() first yields, as in kicker.stop().
            stopped = asyncio.get_running_loop().create_task(teardown(), eager_start=True)
        await asyncio.shield(stopped)

    async def teardown():
        try:
            await kicker.stop()
        finally:
            try:
                port.core._stop()
            finally:
                try:
                    await ledger.close()
                finally:
                    store.close()

    try:
        await kicker.start()
    except BaseException:
        await stop()
        raise
    return StartedMailInjector(options['state_path'], import_marker, stop)
