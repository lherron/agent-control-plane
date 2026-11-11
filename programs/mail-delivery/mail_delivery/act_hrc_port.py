"""The injector's HRC port, over HRC's unix socket.

Ports `packages/hrc-injector-core/src/socket-injection-port.ts`, the parts of
the installed `hrc-sdk` it calls (`client-transport.js`, `client-runtime.js`,
`client-diagnostics.js`, `client-chat-events.js`), and the injector's
composition in `hrc-mail-injector/src/index.ts` with `federated-runtimes.ts`
and `failure-notice-dispatch.ts`.

Every SDK method below makes the request its TypeScript namesake makes: the
same method, path, query (URLSearchParams form encoding, `String()` values),
JSON body (`JSON.stringify` key order, absent keys dropped) and the headers HRC
reads (`x-praesidium-caller`, `user-agent`, `content-type`,
`x-hrc-subscriber-name`). Each request uses its own connection.

Values: `None` at the top level of an optional field means TypeScript
`undefined` (the key is left out). A dictionary the caller passes through
verbatim (an origin, an intent, a broker query) is sent as it is, so a `None`
inside it is JSON `null`, as it would be in TypeScript.
"""
import asyncio
import functools
import json
from urllib.parse import quote, quote_plus

from .act_contracts import HrcDomainError, HrcErrorCode

MAIL_SUBSCRIBER_NAME = 'mail'
CALLER = 'hrc-mail-injector'
DEFAULT_USER_AGENT = 'hrc-mail-injector'
SUBSCRIBER_NAME_HEADER = 'x-hrc-subscriber-name'
BROKER_FOLLOW_LIMIT = 500
RECONNECT_DELAY_MS = 250
# The broker follow route answers at once and has no long-poll, so it is read
# when a lifecycle event rings the doorbell. This timer only bounds how long a
# broker row with no lifecycle neighbour can wait.
BROKER_IDLE_POLL_MS = 60_000
# One tool call rings a dozen lifecycle events; read the broker once for the burst.
BROKER_RING_COALESCE_MS = 250
ERROR_BODY_EXCERPT_MAX = 200
ELLIPSIS = '…'
EVENT_FILTER_FIELDS = ('hostSessionId', 'generation', 'scopeRef', 'laneRef', 'runtimeId', 'runId',
                       'category', 'eventKind', 'sourceRef')

# spaces-runtime-contracts RUNTIME_STATUS_VALUES plus hrc-core's stored extras.
RUNTIME_STATUSES = frozenset((
    'allocating', 'compiling', 'admitted', 'starting', 'ready', 'busy', 'stopping', 'stopped',
    'failed', 'unknown_after_restart', 'disposed', 'awaiting_input', 'stale', 'terminated',
    'crashed', 'detached', 'dead', 'adopted',
    'broker-ipc-unavailable', 'pending', 'idle', 'running', 'exited'))
# hrc-core monitor/status-levels.js: statuses classified `runtime-dead`.
TERMINAL_RUNTIME_STATUSES = frozenset((
    'dead', 'stale', 'terminated', 'stopped', 'failed', 'disposed', 'crashed', 'exited'))


class HrcRequestError(Exception):
    """A plain `Error` thrown by the SDK or the port: no code, only a message."""


def parse_hrc_runtime_status(value):
    if isinstance(value, str) and value in RUNTIME_STATUSES:
        return value
    raise HrcRequestError(f'Invalid stored runtime status: {_js_string(value)}')


def is_terminal_runtime_status(status):
    return status is not None and status in TERMINAL_RUNTIME_STATUSES


# ── JavaScript value rendering ───────────────────────────────────────────────

def _js_string(value, in_array=False):
    if value is None:
        return '' if in_array else 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() and abs(value) < 1e21 else repr(value)
    if isinstance(value, list):
        return ','.join(_js_string(item, True) for item in value)
    if isinstance(value, dict):
        return '[object Object]'
    return str(value)


def _js_truthy(value):
    if value is None or value is False or value == '':
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0 and value == value
    return True


def _form(text):
    """application/x-www-form-urlencoded, as URLSearchParams serializes it."""
    return quote_plus(text, safe='*').replace('~', '%7E')


def _component(value):
    """encodeURIComponent."""
    return quote(_js_string(value), safe="-_.!~*'()")


