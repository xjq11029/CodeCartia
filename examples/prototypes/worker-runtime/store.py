"""Real SQLite transactions for the experimental publication coordinator."""
from __future__ import annotations

from contextlib import contextmanager
import json
import sqlite3
from pathlib import Path

from io_policy import safe_output
from wire import canonical, fingerprint, require_text, ProtocolError

DECISIONS = {"sealed_completed", "sealed_partial", "sealed_cancelled", "sealed_timed_out", "sealed_failed"}


class Store:
    def __init__(self, path: str | Path):
        self.path = safe_output(path)
        for suffix in ("-wal", "-shm", "-journal"):
            safe_output(str(self.path) + suffix)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS slots (
                    id TEXT PRIMARY KEY, identity TEXT NOT NULL, latest_generation INTEGER NOT NULL DEFAULT 0,
                    latest_request TEXT, current_snapshot TEXT);
                CREATE TABLE IF NOT EXISTS requests (
                    id TEXT PRIMARY KEY, slot_id TEXT NOT NULL REFERENCES slots(id), generation INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL, frozen TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
                    active_attempt TEXT, UNIQUE(slot_id, generation));
                CREATE TABLE IF NOT EXISTS attempts (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
                    request_id TEXT NOT NULL REFERENCES requests(id), snapshot_id TEXT NOT NULL UNIQUE,
                    fingerprint TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
                    decision TEXT NOT NULL DEFAULT 'open', publication TEXT NOT NULL DEFAULT 'staged',
                    output_state TEXT NOT NULL DEFAULT 'receiving', reason TEXT,
                    protocol_integrity TEXT NOT NULL DEFAULT 'unchecked', semantic_completeness TEXT NOT NULL DEFAULT 'unchecked',
                    cleanup TEXT NOT NULL DEFAULT 'pending');
                CREATE TABLE IF NOT EXISTS snapshots (
                    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
                    slot_id TEXT NOT NULL REFERENCES slots(id), generation INTEGER NOT NULL,
                    fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS audit (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL);
            """)

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, isolation_level=None, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            if write:
                db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    @staticmethod
    def event(db, event, subject, detail):
        db.execute("INSERT INTO audit(event,subject,detail) VALUES(?,?,?)", (event, subject, canonical(detail).decode()))

    def register(self, slot: dict, request_id: str, frozen: dict) -> dict:
        identity = {key: require_text(slot.get(key), key) for key in ("workspaceId", "publicationScopeId", "sourceViewId")}
        require_text(request_id, "requestId")
        slot_id, digest = "slot:" + fingerprint(identity), fingerprint(frozen)
        with self.connection(write=True) as db:
            previous = db.execute("SELECT * FROM requests WHERE id=?", (request_id,)).fetchone()
            if previous:
                if previous["slot_id"] != slot_id or previous["fingerprint"] != digest:
                    raise ProtocolError("request identity reused with changed input")
                return {"publicationSlotId": slot_id, "requestId": request_id, "requestGeneration": previous["generation"]}
            db.execute("INSERT OR IGNORE INTO slots(id,identity) VALUES(?,?)", (slot_id, canonical(identity).decode()))
            generation = db.execute("SELECT latest_generation FROM slots WHERE id=?", (slot_id,)).fetchone()[0] + 1
            db.execute("INSERT INTO requests(id,slot_id,generation,fingerprint,frozen) VALUES(?,?,?,?,?)",
                       (request_id, slot_id, generation, digest, canonical(frozen).decode()))
            db.execute("UPDATE slots SET latest_generation=?,latest_request=? WHERE id=?", (generation, request_id, slot_id))
            self.event(db, "request_registered", request_id, {"slot": slot_id, "generation": generation})
        return {"publicationSlotId": slot_id, "requestId": request_id, "requestGeneration": generation}

    def begin(self, session_id: str, task_id: str, attempt_id: str, payload: dict) -> str:
        key = canonical([require_text(session_id, "sessionId"), require_text(task_id, "taskId"), require_text(attempt_id, "attemptId")]).decode()
        digest = fingerprint(payload)
        with self.connection(write=True) as db:
            existing = db.execute("SELECT * FROM attempts WHERE id=?", (key,)).fetchone()
            if existing:
                if existing["fingerprint"] != digest:
                    raise ProtocolError("same attempt changed frozen request")
                return key
            request = db.execute("SELECT * FROM requests WHERE id=?", (payload["requestId"],)).fetchone()
            if not request or request["state"] != "open" or request["generation"] != payload["requestGeneration"] or request["slot_id"] != payload["publicationSlotId"]:
                raise ProtocolError("attempt is not registered to this request")
            frozen = json.loads(request["frozen"])
            for field, expected in frozen.items():
                if payload.get(field) != expected:
                    raise ProtocolError("registered frozen input changed: " + field)
            if request["active_attempt"]:
                prior = db.execute("SELECT decision FROM attempts WHERE id=?", (request["active_attempt"],)).fetchone()
                if not prior or prior[0] != "sealed_failed":
                    raise ProtocolError("only failed attempts may retry")
            db.execute("INSERT INTO attempts(id,session_id,task_id,attempt_id,request_id,snapshot_id,fingerprint,input_fingerprint) VALUES(?,?,?,?,?,?,?,?)",
                       (key, session_id, task_id, attempt_id, payload["requestId"], payload["snapshotId"], digest, payload["inputManifestRef"]["fingerprint"]))
            db.execute("UPDATE requests SET active_attempt=? WHERE id=?", (key, payload["requestId"]))
            self.event(db, "attempt_started", key, {"requestId": payload["requestId"], "snapshotId": payload["snapshotId"]})
        return key

    def attempt(self, key: str) -> dict:
        with self.connection() as db:
            row = db.execute("SELECT * FROM attempts WHERE id=?", (key,)).fetchone()
            if not row:
                raise KeyError(key)
            return dict(row)

    def validating(self, key):
        with self.connection(write=True) as db:
            db.execute("UPDATE attempts SET output_state='validating' WHERE id=? AND decision='open'", (key,))
            self.event(db, "finished_received", key, {})

    def seal(self, key, decision, reason=None, protocol="unchecked", semantic="unchecked") -> str:
        if decision not in DECISIONS:
            raise ProtocolError("invalid host decision")
        with self.connection(write=True) as db:
            row = db.execute("SELECT decision FROM attempts WHERE id=?", (key,)).fetchone()
            if not row:
                raise KeyError(key)
            if row[0] != "open":
                self.event(db, "late_decision_ignored", key, {"proposed": decision, "kept": row[0]})
                return row[0]
            publication = "eligible" if decision == "sealed_completed" else "isolated"
            db.execute("UPDATE attempts SET decision=?,publication=?,reason=?,protocol_integrity=?,semantic_completeness=?,output_state='sealed' WHERE id=? AND decision='open'",
                       (decision, publication, reason, protocol, semantic, key))
            self.event(db, "attempt_sealed", key, {"decision": decision, "reason": reason})
        return decision

    def cancel(self, key, cancel_request_id):
        require_text(cancel_request_id, "cancelRequestId")
        with self.connection(write=True) as db:
            row = db.execute("SELECT * FROM attempts WHERE id=?", (key,)).fetchone()
            if not row:
                return {"status": "unknown_attempt", "cancelRequestId": cancel_request_id}
            status, decision = "already_terminal", row["decision"]
            if decision == "open":
                status, decision = "accepted", "sealed_cancelled"
                db.execute("UPDATE attempts SET decision=?,publication='isolated',reason='user_cancelled',output_state='sealed' WHERE id=?", (decision, key))
                db.execute("UPDATE requests SET state='cancelled' WHERE id=?", (row["request_id"],))
            result = {"status": status, "decision": decision, "cancelRequestId": cancel_request_id, "attemptKey": key}
            self.event(db, "host_cancel", key, result)
            return result

    def isolate(self, key, reason):
        with self.connection(write=True) as db:
            db.execute("UPDATE attempts SET publication='isolated',reason=? WHERE id=? AND publication NOT IN ('published','historical')", (reason, key))
            self.event(db, "publication_isolated", key, {"reason": reason})

    def publish(self, key, payload, observed_input_fingerprint, before_commit=None) -> str:
        digest = fingerprint(payload)
        try:
            with self.connection(write=True) as db:
                attempt = db.execute("SELECT * FROM attempts WHERE id=?", (key,)).fetchone()
                if not attempt or attempt["decision"] != "sealed_completed" or attempt["publication"] == "isolated":
                    raise ProtocolError("attempt has no publication eligibility")
                previous = db.execute("SELECT * FROM snapshots WHERE id=?", (attempt["snapshot_id"],)).fetchone()
                if previous:
                    if previous["attempt_id"] != key or previous["fingerprint"] != digest:
                        raise ProtocolError("immutable snapshot changed")
                    return attempt["publication"]
                if observed_input_fingerprint != attempt["input_fingerprint"]:
                    raise ProtocolError("inputs changed after completion")
                request = db.execute("SELECT * FROM requests WHERE id=?", (attempt["request_id"],)).fetchone()
                if request["state"] != "open" or request["active_attempt"] != key:
                    raise ProtocolError("superseded attempt or cancelled request")
                slot = db.execute("SELECT * FROM slots WHERE id=?", (request["slot_id"],)).fetchone()
                state = "published" if slot["latest_generation"] == request["generation"] and slot["latest_request"] == request["id"] else "historical"
                db.execute("INSERT INTO snapshots(id,attempt_id,slot_id,generation,fingerprint,payload) VALUES(?,?,?,?,?,?)",
                           (attempt["snapshot_id"], key, request["slot_id"], request["generation"], digest, canonical(payload).decode()))
                db.execute("UPDATE attempts SET publication=? WHERE id=?", (state, key))
                if state == "published":
                    if slot["current_snapshot"]:
                        db.execute("UPDATE attempts SET publication='historical' WHERE snapshot_id=?", (slot["current_snapshot"],))
                    db.execute("UPDATE slots SET current_snapshot=? WHERE id=?", (attempt["snapshot_id"], request["slot_id"]))
                self.event(db, "snapshot_" + state, key, {"snapshotId": attempt["snapshot_id"], "generation": request["generation"]})
                if before_commit:
                    before_commit()
            return state
        except Exception as exc:
            self.isolate(key, "publication_failed: " + str(exc))
            raise

    def cleanup(self, key, state):
        with self.connection(write=True) as db:
            db.execute("UPDATE attempts SET cleanup=? WHERE id=?", (state, key))
            self.event(db, "process_cleanup", key, {"state": state})

    def summary(self) -> dict:
        with self.connection() as db:
            return {name: [dict(row) for row in db.execute("SELECT * FROM " + name + " ORDER BY " + ("sequence" if name == "audit" else "id"))]
                    for name in ("slots", "requests", "attempts", "snapshots", "audit")}

    def recover(self) -> dict:
        self.check_integrity()
        with self.connection(write=True) as db:
            rows = db.execute("SELECT * FROM attempts WHERE decision='open' OR publication='eligible'").fetchall()
            for row in rows:
                decision = "sealed_failed" if row["decision"] == "open" else row["decision"]
                db.execute("UPDATE attempts SET decision=?,publication='isolated',reason='host_recovered_unpublished',cleanup='previous_process_unknown' WHERE id=?", (decision, row["id"]))
                self.event(db, "recovered_unpublished", row["id"], {"decision": decision})
        self.check_integrity()
        return self.summary()

    def check_integrity(self):
        with self.connection() as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchall():
                raise ProtocolError("invalid SQLite state")
            for slot in db.execute("SELECT * FROM slots"):
                latest = db.execute("SELECT id,generation FROM requests WHERE slot_id=? ORDER BY generation DESC LIMIT 1", (slot["id"],)).fetchone()
                if not latest or latest[0] != slot["latest_request"] or latest[1] != slot["latest_generation"]:
                    raise ProtocolError("lost latest request on recovery")
                if slot["current_snapshot"]:
                    current = db.execute("SELECT s.slot_id,a.decision,a.publication FROM snapshots s JOIN attempts a ON a.id=s.attempt_id WHERE s.id=?", (slot["current_snapshot"],)).fetchone()
                    if not current or tuple(current) != (slot["id"], "sealed_completed", "published"):
                        raise ProtocolError("inconsistent current snapshot")
            for row in db.execute("SELECT * FROM snapshots"):
                if fingerprint(json.loads(row["payload"])) != row["fingerprint"]:
                    raise ProtocolError("corrupt snapshot content")
        return True
