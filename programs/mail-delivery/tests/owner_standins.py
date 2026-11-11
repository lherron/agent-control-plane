"""Recording stand-ins for the two owners the acting port calls.

`WrkqStandin` writes a `wrkq` command that logs every frame it receives (one
log per spawned connection) and answers from scenario rules. `HrcStandin` is
a unix-socket HTTP/1.1 server that logs every request and answers from
scenario routes, including NDJSON streams that break or hold open.

Both are used in-process by the tests and as separate processes by the
parity proof, where the TypeScript clients are pointed at the same stand-ins:
`python3.14 owner_standins.py hrc --socket S --scenario F --log L`.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qsl, urlsplit

WRKQ_ENV_KEYS = ('PRAESIDIUM_CALLER', 'WRKQ_DB', 'WRKQ_DB_PATH', 'WRKQ_DB_PATH_FILE',
                 'WRKQD_TOKEN', 'WRKQD_TOKEN_FILE')

WRKQ_SCRIPT = r'''
import json, os, signal, sys, threading, time
SCENARIO = json.loads(open(%(scenario)r).read())
LOGDIR = %(logdir)r
ENV_KEYS = %(env_keys)r
number = 0
while True:
    number += 1
    try:
        fd = os.open(os.path.join(LOGDIR, 'conn-%%03d.jsonl' %% number), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        break
    except FileExistsError:
        continue
log_lock = threading.Lock()
out_lock = threading.Lock()
def log(entry):
    with log_lock:
        os.write(fd, (json.dumps(entry, sort_keys=True) + '\n').encode())
def answer(text):
    with out_lock:
        sys.stdout.write(text)
        sys.stdout.flush()
def on_term(signum, frame):
    # Clients may signal twice in quick succession (the TypeScript and the port
    # both do): ignore the second, and never take a lock inside the handler.
    signal.signal(signum, signal.SIG_IGN)
    os.write(fd, (json.dumps({'signal': signal.Signals(signum).name}) + '\n').encode())
    os._exit(128 + signum)
signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGINT, on_term)
log({'argv': sys.argv[1:], 'env': {key: os.environ.get(key) for key in ENV_KEYS}})
def matches(rule, frame):
    if rule.get('method') != frame.get('method'):
        return False
    params = frame.get('params') or {}
    return all(params.get(key) == value for key, value in (rule.get('match') or {}).items())
def handle(frame):
    rule = next((rule for rule in SCENARIO.get('rules', []) if matches(rule, frame)), None)
    if rule is None:
        if frame.get('method') == 'rpc.initialize':
            rule = {'reply': {'result': SCENARIO.get('initialize', {})}}
        elif frame.get('method') == 'rpc.shutdown':
            rule = {'reply': {'result': None}}
        else:
            rule = {'reply': {'error': {'code': -32601, 'message': 'no scenario rule'}}}
    delay = rule.get('delay_ms', 0) / 1000
    action = rule.get('action')
    def respond():
        if action == 'hang':
            return
        if action == 'exit':
            log({'exit': rule.get('exit_code', 1)})
            os._exit(rule.get('exit_code', 1))
        if action == 'corrupt':
            answer(rule.get('text', 'this is not json') + '\n')
            return
        answer(json.dumps({'jsonrpc': '2.0', 'id': frame.get('id'), **rule['reply']}) + '\n')
    if delay:
        threading.Timer(delay, respond).start()
    else:
        respond()
for line in sys.stdin:
    if not line.strip():
        continue
    try:
        frame = json.loads(line)
    except ValueError:
        log({'unparsed': line})
        continue
    log({'frame': frame, 'raw': line.rstrip('\n')})
    handle(frame)
log({'eof': True})
os._exit(0)
'''


class WrkqStandin:
    def __init__(self, directory, scenario):
        self.directory = Path(directory)
        self.logdir = self.directory / 'wrkq-log'
        self.logdir.mkdir(parents=True, exist_ok=True)
        scenario_path = self.directory / 'wrkq-scenario.json'
        scenario_path.write_text(json.dumps(scenario))
        self.command = self.directory / 'wrkq'
        self.command.write_text(f'#!{sys.executable} -I\n' + WRKQ_SCRIPT % dict(
            scenario=str(scenario_path), logdir=str(self.logdir), env_keys=WRKQ_ENV_KEYS))
        self.command.chmod(0o755)

    def connections(self):
        result = []
        for path in sorted(self.logdir.glob('conn-*.jsonl')):
            entries = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
            result.append(entries)
        return result

    def frames(self):
        """Per connection: the received frames, in order."""
        return [[entry['frame'] for entry in conn if 'frame' in entry] for conn in self.connections()]


class HrcStandin:
    """Unix-socket HTTP server answering scenario routes and logging every request."""

    def __init__(self, socket_path, scenario, log_path=None):
        self.socket_path = str(socket_path)
        self.routes = [dict(route, used=0) for route in scenario.get('routes', [])]
        self.requests = []
        self.log_path = log_path
        self.server = None
        self.holds = set()

    async def start(self):
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        self.server = await asyncio.start_unix_server(self._serve, path=self.socket_path)
        return self

    async def stop(self):
        for writer in list(self.holds):
            writer.close()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    def _route(self, method, path, query):
        for route in self.routes:
            if route.get('method', 'GET') != method or route['path'] != path:
                continue
            if 'query' in route and route['query'] != query:
                continue
            responses = route['responses']
            response = responses[min(route['used'], len(responses) - 1)]
            route['used'] += 1
            return response
        return {'status': 404, 'json': {'error': {'code': 'not_found', 'message': f'no route {method} {path}',
                                                  'detail': {}}}}

    def _record(self, entry):
        self.requests.append(entry)
        if self.log_path is not None:
            with open(self.log_path, 'a') as log:
                log.write(json.dumps(entry, sort_keys=True) + '\n')

    async def _serve(self, reader, writer):
        try:
            while True:
                head = await reader.readuntil(b'\r\n\r\n')
                lines = head.decode('latin-1').split('\r\n')
                method, target, _ = lines[0].split(' ', 2)
                headers = {}
                for line in lines[1:]:
                    if line:
                        name, _, value = line.partition(':')
                        headers[name.strip().lower()] = value.strip()
                body = b''
                if 'content-length' in headers:
                    body = await reader.readexactly(int(headers['content-length']))
                parts = urlsplit(target)
                self._record({'method': method, 'path': parts.path, 'query': parts.query,
                              'query_items': parse_qsl(parts.query, keep_blank_values=True),
                              'headers': headers, 'body': body.decode()})
                response = self._route(method, parts.path, parts.query)
                keep = await self._respond(reader, writer, response)
                if not keep:
                    break
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self.holds.discard(writer)
            writer.close()

    async def _respond(self, reader, writer, response):
        status = response.get('status', 200)
        extra = response.get('headers', {})
        if 'stream' in response:
            head = (f'HTTP/1.1 {status} OK\r\nContent-Type: application/x-ndjson\r\n'
                    'Transfer-Encoding: chunked\r\n')
            head += ''.join(f'{name}: {value}\r\n' for name, value in extra.items())
            writer.write((head + '\r\n').encode())
            await writer.drain()
            for step in response['stream']:
                if 'sleep_ms' in step:
                    await asyncio.sleep(step['sleep_ms'] / 1000)
                elif 'line' in step:
                    data = (json.dumps(step['line']) + '\n').encode()
                    writer.write(f'{len(data):x}\r\n'.encode() + data + b'\r\n')
                    await writer.drain()
                elif step.get('close'):
                    # A break: the connection ends without the closing chunk.
                    return False
                elif step.get('hold'):
                    # Open until the client goes away (an abort or a stop).
                    self.holds.add(writer)
                    await reader.read()
                    return False
            writer.write(b'0\r\n\r\n')
            await writer.drain()
            return True
        if 'json' in response:
            body = json.dumps(response['json']).encode()
            content_type = 'application/json'
        else:
            body = response.get('body', '').encode()
            content_type = response.get('content_type', 'text/plain')
        head = (f'HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\n'
                f'Content-Length: {len(body)}\r\n')
        head += ''.join(f'{name}: {value}\r\n' for name, value in extra.items())
        writer.write((head + '\r\n').encode() + body)
        await writer.drain()
        return True


async def _serve_hrc(args):
    scenario = json.loads(Path(args.scenario).read_text())
    standin = await HrcStandin(args.socket, scenario, args.log).start()
    print('ready', flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await standin.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='kind', required=True)
    hrc = sub.add_parser('hrc')
    hrc.add_argument('--socket', required=True)
    hrc.add_argument('--scenario', required=True)
    hrc.add_argument('--log', required=True)
    args = parser.parse_args()
    asyncio.run(_serve_hrc(args))


if __name__ == '__main__':
    main()