def build_path(base, params):
    """hrc-sdk buildPath: skips absent values and empty arrays, joins arrays with commas."""
    pairs = []
    for name, value in params:
        if value is _ABSENT:
            continue
        if isinstance(value, list) and not value:
            continue
        text = _js_string(value)
        pairs.append(f'{_form(name)}={_form(text)}')
    return f"{base}?{'&'.join(pairs)}" if pairs else base


class _Absent:
    def __repr__(self):
        return 'undefined'


_ABSENT = _Absent()


def _opt(mapping, key):
    """`mapping?.[key]`: absent for a missing key, a missing mapping or None."""
    if not isinstance(mapping, dict):
        return _ABSENT
    value = mapping.get(key, _ABSENT)
    return _ABSENT if value is None else value


def _empty_to_absent(value):
    return value if _js_truthy(value) and value is not _ABSENT else _ABSENT


def _bool_field(value):
    return 'true' if _js_truthy(value) and value is not _ABSENT else _ABSENT


def _event_filter_params(source):
    return [(field, _opt(source, field)) for field in EVENT_FILTER_FIELDS]


def _runtime_filter_params(source):
    return [
        ('hostSessionId', _empty_to_absent(_opt(source, 'hostSessionId'))),
        ('transport', _empty_to_absent(_opt(source, 'transport'))),
        ('status', _opt(source, 'status')),
        ('stale', _opt(source, 'stale')),
        ('olderThan', _empty_to_absent(_opt(source, 'olderThan'))),
        ('scope', _empty_to_absent(_opt(source, 'scope'))),
        ('agent', _empty_to_absent(_opt(source, 'agent'))),
        ('task', _empty_to_absent(_opt(source, 'task'))),
        ('json', _opt(source, 'json')),
        ('all', _opt(source, 'all')),
        ('omitState', _opt(source, 'omitState')),
    ]


def _json_text(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False)


def _defined(*pairs):
    """An object literal whose `undefined` members JSON.stringify drops."""
    return {key: value for key, value in pairs if value is not None and value is not _ABSENT}


def _bounded_detail_string(value):
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed[:ERROR_BODY_EXCERPT_MAX] + ELLIPSIS if len(trimmed) > ERROR_BODY_EXCERPT_MAX else trimmed


def _typed_response_error_message(error):
    code, message, detail = error.get('code'), error.get('message'), error.get('detail')
    message = '' if message is None else _js_string(message)
    if code != HrcErrorCode.INTERNAL_ERROR:
        return message
    if not isinstance(detail, dict):
        raise TypeError("undefined is not an object (evaluating 'detail[\"cause\"]')")
    cause = _bounded_detail_string(detail.get('cause'))
    request_id = _bounded_detail_string(detail.get('requestId'))
    return (f'{message} [{code}]' + (f': {cause}' if cause else '') +
            (f' (requestId={request_id})' if request_id else ''))


# ── HTTP over the unix socket ─────────────────────────────────────────────────

class _Response:
    def __init__(self, status, headers, reader, writer):
        self.status = status
        self.headers = headers
        self.reader = reader
        self.writer = writer

    @property
    def ok(self):
        return 200 <= self.status <= 299

    def header(self, name):
        return self.headers.get(name.lower())

    async def chunks(self):
        encoding = (self.header('transfer-encoding') or '').lower()
        try:
            if 'chunked' in encoding:
                while True:
                    size_line = await self.reader.readuntil(b'\r\n')
                    size = int(size_line.split(b';', 1)[0].strip() or b'0', 16)
                    if size == 0:
                        await self.reader.readuntil(b'\r\n')
                        return
                    data = await self.reader.readexactly(size)
                    await self.reader.readexactly(2)
                    yield data
            elif self.header('content-length') is not None:
                remaining = int(self.header('content-length'))
                if remaining:
                    yield await self.reader.readexactly(remaining)
            else:
                while chunk := await self.reader.read(65536):
                    yield chunk
        except asyncio.IncompleteReadError as error:
            raise HrcRequestError('The socket connection was closed unexpectedly.') from error

    async def body(self):
        try:
            return b''.join([chunk async for chunk in self.chunks()])
        finally:
            self.close()

    async def json(self):
        raw = await self.body()
        try:
            return json.loads(raw.decode())
        except ValueError as error:
            raise HrcRequestError(f'Failed to parse JSON: {error}') from error

    def close(self):
        try:
            self.writer.close()
        except Exception:
            pass


