"""One persistent connection, one exclusive transaction, no takeover timeout."""
from pathlib import Path
import sqlite3


class DelivererLock:
    def __init__(self, state_path):
        self.path = Path(state_path).with_name('hrc-mail-injector.deliverer-lock.sqlite')
        self.db = None
        self.held = False
        self.closed = False

    def try_acquire(self):
        if self.closed:
            raise RuntimeError('deliverer lock is closed')
        if self.held:
            return True
        if self.db is None:
            self.db = sqlite3.connect(self.path, timeout=0, isolation_level=None)
            self.db.execute('PRAGMA busy_timeout=0')
        try:
            self.db.execute('BEGIN EXCLUSIVE')
        except sqlite3.OperationalError as error:
            if error.sqlite_errorcode in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                return False
            raise
        self.held = True
        return True

    def release(self):
        if self.held:
            self.db.execute('ROLLBACK')
            self.held = False

    def close(self):
        if self.db is not None:
            self.db.close()
        self.held = False
        self.closed = True
