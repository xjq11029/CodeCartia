"""Bounded host for one controlled worker/attempt; not a product orchestrator."""
from __future__ import annotations

from collections import Counter
import base64
import hashlib
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time
import uuid

from store import Store
from wire import (BOOTSTRAP, PAIR, TRANSPORT, MODE, FEATURES, LIMITS, KINDS, canonical,
                  decode, fingerprint, batch_fingerprint, fact_key, validate_records,
                  validate_completeness, require_int, require_text, ProtocolError)

ROOT = Path(__file__).resolve().parent
WORKER_ID = "codecartia-controlled-producer"


class Host:
    def __init__(self, store: Store, hello_mode="normal", initial_credit=1, auto_ack=True):
        if initial_credit not in (0, 1):
            raise ValueError("experimental initial credit is 0 or 1")
        self.store, self.session = store, str(uuid.uuid4())
        self.worker_id, self.boot = WORKER_ID, None
        self.serial, self.trace, self.logs = 0, [], bytearray()
        self.log_truncated = False
        self.queue = queue.Queue(maxsize=LIMITS["maxQueuedFrames"])
        self.overflow = threading.Event()
        self.closed, self.ready, self.key, self.request = False, False, None, None
        self.task_id, self.attempt_id = None, None
        self.initial_credit, self.credit, self.auto_ack = initial_credit, initial_credit, auto_ack
        self.batches, self.batch_ids, self.raw_records = {}, {}, []
        self.accepted, self.finished, self.cancel_ack = False, None, None
        self.coverage_gaps = []
        self.duplicates, self.quarantined, self.control_count = 0, 0, 0
        self.received_frames, self.audit_bytes, self.audit_truncated = 0, 0, False
        self.materialized, self.cleanup_state = {}, None
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen([sys.executable, "-B", str(ROOT / "producer.py"), hello_mode],
                                        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env=env, creationflags=flags, bufsize=0)
        self.readers = [threading.Thread(target=self._read_frames, daemon=True), threading.Thread(target=self._read_logs, daemon=True)]
        for thread in self.readers:
            thread.start()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def _enqueue(self, item):
        try:
            self.queue.put_nowait(item)
        except queue.Full:
            self.overflow.set()

    def _read_frames(self):
        try:
            while True:
                raw = self.process.stdout.readline(LIMITS["maxFrameBytes"] + 1)
                if not raw:
                    self._enqueue(("eof", None))
                    return
                if len(raw) > LIMITS["maxFrameBytes"] or not raw.endswith(b"\n"):
                    self._enqueue(("error", "oversized or unterminated frame"))
                    return
                self._enqueue(("frame", raw))
        except (OSError, ValueError) as exc:
            self._enqueue(("error", str(exc)))

    def _read_logs(self):
        try:
            while True:
                raw = self.process.stderr.read(1024)
                if not raw:
                    return
                room = LIMITS["maxLogBytes"] - len(self.logs)
                self.logs.extend(raw[:max(0, room)])
                if len(raw) > room:
                    self.log_truncated = True
        except (OSError, ValueError):
            return

    def record(self, direction, message, raw=None):
        size = len(canonical(message)) + (len(raw) if raw is not None else 0)
        if self.audit_truncated or len(self.trace) >= LIMITS["maxAuditEntries"] or self.audit_bytes + size > LIMITS["maxAuditBytes"]:
            self.audit_truncated = True
            return
        self.audit_bytes += size
        item = {"sequence": len(self.trace) + 1, "direction": direction, "message": message}
        if raw is not None:
            item["rawFrame"] = {"encoding": "base64", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                                "data": base64.b64encode(raw).decode("ascii")}
        self.trace.append(item)

    def send(self, kind, payload=None, **fields):
        self.serial += 1
        message = {"kind": kind, "messageId": "h" + str(self.serial), **fields}
        if payload is not None:
            message.update(PAIR, sessionId=self.session, workerId=self.worker_id, bootId=self.boot,
                           requiredFeatures=[], optionalFeatures=[], payload=payload)
            if self.task_id is not None and kind != "session.shutdown":
                message.update(taskId=self.task_id, attemptId=self.attempt_id)
        raw = canonical(message) + b"\n"
        if len(raw) > LIMITS["maxFrameBytes"]:
            raise ProtocolError("outgoing frame exceeds negotiated budget")
        self.process.stdin.write(raw)
        self.process.stdin.flush()
        self.record("host-to-worker", message, raw)
        return message

    def receive(self, timeout=5.0):
        if self.overflow.is_set():
            raise ProtocolError("control queue budget exhausted")
        if self.audit_truncated:
            raise ProtocolError("audit byte/entry budget exhausted")
        try:
            kind, value = self.queue.get(timeout=max(0.001, timeout))
        except queue.Empty as exc:
            raise TimeoutError("worker deadline exceeded") from exc
        if kind == "eof":
            raise EOFError("worker closed its protocol stream")
        if kind == "error":
            raise ProtocolError(value)
        self.received_frames += 1
        if self.received_frames > LIMITS["maxSessionFrames"]:
            raise ProtocolError("session message budget exhausted")
        try:
            message = decode(value)
        except ProtocolError:
            self.record("invalid-frame", {"sha256": hashlib.sha256(value).hexdigest(), "bytes": len(value), "preview": value[:160].decode("utf-8", errors="replace")}, value)
            raise
        self.record("worker-to-host", message, value)
        return message

    def handshake(self):
        hello = self.receive(LIMITS["startupSeconds"])
        if (hello.get("kind") != "hello" or hello.get("bootstrapProfile") != BOOTSTRAP or
                PAIR not in hello.get("offeredPairs", []) or hello.get("requiredBootstrapFeatures")):
            raise ProtocolError("incompatible worker bootstrap")
        if hello.get("workerId") != WORKER_ID:
            raise ProtocolError("unexpected worker")
        self.boot = require_text(hello.get("bootId"), "bootId")
        capability = hello.get("capabilities", {})
        if MODE not in capability.get("modeProfiles", []) or capability.get("executionFeatures", {}).get("maxConcurrentTasks") != 1:
            raise ProtocolError("unsupported worker capabilities")
        init = self.send("initialize", bootstrapProfile=BOOTSTRAP, replyTo=hello["messageId"], sessionId=self.session,
                         selectedPair=PAIR, selectedCapabilities=capability, requiredFeatures=FEATURES, optionalFeatures=[],
                         transportProfileId=TRANSPORT, flowControlProfileId="single-credit-v0.1-experimental",
                         flowControlProfile={**LIMITS, "initialCredit": self.initial_credit})
        ready = self.receive(LIMITS["startupSeconds"])
        if (ready.get("kind") != "ready" or ready.get("bootstrapProfile") != BOOTSTRAP or ready.get("selectedPair") != PAIR or
                ready.get("sessionId") != self.session or ready.get("bootId") != self.boot or ready.get("replyTo") != init["messageId"] or
                ready.get("configurationFingerprint") != fingerprint(init) or ready.get("acceptedCapabilities") != capability or ready.get("availability") != "available"):
            raise ProtocolError("ready does not match selected configuration")
        self.ready = True

    def analyze(self, request, task_id="task", attempt_id="attempt"):
        if not self.ready:
            raise ProtocolError("analyze before ready")
        for field in ("snapshotId", "analysisProfileId", "effectiveRuleSetId", "sourceViewId", "configId",
                      "transportProfileId", "flowControlProfileId", "deadlineProfileId"):
            require_text(request.get(field), field)
        if request["transportProfileId"] != TRANSPORT or request["flowControlProfileId"] != "single-credit-v0.1-experimental":
            raise ProtocolError("unnegotiated transport/flow profile")
        if request["scope"]["configId"] != request["configId"] or type(request.get("allowPartial")) is not bool:
            raise ProtocolError("invalid analyze scope/partial policy")
        require_int(request.get("requestGeneration"), "requestGeneration", 1)
        if self.request is not None and (self.task_id, self.attempt_id, fingerprint(self.request)) != (task_id, attempt_id, fingerprint(request)):
            self.store.seal(self.key, "sealed_failed", "conflicting_analyze", "invalid")
            raise ProtocolError("active attempt changed")
        self.task_id, self.attempt_id = task_id, attempt_id
        self.key = self.store.begin(self.session, task_id, attempt_id, request)
        self.request = request
        self.send("analyze", request)

    def pump(self, timeout=5.0):
        try:
            message = self.receive(timeout)
            self._handle(message)
            return message
        except TimeoutError:
            if self.key:
                self.store.seal(self.key, "sealed_timed_out", "worker_deadline")
            raise
        except (ProtocolError, EOFError) as exc:
            if self.key:
                self.store.seal(self.key, "sealed_failed", str(exc), "invalid" if isinstance(exc, ProtocolError) else "incomplete")
            raise
        except (ValueError, KeyError, TypeError, RecursionError) as exc:
            if self.key:
                self.store.seal(self.key, "sealed_failed", "invalid_message_structure: " + str(exc), "invalid")
            raise ProtocolError("invalid message structure") from exc

    def _handle(self, message):
        expected = {**PAIR, "sessionId": self.session, "workerId": self.worker_id, "bootId": self.boot,
                    "taskId": self.task_id, "attemptId": self.attempt_id}
        if any(message.get(key) != value for key, value in expected.items()):
            self.quarantined += 1
            self.record("quarantined", {"reason": "envelope_identity_mismatch", "messageId": message.get("messageId")})
            return
        if any(feature not in FEATURES for feature in message.get("requiredFeatures", [])):
            raise ProtocolError("unknown required message feature")
        require_text(message.get("messageId"), "messageId")
        kind, payload = message["kind"], message.get("payload")
        if not isinstance(payload, dict):
            raise ProtocolError("message payload must be object")
        if kind != "facts.batch":
            self.control_count += 1
            if self.control_count > LIMITS["maxQueuedFrames"]:
                raise ProtocolError("control message budget exhausted")
        if kind == "cancel.ack":
            self.cancel_ack = payload
            return
        if self.store.attempt(self.key)["decision"] != "open":
            self.record("terminal-message-audit", {"kind": kind, "messageId": message["messageId"]})
            return
        if kind == "task.accepted":
            if payload.get("requestFingerprint") != fingerprint(self.request) or payload.get("acceptedScope") != self.request["scope"]:
                raise ProtocolError("accepted frozen request mismatch")
            if payload.get("executionModes") != self.request["requiredExecutionModes"]:
                raise ProtocolError("accepted modes differ")
            gaps = payload.get("coverageGaps")
            if not isinstance(gaps, list) or (gaps and not self.request["allowPartial"]):
                raise ProtocolError("unpermitted accepted coverage gaps")
            self.coverage_gaps = gaps
            self.accepted = True
        elif kind == "task.rejected":
            self.store.seal(self.key, "sealed_failed", "request_rejected:" + str(payload.get("code")))
        elif kind == "facts.batch":
            self._batch(payload, message["messageId"])
        elif kind == "task.finished":
            if not self.accepted:
                raise ProtocolError("finished before task accepted")
            if self.finished is not None and canonical(self.finished) != canonical(payload):
                raise ProtocolError("contradictory final manifest")
            self.finished = payload
            self.store.validating(self.key)
        elif kind == "task.progress":
            return
        elif kind == "protocol.error":
            raise ProtocolError("worker protocol error: " + str(payload.get("code")))
        else:
            raise ProtocolError("unsupported required message kind: " + str(kind))

    def _batch(self, payload, message_id):
        if not self.accepted or self.finished is not None:
            raise ProtocolError("batch outside accepted/unsealed stream")
        if self.credit <= 0:
            raise ProtocolError("fact sent without credit")
        self.credit -= 1
        for field in ("snapshotId", "scope", "publicationSlotId", "requestId", "requestGeneration"):
            if payload.get(field) != self.request[field]:
                raise ProtocolError("batch frozen identity mismatch: " + field)
        seq = require_int(payload.get("sequence"), "sequence", 1)
        batch_id = require_text(payload.get("batchId"), "batchId")
        count = require_int(payload.get("recordCount"), "recordCount")
        records = payload.get("records")
        if not isinstance(records, list) or count != len(records) or count > LIMITS["maxBatchRecords"]:
            raise ProtocolError("invalid batch record count")
        if payload.get("payloadFingerprint") != batch_fingerprint(payload):
            raise ProtocolError("batch fingerprint mismatch")
        validate_completeness(payload.get("completeness"), self.request["scope"])
        for record in records:
            if not isinstance(record, dict):
                raise ProtocolError("record must be object")
            fact_key(record.get("ref"))
        if seq in self.batches or batch_id in self.batch_ids:
            if self.batches.get(seq) != payload or self.batch_ids.get(batch_id) != seq:
                raise ProtocolError("conflicting duplicate batch/sequence")
            status = "duplicate"
            self.duplicates += 1
        else:
            if len(self.batches) >= LIMITS["maxBatches"] or len(self.raw_records) + count > LIMITS["maxRecords"]:
                raise ProtocolError("staging budget exhausted")
            self.batches[seq], self.batch_ids[batch_id] = payload, seq
            self.raw_records.extend(records)
            status = "staged"
        if self.auto_ack:
            self.send("batch.ack", {"batchId": batch_id, "sequence": seq, "payloadFingerprint": payload["payloadFingerprint"], "status": status, "credit": 1}, replyTo=message_id)
            self.credit += 1

    def until_finished(self, timeout=None):
        deadline = time.monotonic() + (LIMITS["taskSeconds"] if timeout is None else timeout)
        while self.finished is None and self.store.attempt(self.key)["decision"] == "open":
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self.store.seal(self.key, "sealed_timed_out", "worker_absolute_deadline")
                raise TimeoutError("worker absolute deadline exceeded")
            self.pump(remaining)
        return self.finished

    def finalize(self):
        if self.store.attempt(self.key)["decision"] != "open":
            return self.store.attempt(self.key)["decision"]
        try:
            if self.finished is None:
                raise ProtocolError("no final manifest")
            value = self.finished
            for field in ("snapshotId", "scope", "publicationSlotId", "requestId", "requestGeneration", "inputManifestRef", "identityRegistryRef", "analysisProfileId", "effectiveRuleSetId", "sourceViewId"):
                if value.get(field) != self.request[field]:
                    raise ProtocolError("finished frozen identity mismatch: " + field)
            sequence = require_int(value.get("finalSequence"), "finalSequence")
            if sorted(self.batches) != list(range(1, sequence + 1)):
                raise ProtocolError("missing final batch sequence")
            manifest = [{field: item[field] for field in ("batchId", "sequence", "payloadFingerprint", "recordCount")} for _, item in sorted(self.batches.items())]
            counts = dict(Counter(record["ref"]["kind"] for record in self.raw_records))
            require_int(value.get("totalRecordCount"), "totalRecordCount")
            if not isinstance(value.get("recordCounts"), dict):
                raise ProtocolError("invalid final recordCounts")
            for count in value["recordCounts"].values():
                require_int(count, "recordCounts value")
            if (canonical(value.get("batchManifest")) != canonical(manifest) or value["totalRecordCount"] != len(self.raw_records) or
                    canonical(value["recordCounts"]) != canonical(counts) or value.get("diagnosticManifest") != []):
                raise ProtocolError("final manifest/counts differ from received ledger")
            validate_completeness(value.get("completeness"), self.request["scope"])
            self.materialized = validate_records(self.raw_records, self.request)
            complete = value["completeness"]["complete"]
            if complete and (self.coverage_gaps or any(not item["completeness"]["complete"] for item in self.batches.values()) or
                             any(not item.get("completeness", {"complete": True})["complete"] for item in self.raw_records)):
                raise ProtocolError("final completeness lost a producer gap")
            outcome = value.get("outcome")
            if outcome == "completed" and complete:
                return self.store.seal(self.key, "sealed_completed", protocol="valid", semantic="complete")
            if outcome == "partial" and not complete:
                decision = "sealed_partial" if self.request["allowPartial"] else "sealed_failed"
                return self.store.seal(self.key, decision, "semantic_incomplete", "valid", "incomplete")
            if outcome in {"failed", "cancelled", "timed_out"}:
                return self.store.seal(self.key, "sealed_" + outcome, "worker_" + outcome, "valid", "incomplete")
            raise ProtocolError("outcome and completeness disagree")
        except (ProtocolError, KeyError, TypeError) as exc:
            self.store.seal(self.key, "sealed_failed", str(exc), "invalid")
            raise ProtocolError(str(exc)) from exc

    def publish(self, observed_input_fingerprint=None):
        payload = {"records": list(self.materialized.values()), "completeness": self.finished["completeness"], "manifest": self.finished["batchManifest"]}
        observed = observed_input_fingerprint or self.request["inputManifestRef"]["fingerprint"]
        return self.store.publish(self.key, payload, observed)

    def cancel(self, cancel_request_id="cancel-1"):
        result = self.store.cancel(self.key, cancel_request_id)
        self.record("host-cancel-result", result)
        if result["status"] == "accepted":
            try:
                self.send("task.cancel", {"cancelRequestId": cancel_request_id, "reason": "test-request", "decision": result["decision"]})
            except (BrokenPipeError, OSError):
                self.record("cancel-send-failed", {})
        return result

    def stop_cancelled(self, timeout=None):
        deadline = time.monotonic() + (LIMITS["stopSeconds"] if timeout is None else timeout)
        while self.process.poll() is None and time.monotonic() < deadline:
            try:
                self.pump(max(0.001, deadline - time.monotonic()))
            except (EOFError, TimeoutError, ProtocolError):
                break
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=max(0.001, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                self.cleanup_state = "forced_terminated"
        if self.cleanup_state is None:
            self.cleanup_state = "exited"
        self.store.cleanup(self.key, self.cleanup_state)

    def close(self):
        if self.closed:
            return
        self.closed = True
        if self.process.poll() is None:
            try:
                self.send("session.shutdown", {"reason": "experiment_cleanup", "deadlineProfileId": "host-monotonic-v0.1-experimental"})
                self.process.wait(timeout=0.5)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)
                self.cleanup_state = "forced_terminated"
        if self.cleanup_state is None:
            self.cleanup_state = "exited"
        for thread in self.readers:
            thread.join(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                stream.close()
            except OSError as exc:
                # The peer may exit between the final cancel and pipe cleanup.
                self.record("pipe-close-observation", {"error": str(exc), "processExited": self.process.poll() is not None})
        if self.key:
            if self.store.attempt(self.key)["decision"] == "open":
                self.store.seal(self.key, "sealed_failed", "host_closed_before_completion")
            self.store.cleanup(self.key, self.cleanup_state)

    def observation(self):
        return {"sessionId": self.session, "pid": self.process.pid, "returnCode": self.process.poll(),
                "cleanup": self.cleanup_state, "uniqueBatches": len(self.batches), "rawRecordCount": len(self.raw_records),
                "uniqueRecordCount": len(self.materialized), "duplicateBatches": self.duplicates,
                "quarantinedMessages": self.quarantined, "cancelAck": self.cancel_ack,
                "receivedFrames": self.received_frames, "auditBytes": self.audit_bytes, "auditTruncated": self.audit_truncated,
                "logs": bytes(self.logs).decode("utf-8", errors="replace"), "logTruncated": self.log_truncated,
                "trace": self.trace}
