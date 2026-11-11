"""Desired ownership and observational reporting. This connection is not the store."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time

# Keep byte-identical to delivery-owner.ts. No row means injector.
SCHEMA = """CREATE TABLE IF NOT EXISTS delivery_owner (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL CHECK (owner IN ('injector', 'port')),
  changed_at TEXT NOT NULL,
  delivering_owner TEXT CHECK (delivering_owner IN ('injector', 'port')),
  delivering_pid INTEGER,
  delivering_since TEXT
)"""


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class DeliveryOwner:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=1, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.ready = False

    def ensure(self):
        if not self.ready:
            self.db.execute(SCHEMA)
            self.ready = True

    def read(self):
        self.ensure()
        row = self.db.execute('SELECT * FROM delivery_owner WHERE singleton = 1').fetchone()
        return dict(row) if row else dict(owner='injector', changed_at=None,
            delivering_owner=None, delivering_pid=None, delivering_since=None)

    def set_owner(self, owner):
        if owner not in ('injector', 'port'):
            raise ValueError('owner must be injector or port')
        self.ensure()
        self.db.execute('INSERT INTO delivery_owner (singleton, owner, changed_at) VALUES (1, ?, ?) '
                        'ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner, changed_at=excluded.changed_at',
                        (owner, stamp()))

    def report(self, owner, pid):
        self.ensure()
        self.db.execute("INSERT OR IGNORE INTO delivery_owner (singleton, owner, changed_at) VALUES (1, 'injector', ?)", (stamp(),))
        self.db.execute('UPDATE delivery_owner SET delivering_owner=?, delivering_pid=?, delivering_since=? WHERE singleton=1',
                        (owner, pid, stamp()))

    def clear(self):
        self.ensure()
        self.db.execute('UPDATE delivery_owner SET delivering_owner=NULL, delivering_pid=NULL, delivering_since=NULL WHERE singleton=1')

    def close(self):
        self.db.close()


def flip(flag, owner, timeout=30, poll=time.sleep):
    """Only observes reporting; never opens or forces the lock."""
    flag.set_owner(owner)
    deadline = time.monotonic() + timeout
    while True:
        row = flag.read()
        if row['delivering_owner'] == owner:
            return row
        if time.monotonic() >= deadline:
            raise TimeoutError(f"handover incomplete: desired {owner}; holder pid {row['delivering_pid']} ({row['delivering_owner']})")
        poll(min(1, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('owner', nargs='?', choices=('injector', 'port'))
    parser.add_argument('--state-path', type=Path, help='explicit private database for isolated acceptance')
    args = parser.parse_args()
    from .node_config import state_path
    try:
        path = args.state_path if args.state_path is not None else state_path()
    except ValueError as error:
        parser.exit(1, f'{error}\n')
    flag = DeliveryOwner(path)
    try:
        print(json.dumps(flip(flag, args.owner) if args.owner else flag.read()))
    except TimeoutError as error:
        parser.exit(1, f'{error}\n')
    finally:
        flag.close()


if __name__ == '__main__':
    main()
