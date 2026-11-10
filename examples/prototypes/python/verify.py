"""Use the independent expected file only here; reject corrupted reports as well."""
import copy
import ast
import hashlib
import json
import sys
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
from extract import BASE, byte_position, contained, extract


def write_report(name, value):
    path = contained(BASE / "reports", name)
    if path.suffix != ".json":
        raise ValueError("REPORT_FORMAT_REFUSED")
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def declaration_span(raw, qualified_target):
    """Locate the independently expected qualified declaration in original text."""
    parts = qualified_target.split(".")[1:]
    body = ast.parse(raw.decode("utf-8-sig")).body
    declaration = None
    for name in parts:
        matches = [node for node in body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
        if len(matches) != 1:
            raise ValueError("Expected declaration is absent or ambiguous")
        declaration = matches[0]
        body = declaration.body
    raw_lines = raw.splitlines(keepends=True)
    bom = 3 if raw.startswith(b"\xef\xbb\xbf") else 0
    start = sum(map(len, raw_lines[:declaration.lineno - 1])) + declaration.col_offset + (bom if declaration.lineno == 1 else 0)
    end = sum(map(len, raw_lines[:declaration.end_lineno - 1])) + declaration.end_col_offset + (bom if declaration.end_lineno == 1 else 0)
    start_prefix = raw_lines[declaration.lineno - 1][(bom if declaration.lineno == 1 else 0):start - sum(map(len, raw_lines[:declaration.lineno - 1]))].decode("utf-8")
    end_prefix = raw_lines[declaration.end_lineno - 1][(bom if declaration.end_lineno == 1 else 0):end - sum(map(len, raw_lines[:declaration.end_lineno - 1]))].decode("utf-8")
    return {"startByte": start, "endByte": end, "startLine": declaration.lineno, "startColumn": len(start_prefix) + 1, "endLine": declaration.end_lineno, "endColumn": len(end_prefix) + 1}, declaration


def fingerprint(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def evaluate(report, expected):
    checks = []

    def check(name, passed):
        checks.append({"name": name, "passed": bool(passed)})

    for project, count in expected["callInventory"].items():
        check("call-inventory:" + project, sum(f["project"] == project for f in report["facts"]) == count)
    check("no-unregistered-project-facts", all(f["project"] in expected["callInventory"] for f in report["facts"]))
    for wanted in expected["bindings"]:
        matches = [fact for fact in report["facts"] if all(fact[key] == wanted[key] for key in ("project", "owner", "callee"))]
        check("binding-count:" + wanted["owner"] + ":" + wanted["callee"], len(matches) == wanted.get("count", 1))
        for index, fact in enumerate(matches):
            name = wanted["owner"] + ":" + wanted["callee"] + f":{index}"
            check("binding:" + name, fact["mode"] == wanted["mode"] and fact["target"] == wanted.get("target") and fact["code"] == wanted.get("code"))
            if wanted["mode"] == "confirmed":
                target = fact.get("targetEvidence") or {}
                check("target-source:" + name, target.get("mappingStatus") == "exact" and target.get("inputId", "").split(":")[-1] == wanted["target"].split(".")[0] + ".py")
                target_id = wanted["project"] + ":" + wanted["target"].split(".")[0] + ".py"
                source_input = next(i for i in report["inputs"] if i["inputId"] == target_id)
                raw_target = contained(BASE, source_input["path"]).read_bytes()
                expected_span, declaration = declaration_span(raw_target, wanted["target"])
                native = target.get("nativePositions", {})
                check("exact-qualified-declaration:" + name, target.get("inputId") == target_id and target.get("inputFingerprint") == "sha256:" + hashlib.sha256(raw_target).hexdigest() and target.get("normalized") == expected_span and native.get("startLine") == declaration.lineno and native.get("endLine") == declaration.end_lineno and native.get("startColumn") == declaration.col_offset and native.get("endColumn") == declaration.end_col_offset and raw_target[expected_span["startByte"]:expected_span["endByte"]].decode("utf-8") == ast.get_source_segment(raw_target.decode("utf-8-sig"), declaration))
    for code in expected["requiredDiagnosticCodes"]:
        check("diagnostic:" + code, any(d["code"] == code for d in report["diagnostics"]))
    wanted = expected["coordinateCase"]
    coordinate = next((f for f in report["facts"] if f["project"] == wanted["project"] and f["owner"] == wanted["owner"] and f["callee"] == wanted["callee"]), None)
    span = coordinate["evidence"] if coordinate else {}
    normal, native = span.get("normalized", {}), span.get("nativePositions", {})
    check("coordinate-normalized", normal == {"startByte": wanted["startByte"], "endByte": wanted["endByte"], "startLine": wanted["line"], "endLine": wanted["line"], "startColumn": wanted["startColumn"], "endColumn": wanted["endColumn"]})
    check("coordinate-native", native.get("startColumn") == wanted["nativeStartColumn"] and native.get("endColumn") == wanted["nativeEndColumn"] and native.get("unit") == "UTF-8-byte-column")
    inputs = {item["inputId"]: item for item in report["inputs"]}
    for index, fact in enumerate(report["facts"]):
        evidence = fact["evidence"]
        raw = (BASE / inputs[evidence["inputId"]]["path"]).read_bytes()
        pos = evidence["normalized"]
        check(f"raw-call-range:{index}", raw[pos["startByte"]:pos["endByte"]].decode("utf-8") == fact["text"] and evidence["inputFingerprint"] == "sha256:" + hashlib.sha256(raw).hexdigest())
        check(f"declaration-not-runtime:{index}", fact["bindingKind"] == "lexical-declaration-reference" and fact["runtimeTargetMode"] == "unknown" and fact["runtimeObserved"] is False and fact["executionReachability"] == "not-evaluated")
    check("not-full-analysis", report["completeness"]["complete"] is False and "schemaVersion" not in report)
    return checks


def main():
    sentinels = [BASE / "fixtures/side_effect/entry.executed", BASE / "fixtures/side_effect/malicious_backend.executed"]
    if any(p.exists() for p in sentinels):
        raise RuntimeError("Existing execution sentinel invalidates this test")
    report = extract()
    expected = json.loads((BASE / "expected/cases.json").read_text(encoding="utf-8"))
    checks = evaluate(report, expected)

    def check(name, passed):
        checks.append({"name": name, "passed": bool(passed)})

    check("current-extractor", report["extractorFingerprint"] == fingerprint(BASE / "extract.py"))
    check("current-registry", report["registryFingerprint"] == fingerprint(BASE / "inputs.json"))
    check("current-source-inputs", all(i["fingerprint"] == fingerprint(BASE / i["path"]) for i in report["inputs"]))
    check("missing-input-observation-current", all((BASE / q["path"]).is_file() == q["exists"] for q in report["inputQueries"]))
    check("oracle-not-input", report["expectedReadByExtractor"] is False and all(i["path"].startswith("fixtures/") for i in report["inputs"]))
    check("source-not-executed", all(not p.exists() for p in sentinels) and report["targetModulesExecuted"] is False)
    for wanted in expected["independentCoordinatePoints"]:
        actual = byte_position(expected["independentCoordinateText"].encode("utf-8"), wanted["byte"])
        check("coordinate-point:" + str(wanted["byte"]), actual == {"line": wanted["line"], "column": wanted["column"]})
    for offset, reason in [(1, "CODEPOINT"), (9, "CRLF")]:
        rejected = False
        try:
            byte_position(expected["independentCoordinateText"].encode("utf-8"), offset)
        except ValueError as error:
            rejected = reason in str(error)
        check("coordinate-interior-refused:" + str(offset), rejected)

    registry = json.loads((BASE / "inputs.json").read_text(encoding="utf-8"))
    for name, root, files in [("path-traversal", "fixtures/positive", ["../../expected/cases.json"]), ("build-project-refused", "fixtures/side_effect", ["pyproject.toml"]), ("non-source-root-refused", "expected", ["cases.json"])]:
        variant = copy.deepcopy(registry)
        variant["projects"] = [{"id": "boundary", "root": root, "files": files}]
        write_report("boundary-inputs.json", variant)
        rejected = False
        try:
            extract("reports/rejected.json", "reports/boundary-inputs.json")
        except ValueError:
            rejected = True
        check("input-policy:" + name, rejected)
    check("build-backend-never-imported", all(not p.exists() for p in sentinels))
    rejected = False
    try:
        extract("expected/cases.json")
    except ValueError:
        rejected = True
    check("output-cannot-overwrite-oracle", rejected)

    # Native directory link: the disposable sentinel is outside reports, never an oracle.
    token = uuid.uuid4().hex
    probe_root = BASE / (".output-probe-" + token)
    link = BASE / "reports" / ("link-" + token)
    probe_root.mkdir()
    sentinel = probe_root / "sentinel.json"
    sentinel.write_text("unchanged", encoding="utf-8")
    try:
        if sys.platform == "win32":
            import _winapi
            _winapi.CreateJunction(str(probe_root), str(link))
        else:
            link.symlink_to(probe_root, target_is_directory=True)
        refused = False
        try:
            write_report(link.name + "/sentinel.json", {"shouldNotWrite": True})
        except ValueError:
            refused = True
        check("verifier-directory-link-refused", refused and sentinel.read_text(encoding="utf-8") == "unchanged")
    finally:
        if link.is_symlink():
            link.unlink()
        elif link.exists():
            link.rmdir()
        sentinel.unlink()
        probe_root.rmdir()

    mutations = {}
    mutant = copy.deepcopy(report)
    mutant["facts"][0]["target"] = "mathops.decode"
    mutations["wrong-target"] = mutant
    mutant = copy.deepcopy(report)
    mutant["facts"].pop(0)
    mutations["missing-call"] = mutant
    mutant = copy.deepcopy(report)
    mutant["facts"].append(copy.deepcopy(mutant["facts"][0]))
    mutations["extra-call"] = mutant
    mutant = copy.deepcopy(report)
    mutant["facts"][0]["evidence"]["normalized"]["startByte"] += 1
    mutations["wrong-byte-offset"] = mutant
    mutant = copy.deepcopy(report)
    next(f for f in mutant["facts"] if f["owner"] == "entry.second")["target"] = "entry.first.same"
    mutations["merged-same-name-scope"] = mutant
    mutant = copy.deepcopy(report)
    next(f for f in mutant["facts"] if f["code"] == "ASSIGNMENT_BINDING_UNKNOWN")["mode"] = "confirmed"
    mutations["unknown-promoted"] = mutant
    mutant = copy.deepcopy(report)
    first = next(f for f in mutant["facts"] if f["owner"] == "entry.first")
    second = next(f for f in mutant["facts"] if f["owner"] == "entry.second")
    first["targetEvidence"] = copy.deepcopy(second["targetEvidence"])
    mutations["same-file-wrong-declaration"] = mutant
    mutant = copy.deepcopy(report)
    mutant["facts"][0]["targetEvidence"]["normalized"]["endByte"] += 1000
    mutations["target-declaration-outside-source"] = mutant
    for name, mutant in mutations.items():
        check("oracle-rejects:" + name, any(not c["passed"] for c in evaluate(mutant, expected)))
    result = {"status": "checks-passed" if all(c["passed"] for c in checks) else "checks-failed", "scope": "Registered flat modules, lexical declarations, coordinates and explicit refusal; not runtime targets, full Python semantics or real project-loader validation", "expectedFingerprint": fingerprint(BASE / "expected/cases.json"), "verifierFingerprint": fingerprint(Path(__file__)), "reportFingerprint": fingerprint(BASE / "reports/actual.json"), "passed": sum(c["passed"] for c in checks), "total": len(checks), "checks": checks}
    write_report("verification.json", result)
    print(json.dumps({k: result[k] for k in ("status", "passed", "total")}))
    for check_result in checks:
        if not check_result["passed"]:
            print(check_result["name"])
    return 0 if result["status"] == "checks-passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
