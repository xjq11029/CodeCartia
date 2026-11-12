"""Run existing analyzers on one authorized external project, without target writes."""
import sys

sys.dont_write_bytecode = True

import argparse
import json
import platform
import shutil
import subprocess
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from policy import BASE, POLICY_VERSION, digest, no_links, readable_static, snapshot, snapshot_changes, write_json


EXPECTED = BASE / "expected/platform-server.json"
ENTRY_INPUT = BASE / "expected/entry-input.json"
SPEC = BASE / "SPEC.md"


def implementation_fingerprints():
    files = [
        BASE / "policy.py", BASE / "verify.py", BASE / "python_bridge.py", BASE / "node_bridge.mjs",
        BASE.parent / "python/project_extract.py", BASE.parent / "js-ts/project-extract.mjs",
        BASE.parent / "js-ts/io-policy.mjs", BASE.parent / "js-ts/toolchain.windows-observed.json",
    ]
    return {file.relative_to(BASE.parent).as_posix(): digest(file.read_bytes()) for file in files}


def check_toolchains(reports):
    registration = json.loads((BASE.parent / "js-ts/toolchain.windows-observed.json").read_text(encoding="utf-8"))
    compiler = Path(registration["typescriptModule"]).resolve()
    recorded = reports["js-ts"]["toolchain"]
    if Path(recorded["modulePath"]).resolve() != compiler or recorded["moduleSha256"] != digest(compiler.read_bytes()) or recorded["version"] != registration["observedVersion"]:
        raise ValueError("Registered TypeScript implementation changed; rerun required")
    node_version = subprocess.run([shutil.which("node") or "node", "--version"], cwd=BASE, capture_output=True, text=True, encoding="utf-8", timeout=15, check=True).stdout.strip()
    if recorded["nodeVersion"] != node_version:
        raise ValueError("Node runtime changed; rerun required")
    python = reports["python"]["toolchain"]
    if python["version"] != platform.python_version() or Path(python["executable"]).resolve() != Path(sys.executable).resolve():
        raise ValueError("Python runtime changed; rerun required")


def input_path(report, root, record):
    relative = Path(record["path"])
    if record.get("kind") == "toolchain":
        library_root = Path(report["toolchain"]["libRoot"])
        if not relative.is_absolute() or not relative.is_relative_to(library_root) or not relative.name.startswith("lib") or not relative.name.endswith(".d.ts"):
            raise ValueError("Unregistered toolchain input")
        no_links(relative)
        return relative
    if relative.anchor or ".." in relative.parts or not readable_static(relative):
        raise ValueError("External input manifest contains a forbidden path")
    path = root / relative
    no_links(path)
    return path


