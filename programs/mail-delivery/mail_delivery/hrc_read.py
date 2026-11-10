"""Injector HRC reads only. No generic GET or submission prefix permission."""
import http.client
import json
from pathlib import Path
import re
import socket
from urllib.parse import urlencode, urlsplit


GET_PATHS = frozenset((
    '/v1/status', '/v1/federation/locate', '/v1/federation/runtimes',
    '/v1/targets/by-session-ref', '/v1/runtimes', '/v1/runtimes/live-refs',
    '/v1/placement/bindings', '/v1/federation/designations',
    '/v1/events/head', '/v1/events/tail', '/v1/broker-events/query', '/v1/broker-events',
))
POST_PATHS = frozenset(('/v1/runtimes/inspect', '/v1/declarations/resolve',
                        '/v1/submissions/preempt/admission'))
IDENTIFIER = r'[A-Za-z0-9_-]+'


def allowed(method, path):
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.fragment or not path.startswith('/v1/'):
        return False
    if method == 'POST':
        return path in POST_PATHS  # exact path, no suffix or query
    if method != 'GET':
        return False
    return (parsed.path in GET_PATHS or
            re.fullmatch('/v1/runtimes/' + IDENTIFIER + '/seat', parsed.path) is not None or
            re.fullmatch('/v1/sessions/by-host/' + IDENTIFIER, parsed.path) is not None)


class HrcError(Exception):
    def __init__(self, status, payload):
        self.status = status
        self.payload = payload
        super().__init__(f'HRC read failed: HTTP {status}')


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__('localhost', timeout=timeout)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class HrcRead:
    def __init__(self, socket_path=None, timeout=3):
        self.socket_path = socket_path or Path.home() / 'praesidium/var/run/hrc/hrc.sock'
        self.timeout = timeout

    def request(self, method, path, body=None):
        if not allowed(method, path):
            raise PermissionError(f'not an allowlisted HRC read: {method} {path}')
        connection = UnixHTTP(self.socket_path, self.timeout)
        try:
            connection.request(method, path,
                body=json.dumps(body).encode() if body is not None else None,
                headers={'Content-Type': 'application/json',
                         'X-Praesidium-Caller': 'mail-delivery-shadow'})
            response = connection.getresponse()
            raw = response.read()
            value = ([json.loads(line) for line in raw.splitlines() if line.strip()]
                     if response.getheader('Content-Type', '').startswith('application/x-ndjson')
                     else json.loads(raw))
            if not 200 <= response.status < 300:
                raise HrcError(response.status, value)
            return value, response.getheader('x-hrc-next-cursor')
        finally:
            connection.close()

    def get(self, path, **params):
        return self.request('GET', path + ('?' + urlencode(params) if params else ''))[0]

    def post(self, path, **body):
        return self.request('POST', path, body)[0]

    def runtimes(self, **params):
        result = []
        while True:
            rows, cursor = self.request('GET', '/v1/runtimes?' + urlencode(dict(limit=500, **params)))
            result.extend(rows)
            if not cursor:
                return result
            params['cursor'] = cursor
