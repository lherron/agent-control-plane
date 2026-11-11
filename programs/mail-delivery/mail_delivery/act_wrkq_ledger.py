"""The injector's wrkq client: `packages/hrc-mail-injector/src/wrkq-ledger.ts`.

It carries the part of `@wrkq/client` that file uses (`client.js`,
`stdio-transport.js`, `json-rpc-channel.js`): `wrkq rpc --stdio` spawned with
no shell, one JSON-RPC frame per line, `rpc.initialize` first. The frames, the
environment, the deadlines and the drop rules are the TypeScript's.

Bun details that are reproduced on purpose: `kill()` is SIGTERM (Bun's default,
although the client's comment says SIGKILL), an exit by signal reads as
`code=128+signal`, and an environment value the TypeScript sets to `undefined`
is removed from the child's environment.
"""
import asyncio
import codecs
import json
import os
import signal

from .act_contracts import WrkqLedgerRequestError, WrkqLedgerUnavailableError

HRC_LEDGER_PRINCIPAL_REF = 'agent:hrc'
PRINCIPAL_FREE_METHODS = frozenset((
    'wrkq.monitor.eventsView',
    'wrkq.envelope.birthEnvelope',
    'wrkq.commit.wait',
    # A read; wrkq refuses an unknown principalRef field on it.
    'wrkq.task.show',
))
REQUEST_TIMEOUT_MS = 15_000
COMMIT_WAIT_DEADLINE_MS = 35_000
CALLER = 'hrc-mail-injector'
CLIENT_INFO = {'name': 'hrc-mail-injector', 'version': '0.1.0'}
STDERR_TAIL_CHARS = 64 * 1024
CLOSE_TIMEOUT_MS = 5000


class WorkRpcError(Exception):
    """`@wrkq/client` WorkRpcError: the server answered with an error frame."""

    def __init__(self, err, method, request_id):
        err = err if isinstance(err, dict) else {}
        message = err.get('message')
        self.message = 'work rpc error' if message is None else str(message)
        super().__init__(self.message)
        code = err.get('code')
        self.rpc_code = -32603 if code is None else code
        self.data = err.get('data')
        self.method = method
        self.request_id = request_id


class WrkqProtocolMismatch(RuntimeError):
    """The start check: wrkq refused the rpc.initialize handshake."""


def _js_truthy(value):
    if value is None or value is False or value == '':
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def _reject_constant(name):
    raise ValueError(f'invalid JSON constant {name}')


def _frame_text(frame):
    return json.dumps(frame, separators=(',', ':'), ensure_ascii=False) + '\n'


def _truncate(text, limit):
    return text[:limit] + '…' if len(text) > limit else text


class _TransportError(Exception):
    """A plain `Error` on the TypeScript side: the message is all it carries."""


def _js_message(error):
    return str(error)


class _StdioClient:
    """WorkClientImpl over StdioTransport and JsonRpcChannel, as one object."""

    def __init__(self, process):
        self.process = process
        self.pending = {}
        self.channel_closed = False
        self.exited = False
        self.stderr_tail = ''
        self.id_seq = 0
        self.initialized = None
        self.buffer = ''
        self.exit_seen = asyncio.Event()
        self.tasks = [
            asyncio.ensure_future(self._pump_stdout()),
            asyncio.ensure_future(self._pump_stderr()),
            asyncio.ensure_future(self._watch_exit()),
        ]

    @classmethod
    async def spawn(cls, command, env):
        process = await asyncio.create_subprocess_exec(
            command, 'rpc', '--stdio',
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, env=env)
        return cls(process)

    # JsonRpcChannel

    def _send(self, frame):
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        if self.channel_closed:
            future.set_exception(_TransportError('work rpc channel is closed'))
            return future
        if frame['id'] in self.pending:
            future.set_exception(_TransportError(f"duplicate JSON-RPC id: {frame['id']}"))
            return future
        self.pending[frame['id']] = future
        try:
            self.process.stdin.write(_frame_text(frame).encode())
        except Exception as error:
            del self.pending[frame['id']]
            future.set_exception(_TransportError(f'work rpc stdin write failed: {error}'))
        return future

    def _feed(self, chunk):
        if self.channel_closed:
            return
        self.buffer += chunk
        while (newline := self.buffer.find('\n')) >= 0:
            line = self.buffer[:newline].strip()
            self.buffer = self.buffer[newline + 1:]
            if not line:
                continue
            try:
                frame = json.loads(line, parse_constant=_reject_constant)
            except ValueError:
                error = _TransportError(
                    'work rpc protocol corruption: non-JSON frame on stdout: ' + _truncate(line, 200))
                self.kill()
                self._reject_all(error)
                return
            frame_id = frame.get('id') if isinstance(frame, dict) else None
            if frame_id is not None and frame_id in self.pending:
                future = self.pending.pop(frame_id)
                if not future.done():
                    future.set_result(frame)
            # Notifications and unknown ids have no correlation target.

    def _reject_all(self, error):
        self.channel_closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(error)
                future.exception()  # an abandoned request must not warn
        self.pending.clear()

    # StdioTransport

    async def _pump_stdout(self):
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        try:
            while chunk := await self.process.stdout.read(65536):
                self._feed(decoder.decode(chunk))
        except Exception:
            pass

    async def _pump_stderr(self):
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        try:
            while chunk := await self.process.stderr.read(65536):
                self.stderr_tail = (self.stderr_tail + decoder.decode(chunk))[-STDERR_TAIL_CHARS:]
        except Exception:
            pass

    async def _watch_exit(self):
        try:
            code = await self.process.wait()
            code = 128 - code if code < 0 else code
        except Exception:
            code = None
        if self.exited:
            return
        self.exited = True
        self.exit_seen.set()
        code_text = 'null' if code is None else str(code)
        tail = f'\n--- stderr tail ---\n{self.stderr_tail}' if self.stderr_tail else ''
        self._reject_all(_TransportError(f'work rpc process exited (code={code_text}){tail}'))

    def kill(self):
        if self.exited:
            return
        try:
            self.process.send_signal(signal.SIGTERM)
        except Exception:
            pass

    async def _close_transport(self):
        if self.exited:
            return
        try:
            self.process.stdin.close()
        except Exception:
            pass
        try:
            await asyncio.wait_for(self.exit_seen.wait(), CLOSE_TIMEOUT_MS / 1000)
        except TimeoutError:
            self.kill()

    # WorkClientImpl

    async def call(self, method, params=None):
        self.id_seq += 1
        request_id = f'req_{self.id_seq}'
        frame = {'jsonrpc': '2.0', 'id': request_id, 'method': method, 'caller': CALLER}
        if params is not None:
            frame['params'] = params
        response = await self._send(frame)
        error = response.get('error') if isinstance(response, dict) else None
        if _js_truthy(error):
            response_id = response.get('id')
            raise WorkRpcError(error, method, request_id if response_id is None else response_id)
        return response.get('result') if isinstance(response, dict) else None

    async def initialize(self):
        from .wrkq_pin import PROTOCOL_VERSION
        self.initialized = await self.call('rpc.initialize', {
            'protocolVersion': PROTOCOL_VERSION, 'client': dict(CLIENT_INFO)})
        return self.initialized

    async def close(self):
        try:
            await self.call('rpc.shutdown')
        except Exception:
            pass  # best effort; stdin EOF is rpc.exit
        await self._close_transport()


