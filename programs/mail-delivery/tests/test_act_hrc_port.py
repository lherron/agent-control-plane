"""The HRC port against a recording unix-socket stand-in: routes, errors, follows."""
import asyncio
import json
import tempfile
import unittest

from mail_delivery import act_hrc_port
from mail_delivery.act_contracts import HrcDomainError
from tests.owner_standins import HrcStandin

UA = 'hrc-mail-injector/0.1.0-test'


def ok(value, **headers):
    return {'status': 200, 'json': value, **({'headers': headers} if headers else {})}


def refused(status, code, message, detail=None):
    error = {'code': code, 'message': message}
    if detail is not None:
        error['detail'] = detail
    return {'status': status, 'json': {'error': error}}


class PortCase(unittest.IsolatedAsyncioTestCase):
    async def serve(self, routes):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.standin = await HrcStandin(f'{directory.name}/hrc.sock', {'routes': routes}).start()
        self.addAsyncCleanup(self.standin.stop)
        self.client = act_hrc_port.HrcClient(self.standin.socket_path, caller='hrc-mail-injector',
                                             user_agent=UA)
        self.port = act_hrc_port.create_kicker_port(self.client)
        return self.port

    def seen(self):
        return [(r['method'], r['path'] + ('?' + r['query'] if r['query'] else ''), r['body'])
                for r in self.standin.requests]


class Routes(PortCase):
    async def test_reads_use_the_sdk_routes_and_the_injector_identity(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/runtimes/inspect', 'responses': [
                ok({'runtimeId': 'rt-1', 'status': 'busy', 'activeInvocationId': None, 'extra': 1})]},
            {'path': '/v1/runtimes', 'query': 'hostSessionId=hs-1&all=true&limit=500',
             'responses': [ok([{'runtimeId': 'a'}], **{'x-hrc-next-cursor': 'c2'})]},
            {'path': '/v1/runtimes', 'query': 'hostSessionId=hs-1&all=true&limit=500&cursor=c2',
             'responses': [ok([{'runtimeId': 'b'}])]},
            {'path': '/v1/runtimes/live-refs', 'responses': [
                ok({'refs': [{'scopeRef': 'agent:a:project:p', 'laneRef': 'main'}]})]},
            {'path': '/v1/events/tail', 'responses': [ok({'events': [{'hrcSeq': 4}]})]},
            {'path': '/v1/status', 'responses': [ok({'mailKicker': 'disabled'})]},
        ])
        self.assertEqual(await port.runtime('rt-1'), {'runtimeId': 'rt-1', 'status': 'busy'})
        self.assertEqual(await port.runtimes_by_host_session('hs-1'), [{'runtimeId': 'a'}, {'runtimeId': 'b'}])
        self.assertEqual(await port.live_session_refs(), ['agent:a:project:p/lane:main'])
        self.assertEqual(await port.lifecycle_events(
            {'eventKind': 'turn.finished', 'runtimeId': 'rt 1', 'limit': 5}), [{'hrcSeq': 4}])
        self.assertEqual(await self.client.get_status(), {'mailKicker': 'disabled'})
        self.assertEqual(self.seen(), [
            ('POST', '/v1/runtimes/inspect', '{"runtimeId":"rt-1"}'),
            ('GET', '/v1/runtimes?hostSessionId=hs-1&all=true&limit=500', ''),
            ('GET', '/v1/runtimes?hostSessionId=hs-1&all=true&limit=500&cursor=c2', ''),
            ('GET', '/v1/runtimes/live-refs', ''),
            ('GET', '/v1/events/tail?limit=5&runtimeId=rt+1&eventKind=turn.finished', ''),
            ('GET', '/v1/status?includeSessions=false', '')])
        headers = self.standin.requests[0]['headers']
        self.assertEqual((headers['x-praesidium-caller'], headers['user-agent'], headers['content-type']),
                         ('hrc-mail-injector', UA, 'application/json'))

    async def test_target_lookup_follows_to_the_active_session(self):
        port = await self.serve([
            {'path': '/v1/targets/by-session-ref', 'query': 'sessionRef=agent%3Aa%3Aproject%3Ap%2Flane%3Amain',
             'responses': [ok({'activeHostSessionId': 'hs/1'})]},
            {'path': '/v1/sessions/by-host/hs%2F1', 'responses': [ok({'hostSessionId': 'hs/1'})]},
            {'path': '/v1/targets/by-session-ref', 'responses': [
                refused(404, 'unknown_session', 'no target')]},
        ])
        self.assertEqual(await port.target_by_session_ref('agent:a:project:p/lane:main'),
                         {'hostSessionId': 'hs/1'})
        self.assertIsNone(await port.target_by_session_ref('agent:b:project:p/lane:main'))

    async def test_doors_carry_the_target_body_and_origin(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/submissions/invoke', 'responses': [ok({'inputId': 'in-1'})]},
            {'method': 'POST', 'path': '/v1/submissions/enqueue', 'responses': [ok({'status': 'completed'})]},
        ])
        session = {'scopeRef': 'agent:a:project:p', 'laneRef': 'main'}
        origin = {'principalRef': 'agent:b', 'envelopeId': 'EN-1'}
        await port.invoke(session, {'harness': 'x'}, 'hello', {
            'ttlMs': 1000, 'submissionOrigin': origin, 'idempotencyKey': 'k',
            'launchPromptOnColdBirth': True})
        self.assertEqual(json.loads(self.seen()[0][2]), {
            'target': 'agent:a:project:p/lane:main', 'body': 'hello', 'origin': origin,
            'idempotencyKey': 'k', 'runtimeIntent': {'harness': 'x'}, 'ttlMs': 1000,
            'coldBirth': {'promptMode': 'replace-priming'}})
        notice = {'principalRef': 'system:hrc-kicker'}
        self.assertEqual(await port.enqueue(session, {}, 'n', {'ttlMs': 1, 'submissionOrigin': notice}),
                         {'status': 'started'})
        self.assertEqual(await port.enqueue(session, {}, 'n', {'ttlMs': 1, 'submissionOrigin': origin}),
                         {'status': 'completed'})

    async def test_federated_live_runtimes_decides_exact_scope_and_liveness(self):
        port = await self.serve([{'path': '/v1/federation/runtimes', 'responses': [ok({
            'localNodeId': 'max3', 'nodes': [
                {'nodeId': 'max3', 'state': 'answered', 'runtimes': [
                    {'scopeRef': 'agent:a:project:p', 'status': 'busy'}]},
                {'nodeId': 'mini', 'state': 'answered', 'runtimes': [
                    {'scopeRef': 'agent:a:project:p:task:T-1', 'status': 'busy'},
                    {'scopeRef': 'agent:a:project:p', 'status': 'detached'},
                    {'scopeRef': 'agent:a:project:p', 'status': 'dead'}]},
                {'nodeId': 'svc', 'state': 'unreachable', 'runtimes': [
                    {'scopeRef': 'agent:a:project:p', 'status': 'busy'}]}]})]}])
        self.assertEqual(await port.federated_live_runtimes('agent:a:project:p'), {
            'localNodeId': 'max3', 'liveNodeIds': ['max3'], 'unansweredNodeIds': ['svc']})
        self.assertEqual(self.seen()[0][1], '/v1/federation/runtimes?scope=agent%3Aa%3Aproject%3Ap')


