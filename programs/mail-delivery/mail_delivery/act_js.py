"""JavaScript value semantics the policy translation leans on.

Not a port of a TypeScript file: `Set` iteration order, `Date.prototype.toISOString`
from epoch milliseconds, and `Date.parse` (via presentation_text's reading).
"""
from datetime import datetime, timezone
from .presentation_text import _ms


class OrderedSet(dict):
    """A JavaScript Set: insertion-ordered membership, `add`, `discard`, iteration."""

    def __init__(self, values=()):
        super().__init__()
        for value in values:
            self[value] = None

    def add(self, value):
        self[value] = None

    def discard(self, value):
        self.pop(value, None)

    def __repr__(self):
        return f'OrderedSet({list(self)!r})'


def iso_from_ms(ms):
    """`new Date(ms).toISOString()`."""
    ms = int(ms)
    return datetime.fromtimestamp(ms // 1000, timezone.utc).replace(microsecond=(ms % 1000) * 1000) \
        .isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def date_parse(value):
    """`Date.parse(value)`; NaN is None."""
    return _ms(value)


INFINITY = float('inf')

UNDEFINED = type('Undefined', (), {'__repr__': lambda self: 'undefined', '__bool__': lambda self: False})()
"""JavaScript `undefined`, where the policy tells it apart from `null` (None)."""


def js_get(value, key):
    """`value.key`: None for an absent key, as `undefined` reads; raises on a
    null or undefined `value`, as reading a property of one throws."""
    if value is None or value is UNDEFINED:
        raise TypeError(f"Cannot read properties of {'null' if value is None else 'undefined'} (reading '{key}')")
    return value.get(key) if isinstance(value, dict) else getattr(value, key, None)


def js_gt_zero(value):
    """`value > 0` for a JSON number or a missing one (undefined > 0 is false)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0
