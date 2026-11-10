from unittest import TestCase
from mail_delivery.evidence import DeliveryHistory


def line(name, at, **data):
    return dict(event='wrkq.kicker.'+name, ts=f'2026-11-10T12:00:{at:02d}Z', data=data)


class DeliveryEvidence(TestCase):
    def test_admitted_door_requires_matching_envelope_runtime_and_survives_deleted_store_row(self):
        h = DeliveryHistory()
        h.accept(line('delivery_intent', 1, envelope='EN-1', runtimeId='rt-a', door='steer', form='full'))
        h.accept(line('delivery_admitted', 2, envelope='EN-1', runtimeId='rt-b', door='steer'))
        self.assertIsNone(h.first_admission('EN-1'))
        h.accept(line('delivery_admitted', 3, envelope='EN-1', runtimeId='rt-a', door='steer'))
        self.assertEqual(h.first_admission('EN-1')['door'], 'steer')
        self.assertEqual(h.first_admission('EN-1')['runtime_id'], 'rt-a')

    def test_launch_uses_presentation_identity_to_bind_the_new_runtime(self):
        h = DeliveryHistory()
        h.accept(line('delivery_intent', 1, envelope='EN-1', door='launch', form='full', presentationId='p-1'))
        h.accept(line('delivery_admitted', 2, envelope='EN-1', runtimeId='born', door='invoke'))
        self.assertIsNone(h.first_admission('EN-1'))
        h.accept(line('presented', 3, envelope='EN-1', runtimeId='born', door='invoke', presentationId='p-1'))
        self.assertEqual(h.first_admission('EN-1')['door'], 'launch')
        self.assertEqual(h.first_admission('EN-1')['runtime_id'], 'born')

    def test_digest_members_keep_their_own_admission_and_first_attempt(self):
        h = DeliveryHistory()
        h.accept(line('delivery_intent', 1, envelope='EN-1', door='enqueue', form='full'))
        h.accept(line('delivery_intent', 2, envelope='EN-1', runtimeId='rt', door='steer', form='digest'))
        h.accept(line('delivery_admitted', 3, envelopes=['EN-1'], runtimeId='rt', door='steer'))
        self.assertEqual(h.first_intent('EN-1')['data']['door'], 'enqueue')
        self.assertEqual(h.first_admission('EN-1')['door'], 'steer')
        self.assertEqual(h.delivered_envelopes(), {'EN-1'})