def verify_reports(expected, entry_input, reports, audits, before, after):
    checks = []
    root = Path(expected["roots"]["js-ts"])
    first = {item["path"]: item for item in before["files"]}

    def check(name, passed, detail=None):
        record = {"name": name, "passed": bool(passed)}
        if detail is not None:
            record["detail"] = detail
        checks.append(record)

    for observation in expected["sourceObservations"]:
        actual = first.get(observation["path"])
        check("selected-input-hash:" + observation["id"], actual is not None and actual["sha256"] == observation["sha256"], None if actual else "Input unavailable in permitted static snapshot")
    entry_records = [item for item in reports["js-ts"].get("inputManifest", []) if item["path"] == entry_input["path"]]
    check("explicit-node-entry-captured", len(entry_records) == 1 and entry_records[0]["kind"] == "source" and entry_records[0]["sha256"] == entry_input["sha256"])
    declaration_marker, call_marker = entry_input["requiredDeclaration"], entry_input["requiredCall"]
    entry_declaration = any(item["file"] == entry_input["path"] and item.get("name") == declaration_marker["name"] and item["span"] == declaration_marker["span"] for item in reports["js-ts"].get("declarations", []))
    entry_call = any(item["file"] == entry_input["path"] and item.get("callee") == call_marker["callee"] and item["span"] == call_marker["span"] for item in reports["js-ts"].get("calls", []))
    check("explicit-node-entry-has-source-facts", entry_declaration and entry_call)
    for language, report in reports.items():
        analysis_root = Path(expected["roots"][language])
        check("report-identity:" + language, report.get("reportVersion") == "project-loading-v0.1" and report.get("language") == language and report.get("projectId") == "platform-server-" + language)
        check("not-complete-project:" + language, report.get("completeness", {}).get("complete") is False)
        check("runtime-targets-remain-unknown:" + language, bool(report.get("calls")) and all(call.get("runtimeTargetMode") == "unknown" for call in report["calls"]))
        check("unknown-targets-have-no-declaration:" + language, all(call.get("target") is None for call in report["calls"] if call.get("resolution") == "unresolved"))
        codes = {item.get("code") for item in report.get("diagnostics", [])}
        check("missing-project-config-diagnosed:" + language, expected["metadataPreconditions"][language]["requiredDiagnostic"] in codes)
        for missing in expected["metadataPreconditions"][language]["absent"]:
            check("original-config-not-created:" + language + ":" + missing, not (analysis_root / missing).exists())
        audit = audits[language]
        check("no-external-write-attempts:" + language, not audit.get("rejectedWriteAttempts"))
        check("no-target-execution-attempts:" + language, not audit.get("rejectedExecutionAttempts"))
        check("no-forbidden-read-attempts:" + language, not audit.get("rejectedReadAttempts"))
        manifest = report.get("inputManifest", [])
        check("nonempty-input-manifest:" + language, bool(manifest))
        for item in manifest:
            name = language + ":" + item["path"]
            try:
                source = input_path(report, analysis_root, item)
                data = source.read_bytes()
                check("captured-input-still-current:" + name, digest(data) == item["sha256"] and len(data) == item["sizeBytes"])
                if item.get("kind") != "toolchain":
                    full_relative = source.relative_to(root).as_posix()
                    if full_relative in first:
                        check("captured-input-matches-before:" + name, first[full_relative]["sha256"] == item["sha256"])
            except (OSError, ValueError, KeyError) as error:
                check("captured-input-still-current:" + name, False, type(error).__name__ + ": " + str(error))
    for expected_case in expected["cases"]:
        report = reports.get(expected_case["language"], {})
        collection = report.get("declarations" if expected_case["kind"] == "declaration" else "calls", [])
        identity_field = "name" if expected_case["kind"] == "declaration" else "callee"
        # Chained calls can share a start byte. Use the independently selected
        # callee/declaration identity, then verify the entire original span.
        matches = [item for item in collection if item.get("file") == expected_case["file"] and item.get("span", {}).get("startByte") == expected_case["span"]["startByte"] and item.get(identity_field) == expected_case[identity_field]]
        fields = ("name", "qualifiedName", "span") if expected_case["kind"] == "declaration" else ("callee", "span", "bindingKind", "resolution", "target", "runtimeTargetMode")
        passed = len(matches) == 1 and all(matches[0].get(field) == expected_case[field] for field in fields)
        check("selected-anchor:" + expected_case["id"], passed, {"expected": {key: expected_case[key] for key in fields}, "actual": [{key: item.get(key) for key in fields} for item in matches]})
    changes = snapshot_changes(before, after)
    check("permitted-static-inputs-unchanged", not changes and not before["unreadable"] and not after["unreadable"], changes)
    return checks, changes


