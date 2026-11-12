"""Execute the SPEC expectations against real pipes, processes and SQLite files."""
from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import uuid

from cases import SLOT, request_for, rebuild_finish
from host import Host
from io_policy import ROOT, REPORTS, safe_output, write_json
from store import Store
from wire import LIMITS, PAIR, TRANSPORT, ProtocolError, batch_fingerprint, canonical, decode


def expect_error(action, types=(ProtocolError,)):
    try:
        action()
    except types as exc:
        return str(exc)
    raise AssertionError("the invalid operation was accepted")


class Suite:
    def __init__(self):
        self.scratch = REPORTS / (".run-" + str(uuid.uuid4()))
        safe_output(self.scratch / "sentinel").parent.mkdir(parents=True, exist_ok=True)
        self.cases, self.traces, self.storage = [], [], []
        self.serial = 0

    def store(self):
        self.serial += 1
        return Store(self.scratch / ("case-" + str(self.serial) + ".sqlite"))

    @contextmanager
    def host(self, store, **kwargs):
        host = Host(store, **kwargs)
        try:
            yield host
        finally:
            host.close()
            self.traces.append(host.observation())

    def check(self, name, source, operation):
        started = time.perf_counter()
        try:
            detail = operation()
            self.cases.append({"name": name, "source": source, "passed": True, "seconds": round(time.perf_counter() - started, 4), "observation": detail})
            print("PASS " + name, flush=True)
        except Exception as exc:
            self.cases.append({"name": name, "source": source, "passed": False, "seconds": round(time.perf_counter() - started, 4), "error": str(exc), "traceback": traceback.format_exc()})
            print("FAIL " + name + ": " + str(exc), flush=True)

    def completed(self, store, request, publish=True):
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            assert host.finalize() == "sealed_completed"
            state = host.publish() if publish else "eligible"
            return host.key, state

    def forward_refs(self):
        store = self.store()
        request = request_for(store, "forward")
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            while len(host.batches) < 1:
                host.pump()
            assert len(host.raw_records) == 1 and host.materialized == {}
            assert store.attempt(host.key)["decision"] == "open"
            assert store.summary()["slots"][0]["current_snapshot"] is None
            host.until_finished()
            assert host.finalize() == "sealed_completed"
            assert host.publish() == "published"
            assert len(host.raw_records) == 5 and len(host.materialized) == 5
        assert b'"kind":"facts.batch"' in host.logs and host.process.poll() is not None
        store.check_integrity()
        return {"wireRecords": 5, "materializedRecords": 5, "ackWasPublication": False, "stderrExcluded": True}

    def duplicates(self, across_batches=False):
        store = self.store()
        request = request_for(store, "duplicates")
        experiment = request["extensions"]["codecartia.runtimeExperiment"]
        if across_batches:
            evidence = deepcopy(experiment["batches"][1]["records"][2])
            experiment["batches"][1]["records"].append(evidence)
            experiment["batches"][1]["recordCount"] = 5
            experiment["batches"][1]["payloadFingerprint"] = batch_fingerprint(experiment["batches"][1])
            experiment["finish"] = rebuild_finish(request, experiment["batches"])
        else:
            experiment["batches"].insert(1, deepcopy(experiment["batches"][0]))
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            assert host.finalize() == "sealed_completed"
            assert len(host.raw_records) == (6 if across_batches else 5)
            assert len(host.materialized) == 5
            assert host.duplicates == (0 if across_batches else 1)
            host.publish()
        return {"rawRecords": 6 if across_batches else 5, "uniqueRecords": 5}

    def invalid_stream(self, variant):
        store = self.store()
        request = request_for(store, variant)
        experiment = request["extensions"]["codecartia.runtimeExperiment"]
        b1, b2 = experiment["batches"]
        if variant == "missing-batch":
            experiment["batches"] = [b1]
        elif variant == "wrong-count":
            experiment["finish"]["totalRecordCount"] = 6
        elif variant == "wrong-hash":
            b1["payloadFingerprint"] = "0" * 64
        elif variant == "conflicting-duplicate":
            changed = deepcopy(b1)
            changed["records"][0]["type"] = "changed-relation"
            changed["payloadFingerprint"] = batch_fingerprint(changed)
            experiment["batches"] = [b1, changed, b2]
        elif variant == "wrong-revision":
            b1["records"][0]["evidenceRefs"][0]["revisionId"] = "missing-v2"
            b1["payloadFingerprint"] = batch_fingerprint(b1)
            experiment["finish"] = rebuild_finish(request, experiment["batches"])
        elif variant == "id-only-reference":
            del b1["records"][0]["ref"]["revisionId"]
            b1["payloadFingerprint"] = batch_fingerprint(b1)
            experiment["finish"] = rebuild_finish(request, experiment["batches"])
        elif variant == "self-support":
            b2["records"][3]["inputFactRefs"] = [deepcopy(b1["records"][0]["ref"])]
            b2["payloadFingerprint"] = batch_fingerprint(b2)
            experiment["finish"] = rebuild_finish(request, experiment["batches"])
        elif variant == "auxiliary-source":
            b2["records"][2]["production"] = "manual"
            b2["payloadFingerprint"] = batch_fingerprint(b2)
            experiment["finish"] = rebuild_finish(request, experiment["batches"])
        elif variant == "missing-exact-reference":
            experiment["batches"] = [b1]
            experiment["finish"] = rebuild_finish(request, [b1])
        elif variant == "unknown-required-feature":
            experiment["envelopeOverrides"] = {"0": {"requiredFeatures": ["not-supported"]}}
        elif variant == "lost-coverage-gap":
            request["requestedCoverage"].append("not-supported")
        elif variant == "boolean-empty-count":
            experiment["batches"] = []
            experiment["finish"] = rebuild_finish(request, [])
            experiment["finish"]["totalRecordCount"] = False
        else:
            experiment["behavior"] = variant
        with self.host(store, initial_credit=0 if variant == "violate-credit" else 1) as host:
            host.handshake()
            host.analyze(request)
            def run():
                host.until_finished()
                host.finalize()
            reason = expect_error(run)
            assert store.attempt(host.key)["decision"] == "sealed_failed"
            assert store.summary()["slots"][0]["current_snapshot"] is None
        return {"rejected": True, "reason": reason}

    def incompatible(self, mode):
        with self.host(self.store(), hello_mode=mode) as host:
            error = expect_error(host.handshake)
            assert not host.ready and host.key is None
        return {"sessionRejected": True, "reason": error}

    def unsupported_mode(self):
        store = self.store()
        request = request_for(store, "unsupported")
        request["requiredExecutionModes"] = ["full-business-analysis"]
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            row = store.attempt(host.key)
            assert row["decision"] == "sealed_failed" and row["reason"].startswith("request_rejected:")
            assert not host.accepted and not host.batches
        return {"requestRejected": True, "noFacts": True}

    def stale_envelope(self):
        store = self.store()
        request = request_for(store, "stale", behavior="stale-envelope")
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            assert host.finalize() == "sealed_completed" and host.quarantined == 1
            assert len(host.raw_records) == 5
            host.publish()
        return {"staleMessagesQuarantined": 1, "currentRecords": 5}

    def cancellation(self, behavior):
        store = self.store()
        request = request_for(store, behavior, behavior=behavior)
        with self.host(store, initial_credit=0) as host:
            host.handshake()
            host.analyze(request)
            while not host.accepted:
                host.pump()
            assert host.cancel()["status"] == "accepted"
            host.stop_cancelled(timeout=0.3)
            assert store.attempt(host.key)["decision"] == "sealed_cancelled"
            assert host.cancel_ack and host.cancel_ack["status"] == "accepted"
            assert host.process.poll() is not None and not host.batches
            if behavior == "ignore-cancel":
                assert host.cleanup_state == "forced_terminated"
            assert host.finalize() == "sealed_cancelled"
        return {"ackObserved": True, "cleanup": host.cleanup_state, "decision": "sealed_cancelled"}

    def cancel_order(self, finish_first):
        store = self.store()
        request = request_for(store, "order")
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            assert store.attempt(host.key)["output_state"] == "validating"
            if finish_first:
                assert host.finalize() == "sealed_completed"
                host.publish()
                assert host.cancel()["status"] == "already_terminal"
                assert store.summary()["slots"][0]["current_snapshot"] == "snapshot-order"
            else:
                assert host.cancel()["status"] == "accepted"
                assert host.finalize() == "sealed_cancelled"
                assert store.summary()["slots"][0]["current_snapshot"] is None
        return {"winner": "completed" if finish_first else "cancelled"}

    def failure(self, behavior):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        request = request_for(store, "failure", behavior=behavior)
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            reason = expect_error(lambda: host.until_finished(timeout=0.25), (EOFError, TimeoutError))
            decision = "sealed_failed" if behavior == "crash" else "sealed_timed_out"
            assert store.attempt(host.key)["decision"] == decision
        assert host.process.poll() is not None
        assert store.summary()["slots"][0]["current_snapshot"] == "snapshot-seed"
        return {"decision": decision, "oldCurrentPreserved": True, "reason": reason}

    def stale_flood(self, fast=False):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        request = request_for(store, "flood", behavior="stale-fast-flood" if fast else "stale-flood")
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            started = time.monotonic()
            reason = expect_error(lambda: host.until_finished(timeout=3 if fast else 0.15), (ProtocolError,) if fast else (TimeoutError,))
            elapsed = time.monotonic() - started
            expected = "sealed_failed" if fast else "sealed_timed_out"
            assert store.attempt(host.key)["decision"] == expected
            if fast:
                assert reason == "session message budget exhausted", reason
                assert host.received_frames == LIMITS["maxSessionFrames"] + 1
            else:
                assert reason == "worker absolute deadline exceeded", reason
            assert elapsed < (3.0 if fast else 1.5)
            assert len(host.trace) <= LIMITS["maxAuditEntries"] and host.audit_bytes <= LIMITS["maxAuditBytes"]
        assert store.summary()["slots"][0]["current_snapshot"] == "snapshot-seed"
        return {"decision": expected, "elapsedSeconds": elapsed, "quarantined": host.quarantined,
                "boundedAuditEntries": len(host.trace), "reason": reason}

    def partial(self, allowed):
        store = self.store()
        request = request_for(store, "partial", allow_partial=allowed, partial=True)
        with self.host(store) as host:
            host.handshake()
            host.analyze(request)
            host.until_finished()
            decision = host.finalize()
            assert decision == ("sealed_partial" if allowed else "sealed_failed")
            row = store.attempt(host.key)
            assert row["protocol_integrity"] == "valid" and row["semantic_completeness"] == "incomplete"
            assert row["publication"] == "isolated" and store.summary()["slots"][0]["current_snapshot"] is None
        return {"allowPartial": allowed, "decision": decision, "protocolIntegrity": "valid"}

    def generation_order(self):
        store = self.store()
        a, b = request_for(store, "A"), request_for(store, "B")
        assert a["requestGeneration"] == 1 and b["requestGeneration"] == 2
        self.completed(store, b)
        key_a, state = self.completed(store, a)
        assert state == "historical" and store.attempt(key_a)["decision"] == "sealed_completed"
        saved = Store(store.path).recover()
        assert saved["slots"][0]["current_snapshot"] == "snapshot-B" and saved["slots"][0]["latest_generation"] == 2
        return {"latestGeneration": 2, "current": "snapshot-B", "older": "historical"}

    def latest_failed(self):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        a = request_for(store, "A")
        key, _ = self.completed(store, a, publish=False)
        b = request_for(store, "B", behavior="crash")
        with self.host(store) as host:
            host.handshake()
            host.analyze(b)
            expect_error(host.until_finished, (EOFError,))
        assert store.publish(key, {"controlled": "A"}, a["inputManifestRef"]["fingerprint"]) == "historical"
        saved = Store(store.path).recover()
        assert saved["slots"][0]["latest_generation"] == 3 and saved["slots"][0]["latest_request"] == "B"
        assert saved["slots"][0]["current_snapshot"] == "snapshot-seed"
        return {"newRequestAfterPrecheck": True, "latestFailedGeneration": 3, "olderDidNotRegainEligibility": True}

    def retry(self):
        store = self.store()
        original = request_for(store, "retry", behavior="crash")
        same = request_for(store, "retry", behavior="crash")
        assert same["requestGeneration"] == 1
        with self.host(store) as host:
            host.handshake()
            host.analyze(original, attempt_id="first")
            expect_error(host.until_finished, (EOFError,))
            old_key = host.key
        new_request = request_for(store, "retry", snapshot="snapshot-retry-2")
        with self.host(store) as host:
            host.handshake()
            host.analyze(new_request, attempt_id="second")
            host.until_finished()
            assert host.finalize() == "sealed_completed"
            host.publish()
        assert store.seal(old_key, "sealed_completed") == "sealed_failed"
        assert store.summary()["slots"][0]["latest_generation"] == 1
        assert store.summary()["slots"][0]["current_snapshot"] == "snapshot-retry-2"
        return {"generationAfterRetry": 1, "oldAttemptDecision": "sealed_failed"}

    def publication_failure(self, changed_input):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        request = request_for(store, "new")
        key, _ = self.completed(store, request, publish=False)
        def storage_fault():
            raise OSError("injected storage failure before commit")
        if changed_input:
            reason = expect_error(lambda: store.publish(key, {"new": True}, "changed-input"))
        else:
            reason = expect_error(lambda: store.publish(key, {"new": True}, request["inputManifestRef"]["fingerprint"], before_commit=storage_fault), (OSError,))
        row = store.attempt(key)
        assert row["decision"] == "sealed_completed" and row["publication"] == "isolated"
        assert store.summary()["slots"][0]["current_snapshot"] == "snapshot-seed"
        assert len(store.summary()["snapshots"]) == 1
        return {"executionDecisionPreserved": True, "oldCurrentPreserved": True, "reason": reason}

    def crash_commit(self, point):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        request = request_for(store, "new")
        key, _ = self.completed(store, request, publish=False)
        operation = {"database": str(store.path), "attemptKey": key, "point": point,
                     "snapshotPayload": {"record": "new-durable-snapshot"}, "inputFingerprint": request["inputManifestRef"]["fingerprint"]}
        operation_path = self.scratch / (point + ".json")
        write_json(operation_path, operation)
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        child = subprocess.Popen([sys.executable, "-B", str(ROOT / "store_probe.py"), str(operation_path)],
                                 cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                 creationflags=flags, env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
        output = queue.Queue()
        reader = threading.Thread(target=lambda: output.put(child.stdout.readline()), daemon=True)
        reader.start()
        try:
            line = output.get(timeout=8).decode().strip()
            expected = "transaction-prepared" if point == "before-commit" else "transaction-committed:published"
            assert line == expected, line
            child.kill()
            child.wait(timeout=5)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            reader.join(timeout=2)
            stderr = child.stderr.read().decode(errors="replace")
            child.stdout.close()
            child.stderr.close()
        assert not stderr, stderr
        recovered = Store(store.path).recover()
        slot = recovered["slots"][0]
        assert slot["latest_generation"] == 2 and slot["latest_request"] == "new"
        assert slot["current_snapshot"] == ("snapshot-seed" if point == "before-commit" else "snapshot-new")
        assert len(recovered["snapshots"]) == (1 if point == "before-commit" else 2)
        assert store.attempt(key)["decision"] == "sealed_completed"
        self.storage.append({"point": point, "childPid": child.pid, "returnCode": child.returncode, "signal": line,
                             "recovered": recovered})
        return {"point": point, "latestGeneration": 2, "current": slot["current_snapshot"], "processKilled": True}

    def empty_protocol(self):
        store = self.store()
        request = request_for(store, "empty")
        experiment = request["extensions"]["codecartia.runtimeExperiment"]
        experiment["batches"] = []
        experiment["finish"] = rebuild_finish(request, [])
        self.completed(store, request)
        return {"protocolZeroOutputValid": True, "productAcceptance": "not-measured"}

    def corruption(self):
        store = self.store()
        self.completed(store, request_for(store, "seed"))
        with store.connection(write=True) as db:
            db.execute("UPDATE snapshots SET payload='{}'")
        reason = expect_error(store.recover)
        return {"corruptStateRejected": True, "reason": reason}

    def parser_and_path(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'[]', b'\xff', b'{"x":1e9999}', b'{"x":"\\ud800"}', b'{"x":' + b'[' * 1500 + b'0' + b']' * 1500 + b'}'):
            expect_error(lambda raw=raw: decode(raw))
        expect_error(lambda: safe_output(ROOT / "SPEC.md"), (ValueError,))
        protected = self.scratch / "protected.txt"
        protected.write_bytes(b"preserve this input")
        alias = self.scratch / "alias.json"
        os.link(protected, alias)
        expect_error(lambda: write_json(alias, {"changed": True}), (ValueError,))
        assert protected.read_bytes() == b"preserve this input"
        return {"invalidFramesRejected": 7, "sourceOverwriteRejected": True, "hardLinkOverwriteRejected": True}

    def run(self):
        self.check("forward-reference-and-log-isolation", "WP04/WP10", self.forward_refs)
        self.check("duplicate-batch-idempotence", "WP05/W-B", lambda: self.duplicates(False))
        self.check("cross-batch-record-counts", "W-B/raw-vs-materialized", lambda: self.duplicates(True))
        for variant in ("missing-batch", "wrong-count", "wrong-hash", "conflicting-duplicate", "wrong-revision", "id-only-reference",
                        "self-support", "auxiliary-source", "missing-exact-reference", "unknown-required-feature", "lost-coverage-gap", "boolean-empty-count",
                        "bad-json", "oversize", "violate-credit", "nonfinite-frame", "surrogate-frame", "missing-kind"):
            self.check(variant, "WP05/06/09/11/12/15", lambda variant=variant: self.invalid_stream(variant))
        for mode in ("no-common-schema", "unknown-feature", "wrong-ready"):
            self.check(mode, "WP01/W-H", lambda mode=mode: self.incompatible(mode))
        self.check("unsupported-required-mode", "WP02", self.unsupported_mode)
        self.check("old-attempt-frame-isolation", "WP03", self.stale_envelope)
        for behavior in ("wait-for-cancel", "ignore-cancel", "late-complete"):
            self.check("zero-credit-" + behavior, "WP07/08/10", lambda behavior=behavior: self.cancellation(behavior))
        self.check("cancel-during-validation", "W-L05", lambda: self.cancel_order(False))
        self.check("completion-before-cancel", "W-L04", lambda: self.cancel_order(True))
        self.check("worker-crash-preserves-current", "WP08", lambda: self.failure("crash"))
        self.check("worker-timeout-preserves-current", "WP08", lambda: self.failure("hang"))
        self.check("stale-frames-cannot-postpone-deadline", "WP08/10/control-deadline", lambda: self.stale_flood(False))
        self.check("stale-frames-count-toward-session-budget", "WP10/control-budget", lambda: self.stale_flood(True))
        self.check("allowed-partial", "W-S01", lambda: self.partial(True))
        self.check("strict-semantic-incomplete", "WP13/W-S09", lambda: self.partial(False))
        self.check("reverse-completion-order", "W-L10/D12", self.generation_order)
        self.check("new-request-after-precheck-fails", "W-L10/11/D12", self.latest_failed)
        self.check("idempotent-request-and-failed-attempt-retry", "W-L12", self.retry)
        self.check("storage-error-after-completion", "WP14", lambda: self.publication_failure(False))
        self.check("input-change-after-completion", "WP14", lambda: self.publication_failure(True))
        self.check("process-crash-before-sqlite-commit", "M1-08/R12", lambda: self.crash_commit("before-commit"))
        self.check("process-crash-after-sqlite-commit", "M1-08/R12", lambda: self.crash_commit("after-commit"))
        self.check("empty-technical-stream", "W-S07", self.empty_protocol)
        self.check("corrupt-recovery-state", "R12/recovery", self.corruption)
        self.check("strict-framing-and-output-boundary", "WP10/12", self.parser_and_path)
        manifest = [{"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in sorted(ROOT.glob("*.py"))]
        manifest += [{"path": "SPEC.md", "sha256": hashlib.sha256((ROOT / "SPEC.md").read_bytes()).hexdigest()}]
        report = {"experimentVersion": "runtime-experiment-v0.1", "executedAtUtc": datetime.now(timezone.utc).isoformat(),
                  "environment": {"python": sys.version, "executable": sys.executable, "sqlite": sqlite3.sqlite_version, "os": platform.platform()},
                  "versions": PAIR, "transportProfileId": TRANSPORT, "explorationLimits": LIMITS,
                  "inputManifest": manifest, "passed": sum(item["passed"] for item in self.cases), "total": len(self.cases),
                  "cases": self.cases, "productAcceptance": "not-measured", "g1": "not-frozen",
                  "limitations": ["controlled producer, not language-worker integration", "single active attempt per process",
                                  "FactRef/manifest/source subset, not full theme schema", "no cross-worker external providers",
                                  "Windows process-kill recovery is not physical power-loss durability", "no cross-platform/package/semantic quality acceptance"]}
        write_json(REPORTS / "verification.json", report)
        write_json(REPORTS / "traces.json", {"workers": self.traces, "storage": self.storage})
        resolved = self.scratch.resolve()
        if not resolved.is_relative_to(REPORTS.resolve()) or resolved.parent != REPORTS.resolve() or not resolved.name.startswith(".run-"):
            raise ValueError("refusing scratch cleanup outside report directory")
        shutil.rmtree(resolved)
        print(str(report["passed"]) + "/" + str(report["total"]) + " runtime experiments passed", flush=True)
        return report["passed"] == report["total"]


if __name__ == "__main__":
    raise SystemExit(0 if Suite().run() else 1)
