"""Exploratory framing and a deliberately scoped 0.2 FactRef validator."""
from __future__ import annotations

import hashlib
import json

BOOTSTRAP = "codecartia-worker-bootstrap-v0.1-draft"
PAIR = {"protocolVersion": "0.2-draft", "schemaVersion": "0.2-draft"}
TRANSPORT = "jsonl-utf8-sha256-sorted-keys-v0.1-experimental"
MODE = "controlled-fact-stream-v0.1"
FEATURES = ["precise-fact-ref", "latest-request-generation"]
LIMITS = {"maxFrameBytes": 1048576, "maxJsonDepth": 64, "maxQueuedFrames": 128, "maxLogBytes": 65536,
          "maxSessionFrames": 256, "maxAuditEntries": 768, "maxAuditBytes": 8388608,
          "maxBatchRecords": 256, "maxBatches": 64, "maxRecords": 4096,
          "maxInFlightBatches": 1, "startupSeconds": 5.0, "taskSeconds": 5.0,
          "stopSeconds": 1.0}
KINDS = {"EntityVersion", "Relation", "Evidence", "Derivation", "Condition"}
SCOPE_FIELDS = ("projectId", "environmentId", "configId", "entryContextId")
REF_FIELDS = ("kind", "id", "revisionId", "snapshotId", "sourceViewId", "layer")
DEPENDENCY_FIELDS = ("evidenceRefs", "conditionRefs", "inputFactRefs", "outputFactRefs",
                     "sourceClosure", "supportingEvidenceRefs", "opposingEvidenceRefs")


class ProtocolError(ValueError):
    pass


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def fingerprint(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def decode(raw: bytes) -> dict:
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ProtocolError("duplicate JSON key")
            result[key] = value
        return result
    def reject_constant(value):
        raise ProtocolError("non-finite JSON number: " + value)
    try:
        text = raw.decode("utf-8", errors="strict")
        depth, quoted, escaped = 0, False, False
        for character in text:
            if quoted:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == '"':
                    quoted = False
            elif character == '"':
                quoted = True
            elif character in "[{":
                depth += 1
                if depth > LIMITS["maxJsonDepth"]:
                    raise ProtocolError("JSON nesting budget exhausted")
            elif character in "]}":
                depth -= 1
        value = json.loads(text, object_pairs_hook=unique, parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ProtocolError("frame must be a JSON object")
        # json.loads accepts overflowing exponents and lone escaped surrogates.
        # Validate the entire decoded tree before it can enter host state.
        canonical(value)
        return value
    except ProtocolError:
        raise
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise ProtocolError("invalid UTF-8/JSON frame") from exc


def require_text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ProtocolError("missing " + field)
    return value


def require_int(value: object, field: str, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ProtocolError("invalid " + field)
    return value


def fact_key(ref: dict) -> str:
    if not isinstance(ref, dict) or ref.get("kind") not in KINDS:
        raise ProtocolError("unsupported/ID-only FactRef")
    fields = [require_text(ref.get(key), key) for key in REF_FIELDS]
    scope = ref.get("scope")
    if not isinstance(scope, dict) or set(scope) != set(SCOPE_FIELDS):
        raise ProtocolError("incomplete FactRef scope")
    fields.append([require_text(scope.get(key), "scope." + key) for key in SCOPE_FIELDS])
    if ref["layer"] not in {"base", "rule-output", "merged", "overlay", "runtime"}:
        raise ProtocolError("unknown FactRef layer")
    return canonical(fields).decode("utf-8")


def completeness(scope: dict, complete: bool = True) -> dict:
    return {"complete": complete, "missingInputs": [], "unsupportedModes": [],
            "truncations": [], "freshness": "current", "affectedScope": scope,
            "diagnosticRefs": []}


def validate_completeness(value: dict, scope: dict) -> None:
    if not isinstance(value, dict) or type(value.get("complete")) is not bool:
        raise ProtocolError("missing completeness")
    for key in ("missingInputs", "unsupportedModes", "truncations", "diagnosticRefs"):
        if not isinstance(value.get(key), list):
            raise ProtocolError("missing completeness." + key)
    if value.get("freshness") not in {"current", "stale"} or value.get("affectedScope") != scope:
        raise ProtocolError("invalid completeness scope/freshness")
    if value["complete"] and (value["missingInputs"] or value["unsupportedModes"] or value["truncations"] or value["freshness"] != "current"):
        raise ProtocolError("complete output has gaps")


def batch_fingerprint(payload: dict) -> str:
    return fingerprint({key: value for key, value in payload.items() if key != "payloadFingerprint"})


def validate_records(records: list[dict], request: dict) -> dict:
    """Validate only the explicitly advertised record subset, never full semantics."""
    materialized = {}
    for record in records:
        if not isinstance(record, dict) or "derivationRefs" in record:
            raise ProtocolError("invalid record or worker support projection")
        ref = record.get("ref")
        key = fact_key(ref)
        if ref["snapshotId"] != request["snapshotId"] or ref["scope"] != request["scope"]:
            raise ProtocolError("cross snapshot/scope fact")
        if ref["sourceViewId"] != request["sourceViewId"]:
            raise ProtocolError("source view mismatch")
        if request["sourceViewId"] == "static" and (record.get("production") != "automatic" or ref["layer"] in {"overlay", "runtime"}):
            raise ProtocolError("auxiliary source in automatic baseline")
        if key in materialized and canonical(materialized[key]) != canonical(record):
            raise ProtocolError("same FactRef changed content")
        if "completeness" in record:
            validate_completeness(record["completeness"], request["scope"])
        materialized[key] = record
    graph = {}
    registry = {canonical(item) for item in request["entityRegistry"]}
    for key, record in materialized.items():
        for field in DEPENDENCY_FIELDS:
            values = record.get(field, [])
            if not isinstance(values, list):
                raise ProtocolError("invalid dependency array")
            for ref in values:
                if fact_key(ref) not in materialized:
                    raise ProtocolError("missing exact fact: " + field)
        if any(name in record for name in ("inputFactIds", "outputIds", "evidenceIds")):
            raise ProtocolError("ID-only dependency")
        if record["ref"]["kind"] == "Relation":
            entities = [record.get("sourceRef"), *record.get("targetRefs", [])]
            for entity in entities:
                if not isinstance(entity, dict) or entity.get("kind") != "EntityRef" or canonical(entity) not in registry:
                    raise ProtocolError("unregistered logical EntityRef")
        if record["ref"]["kind"] == "Derivation":
            if not record.get("inputFactRefs") or not record.get("outputFactRefs"):
                raise ProtocolError("empty derivation")
            if request["sourceViewId"] == "static" and record.get("analysisMode") != "static":
                raise ProtocolError("non-static derivation")
            for output in record["outputFactRefs"]:
                graph.setdefault(fact_key(output), set()).update(fact_key(item) for item in record["inputFactRefs"])
    visiting, visited = set(), set()
    def visit(key):
        if key in visiting:
            raise ProtocolError("cyclic fact support")
        if key in visited:
            return
        visiting.add(key)
        for target in graph.get(key, ()):
            visit(target)
        visiting.remove(key)
        visited.add(key)
    for key in graph:
        visit(key)
    return materialized
