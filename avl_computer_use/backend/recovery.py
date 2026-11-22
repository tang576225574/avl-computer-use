"""Input state that must survive a managed desktop backend restart."""

import sqlite3


class RecoveryState:
    def __init__(self, path):
        self.db = sqlite3.connect(path or ":memory:", timeout=1)
        with self.db:
            self.db.execute("CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY NOT NULL)")
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS control
                (id INTEGER PRIMARY KEY CHECK (id = 1), paused INTEGER NOT NULL, observe INTEGER NOT NULL)
            """)
            self.db.execute("INSERT OR IGNORE INTO control VALUES (1, 0, 0)")

    def restore(self):
        paused, observe = self.db.execute("SELECT paused, observe FROM control WHERE id = 1").fetchone()
        return bool(paused), bool(observe)

    def reserve(self, request_id, *, observe_only):
        with self.db:
            inserted = self.db.execute("INSERT OR IGNORE INTO requests VALUES (?)", (request_id,)).rowcount
            if not inserted:
                return False
            self.db.execute("""
                DELETE FROM requests WHERE rowid <=
                (SELECT rowid FROM requests ORDER BY rowid DESC LIMIT 1 OFFSET 1024)
            """)
            if not observe_only:
                self.db.execute("UPDATE control SET observe = 1 WHERE id = 1")
            return True

    def observed(self):
        with self.db:
            self.db.execute("UPDATE control SET observe = 0 WHERE id = 1")

    def pause(self, paused):
        with self.db:
            self.db.execute("UPDATE control SET paused = ? WHERE id = 1", (paused,))

    def close(self):
        self.db.close()
