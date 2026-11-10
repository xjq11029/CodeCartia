"""Independent report checks; this process never loads fixture assemblies or runs C#."""
import copy
import hashlib
import json
import sys
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parent


def write_report(name, value):
    root = BASE / "reports"
    path = root / name
    if Path(name).is_absolute() or not path.resolve().is_relative_to(root) or path.suffix != ".json":
        raise ValueError("REPORT_PATH_REFUSED")
    cursor = path
    while cursor != root.parent:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("REPORT_LINK_REFUSED")
        cursor = cursor.parent
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fingerprint(path):
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def evaluate(report, expected):
    checks = []

    def check(name, passed):
        checks.append({"name": name, "passed": bool(passed)})

    cases = {case["caseId"]: case for case in report["cases"]}
    check("exact-case-inventory", set(cases) == {"positive", "missing-reference", "dynamic"})
    check("exact-call-inventory", sum(len(case["calls"]) for case in cases.values()) == len(expected["positiveCalls"]) + len(expected["unknownCalls"]))
    for wanted in expected["positiveCalls"]:
        calls = [c for c in cases.get("positive", {}).get("calls", []) if c["text"] == wanted["text"]]
        check("positive-present:" + wanted["text"], len(calls) == 1)
        if not calls:
            continue
        call = calls[0]
        target = call.get("target") or {}
        check("static-binding:" + wanted["text"], call["resolution"] == "confirmed" and call["targetMode"] == "exact" and call["targetSetCompleteness"] == "complete" and target.get("signature") == wanted["signature"] and call["candidateSignatures"] == [])
        target_span = target.get("declarationSpan") or {}
        check("target-evidence:" + wanted["text"], target_span.get("inputId") == wanted["targetInputId"] and target_span.get("mappingStatus") == "exact" and target_span.get("normalized", {}).get("startLine") == wanted["targetLine"])
        target_source = BASE / "fixtures" / wanted["targetInputId"].removeprefix("csharp-input:")
        raw_target = target_source.read_bytes()
        wanted_pos = wanted["targetSpan"]
        native = (target_span.get("nativePositions") or [{}])[0]
        check("exact-overload-declaration:" + wanted["text"], target_span.get("inputFingerprint") == fingerprint(target_source) and target_span.get("normalized") == wanted_pos and raw_target[wanted_pos["startByte"]:wanted_pos["endByte"]].decode("utf-8") == "Select" and raw_target.splitlines()[wanted["targetLine"] - 1].decode("utf-8").strip() == wanted["declarationLine"] and native.get("startUtf16") == len(raw_target[:wanted_pos["startByte"]].decode("utf-8").encode("utf-16-le")) // 2 and native.get("endUtf16") == len(raw_target[:wanted_pos["endByte"]].decode("utf-8").encode("utf-16-le")) // 2)
    for wanted in expected["unknownCalls"]:
        case = cases.get(wanted["caseId"], {})
        calls = [c for c in case.get("calls", []) if c["text"] == wanted["text"]]
        check("unknown-present:" + wanted["text"], len(calls) == 1)
        if not calls:
            continue
        call = calls[0]
        check("unknown-not-promoted:" + wanted["text"], call["targetMode"] == "unknown" and call["resolution"] == "unresolved" and call["targetSetCompleteness"] == "unknown" and call["target"] is None and call["reason"] == wanted["reason"])
        if "diagnosticId" in wanted:
            check("native-diagnostic:" + wanted["diagnosticId"], any(d["id"] == wanted["diagnosticId"] for d in case.get("diagnostics", [])))
    for wanted in expected["coordinateProbes"]:
        probe = next((p["sourceSpan"] for p in report["coordinateProbes"] if p["id"] == wanted["id"]), {})
        check("coordinate-status:" + wanted["id"], probe.get("mappingStatus") == wanted["mappingStatus"])
        if "normalized" in wanted:
            check("coordinate-exact:" + wanted["id"], probe.get("normalized") == wanted["normalized"])
        else:
            check("coordinate-rejected:" + wanted["id"], probe.get("normalized") is None and probe.get("diagnosticCode") == wanted["diagnosticCode"])
    for case in cases.values():
        for call in case["calls"]:
            span = call["sourceSpan"]
            raw = (BASE / "fixtures" / span["inputId"].removeprefix("csharp-input:")).read_bytes()
            pos = span["normalized"]
            check("source-byte-slice:" + call["sampleKey"], raw[pos["startByte"]:pos["endByte"]].decode("utf-8") == call["text"] and span["inputFingerprint"] == "sha256:" + hashlib.sha256(raw).hexdigest())
            check("no-runtime-claim:" + call["sampleKey"], call["production"] == "automatic" and call["runtimeObserved"] is False)
    check("positive-native-diagnostics-clear", not cases.get("positive", {}).get("diagnostics", ["missing"]))
    check("partial-schema-only", "schemaVersion" not in report and "not a schema" in report.get("contractReference", ""))
    check("unverified-project-load-visible", report["analysisProfile"]["projectLoad"] is False and any("MSBuild/JDT" in s for s in report["scopeLimitations"]))
    return checks


def main():
    expected = json.loads((BASE / "expected.json").read_text(encoding="utf-8"))
    report = json.loads((BASE / "reports/actual.json").read_text(encoding="utf-8"))
    checks = evaluate(report, expected)

    def check(name, passed):
        checks.append({"name": name, "passed": bool(passed)})

    check("current-extractor", report["analysisProfile"]["extractorFingerprint"] == fingerprint(BASE / "analyze.ps1"))
    check("current-input-registry", report["analysisProfile"]["inputManifestFingerprint"] == fingerprint(BASE / "inputs.json"))
    check("all-inputs-current", all(i["inputFingerprint"] == fingerprint(BASE / "fixtures" / i["relativePath"]) for i in report["inputs"]))
    for item in report["analysisProfile"]["references"] + report["analysisProfile"]["roslynAssemblies"]:
        check("current-tool-input:" + Path(item["path"]).name, item["fingerprint"] == fingerprint(Path(item["path"])))
    check("expected-not-analyzer-input", report["analysisProfile"]["answerInputsRead"] is False and all("expected" not in i["relativePath"] for i in report["inputs"]))
    policy = json.loads((BASE / "reports/boundary-policy.json").read_text(encoding="utf-8"))
    check("boundary-test-current", policy["testFingerprint"] == fingerprint(BASE / "test.ps1"))
    check("boundary-refusals", all(p["passed"] for p in policy["checks"]) and len(policy["checks"]) == 5)
    check("project-sentinel-absent", not (BASE / "fixtures/project.executed").exists())

    mutations = {}
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"][0]["target"]["signature"] = "Lab.Converter.Select(string)"
    mutations["wrong-overload"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"].pop()
    mutations["missing-call"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"][0]["candidateSignatures"].append("Wrong.Extra()")
    mutations["extra-candidate"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"][0]["sourceSpan"]["normalized"]["startByte"] += 1
    mutations["wrong-byte-coordinate"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][2]["calls"][0]["targetMode"] = "exact"
    mutations["dynamic-promoted"] = mutant
    mutant = copy.deepcopy(report)
    mutant["coordinateProbes"][2]["sourceSpan"]["mappingStatus"] = "exact"
    mutations["surrogate-interior-promoted"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"][0]["target"]["declarationSpan"]["normalized"]["endByte"] += 1000
    mutations["target-declaration-outside-source"] = mutant
    mutant = copy.deepcopy(report)
    mutant["cases"][0]["calls"][0]["target"]["declarationSpan"] = copy.deepcopy(mutant["cases"][0]["calls"][1]["target"]["declarationSpan"])
    mutations["other-overload-declaration"] = mutant
    for name, mutant in mutations.items():
        check("oracle-rejects:" + name, any(not c["passed"] for c in evaluate(mutant, expected)))
    token = uuid.uuid4().hex
    probe_root = BASE / (".verifier-output-probe-" + token)
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
    result = {"status": "checks-passed" if all(c["passed"] for c in checks) else "checks-failed", "scope": "local Roslyn binding, coordinates and explicit refusal policy only; not real project-loader safety", "verifierFingerprint": fingerprint(Path(__file__)), "expectedFingerprint": fingerprint(BASE / "expected.json"), "reportFingerprint": fingerprint(BASE / "reports/actual.json"), "passed": sum(c["passed"] for c in checks), "total": len(checks), "checks": checks}
    write_report("verification.json", result)
    print(json.dumps({k: result[k] for k in ("status", "passed", "total")}))
    for c in checks:
        if not c["passed"]:
            print(c["name"])
    return 0 if result["status"] == "checks-passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