class Errors(PortCase):
    async def test_domain_errors_and_plain_failures(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/runtimes/inspect', 'responses': [
                refused(404, 'unknown_runtime', 'gone'),
                refused(500, 'internal_error', 'boom', {'cause': ' disk ', 'requestId': 'r1'}),
                {'status': 502, 'body': 'Bad gateway'},
                {'status': 500, 'json': {'nothing': True}},
                ok({'runtimeId': 'rt', 'status': 'sideways', 'activeInvocationId': None})]},
            {'method': 'POST', 'path': '/v1/declarations/resolve', 'responses': [
                refused(422, 'declaration_invalid', 'participant only', {'reason': 'participant-only'})]},
        ])
        self.assertIsNone(await port.runtime('rt'))
        with self.assertRaises(HrcDomainError) as caught:
            await port.runtime('rt')
        self.assertEqual((caught.exception.code, str(caught.exception)),
                         ('internal_error', 'boom [internal_error]: disk (requestId=r1)'))
        with self.assertRaises(Exception) as caught:
            await port.runtime('rt')
        self.assertEqual(str(caught.exception), 'HRC request failed with status 502: Bad gateway')
        self.assertNotIsInstance(caught.exception, HrcDomainError)
        with self.assertRaises(Exception) as caught:
            await port.runtime('rt')
        self.assertEqual(str(caught.exception), 'HRC request failed with status 500')
        with self.assertRaises(Exception) as caught:
            await port.runtime('rt')
        self.assertEqual(str(caught.exception), 'Invalid stored runtime status: sideways')
        with self.assertRaises(HrcDomainError) as caught:
            await port.resolve_runtime_intent('agent:a:project:p', None)
        self.assertEqual((caught.exception.status, caught.exception.detail['reason']),
                         (422, 'participant-only'))
        self.assertEqual(self.seen()[-1][2], '{"scopeRef":"agent:a:project:p"}')

    async def test_withdraw_answers_are_projected_and_failures_returned(self):
        port = await self.serve([{'method': 'POST', 'path': '/v1/submissions/withdraw', 'responses': [
            ok({'outcome': 'withdrawn', 'extra': 1}), ok({'outcome': 'not_held'}),
            refused(409, 'stale_context', 'already presented')]}])
        request = {'runtimeId': 'rt', 'envelopeId': 'EN-1', 'reason': 'r'}
        self.assertEqual(await port.withdraw(request), {'ok': True, 'response': {'outcome': 'withdrawn'}})
        self.assertEqual(await port.withdraw(request),
                         {'ok': True, 'response': {'outcome': 'not_held', 'state': 'terminal'}})
        self.assertEqual(await port.withdraw(request), {'ok': False, 'error': {'message': 'already presented'}})


