"""Fixed real evidence required before any scorer revision scores live records."""
from pathlib import Path
import json
import sqlite3
import tempfile
from unittest import TestCase
from mail_delivery.score import score


class LiveScorerRegression(TestCase):
    def setUp(self):
        self.fixture=json.loads((Path(__file__).parent/'fixtures/scorer-live-20261110.json').read_text())
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.db=self.root/'evidence.sqlite'
        c=sqlite3.connect(self.db)
        c.execute('CREATE TABLE hrcmail_delivery_intents(envelope_id TEXT,door TEXT,runtime_id TEXT,generation INTEGER,delivery_outcome TEXT,submitted_at TEXT)')
        c.execute('CREATE TABLE hrcmail_drive_diagnostics(envelope_id TEXT,target_session_ref TEXT,wake_reason TEXT,outcome TEXT,observed_seat_state TEXT,runtime_id TEXT,created_at TEXT)')
        for table,records,fields in (
            ('hrcmail_delivery_intents',self.fixture['intents'],('envelope_id','door','runtime_id','generation','delivery_outcome','submitted_at')),
            ('hrcmail_drive_diagnostics',self.fixture['diagnostics'],('envelope_id','target_session_ref','wake_reason','outcome','observed_seat_state','runtime_id','created_at'))):
            for row in records:
                c.execute('INSERT INTO '+table+' VALUES ('+','.join('?' for _ in fields)+')',tuple(row.get(k) for k in fields))
        c.commit();c.close()
        # Relocate only the canonical host path for a developer's HOME. The
        # fixed policy facts, clocks, identities and source stamps stay intact.
        canonical=str(Path.home()/'praesidium/var/run/praesidium/kernel.sock')
        shadow=[dict(r,kernel_socket=canonical) for r in self.fixture['shadow']]
        self.shadow=self.root/'shadow.jsonl';self.shadow.write_text(''.join(json.dumps(r)+'\n' for r in shadow))
        self.injector=self.root/'injector.jsonl';self.injector.write_text(''.join(json.dumps(r)+'\n' for r in self.fixture['injector']))

    def test_accepted_first_hour_has_both_real_first_agreements_and_six_cache_defects(self):
        r=score(self.shadow,self.db,'2026-11-10',injector_log=self.injector,**self.fixture['first_hour_window'])
        actual={v['envelope_id']:v['classification'] for v in r['rows']}
        self.assertEqual(actual,self.fixture['expected'])
        enqueue=next(v for v in r['rows'] if v['envelope_id']=='EN-50854')['first_delivery_comparison']
        self.assertEqual(enqueue['decision']['action'],'enqueue')
        self.assertEqual(enqueue['injector_decision'],'enqueue')
        self.assertEqual(enqueue['decided_at'],'2026-11-10T21:15:45.450Z')
        self.assertEqual(enqueue['evidence'][0],'2026-11-10T21:16:34.837Z')
        self.assertTrue(any(e['event']=='wrkq.kicker.delivery_intent' and e['ts'].startswith('2026-11-10T21:16:44') and e['data'].get('door')=='steer' for e in self.fixture['injector']))

    def test_EN_50888_completion_stays_with_its_pending_drive(self):
        r=score(self.shadow,self.db,'2026-11-10',since='2026-11-10T22:18:50Z',until='2026-11-10T22:24:00Z',injector_log=self.injector)
        phase=self.fixture['phase'];row=next(v for v in r['rows'] if v['envelope_id']==phase['envelope_id'])
        observation=next(v for v in row['observation_scores'] if v['decided_at']==phase['observation_at'])
        self.assertEqual(observation['classification'],phase['expected'])

    def test_EN_50982_second_precision_terminal_fence_keeps_its_matching_steer(self):
        fixed=json.loads((Path(__file__).parent/'fixtures/scorer-live-20261111-EN50982.json').read_text())
        canonical=str(Path.home()/'praesidium/var/run/praesidium/kernel.sock')
        self.shadow.write_text(''.join(json.dumps(dict(r,kernel_socket=canonical))+'\n' for r in fixed['shadow']))
        self.injector.write_text(''.join(json.dumps(r)+'\n' for r in fixed['injector']))
        report=score(self.shadow,self.db,'2026-11-11',since='2026-11-11T00:07:00Z',until='2026-11-11T00:15:00Z',injector_log=self.injector)
        row=report['rows'][0]
        self.assertEqual(row['classification'],'agreed')
        observed=next(r for r in row['observation_scores'] if r['decided_at']=='2026-11-11T00:07:12.807Z')
        self.assertEqual(observed['classification'],'agreed')
        self.assertEqual(observed['evidence'][0],'2026-11-11T00:07:25.521Z')