def _authority_environment():
    env = {}
    db = os.environ.get('HRC_WRKQ_DB', '').strip()
    if db:
        env['WRKQ_DB'] = db
        env['WRKQ_DB_PATH'] = None
        env['WRKQ_DB_PATH_FILE'] = None
    token_file = os.environ.get('HRC_WRKQD_TOKEN_FILE', '').strip()
    if token_file:
        env['WRKQD_TOKEN'] = ''
        env['WRKQD_TOKEN_FILE'] = token_file
    return env


def _child_environment():
    merged = {**os.environ, **_authority_environment(), 'PRAESIDIUM_CALLER': CALLER}
    return {name: value for name, value in merged.items() if value is not None}


async def _settled(task):
    try:
        return await asyncio.shield(task)
    except Exception:
        return None


def _quiet(task):
    if not task.cancelled():
        task.exception()


class WrkqLedger:
    """One lazy, initialized transport per channel; failures reconnect on the next call."""

    def __init__(self, command='wrkq'):
        self._command = command
        # The stdio forwarder is serial. A parked wait must never block delivery
        # reads and writes (or their shorter deadlines) on the ordinary connection.
        self._connections = {'delivery': None, 'waiting': None}
        self._closed = False

    async def _deadline(self, client, method, operation, timeout_ms=None):
        timeout_ms = REQUEST_TIMEOUT_MS if timeout_ms is None else timeout_ms
        task = asyncio.ensure_future(operation)
        try:
            done, _ = await asyncio.wait({task}, timeout=timeout_ms / 1000)
        except asyncio.CancelledError:
            task.cancel()
            raise
        if task in done:
            return task.result()
        task.add_done_callback(_quiet)
        error = WrkqLedgerUnavailableError(
            f'wrkq {method} did not answer within {timeout_ms}ms', method)
        client.kill()
        raise error

    async def _connect(self):
        # Initialize explicitly so the handshake also has a deadline and cleanup.
        client = await _StdioClient.spawn(self._command, _child_environment())
        try:
            await self._deadline(client, 'rpc.initialize', client.initialize())
            return client
        except BaseException:
            client.kill()
            raise

    async def _call(self, method, params, timeout_ms=None):
        if self._closed:
            raise WrkqLedgerUnavailableError('wrkq ledger is closed', method)
        channel = 'waiting' if method == 'wrkq.commit.wait' else 'delivery'
        if self._connections[channel] is None:
            task = asyncio.ensure_future(self._connect())
            task.add_done_callback(_quiet)
            self._connections[channel] = task
        pending = self._connections[channel]
        client = None
        try:
            client = await asyncio.shield(pending)
            payload = (params if method in PRINCIPAL_FREE_METHODS
                       else {'principalRef': HRC_LEDGER_PRINCIPAL_REF, **params})
            return await self._deadline(client, method, client.call(method, payload), timeout_ms)
        except Exception as error:
            # Refusals keep a healthy transport. Never replay a possibly committed
            # write. An older failing request cannot invalidate a replacement.
            if client is None or not isinstance(error, WorkRpcError):
                if self._connections[channel] is pending:
                    self._connections[channel] = None
                if client is not None:
                    client.kill()
            if isinstance(error, WorkRpcError):
                raise WrkqLedgerRequestError(
                    f'wrkq {error.method} refused: {error.message}',
                    method if error.method is None else error.method,
                    error.rpc_code, error.data) from error
            if isinstance(error, WrkqLedgerUnavailableError):
                raise
            raise WrkqLedgerUnavailableError(
                f'wrkq {method} failed: {_js_message(error)}', method) from error

    async def close(self):
        self._closed = True
        parked = self._connections['waiting']
        self._connections['waiting'] = None
        # Closing the transport cancels the parked wait too. Graceful shutdown
        # would itself queue behind that wait in the serial forwarder.
        if parked is not None:
            client = await _settled(parked)
            if client is not None:
                client.kill()
        pending = self._connections['delivery']
        self._connections['delivery'] = None
        if pending is None:
            return
        client = await _settled(pending)
        if client is None:
            return
        try:
            await self._deadline(client, 'rpc.shutdown', client.close())
        except Exception:
            client.kill()

    async def commit_wait(self, params):
        requested = params.get('timeoutMs')
        timeout_ms = max(1000, min(25000, 25000 if requested is None else requested))
        return await self._call('wrkq.commit.wait', {**params, 'timeoutMs': timeout_ms},
                                COMMIT_WAIT_DEADLINE_MS)

    async def pending_view(self, params):
        return await self._call('wrkq.envelope.pendingView', params)

    async def present(self, params):
        return await self._call('wrkq.envelope.present', params)

    async def fail(self, params):
        return await self._call('wrkq.envelope.fail', params)

    async def envelope_show(self, params):
        return await self._call('wrkq.envelope.show', params)

    async def task_show(self, params):
        return await self._call('wrkq.task.show', params)

    async def events_view(self, params):
        view = await self._call('wrkq.monitor.eventsView', params)
        if view is None:
            raise TypeError("null is not an object (evaluating 'view.items')")
        view = view if isinstance(view, dict) else {}
        items = view.get('items')
        high_water = view.get('high_water')
        return {
            'items': [_map_monitor_event(row) for row in items] if isinstance(items, list) else [],
            'highWater': high_water if _is_number(high_water) else params.get('cursor'),
        }

    async def verify(self, envelope='EN-00000'):
        """Start check: one envelope read on the delivery connection.

        Raises when the read cannot be made or wrkq refuses the handshake. A
        schema hash or version that differs from the pin is reported in
        `matchesPin`, never raised.
        """
        from .wrkq_pin import PROTOCOL_SCHEMA_HASH, PROTOCOL_VERSION
        try:
            await self.envelope_show({'envelope': envelope})
        except WrkqLedgerRequestError as error:
            if error.method != 'rpc.initialize':
                pass  # wrkq answered the read; the handshake stood
            else:
                data = error.data if isinstance(error.data, dict) else {}
                raise WrkqProtocolMismatch(
                    f'wrkq refused the rpc.initialize handshake ({error.message}); '
                    f'client protocol {PROTOCOL_VERSION} schema {PROTOCOL_SCHEMA_HASH}, '
                    f"wrkq schema {data.get('serverProtocolSchemaHash', 'not reported')}") from error
        pending = self._connections['delivery']
        client = await _settled(pending) if pending is not None else None
        answered = (client.initialized or {}) if client is not None else {}
        if not isinstance(answered, dict):
            answered = {}
        server_hash = answered.get('protocolSchemaHash')
        server_version = answered.get('protocolVersion')
        # Not an error: the injector neither sends nor reads the hash and keeps
        # delivering when wrkq moves ahead of ACP's pin. The caller logs a warning.
        return {'protocolVersion': server_version, 'protocolSchemaHash': server_hash,
                'matchesPin': server_hash == PROTOCOL_SCHEMA_HASH and server_version == PROTOCOL_VERSION,
                'pinnedVersion': PROTOCOL_VERSION, 'pinnedSchemaHash': PROTOCOL_SCHEMA_HASH}


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _map_monitor_event(raw):
    row = raw if isinstance(raw, dict) else {}
    event = {
        'id': row['id'] if _is_number(row.get('id')) else 0,
        'timestamp': row['timestamp'] if isinstance(row.get('timestamp'), str) else '',
        'resourceType': row['resource_type'] if isinstance(row.get('resource_type'), str) else '',
    }
    if isinstance(row.get('resource_uuid'), str):
        event['resourceUuid'] = row['resource_uuid']
    if isinstance(row.get('resource_id'), str):
        event['resourceId'] = row['resource_id']
    event['eventType'] = row['event_type'] if isinstance(row.get('event_type'), str) else ''
    if isinstance(row.get('payload'), str):
        event['payload'] = row['payload']
    return event


def create_wrkq_ledger(command='wrkq'):
    return WrkqLedger(command)
