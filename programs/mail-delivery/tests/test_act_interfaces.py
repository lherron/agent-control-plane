"""Rules at the policy/owner-client seam; no owners are contacted."""
import unittest
from mail_delivery.act_contracts import HrcDomainError, HrcErrorCode, WrkqLedgerRequestError
from mail_delivery.act_scope import target_session_ref_for_ledger_scope
from mail_delivery.act_types import newest_presentation_receipt, envelope_id_sequence


class InterfaceTests(unittest.TestCase):
    def test_error_identity_and_details(self):
        error = HrcDomainError(HrcErrorCode.DECLARATION_INVALID, 'invalid', {'reason': 'participant-only'})
        self.assertEqual((error.code, error.message, error.status), ('declaration_invalid', 'invalid', 422))
        self.assertEqual(error.detail, {'reason': 'participant-only'})
        refusal = WrkqLedgerRequestError('wrong state', 'wrkq.envelope.present', -32000, {'reason': 'wrong_state'})
        self.assertEqual(refusal.data['reason'], 'wrong_state')

    def test_scope_forms(self):
        for value in ('cody@wrkq:primary', 'agent:cody:project:wrkq:task:primary',
                      'agent:cody:project:wrkq:task:primary/lane:main'):
            self.assertEqual(target_session_ref_for_ledger_scope(value),
                             'agent:cody:project:wrkq:task:primary/lane:main')
        self.assertIsNone(target_session_ref_for_ledger_scope(''))
        self.assertIsNone(target_session_ref_for_ledger_scope('a b@wrkq:t'))

    def test_receipt_tie_uses_last(self):
        rows = [{'presentedAt': '2026-01-01T00:00:00Z', 'runtimeId': 'old'},
                {'presentedAt': '2026-01-01T00:00:00Z', 'runtimeId': 'new'}]
        self.assertIs(newest_presentation_receipt({'presentedTo': rows}), rows[-1])
        self.assertEqual(envelope_id_sequence(' EN-13281 '), 13281)
        self.assertEqual(envelope_id_sequence('EN-9007199254740992'), 0)