class HrcClient:
    """The subset of `hrc-sdk` HrcClient the injector calls, method for method."""

    def __init__(self, socket_path, caller=CALLER, user_agent=DEFAULT_USER_AGENT):
        self.socket_path = str(socket_path)
        self.caller = caller
        self.user_agent = user_agent

    async def unix_fetch(self, path, method='GET', body=None, headers=None):
        reader, writer = await asyncio.open_unix_connection(self.socket_path)
        try:
            lines = [f'{method} {path} HTTP/1.1', 'Host: hrc', 'Connection: close', 'Accept: */*']
            for name, value in (headers or {}).items():
                lines.append(f'{name}: {value}')
            lines.append(f'user-agent: {self.user_agent}')
            lines.append(f'x-praesidium-caller: {self.caller}')
            payload = b'' if body is None else body.encode()
            if body is not None:
                lines.append(f'Content-Length: {len(payload)}')
            writer.write(('\r\n'.join(lines) + '\r\n\r\n').encode() + payload)
            await writer.drain()
            head = await reader.readuntil(b'\r\n\r\n')
        except BaseException:
            writer.close()
            raise
        status_line, *header_lines = head.decode('latin-1').split('\r\n')
        status = int(status_line.split(' ', 2)[1])
        response_headers = {}
        for line in header_lines:
            if line:
                name, _, value = line.partition(':')
                response_headers[name.strip().lower()] = value.strip()
        return _Response(status, response_headers, reader, writer)

    async def post_json(self, path, body):
        return await self.request_json(path, 'POST', _json_text(body), {'Content-Type': 'application/json'})

    async def get_json(self, path):
        return await self.request_json(path, 'GET')

    async def request_json(self, path, method, body=None, headers=None):
        response = await self.unix_fetch(path, method, body, headers)
        if not response.ok:
            await self.throw_typed_error(response)
        return await response.json()

    async def throw_typed_error(self, response):
        raw = await response.body()
        text = raw.decode(errors='replace')
        try:
            body = json.loads(text)
        except ValueError:
            excerpt = (text[:ERROR_BODY_EXCERPT_MAX] + ELLIPSIS if len(text) > ERROR_BODY_EXCERPT_MAX
                       else text)
            suffix = f': {excerpt}' if excerpt else ''
            raise HrcRequestError(f'HRC request failed with status {response.status}{suffix}') from None
        error = body.get('error') if isinstance(body, dict) else None
        if _js_truthy(error):
            error = error if isinstance(error, dict) else {}
            detail = error.get('detail')
            raise HrcDomainError(error.get('code'), _typed_response_error_message(error), detail)
        raise HrcRequestError(f'HRC request failed with status {response.status}')

    async def stream_ndjson(self, path, signal=None, receipt_seq=None):
        """hrc-sdk streamNdjson: one value per line, acknowledging receipts before yielding."""
        response = await self.unix_fetch(path, 'GET')
        if not response.ok:
            await self.throw_typed_error(response)
        aborted = signal if signal is not None else asyncio.Event()
        watcher = asyncio.ensure_future(aborted.wait())
        watcher.add_done_callback(lambda _: response.close())
        subscriber_id = (response.header('x-hrc-subscriber-id') or '').strip()
        receipt_token = (response.header('x-hrc-receipt-token') or '').strip()
        receipt_ack_path = (response.header('x-hrc-receipt-ack-path') or '').strip()
        receipt_enabled = bool(subscriber_id and receipt_token and receipt_ack_path and receipt_seq)

        def parse(raw):
            trimmed = raw.strip()
            if not trimmed:
                return _ABSENT
            try:
                return json.loads(trimmed)
            except ValueError:
                return _ABSENT

        async def acknowledge(value):
            if not receipt_enabled:
                return
            seq = receipt_seq(value)
            if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1 or seq > 2 ** 53 - 1:
                return
            try:
                await self.post_json(receipt_ack_path, {
                    'subscriberId': subscriber_id, 'receiptToken': receipt_token, 'seq': seq})
            except Exception:
                pass

        try:
            buffer = ''
            async for chunk in response.chunks():
                if aborted.is_set():
                    return
                buffer += chunk.decode()
                *lines, buffer = buffer.split('\n')
                for line in lines:
                    value = parse(line)
                    if value is _ABSENT:
                        continue
                    await acknowledge(value)
                    yield value
                    if aborted.is_set():
                        return
            value = parse(buffer)
            if value is not _ABSENT:
                await acknowledge(value)
                yield value
        except HrcRequestError:
            if aborted.is_set():
                return
            raise
        finally:
            watcher.cancel()
            response.close()

    # -- client-runtime.js --

    async def _post_capability(self, path, request, unsupported):
        try:
            response = await self.unix_fetch(path, 'POST', _json_text(request),
                                             {'Content-Type': 'application/json'})
        except Exception as error:
            raise HrcDomainError(HrcErrorCode.RUNTIME_UNAVAILABLE,
                                 f'HRC daemon unreachable at {self.socket_path}',
                                 {'code': 'hrc_daemon_unreachable', 'socketPath': self.socket_path,
                                  'cause': str(error)}) from error
        if response.status == 404:
            response.close()
            raise HrcDomainError(HrcErrorCode.UNSUPPORTED_CAPABILITY, unsupported[0],
                                 {'capability': unsupported[1], 'route': path})
        if not response.ok:
            await self.throw_typed_error(response)
        return await response.json()

    async def resolve_runtime_intent(self, request):
        return await self._post_capability('/v1/declarations/resolve', request, (
            'HRC daemon does not serve declaration resolution', 'declarations.resolve'))

    async def get_session(self, host_session_id):
        return await self.get_json(f'/v1/sessions/by-host/{_component(host_session_id)}')

    async def steer(self, request):
        return await self.post_json('/v1/submissions/steer', request)

    async def enqueue(self, request):
        return await self.post_json('/v1/submissions/enqueue', request)

    async def invoke(self, request):
        return await self.post_json('/v1/submissions/invoke', request)

    async def preempt(self, request):
        return await self.post_json('/v1/submissions/preempt', request)

    async def preempt_admission(self, request):
        return await self.post_json('/v1/submissions/preempt/admission', request)

    async def get_seat(self, runtime_id):
        return await self.get_json(f'/v1/runtimes/{_component(runtime_id)}/seat')

    async def withdraw(self, request):
        return await self.post_json('/v1/submissions/withdraw', request)

    async def get_live_seat_refs(self):
        return await self.get_json('/v1/runtimes/live-refs')

    async def list_local_placement_bindings(self):
        return await self.get_json('/v1/placement/bindings?home=self&state=active')

    async def list_unborn_designations(self):
        return await self.get_json('/v1/federation/designations?unborn=true')

    async def events_head(self):
        return await self.get_json('/v1/events/head')

    async def query_broker_events(self, op, options=None):
        # A None member of op is TypeScript undefined: buildPath leaves it out.
        params = [(key, _ABSENT if value is None else value) for key, value in op.items()]
        if _opt(options, 'includeRetained') is True:
            params.append(('includeRetained', 'true'))
        return await self.get_json(build_path('/v1/broker-events/query', params))

    async def follow_broker_events(self, request, subscriber_name):
        params = [('afterCommit', request.get('afterCommit', _ABSENT))]
        if request.get('limit') is not None:
            params.append(('limit', request['limit']))
        if request.get('includeRetained') is True:
            params.append(('includeRetained', 'true'))
        response = await self.unix_fetch(build_path('/v1/broker-events/follow', params), 'GET',
                                         headers={SUBSCRIBER_NAME_HEADER: subscriber_name})
        if not response.ok:
            await self.throw_typed_error(response)
        return await response.json()

    async def declare_subscriber(self, request):
        return await self.post_json('/v1/server/subscribers', request)

    async def inspect_runtime(self, request):
        return await self.post_json('/v1/runtimes/inspect', request)

    # -- client-diagnostics.js --

    async def get_status(self, options=None):
        return await self.get_json(build_path('/v1/status', [
            ('includeArchived', _bool_field(_opt(options, 'includeArchived'))),
            ('includePeerHealth', _bool_field(_opt(options, 'includePeerHealth'))),
            ('includeSessions', _opt(options, 'includeSessions') is True)]))

    async def locate_scope(self, scope_ref):
        return await self.get_json(build_path('/v1/federation/locate', [('scopeRef', scope_ref)]))

    async def list_federated_runtimes(self, filter=None):
        return await self.get_json(build_path('/v1/federation/runtimes', _runtime_filter_params(filter)))

    async def list_runtimes_page(self, filter=None):
        path = build_path('/v1/runtimes', _runtime_filter_params(filter) + [
            ('limit', _opt(filter, 'limit')), ('cursor', _empty_to_absent(_opt(filter, 'cursor')))])
        response = await self.unix_fetch(path, 'GET')
        if not response.ok:
            await self.throw_typed_error(response)
        next_cursor = (response.header('x-hrc-next-cursor') or '').strip() or None
        runtimes = await response.json()
        return {'runtimes': runtimes, **({'nextCursor': next_cursor} if next_cursor is not None else {})}

    async def list_runtimes(self, filter=None):
        filter = dict(filter or {})
        if _opt(filter, 'limit') is not _ABSENT or _opt(filter, 'cursor') is not _ABSENT:
            return (await self.list_runtimes_page(filter))['runtimes']
        runtimes, cursor = [], None
        while True:
            page = await self.list_runtimes_page({**filter, 'limit': 500,
                                                  **({'cursor': cursor} if cursor is not None else {})})
            runtimes.extend(page['runtimes'])
            cursor = page.get('nextCursor')
            if cursor is None:
                return runtimes

    # -- client-chat-events.js --

    async def get_target(self, session_ref):
        return await self.get_json(f'/v1/targets/by-session-ref?sessionRef={_component(session_ref)}')

    async def ensure_target(self, request):
        return await self.post_json('/v1/targets/ensure', request)

    async def tail_events(self, options):
        return await self.get_json(build_path('/v1/events/tail', [
            ('limit', _opt(options, 'limit')), ('beforeHrcSeq', _opt(options, 'beforeHrcSeq')),
            ('ledgerIncarnationId', _opt(options, 'ledgerIncarnationId'))] + _event_filter_params(options)))

    def watch(self, options=None):
        follow = _opt(options, 'follow')
        path = build_path('/v1/events', [
            ('fromSeq', _opt(options, 'fromSeq')),
            ('follow', _bool_field(follow)),
            ('receipt', 'consumer-ack-v1' if _js_truthy(follow) and follow is not _ABSENT else _ABSENT),
        ] + _event_filter_params(options))
        return self._watch(path, options)

    async def _watch(self, path, options):
        signal = options.get('signal') if isinstance(options, dict) else None
        async for event in self.stream_ndjson(path, signal, lambda event: _seq(event, 'hrcSeq')):
            if _matches_watch_options(event, options):
                yield event


