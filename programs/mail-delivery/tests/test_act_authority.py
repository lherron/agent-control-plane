"""Typed birth-refusal rules from t09657/t09822/t12423/t12214."""
import unittest
from mail_delivery.act_contracts import HrcDomainError
from mail_delivery.act_authority import (birth_deferral_for, deterministic_birth_refusal_for,
    local_placement_refusal_for, participant_only_refusal_for, participant_host_refusal_for)


class AuthorityTests(unittest.TestCase):
    def test_typed_refusals_not_message_text(self):
        self.assertIsNone(deterministic_birth_refusal_for(Exception('declaration_invalid')))
        self.assertEqual(deterministic_birth_refusal_for(HrcDomainError('declaration_invalid', 'bad')),
                         dict(code='declaration_invalid', message='bad'))
        self.assertEqual(deterministic_birth_refusal_for(HrcDomainError('cwd_missing', 'gone')),
                         dict(code='cwd_missing', message='gone'))
        local = HrcDomainError('declaration_invalid', 'no checkout', dict(source='project-targets', home='/host'))
        self.assertIsNone(deterministic_birth_refusal_for(local))
        self.assertEqual(local_placement_refusal_for(local)['home'], '/host')
        self.assertIsNotNone(participant_only_refusal_for(HrcDomainError('stale_context', 'wait', dict(reason='participant-only'))))
        self.assertIsNone(participant_only_refusal_for(Exception('participant-only')))
        self.assertEqual(participant_host_refusal_for(HrcDomainError('stale_context', 'wait', dict(reason='host_absent'))), {'reason': 'host_absent'})

    def test_deferral_requires_all_designation_fields(self):
        detail = dict(reason='birth-designated-elsewhere', birthDesignation=dict(homeNodeId='svc', designationEpoch=1,
                      birthEnvelopeId='EN-1', senderScopeRef='sender', provenance='registry'))
        self.assertEqual(birth_deferral_for(HrcDomainError('stale_context', 'deferred', detail))['homeNodeId'], 'svc')
        del detail['birthDesignation']['provenance']
        self.assertIsNone(birth_deferral_for(HrcDomainError('stale_context', 'deferred', detail)))