def run_bridge(language, root, entry_input):
    request = {"projectId": "platform-server-" + language, "projectRoot": root}
    if language == "js-ts":
        request.update(entry_input["request"])
    command = [sys.executable, "-B", str(BASE / "python_bridge.py"), json.dumps(request)] if language == "python" else [shutil.which("node") or "node", str(BASE / "node_bridge.mjs"), json.dumps(request)]
    result = subprocess.run(command, cwd=BASE, capture_output=True, text=True, encoding="utf-8", timeout=180, check=False)
    if result.returncode != 0:
        raise RuntimeError(language + " bridge failed: " + result.stderr[-8000:])
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-existing", action="store_true")
    options = parser.parse_args()
    expected_bytes = EXPECTED.read_bytes()
    expected = json.loads(expected_bytes)
    entry_bytes = ENTRY_INPUT.read_bytes()
    entry_input = json.loads(entry_bytes)
    root = Path(expected["roots"]["js-ts"])
    versions = implementation_fingerprints()
    frozen = {"expectedSha256": digest(expected_bytes), "entryInputSha256": digest(entry_bytes), "specSha256": digest(SPEC.read_bytes()), "implementations": versions, "policyVersion": POLICY_VERSION}
    if options.check_existing:
        previous = json.loads((BASE / "reports/verification.json").read_text(encoding="utf-8"))
        if previous["bindings"] != frozen:
            raise ValueError("Observation implementation/specification/expected changed; rerun required")
        for language, wanted in previous["rawReportSha256"].items():
            if digest((BASE / "reports/raw" / (language + ".json")).read_bytes()) != wanted:
                raise ValueError("Saved raw report changed: " + language)
        for name, wanted in previous["supportingReportSha256"].items():
            if digest((BASE / "reports" / name).read_bytes()) != wanted:
                raise ValueError("Saved observation evidence changed: " + name)
        reports = {language: json.loads((BASE / "reports/raw" / (language + ".json")).read_text(encoding="utf-8")) for language in expected["roots"]}
        audits = json.loads((BASE / "reports/access-audit.json").read_text(encoding="utf-8"))
        saved = json.loads((BASE / "reports/input-snapshots.json").read_text(encoding="utf-8"))
        before, after = saved["before"], snapshot(root)
    else:
        before = snapshot(root)
        before_index = {item["path"]: item for item in before["files"]}
        for observation in expected["sourceObservations"]:
            if before_index.get(observation["path"], {}).get("sha256") != observation["sha256"]:
                raise ValueError("Selected original source changed before extraction: " + observation["path"])
        if before_index.get(entry_input["path"], {}).get("sha256") != entry_input["sha256"]:
            raise ValueError("Explicit Node entry changed since its source evidence was recorded")
        for language, precondition in expected["metadataPreconditions"].items():
            if any((Path(expected["roots"][language]) / name).exists() for name in precondition["absent"]):
                raise ValueError("External project configuration changed since anchor selection")
        reports, audits = {}, {}
        for language, analysis_root in expected["roots"].items():
            result = run_bridge(language, analysis_root, entry_input)
            reports[language], audits[language] = result["raw"], result["accessAudit"]
            write_json("raw/" + language + ".json", result["raw"])
        after = snapshot(root)
        write_json("access-audit.json", audits)
        write_json("input-snapshots.json", {"before": before, "after": after, "expectedSelectionMtimes": [{"path": item["path"], "mtimeNs": item["mtimeNs"]} for item in expected["sourceObservations"]]})
    check_toolchains(reports)
    if implementation_fingerprints() != versions:
        raise ValueError("Observation implementation changed during this run")
    checks, changes = verify_reports(expected, entry_input, reports, audits, before, after)
    passed = all(item["passed"] for item in checks)
    summary = {}
    for language, report in reports.items():
        summary[language] = {
            "toolchain": report["toolchain"], "inputsByKind": dict(Counter(item["kind"] for item in report["inputManifest"])),
            "declarations": len(report["declarations"]), "calls": len(report["calls"]),
            "callResolutions": dict(Counter(item["resolution"] for item in report["calls"])),
            "diagnosticCodes": dict(Counter(item["code"] for item in report["diagnostics"])),
            "completeness": report["completeness"],
        }
    package = json.loads((root / "package.json").read_text(encoding="utf-8-sig"))
    requirements = [line.split("#", 1)[0].strip() for line in (root / "inference-sidecar/requirements.txt").read_text(encoding="utf-8-sig").splitlines() if line.split("#", 1)[0].strip()]
    known_not_captured = []
    if (root / "bin/www").is_file() and not any(item["path"] == "bin/www" for item in reports["js-ts"]["inputManifest"]):
        known_not_captured.append({"language": "js-ts", "path": "bin/www", "reason": "Extensionless Node entry is in the permitted source snapshot but absent from analyzer inputs."})
    result = {
        "reportVersion": "external-project-observation-v0.1", "observedAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "checks-passed" if passed else "checks-failed", "scope": "Six hand-selected source anchors in one real project family; not exhaustive semantic truth, held-out quality, framework or product acceptance.",
        "roots": expected["roots"], "bindings": frozen, "observerPython": platform.python_version(),
        "passed": sum(item["passed"] for item in checks), "total": len(checks), "selectedAnchors": sum(item["passed"] for item in checks if item["name"].startswith("selected-anchor:")), "selectedAnchorTotal": len(expected["cases"]),
        "rawReportSha256": {language: digest((BASE / "reports/raw" / (language + ".json")).read_bytes()) for language in reports},
        "supportingReportSha256": {name: digest((BASE / "reports" / name).read_bytes()) for name in ("access-audit.json", "input-snapshots.json")},
        "staticSnapshotFileCount": len(before["files"]), "inputChanges": changes,
        "knownNotCapturedInputs": known_not_captured,
        "explicitEntryInput": entry_input,
        "declaredDependencies": {"nodeProjectVersion": package.get("version"), "node": package.get("dependencies", {}), "pythonRequirements": requirements, "installedVersionsVerified": False},
        "summary": summary, "checks": checks,
        "unverifiedBoundaries": ["Express/FastAPI routing, reachable HTTP chains, asynchronous scheduling and framework semantics.", "koffi/DLL/FFI internals, model execution and cross-service identity.", "General dataflow, business steps, authorization and complete project quality."],
    }
    if not options.check_existing:
        write_json("verification.json", result)
    print(json.dumps({"status": result["status"], "selectedAnchors": result["selectedAnchors"], "selectedAnchorTotal": result["selectedAnchorTotal"], "passed": result["passed"], "total": result["total"], "staticSnapshotFiles": result["staticSnapshotFileCount"], "inputChanges": len(changes), "mode": "check-existing" if options.check_existing else "rebuilt"}))
    for check in checks:
        if not check["passed"]:
            print(check["name"])
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