ACK = {'x-hrc-subscriber-id': 'sub-1', 'x-hrc-receipt-token': 'tok',
       'x-hrc-receipt-ack-path': '/v1/server/subscribers/ack'}


class Follows(PortCase):
    async def test_lifecycle_follow_breaks_resumes_and_declares_again(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/server/subscribers', 'responses': [ok({'name': 'mail'})]},
            {'method': 'POST', 'path': '/v1/server/subscribers/ack', 'responses': [ok({})]},
            {'path': '/v1/events', 'responses': [
                {'stream': [{'line': {'hrcSeq': 11}}, {'line': {'hrcSeq': 10}}, {'close': True}],
                 'headers': ACK},
                {'stream': [{'line': {'hrcSeq': 12}}, {'hold': True}], 'headers': ACK}]},
        ])
        events, states, done = [], [], asyncio.Event()

        def on_event(event):
            events.append(event['hrcSeq'])
            if event['hrcSeq'] == 12:
                done.set()
        unsubscribe = await port.subscribe_lifecycle({'afterSeq': 10, 'onEvent': on_event,
                                                      'onStreamState': states.append})
        await asyncio.wait_for(done.wait(), 5)
        await unsubscribe()
        self.assertEqual((events, states), ([11, 12], ['down', 'resumed']))
        self.assertEqual(self.seen(), [
            ('POST', '/v1/server/subscribers', '{"name":"mail"}'),
            ('GET', '/v1/events?fromSeq=11&follow=true&receipt=consumer-ack-v1', ''),
            ('POST', '/v1/server/subscribers/ack', '{"subscriberId":"sub-1","receiptToken":"tok","seq":11}'),
            ('POST', '/v1/server/subscribers/ack', '{"subscriberId":"sub-1","receiptToken":"tok","seq":10}'),
            ('POST', '/v1/server/subscribers', '{"name":"mail"}'),
            ('GET', '/v1/events?fromSeq=12&follow=true&receipt=consumer-ack-v1', ''),
            ('POST', '/v1/server/subscribers/ack', '{"subscriberId":"sub-1","receiptToken":"tok","seq":12}')])

    async def test_broker_follow_declares_again_after_an_unknown_subscriber_answer(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/server/subscribers', 'responses': [ok({'name': 'mail'})]},
            {'path': '/v1/broker-events/follow', 'responses': [
                ok({'events': [{'commitOrdinal': 101}, {'commitOrdinal': 102}], 'nextCommit': 102}),
                refused(400, 'invalid_selector', 'subscriber "mail" is not declared for broker-events follow',
                        {'field': 'x-hrc-subscriber-name'}),
                ok({'events': [{'commitOrdinal': 103}], 'nextCommit': 103})]},
        ])
        port.core.broker_idle_poll_ms = 50
        events, states, done = [], [], asyncio.Event()

        def on_event(event):
            events.append((event['commitOrdinal'], event['id']))
            if event['id'] == 103:
                done.set()
        unsubscribe = await port.subscribe_broker({'afterCommit': 100, 'onEvent': on_event,
                                                   'onStreamState': states.append})
        await asyncio.wait_for(done.wait(), 5)
        await unsubscribe()
        self.assertEqual(events, [(101, 101), (102, 102), (103, 103)])
        self.assertEqual(states, ['down', 'resumed'])
        follows = [r for r in self.standin.requests if r['path'] == '/v1/broker-events/follow']
        self.assertEqual([r['query'] for r in follows], [
            'afterCommit=100&limit=500', 'afterCommit=103&limit=500', 'afterCommit=103&limit=500'])
        self.assertEqual({r['headers']['x-hrc-subscriber-name'] for r in follows}, {'mail'})
        self.assertEqual([m for m, *_ in self.seen()].count('POST'), 2)

    async def test_a_stopped_port_refuses_without_calling(self):
        port = await self.serve([
            {'method': 'POST', 'path': '/v1/server/subscribers', 'responses': [ok({})]},
            {'path': '/v1/broker-events/follow', 'responses': [ok({'events': [], 'nextCommit': 0})]}])
        unsubscribe = await port.subscribe_broker({'afterCommit': 0, 'onEvent': lambda event: None})
        await unsubscribe()
        before = len(self.standin.requests)
        with self.assertRaises(Exception) as caught:
            await port.events_head()
        self.assertEqual(str(caught.exception), 'socket injection port is stopped')
        with self.assertRaises(Exception):
            await port.enqueue({'scopeRef': 's', 'laneRef': 'l'}, {}, 'p',
                               {'ttlMs': 1, 'submissionOrigin': {'principalRef': 'x'}})
        self.assertEqual(len(self.standin.requests), before)


if __name__ == '__main__':
    unittest.main()
