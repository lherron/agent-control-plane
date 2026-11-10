"""Byte-compatible port of the injector's ledger/presentation.ts.

Inputs retain the owner's camelCase JSON keys. ``now`` is always supplied by
callers (UTC ISO string, datetime, or epoch milliseconds). Clipping deliberately
retains lone UTF-16 surrogates, just as JavaScript String.slice does; a UTF-8
transport must replace those with U+FFFD, as TextEncoder does.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import hashlib
import os
from pathlib import Path
import re
import tomllib

# ECMAScript WhiteSpace + LineTerminator, rather than Python's wider strip().
_WS = '\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
_CHICAGO = ZoneInfo('America/Chicago')
_REMINDER = ('<system_reminder>\nDaedalus will by default load more context than you and will find flaws in your spec.  That does not mean he has better judgement, only better information.  Assess his rulings critically and push back if he tries to add security theater, provenance without need, sha checks/hashing unsolicited, or **unrealistic edge cases**.\n</system_reminder>')


def _trim(text):
    return text.strip(_WS)


def _ms(value):
    """Date.parse for owner ISO timestamps, including offsets and invalid dates."""
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    if isinstance(value, (int, float)):
        return value
    if not isinstance(value, str):
        return None
    try:
        # ISO's day overflow is normalized by Date.parse (e.g. February 30).
        match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})(.*)', value)
        if match:
            year, month, day = map(int, match.group(1, 2, 3))
            if not 1 <= day <= 31:
                return None
            base = datetime(year, month, 1) + timedelta(days=day-1)
            value = base.strftime('%Y-%m-%d') + match[4]
        at = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if at.tzinfo is None:
            # ISO date-only is UTC; date-time without offset uses host local TZ.
            if len(value) <= 10:
                at = at.replace(tzinfo=timezone.utc)
        return int(at.timestamp() * 1000)
    except (ValueError, OverflowError, OSError):
        return None


def _elapsed(at, now):
    parsed = _ms(at)
    return None if parsed is None else _elapsed_ms(max(_ms(now) - parsed, 0))


def _elapsed_ms(ms):
    minutes = int(ms // 60000)
    if minutes < 60:
        return f'{max(minutes, 1)}m'
    hours = minutes // 60
    return f'{hours}h' if hours < 48 else f'{hours // 24}d'


def _sent(e):
    ms = _ms(e.get('createdAt'))
    if ms is None:
        return None
    at = datetime.fromtimestamp(ms / 1000, _CHICAGO)
    return f'{at.hour % 12 or 12:02}:{at.minute:02}{"A" if at.hour < 12 else "P"}'


def _clip(text, count):
    raw = text.encode('utf-16-le', 'surrogatepass')
    return text if len(raw) <= count * 2 else raw[:count*2].decode('utf-16-le', 'surrogatepass') + '…'


def _name(principal):
    return principal[6:] if principal.startswith('agent:') else principal


def _scope(scope):
    if '@' in scope:
        return scope.split('/lane:')[0]
    parts = scope.split(':')
    if len(parts) not in (2, 4, 6, 8) or parts[0] != 'agent':
        return scope
    if any(not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', token) for token in parts[1::2]):
        return scope
    if len(parts) >= 4 and parts[2] != 'project':
        return scope
    if len(parts) >= 6 and parts[4] not in ('task', 'role'):
        return scope
    if len(parts) == 8 and (parts[4] != 'task' or parts[6] != 'role'):
        return scope
    result = parts[1]
    if len(parts) >= 4:
        result += '@' + parts[3]
    if len(parts) >= 6:
        result += (':' if parts[4] == 'task' else '/') + parts[5]
    if len(parts) == 8:
        result += '/' + parts[7]
    return result


def _party(party):
    scope = party.get('scopeRef')
    return _scope(scope) if scope is not None and _trim(scope) else _name(party['principalRef'])


def reply_principal(envelope):
    party = envelope.get('to') or {}
    scope = _trim(party.get('scopeRef') or '')
    if scope.find('@') > 0:
        return 'agent:' + scope.split('@')[0]
    principal = _trim(party.get('principalRef') or '')
    return principal if re.fullmatch(r'agent:[A-Za-z0-9_-]+', principal) else None


def envelope_reply_addressee(envelope):
    return _party(envelope['from'])


def _read(style):
    return 'prae room mail get' if style == 'prae' else 'wrkc show'


def _history(style):
    return 'prae room history' if style == 'prae' else 'wrkc log'


def format_envelope_presentation(presentable, now):
    p, e = presentable, presentable['envelope']
    style = p.get('hintStyle')
    form = 'full' if p.get('form') is None else p['form']
    sender = _party(e['from'])
    scope = e['from'].get('scopeRef')
    if scope is not None and _trim(scope) and 'senderGeneration' in p:
        sender += f" (gen {p['senderGeneration']})"
    clauses = [e['roomKey']]
    if (sent := _sent(e)) is not None:
        clauses.append(sent)
    clauses.append(f'{sender} → you')
    if e.get('obligation') == 'reply_required':
        clauses.append('reply required')
    if p.get('delivery') == 'hold':
        clauses.append('preempt')
    if form == 'reminder':
        ago = _elapsed(p.get('turnEndedAt'), now)
        clauses.append('still owed — your turn ended' + (f' {ago} ago' if ago else '') + ' without a reply')
    elif form not in ('full', 'digest'):
        ago = _elapsed(e.get('retryAt'), now)
        why = 'you deferred this' + (f' {ago} ago' if ago else '')
        reason = e.get('deferReason')
        if reason is not None and _trim(reason):
            why += f': "{_clip(_trim(reason), 120)}"'
        clauses.append(why)
    lines = ['[' + ' · '.join(clauses) + ']']
    if form == 'full':
        if p.get('historyHint'):
            count = p.get('messageCount', 'undefined')
            ago = _elapsed(p.get('lastMessageAt'), now)
            lines.append(f"history: {_history(style)} {e['roomKey']}   ({count} {'message' if count == 1 else 'messages'}" + (f' · last {ago} ago' if ago else '') + ')')
        body = e['body']
        lines.append(_clip(body, 4000))
        length = len(body.encode('utf-16-le', 'surrogatepass')) // 2
        if length > 4000:
            lines.append(f"[body clipped at 4,000 of {length:,} chars — full body: {_read(style)} {e['id']}]")
    else:
        lines.append(f"read: {_read(style)} {e['id']}   ·   thread: {_history(style)} {e['roomKey']}")
    if e.get('obligation') == 'reply_required':
        to, principal = envelope_reply_addressee(e), reply_principal(e)
        as_flag = '' if style == 'prae' or principal is None else f' --as {principal}'
        say = 'prae room say' if style == 'prae' else 'wrkc say'
        lines.append(f"reply: {say} {e['id']} --to {to}{as_flag} - <<'EOF'\n…\nEOF")
    return '\n'.join(lines)


def _append_reminder(text, envelopes):
    for e in envelopes:
        scope = _trim(e['from'].get('scopeRef') or '')
        sender = scope.split('@')[0] if scope.find('@') > 0 else _name(e['from']['principalRef'])
        recipient = reply_principal(e)
        if sender == 'daedalus' and recipient and _name(recipient) in ('clod', 'cody', 'mable', 'astra'):
            return text + '\n\n' + _REMINDER
    return text


def format_envelope_presentations(presentables, now):
    return _append_reminder('\n\n'.join(format_envelope_presentation(p, now) for p in presentables),
                            [p['envelope'] for p in presentables])


def format_backlog_digest(envelopes, now, hint_style=None):
    ordered = sorted(envelopes, key=lambda e: _ms(e.get('createdAt')) or 0)
    oldest = _elapsed(ordered[0].get('createdAt'), now) if ordered else None
    lines = [f'[while you were away — {len(ordered)} fyi' + (f', oldest {oldest} ago' if oldest else '') + ']']
    for e in ordered:
        parts = [e['id']]
        if (sent := _sent(e)) is not None:
            parts.append(sent)
        parts.append(_party(e['from']))
        if (age := _elapsed(e.get('createdAt'), now)) is not None:
            parts.append(f'{age} ago')
        parts.append(_clip(_trim(e['body'].split('\n', 1)[0]), 120))
        lines.append(' · '.join(parts))
    lines.append(f'full text: {_read(hint_style)} <EN-id>')
    return _append_reminder('\n'.join(lines), ordered)


def format_envelope_failure_notice(envelope, reason, options=None, *, now=None):
    e, options = envelope, options or {}
    now = options.get('now', now)
    if now is None:
        raise TypeError('now must be injected')
    to = e.get('to') or {}
    addressee = _party(to) if _trim(to.get('scopeRef') or '') or 'principalRef' in to else 'the addressee'
    parts = [e['roomKey']]
    if (sent := _sent(e)) is not None:
        parts.append(sent)
    parts.extend([f"your {e['id']} → {addressee}", f'failed: {reason}'])
    newest, rank = {}, float('-inf')
    for receipt in e['presentedTo']:
        at = _ms(receipt.get('presentedAt'))
        at = float('-inf') if at is None else at
        if at >= rank:
            newest, rank = receipt, at
    runtime = options.get('runtimeId')
    if runtime is None:
        runtime = newest.get('runtimeId')
    resend = f"Resend: wrkc say {e['roomKey']} --to {addressee} -"
    if reason == 'runtime_terminated':
        at = _ms(newest.get('presentedAt'))
        held = ''
        if at is not None:
            elapsed = max(_ms(now)-at, 0)
            held = ' ' + (f'{int(elapsed // 1000)}s' if elapsed // 1000 < 90 else _elapsed_ms(elapsed))
        ended = 'its runtime ended' if runtime is None else f'runtime {runtime} ended'
        detail = f'presented{held}, undisposed; {ended}. {resend}'
    elif reason == 'ignored':
        detail = 'presented, reminded, 2 turns ended undisposed' + ('' if runtime is None else f' on {runtime}') + '. Resend or escalate.'
    elif reason == 'undeliverable':
        detail = f'never delivered; {addressee} could not be seated. Resend or escalate.'
    elif reason == 'legacy':
        detail = f'ended under the retired round bound. {resend}'
    else:
        detail = ''  # Array.join renders an undefined switch result as empty.
    lines = ['[' + ' · '.join(parts) + ']', detail]
    if options.get('detail') and _trim(options['detail']):
        lines.append('Why: ' + _trim(options['detail']))
    return '\n'.join(lines)


def _space_id(ref):
    """Only the id projection of spaces-config parseSpaceRef; selectors accept any nonempty text."""
    if not isinstance(ref, str):
        return None
    match = re.fullmatch(r'spaces?:(?:(?:agent|project):)?([a-z0-9]+(?:-[a-z0-9]+)*)(?:@(.+))?', ref)
    if match and len(match[1]) <= 64:
        return match[1]
    match = re.fullmatch(r'spaces?:path:([^@]+)@(.+)', ref)
    if match:
        segments = [p for p in match[1].split('/') if p]
        return re.sub(r'[^a-z0-9]+', '-', (segments[-1] if segments else 'path-ref').lower()).strip('-') or 'path-ref'
    return None


def get_agent_roots_for_project(project_root=None):
    """Project agents-root, then ASP_AGENTS_ROOT/config/convention; dedupe by absolute path."""
    home = os.environ.get('HOME', str(Path.home()))
    def expand(value):
        return home if value == '~' else os.path.join(home, value[2:]) if value.startswith('~/') else value
    roots = []
    if project_root:
        manifest = Path(project_root, 'asp-targets.toml')
        if manifest.exists():
            data = tomllib.loads(manifest.read_text())
            value = data.get('agents-root')
            if value:
                root = os.path.abspath(os.path.join(project_root, expand(value)))
                if os.path.exists(root):
                    roots.append(root)
    canonical = os.environ.get('ASP_AGENTS_ROOT')
    if not canonical:
        config = Path(os.environ.get('ASP_HOME', str(Path.home() / '.asp')), 'config.toml')
        try:
            value = tomllib.loads(config.read_text()).get('agents-root')
            canonical = value if isinstance(value, str) else None
        except (OSError, ValueError):
            pass
    if canonical is not None:
        roots.append(expand(canonical))
    else:
        root = os.path.join(home, 'praesidium', 'var', 'agents')
        if os.path.exists(root):
            roots.append(root)
    seen, result = set(), []
    for root in roots:
        key = os.path.abspath(root)
        if key not in seen:
            seen.add(key)
            result.append(root)
    return result


class RecipientHints:
    def __init__(self, log, roots=get_agent_roots_for_project):
        self.log, self.roots, self.cache = log, roots, {}

    def for_recipient(self, agent_id, project_root=None):
        try:
            if not re.fullmatch(r'[A-Za-z0-9_-]+', agent_id):
                raise ValueError('invalid recipient agent id')
            for root in self.roots(project_root):
                path = os.path.normpath(os.path.join(root, agent_id, 'agent-profile.toml'))
                try:
                    stat = os.stat(path)
                except FileNotFoundError:
                    continue
                stamp = (stat.st_mtime_ns / 1_000_000, stat.st_size)
                cached = self.cache.get(path)
                if cached and cached[0] == stamp:
                    return cached[2]
                content = Path(path).read_bytes().decode('utf-8', errors='replace')
                profile = tomllib.loads(content)
                spaces = profile.get('spaces')
                base = spaces.get('base') if isinstance(spaces, dict) else None
                style = 'prae' if isinstance(base, list) and any(_space_id(ref) == 'prae-tools' for ref in base) else 'legacy'
                content_hash = hashlib.sha256(content.encode('utf-8')).hexdigest()
                self.cache[path] = (stamp, content_hash, style)
                self.log('DEBUG', 'wrkq.kicker.recipient_hint_profile',
                         dict(agentId=agent_id, path=path, contentHash=content_hash, style=style))
                return style
            raise ValueError('recipient profile not found')
        except Exception as error:
            self.log('WARN', 'wrkq.kicker.recipient_hint_fallback', dict(agentId=agent_id, reason=str(error)))
            return 'legacy'
