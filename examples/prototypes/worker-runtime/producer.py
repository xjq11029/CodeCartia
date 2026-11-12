"""Trusted fault-injectable protocol producer. It never loads target project code."""
from __future__ import annotations

import os
import sys
import time
import uuid

from wire import BOOTSTRAP, PAIR, TRANSPORT, MODE, FEATURES, LIMITS, KINDS, canonical, decode, fingerprint

WORKER_ID = "codecartia-controlled-producer"


def main():
    boot = str(uuid.uuid4())
    serial = 0
    hello_mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
    pairs = [PAIR] if hello_mode != "no-common-schema" else [{**PAIR, "schemaVersion": "0.1-draft"}]
    capability = {"adapterId": WORKER_ID, "adapterKind": "protocol", "adapterVersion": "0.1-experimental",
                  "languageIds": [], "frameworkProfiles": [], "protocolProfiles": [TRANSPORT],
                  "recordKinds": sorted(KINDS), "modeProfiles": [MODE],
                  "requiredInputKinds": ["controlled-fixture"], "toolRequirements": ["python-stdlib"],
                  "availability": "available", "validationStatus": "experimental-not-product",
                  "validationReportRefs": [], "coordinatePolicyIds": [], "sourceViews": ["static"],
                  "extensions": ["codecartia.runtimeExperiment"],
                  "executionFeatures": {"cancel": True, "partial": True, "maxConcurrentTasks": 1, "flowControl": True}}

    def send(kind, payload=None, task=None, overrides=None, **fields):
        nonlocal serial
        serial += 1
        message = {"kind": kind, "messageId": "w" + str(serial), **fields}
        if payload is not None:
            message.update(PAIR, sessionId=session, workerId=WORKER_ID, bootId=boot,
                           requiredFeatures=[], optionalFeatures=[], payload=payload)
            if task is not None:
                message.update(taskId=task["taskId"], attemptId=task["attemptId"])
        if overrides:
            message.update(overrides)
        sys.stdout.buffer.write(canonical(message) + b"\n")
        sys.stdout.buffer.flush()
        return message

    hello = send("hello", bootstrapProfile=BOOTSTRAP, workerId=WORKER_ID, workerBuild="0.1-experimental", bootId=boot,
                 offeredPairs=pairs, capabilities=capability,
                 requiredBootstrapFeatures=["unknown-required"] if hello_mode == "unknown-feature" else [], optionalBootstrapFeatures=[])
    raw = sys.stdin.buffer.readline(LIMITS["maxFrameBytes"] + 1)
    if not raw:
        return
    init = decode(raw)
    if (init.get("kind") != "initialize" or init.get("bootstrapProfile") != BOOTSTRAP or
            init.get("selectedPair") not in pairs or init.get("replyTo") != hello["messageId"]):
        send("session.rejected", bootstrapProfile=BOOTSTRAP, code="incompatible_initialization", offeredPairs=pairs, unsupportedFeatures=[])
        return
    session = init["sessionId"]
    ready_pair = {**PAIR, "schemaVersion": "wrong"} if hello_mode == "wrong-ready" else PAIR
    send("ready", bootstrapProfile=BOOTSTRAP, replyTo=init["messageId"], sessionId=session, bootId=boot,
         selectedPair=ready_pair, acceptedCapabilities=capability, availability="available", configurationFingerprint=fingerprint(init))
    credit = init["flowControlProfile"]["initialCredit"]
    active = None
    accepted = None
    position = 0
    finished = False

    def pump():
        nonlocal credit, position, finished
        if not active or finished:
            return
        experiment = active["payload"]["extensions"]["codecartia.runtimeExperiment"]
        behavior = experiment.get("behavior", "normal")
        if behavior in {"wait-for-cancel", "ignore-cancel", "late-complete", "hang"}:
            return
        if behavior == "crash":
            os._exit(17)
        if behavior in {"stale-flood", "stale-fast-flood"}:
            while True:
                send("task.progress", {"phase": "invalid-old-attempt"}, task=active, overrides={"attemptId": "old-attempt"})
                # Keep the session-budget case below the reader queue capacity,
                # so its evidence isolates the total-message guard.
                time.sleep(0.005 if behavior == "stale-flood" else 0.006)
        if behavior in {"nonfinite-frame", "surrogate-frame", "missing-kind"}:
            raw = b'{"kind":"test","x":1e9999}\n' if behavior == "nonfinite-frame" else b'{"kind":"test","x":"\\ud800"}\n'
            if behavior == "missing-kind":
                raw = canonical({**PAIR, "sessionId": session, "workerId": WORKER_ID, "bootId": boot, "messageId": "no-kind",
                                 "taskId": active["taskId"], "attemptId": active["attemptId"], "requiredFeatures": [], "payload": {}}) + b"\n"
            sys.stdout.buffer.write(raw)
            sys.stdout.buffer.flush()
            finished = True
            return
        if behavior == "bad-json":
            sys.stdout.buffer.write(b"not protocol JSON\n")
            sys.stdout.buffer.flush()
            finished = True
            return
        if behavior == "oversize":
            sys.stdout.buffer.write(b"x" * (LIMITS["maxFrameBytes"] + 1) + b"\n")
            sys.stdout.buffer.flush()
            finished = True
            return
        batches = experiment["batches"]
        while position < len(batches) and (credit > 0 or behavior == "violate-credit"):
            item = batches[position]
            if behavior == "stale-envelope" and position == 0:
                send("facts.batch", item, task=active, overrides={"attemptId": "old-attempt"})
            overrides = experiment.get("envelopeOverrides", {}).get(str(position))
            send("facts.batch", item, task=active, overrides=overrides)
            credit -= 1
            position += 1
        if position == len(batches):
            send("task.finished", experiment["finish"], task=active)
            if behavior == "duplicate-finish":
                send("task.finished", experiment["finish"], task=active)
            finished = True

    while True:
        raw = sys.stdin.buffer.readline(LIMITS["maxFrameBytes"] + 1)
        if not raw:
            return
        message = decode(raw)
        kind = message.get("kind")
        if kind == "session.shutdown":
            return
        if any(message.get(key) != value for key, value in {**PAIR, "sessionId": session, "workerId": WORKER_ID, "bootId": boot}.items()):
            return
        if kind == "analyze":
            payload = message["payload"]
            if active:
                if (message["taskId"], message["attemptId"], fingerprint(payload)) == (active["taskId"], active["attemptId"], fingerprint(active["payload"])):
                    send(accepted["kind"], accepted["payload"], task=message)
                else:
                    send("protocol.error", {"code": "conflicting_analyze"}, task=message)
                continue
            active = message
            required = payload.get("requiredExecutionModes", [])
            coverage = payload.get("requestedCoverage", [])
            if any(mode != MODE for mode in required) or payload.get("declaredExternalProviders") or (not payload.get("allowPartial") and any(mode != MODE for mode in coverage)):
                accepted = send("task.rejected", {"code": "unsupported_required_mode", "reason": "controlled producer capability is insufficient"}, task=active)
                continue
            accepted = send("task.accepted", {"requestFingerprint": fingerprint(payload), "acceptedScope": payload["scope"],
                                              "executionModes": required, "coverageGaps": [mode for mode in coverage if mode != MODE]}, task=active)
            sys.stderr.buffer.write(canonical({"kind": "facts.batch", "message": "this is a log, not a fact"}) + b"\n")
            sys.stderr.buffer.flush()
            pump()
        elif kind == "batch.ack" and active:
            credit += message["payload"].get("credit", 0)
            pump()
        elif kind == "task.cancel" and active:
            behavior = active["payload"]["extensions"]["codecartia.runtimeExperiment"].get("behavior", "normal")
            send("cancel.ack", {"cancelRequestId": message["payload"]["cancelRequestId"], "status": "already_terminal" if finished else "accepted",
                                "workerObservedState": "finished" if finished else "running"}, task=active, replyTo=message["messageId"])
            if behavior == "ignore-cancel":
                continue
            if behavior == "late-complete":
                send("task.finished", active["payload"]["extensions"]["codecartia.runtimeExperiment"]["finish"], task=active)
            else:
                send("task.finished", {"outcome": "cancelled"}, task=active)
            return


if __name__ == "__main__":
    main()
