"""One digest's durable members; translation of policy/drive/digest-group.ts."""
DIGEST_PREFIX = 'present-digest-'
UUID_LENGTH = 36


def digest_presentation_id(group_id, envelope_id):
    return f'{DIGEST_PREFIX}{group_id}-{envelope_id}'


def digest_group_of(presentation_id):
    if not presentation_id.startswith(DIGEST_PREFIX):
        return None
    group = presentation_id[len(DIGEST_PREFIX):len(DIGEST_PREFIX)+UUID_LENGTH]
    return group if len(group) == UUID_LENGTH else None


def digest_members(server, intent):
    group = digest_group_of(intent.presentation_id)
    if group is None:
        return [intent]
    siblings = [candidate for candidate in server.store.mail_delivery.list_open_intents(intent.target_session_ref)
                if candidate.envelope_id != intent.envelope_id and digest_group_of(candidate.presentation_id) == group]
    return [intent, *siblings]