def _seq(event, key):
    return event.get(key) if isinstance(event, dict) else None


def _matches_watch_options(event, options):
    if not options:
        return True
    for field in EVENT_FILTER_FIELDS:
        if field in ('category', 'eventKind'):
            continue
        expected = _opt(options, field)
        if expected is not _ABSENT and _seq(event, field) != expected:
            return False

    def filter_list(value):
        if value is _ABSENT:
            return None
        raw = value.split(',') if isinstance(value, str) else value
        items = [item.strip() for item in raw if item.strip() != '']
        return items or None
    categories = filter_list(_opt(options, 'category'))
    kinds = filter_list(_opt(options, 'eventKind'))
    if categories is None and kinds is None:
        return True
    return ((categories is not None and _seq(event, 'category') in categories) or
            (kinds is not None and _seq(event, 'eventKind') in kinds))


# ── socket-injection-port.ts ─────────────────────────────────────────────────

def _guarded(method):
    @functools.wraps(method)
    async def wrapper(self, *args, **kwargs):
        if self._closed:
            raise HrcRequestError('socket injection port is stopped')
        return await method(self, *args, **kwargs)
    return wrapper


class SocketInjectionPort:
    """Socket-only implementation of the injector's HRC capability boundary.

    Declaring the durable `mail` subscriber is lazy and idempotent: both
    evidence feeds use the same admitted consumer identity. Once either
    follow's unsubscribe runs, the whole port is stopped and refuses calls.
    """

    def __init__(self, client, broker_idle_poll_ms=None):
        self.client = client
        self.broker_idle_poll_ms = BROKER_IDLE_POLL_MS if broker_idle_poll_ms is None else broker_idle_poll_ms
        self._closed = False
        self._stopping = asyncio.Event()
        self._broker_rung = False
        self._wake_broker = None
        self._subscriber = None

    def _stop(self):
        self._closed = True
        self._stopping.set()

    def _ring_broker(self):
        self._broker_rung = True
        if self._wake_broker is not None:
            self._wake_broker.set()

    async def _wait_for(self, event, ms):
        waits = [asyncio.ensure_future(event.wait())]
        if event is not self._stopping:
            waits.append(asyncio.ensure_future(self._stopping.wait()))
        try:
            await asyncio.wait(waits, timeout=ms / 1000, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for wait in waits:
                wait.cancel()

    async def _wait_for_stop(self, ms):
        await self._wait_for(self._stopping, ms)

    async def _wait_for_broker_ring(self, ms):
        wake = asyncio.Event()
        self._wake_broker = wake
        try:
            await self._wait_for(wake, ms)
        finally:
            if self._wake_broker is wake:
                self._wake_broker = None

    async def _declare_subscriber(self):
        attempt = self._subscriber
        if attempt is None:
            attempt = asyncio.ensure_future(self.client.declare_subscriber({'name': MAIL_SUBSCRIBER_NAME}))
            attempt.add_done_callback(lambda task: task.cancelled() or task.exception())
        self._subscriber = attempt
        try:
            await asyncio.shield(attempt)
        except Exception:
            if self._subscriber is attempt:
                self._subscriber = None
            raise

    def _invalidate_subscriber(self):
        self._subscriber = None

    async def _target_session(self, target_session_ref):
        try:
            target = await self.client.get_target(target_session_ref)
        except HrcDomainError as error:
            if error.code == HrcErrorCode.UNKNOWN_SESSION:
                return None
            raise
        if not isinstance(target, dict) or 'activeHostSessionId' not in target:
            return None
        return await self.client.get_session(target['activeHostSessionId'])

    async def _dispatch(self, door, session, intent, prompt, options):
        target = f"{_js_string(session.get('scopeRef'))}/lane:{_js_string(session.get('laneRef'))}"
        origin = options.get('submissionOrigin')
        wait = ('wait', options.get('waitForCompletion'))
        if door == 'steer':
            return await self.client.steer(_defined(('target', target), ('body', prompt), ('origin', origin), wait))
        common = (('target', target), ('body', prompt), ('origin', origin),
                  ('idempotencyKey', options.get('idempotencyKey')), ('runtimeIntent', intent),
                  ('ttlMs', options.get('ttlMs')), ('turnPolicy', options.get('turnPolicy')), wait)
        if door == 'enqueue':
            return await self.client.enqueue(_defined(*common))
        if door == 'invoke':
            cold = ('coldBirth', {'promptMode': 'replace-priming'}
                    if _js_truthy(options.get('launchPromptOnColdBirth')) else None)
            return await self.client.invoke(_defined(*common, cold))
        return await self.client.preempt(_defined(*common))

    async def _non_local_home(self, scope_ref):
        location = await self.client.locate_scope(scope_ref)
        authority = location['authority']
        if authority.get('state') != 'bound' or _js_truthy(authority.get('isLocal')):
            return None
        return {'homeNodeId': authority['record']['homeNodeId'],
                'source': 'placement-ledger' if authority.get('source') == 'ledger' else 'registry'}

    @_guarded
    async def runtime(self, runtime_id):
        # The exact runtime read, never a paginated fleet scan.
        try:
            runtime = await self.client.inspect_runtime({'runtimeId': runtime_id})
        except HrcDomainError as error:
            if error.code == HrcErrorCode.UNKNOWN_RUNTIME:
                return None
            raise
        result = {'runtimeId': runtime.get('runtimeId'),
                  'status': parse_hrc_runtime_status(runtime.get('status'))}
        if runtime.get('activeInvocationId') is not None:
            result['activeInvocationId'] = runtime['activeInvocationId']
        return result

    @_guarded
    async def runtimes_by_host_session(self, host_session_id):
        return await self.client.list_runtimes({'hostSessionId': host_session_id, 'all': True})

    @_guarded
    async def live_runtimes(self, scope_ref):
        # Without `all`, HRC answers only non-terminal rows (T-12423).
        return await self.client.list_runtimes({'scope': scope_ref})

    @_guarded
    async def live_session_refs(self):
        refs = (await self.client.get_live_seat_refs())['refs']
        return [f"{_js_string(ref.get('scopeRef'))}/lane:{_js_string(ref.get('laneRef'))}" for ref in refs]

    @_guarded
    async def seat(self, runtime_id):
        return await self.client.get_seat(runtime_id)

    @_guarded
    async def withdraw(self, input):
        try:
            response = await self.client.withdraw(input)
            outcome = response.get('outcome')
            if outcome == 'withdrawn':
                projected = {'outcome': 'withdrawn'}
            elif outcome == 'unknown':
                projected = {'outcome': 'unknown'}
            else:
                state = response.get('state')
                projected = {'outcome': 'not_held', 'state': 'terminal' if state is None else state}
            return {'ok': True, 'response': projected}
        except Exception as error:
            return {'ok': False, 'error': {'message': str(error)}}

    @_guarded
    async def resolve_foreign_home(self, scope_ref):
        return await self._non_local_home(scope_ref)

    @_guarded
    async def resolve_runtime_intent(self, scope_ref, materialization_intent):
        resolved = await self.client.resolve_runtime_intent(
            _defined(('scopeRef', scope_ref), ('materializationIntent', materialization_intent)))
        return resolved.get('intent')

    @_guarded
    async def target_by_session_ref(self, target_session_ref):
        return await self._target_session(target_session_ref)

    @_guarded
    async def ensure_target_session(self, target_session_ref, intent, options):
        target = await self.client.ensure_target({'sessionRef': target_session_ref, 'runtimeIntent': intent,
                                                  'persistIntent': options.get('persistIntent')})
        if not isinstance(target, dict) or 'activeHostSessionId' not in target:
            raise HrcRequestError(f'HRC target {target_session_ref} did not materialize a session')
        return await self.client.get_session(target['activeHostSessionId'])

    @_guarded
    async def events_head(self):
        return await self.client.events_head()

    @_guarded
    async def lifecycle_events(self, input):
        return (await self.client.tail_events({'limit': input.get('limit'), 'eventKind': input.get('eventKind'),
                                               'runtimeId': input.get('runtimeId')}))['events']

    @_guarded
    async def broker_events_query(self, op):
        return await self.client.query_broker_events(op)

    @_guarded
    async def local_placement_bindings(self):
        return await self.client.list_local_placement_bindings()

    @_guarded
    async def locate(self, scope_ref):
        return await self._non_local_home(scope_ref)

    @_guarded
    async def unborn_designations(self):
        return await self.client.list_unborn_designations()

    @_guarded
    async def subscribe_lifecycle(self, input):
        on_event, on_state = input['onEvent'], input.get('onStreamState')
        await self._declare_subscriber()

        async def operation():
            cursor = input['afterSeq']
            interrupted = False
            while not self._closed:
                try:
                    # Once per connection: a new stream is the only point where the
                    # daemon may have restarted and forgotten the `mail` admission.
                    await self._declare_subscriber()
                    if interrupted:
                        interrupted = False
                        if on_state is not None:
                            on_state('resumed')
                        # A replacement daemon may have broker commits but no new
                        # lifecycle rows to replay. Catch up from the saved commit.
                        self._ring_broker()
                    async for event in self.client.watch({'fromSeq': cursor + 1, 'follow': True,
                                                          'signal': self._stopping}):
                        if self._closed:
                            return
                        if event['hrcSeq'] <= cursor:
                            continue  # a replay overlapping what was already observed
                        cursor = event['hrcSeq']
                        on_event(event)
                        self._ring_broker()
                except Exception:
                    pass  # handled below like a clean end of stream
                # The replacement daemon has no in-memory named subscribers.
                self._invalidate_subscriber()
                if self._closed:
                    return
                if not interrupted:
                    interrupted = True
                    if on_state is not None:
                        on_state('down')
                await self._wait_for_stop(RECONNECT_DELAY_MS)
        return self._unsubscriber(asyncio.ensure_future(operation()))

    @_guarded
    async def subscribe_broker(self, input):
        on_event, on_state = input['onEvent'], input.get('onStreamState')
        await self._declare_subscriber()

        async def operation():
            cursor = input['afterCommit']
            interrupted = False
            while not self._closed:
                try:
                    await self._declare_subscriber()
                    self._broker_rung = False
                    page = await self.client.follow_broker_events(
                        {'afterCommit': cursor, 'limit': BROKER_FOLLOW_LIMIT}, MAIL_SUBSCRIBER_NAME)
                    if interrupted:
                        interrupted = False
                        if on_state is not None:
                            on_state('resumed')
                    events = page['events']
                    for event in events:
                        if self._closed:
                            return
                        on_event({**event, 'id': event.get('commitOrdinal')})
                    # Follow is newer-or-equal for reconnect safety: move past the boundary.
                    if len(events) > 0:
                        cursor = page['nextCommit'] + 1
                    if len(events) >= BROKER_FOLLOW_LIMIT:
                        continue
                    # Rings that arrive meanwhile stay set and are served by one read.
                    await self._wait_for_stop(BROKER_RING_COALESCE_MS)
                    if not self._broker_rung and not self._closed:
                        await self._wait_for_broker_ring(self.broker_idle_poll_ms)
                except Exception:
                    # A socket break or an unknown-subscriber answer after a daemon
                    # restart invalidates the declaration from the prior epoch.
                    self._invalidate_subscriber()
                    if self._closed:
                        return
                    if not interrupted:
                        interrupted = True
                        if on_state is not None:
                            on_state('down')
                    await self._wait_for_stop(RECONNECT_DELAY_MS)
        return self._unsubscriber(asyncio.ensure_future(operation()))

    def _unsubscriber(self, task):
        async def unsubscribe():
            self._stop()
            await task
        return unsubscribe

    @_guarded
    async def steer(self, session, intent, prompt, options):
        return await self._dispatch('steer', session, intent, prompt, options)

    @_guarded
    async def enqueue(self, session, intent, prompt, options):
        return await self._dispatch('enqueue', session, intent, prompt, options)

    @_guarded
    async def invoke(self, session, intent, prompt, options):
        return await self._dispatch('invoke', session, intent, prompt, options)

    @_guarded
    async def preempt(self, session, intent, prompt, options):
        return await self._dispatch('preempt', session, intent, prompt, options)

    @_guarded
    async def preempt_admission(self, session, request):
        return (await self.client.preempt_admission(request))['admission']


def create_socket_injection_port(client, broker_idle_poll_ms=None):
    return SocketInjectionPort(client, broker_idle_poll_ms)


# ── federated-runtimes.ts ────────────────────────────────────────────────────

async def federated_live_runtimes(client, scope_ref):
    """Which nodes report a live runtime for one exact scope (T-12214).

    A peer that did not answer adds nothing to `liveNodeIds`, not even its
    cached rows; it is named in `unansweredNodeIds` instead.
    """
    report = await client.list_federated_runtimes({'scope': scope_ref})
    live, unanswered = [], []
    for node in report['nodes']:
        if node.get('state') != 'answered':
            unanswered.append(node.get('nodeId'))
            continue
        if any(runtime.get('scopeRef') == scope_ref and not is_terminal_runtime_status(runtime.get('status'))
               and runtime.get('status') != 'detached' for runtime in node['runtimes']):
            live.append(node.get('nodeId'))
    return {'localNodeId': report.get('localNodeId'), 'liveNodeIds': live, 'unansweredNodeIds': unanswered}


# ── failure-notice-dispatch.ts ───────────────────────────────────────────────

def normalize_failure_notice_dispatch_result(result, options):
    """A `completed` answer to a system notice (no envelope id) reads as `started`."""
    origin = options.get('submissionOrigin') or {}
    if (origin.get('principalRef') == 'system:hrc-kicker' and origin.get('envelopeId') is None
            and isinstance(result, dict) and result.get('status') == 'completed'):
        return {**result, 'status': 'started'}
    return result


# ── index.ts composition ─────────────────────────────────────────────────────

class KickerPort:
    """The port the policy sees: the socket port, the federated runtime read and
    the failure-notice enqueue normalisation, composed as `startMailInjector` does.
    The federated read goes to the client directly, so it is not refused once the
    socket port is stopped (as in the TypeScript)."""

    def __init__(self, client, core):
        self.client = client
        self.core = core

    def __getattr__(self, name):
        return getattr(self.core, name)

    async def federated_live_runtimes(self, scope_ref):
        return await federated_live_runtimes(self.client, scope_ref)

    async def enqueue(self, session, intent, prompt, options):
        return normalize_failure_notice_dispatch_result(
            await self.core.enqueue(session, intent, prompt, options), options)


def create_kicker_port(client, broker_idle_poll_ms=None):
    return KickerPort(client, create_socket_injection_port(client, broker_idle_poll_ms))
