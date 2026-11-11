"""Desired ownership and observational reporting. This connection is not the store."""
import argparse
from datetime import datetime, timezone
import json
import os
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
        self.path = Path(path)
        self.db = None
        self.reader = None
        self.ready = False
        self.last = dict(owner='injector', changed_at=None,
            delivering_owner=None, delivering_pid=None, delivering_since=None)

    def ensure(self):
        if self.db is None:
            self.db = sqlite3.connect(self.path, timeout=1, isolation_level=None)
        if not self.ready:
            self.db.execute(SCHEMA)
            self.ready = True

    def read(self, *, require_fresh=False):
        # Shadow/standby reads must never create the database or its flag table.
        if self.reader is None:
            if not self.path.exists():
                return dict(self.last)
            self.reader = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro',
                uri=True, timeout=0, isolation_level=None)
            self.reader.row_factory = sqlite3.Row
        try:
            row = self.reader.execute('SELECT * FROM delivery_owner WHERE singleton = 1').fetchone()
            self.last = dict(row) if row else dict(owner='injector', changed_at=None,
                delivering_owner=None, delivering_pid=None, delivering_since=None)
        except sqlite3.OperationalError as error:
            code = getattr(error, 'sqlite_errorcode', 0) & 255
            if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                if require_fresh:
                    raise
            elif str(error) == 'no such table: delivery_owner':
                self.last = dict(owner='injector', changed_at=None,
                    delivering_owner=None, delivering_pid=None, delivering_since=None)
            else:
                raise
        return dict(self.last)

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
        if self.db is None:
            return
        self.db.execute('UPDATE delivery_owner SET delivering_owner=NULL, delivering_pid=NULL, delivering_since=NULL WHERE singleton=1')

    def close(self):
        if self.reader is not None:
            self.reader.close()
        if self.db is not None:
            self.db.close()


def flip(flag, owner, timeout=30, poll=time.sleep):
    """Operator-only reporting precondition; deliverers never use it for admission."""
    if owner == 'port':
        row = flag.read(require_fresh=True)
        pid = row['delivering_pid']
        alive = False
        if row['delivering_owner'] == 'injector' and isinstance(pid, int) and pid > 0:
            try:
                os.kill(pid, 0)
                alive = True
            except PermissionError:
                alive = True
            except ProcessLookupError:
                pass
        if not alive:
            raise RuntimeError('deploy the flag-following injector on this node first; port handover refused')
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
    except (TimeoutError, RuntimeError, sqlite3.OperationalError) as error:
        parser.exit(1, f'{error}\n')
    finally:
        flag.close()


if __name__ == '__main__':
    main()
