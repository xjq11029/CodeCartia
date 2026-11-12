"""Controlled inputs for pre-existing W-* expectations; no analyzer truth here."""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import hashlib

from wire import TRANSPORT, MODE, completeness, fingerprint, batch_fingerprint

SCOPE = {"projectId": "protocol-fixture", "environmentId": "controlled-process", "configId": "static-fixture",
         "entryContextId": "explicitly-unbound"}
SLOT = {"workspaceId": "runtime-lab", "publicationScopeId": "controlled-scope", "sourceViewId": "static"}


def fixture_records(snapshot):
    def ref(kind, name, layer="base"):
        return {"kind": kind, "id": name, "revisionId": "v1", "snapshotId": snapshot,
                "sourceViewId": "static", "scope": deepcopy(SCOPE), "layer": layer}
    left = {"kind": "EntityRef", "entityKind": "symbol", "id": "source", "projectId": SCOPE["projectId"]}
    right = {"kind": "EntityRef", "entityKind": "symbol", "id": "target", "projectId": SCOPE["projectId"]}
    raw_fingerprint = hashlib.sha256(b"call(target)").hexdigest()
    ev = {"ref": ref("Evidence", "source-span"), "production": "automatic", "carrierKind": "source_code",
          "inputId": "controlled-source", "inputFingerprint": raw_fingerprint,
          "accessRegistrationId": "controlled-memory-fixture", "supportRole": "call-anchor",
          "span": {"inputId": "controlled-source", "inputFingerprint": raw_fingerprint,
                   "coordinatePolicyId": "raw-bytes-codepoints-v0.1", "mappingStatus": "exact", "mappingRefs": [],
                   "normalized": {"startByte": 0, "endByte": 12, "startLine": 1, "startColumn": 1, "endLine": 1, "endColumn": 13},
                   "nativePositions": [{"tool": "controlled-fixture", "unit": "byte", "base": 0, "start": 0, "end": 12}]}}
    a = {"ref": ref("EntityVersion", "source-version"), "production": "automatic", "entityRef": left, "evidenceRefs": [ev["ref"]]}
    b = {"ref": ref("EntityVersion", "target-version"), "production": "automatic", "entityRef": right, "evidenceRefs": [ev["ref"]]}
    relation = {"ref": ref("Relation", "call", "rule-output"), "type": "static-call-candidate", "production": "automatic",
                "sourceRef": left, "targetRefs": [right], "targetMode": "candidateSet", "targetSetCompleteness": "unknown",
                "scope": deepcopy(SCOPE), "contextId": "fixture-call", "resolution": "confirmed", "conditionRefs": [],
                "evidenceRefs": [ev["ref"]], "completeness": completeness(SCOPE)}
    derivation = {"ref": ref("Derivation", "bind-call", "rule-output"), "production": "automatic", "analysisMode": "static",
                  "method": "controlled-test-data", "analyzerId": "protocol-fixture", "version": "v1", "ruleIds": [],
                  "effectiveRuleSetId": "none", "inputFactRefs": [a["ref"], b["ref"], ev["ref"]],
                  "outputFactRefs": [relation["ref"]], "evidenceRefs": [ev["ref"]], "sourceClosure": [ev["ref"]]}
    return [relation, a, b, ev, derivation], [left, right]


def build_batch(request, sequence, records, complete=True):
    value = {key: deepcopy(request[key]) for key in ("snapshotId", "scope", "publicationSlotId", "requestId", "requestGeneration")}
    value.update(batchId="batch-" + str(sequence), sequence=sequence, recordCount=len(records), records=deepcopy(records), completeness=completeness(SCOPE, complete))
    if not complete:
        value["completeness"]["unsupportedModes"] = [{"modeId": "controlled-gap", "reason": "fault fixture semantic gap"}]
    value["payloadFingerprint"] = batch_fingerprint(value)
    return value


def rebuild_finish(request, batches, partial=False):
    value = {key: deepcopy(request[key]) for key in ("snapshotId", "scope", "publicationSlotId", "requestId", "requestGeneration", "inputManifestRef",
                                                     "identityRegistryRef", "analysisProfileId", "effectiveRuleSetId", "sourceViewId")}
    unique = {item["sequence"]: item for item in batches}
    records = [record for _, item in sorted(unique.items()) for record in item["records"]]
    value.update(outcome="partial" if partial else "completed", finalSequence=max(unique, default=0),
                 batchManifest=[{key: item[key] for key in ("batchId", "sequence", "payloadFingerprint", "recordCount")} for _, item in sorted(unique.items())],
                 totalRecordCount=len(records), recordCounts=dict(Counter(item["ref"]["kind"] for item in records)),
                 diagnosticManifest=[], completeness=completeness(SCOPE, not partial))
    if partial:
        value["completeness"]["unsupportedModes"] = [{"modeId": "controlled-gap", "reason": "fault fixture semantic gap"}]
    return value


def request_for(store, name, *, behavior="normal", allow_partial=True, partial=False, slot=None, registration=None, snapshot=None):
    frozen = {"scope": deepcopy(SCOPE), "configId": SCOPE["configId"], "inputManifestRef": {"id": "controlled-inputs", "fingerprint": fingerprint("fixed-controlled-inputs")},
              "identityRegistryRef": {"id": "fixture-identities", "fingerprint": fingerprint(["source", "target"])},
              "analysisProfileId": "reference-transfer-only-v0.1", "effectiveRuleSetId": "none", "sourceViewId": "static"}
    registration = registration or store.register(slot or SLOT, name, frozen)
    payload = {**deepcopy(frozen), **registration, "snapshotId": snapshot or "snapshot-" + name, "previousPublishedSnapshotId": None,
               "inputRegistrations": [{"id": "controlled-memory-fixture", "kind": "controlled-fixture", "readonly": True}],
               "requiredExecutionModes": [MODE], "requestedCoverage": [MODE], "allowPartial": allow_partial,
               "declaredExternalProviders": [], "transportProfileId": TRANSPORT,
               "flowControlProfileId": "single-credit-v0.1-experimental", "deadlineProfileId": "host-monotonic-v0.1-experimental"}
    records, entities = fixture_records(payload["snapshotId"])
    payload["entityRegistry"] = entities
    if partial:
        records[0]["completeness"] = completeness(SCOPE, False)
        records[0]["completeness"]["unsupportedModes"] = [{"modeId": "controlled-gap", "reason": "fault fixture"}]
    batches = [build_batch(payload, 1, records[:1], not partial), build_batch(payload, 2, records[1:], not partial)]
    payload["extensions"] = {"codecartia.runtimeExperiment": {"behavior": behavior, "batches": batches, "finish": rebuild_finish(payload, batches, partial)}}
    return payload
