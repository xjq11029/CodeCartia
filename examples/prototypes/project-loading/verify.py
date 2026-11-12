"""Independent public fixture/evidence evaluation for project-loading-v0.1.

Expectations are authored from the fixture sources. This module does not import
extractor implementation helpers or generate expected values from actual output.
"""
import argparse
from collections import Counter
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time

BASE = Path(__file__).absolute().parent
REPOSITORY = BASE.parents[2]
EXPECTED = BASE / "expected" / "cases.json"
REPORTS = BASE / "reports"
SPAN_KEYS = ("startByte", "endByte", "startLine", "startColumn", "endLine", "endColumn")
sys.dont_write_bytecode = True


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def no_links(path):
    """Check lexical components before resolve, including Windows reparse points."""
    path = Path(path).absolute()
    for component in (path, *path.parents):
        try:
            info = component.lstat()
        except FileNotFoundError:
            continue
        check(not stat.S_ISLNK(info.st_mode), f"linked path refused: {component}")
        check(not (getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)),
              f"reparse point refused: {component}")
    return path


def relative_file(root, value):
    check(isinstance(value, str) and value, "missing relative input path")
    check("\\" not in value and not PurePosixPath(value).is_absolute(), f"non-relative path: {value}")
    check(not re.match(r"^[A-Za-z]:", value), f"absolute drive path: {value}")
    check(all(part not in ("", ".", "..") for part in value.split("/")), f"path traversal: {value}")
    path = no_links(root / value)
    check(path.is_relative_to(root), f"path escaped root: {value}")
    return path


def fixture_root(case):
    root = relative_file(BASE, case["root"])
    check(root.is_relative_to(BASE / "fixtures"), "case root must stay inside fixtures")
    check(root.is_dir(), f"missing fixture root: {root}")
    return root


def tree_fingerprints(root):
    records = {}
    stack = [root]
    while stack:
        current = stack.pop()
        for entry in sorted(os.scandir(current), key=lambda item: item.name):
            path = Path(entry.path)
            no_links(path)
            if entry.is_dir(follow_symlinks=False):
                stack.append(path)
            elif entry.is_file(follow_symlinks=False):
                records[path.relative_to(root).as_posix()] = digest(path.read_bytes())
            else:
                raise AssertionError(f"unexpected special fixture input: {path}")
    return dict(sorted(records.items()))


def coordinates(data, offset):
    check(type(offset) is int and 0 <= offset <= len(data), "byte offset outside input")
    check(not (0 < offset < len(data) and data[offset - 1:offset + 1] == b"\r\n"), "offset splits CRLF")
    prefix = data[:offset].decode("utf-8")
    if prefix.startswith("\ufeff"):
        prefix = prefix[1:]
    endings = list(re.finditer(r"\r\n|\r|\n", prefix))
    line_start = endings[-1].end() if endings else 0
    return len(endings) + 1, len(prefix[line_start:]) + 1


def span_from_bytes(data, start, end):
    start_line, start_column = coordinates(data, start)
    end_line, end_column = coordinates(data, end)
    return dict(zip(SPAN_KEYS, (start, end, start_line, start_column, end_line, end_column)))


def anchor_span(root, file, source, occurrence=None):
    data = relative_file(root, file).read_bytes()
    needle = source.encode("utf-8")
    text = data.decode("utf-8")
    pattern = re.escape(source)
    if source and re.match(r"[\w$]", source[0]):
        pattern = r"(?<![\w$])" + pattern
    starts = [len(text[:match.start()].encode("utf-8")) for match in re.finditer(pattern, text)]
    if occurrence is None:
        check(len(starts) == 1, f"ambiguous source anchor needs explicit occurrence: {file}: {source}")
        occurrence = 1
    check(starts and type(occurrence) is int and 1 <= occurrence <= len(starts), f"expected source anchor missing: {file}: {source}")
    start = starts[occurrence - 1]
    return span_from_bytes(data, start, start + len(needle))


def compare_span(actual, expected, label):
    check(isinstance(actual, dict), f"missing span: {label}")
    check(all(type(actual.get(key)) is int for key in SPAN_KEYS), f"noninteger span: {label}")
    check({key: actual[key] for key in SPAN_KEYS} == expected, f"wrong source span: {label}")


def manifest_bytes(actual, root):
    manifest = actual.get("inputManifest")
    check(isinstance(manifest, list), "inputManifest is not a list")
    captured = {}
    project_paths = set()
    toolchain = actual.get("toolchain", {})
    registration = json.loads((BASE.parent / "js-ts" / "toolchain.windows-observed.json").read_text(encoding="utf-8"))
    ts_module = Path(registration["typescriptModule"]).absolute()
    for item in manifest:
        check(isinstance(item, dict), "malformed manifest entry")
        path_value = item.get("path")
        check(path_value not in captured, f"duplicate input manifest key: {path_value}")
        kind = item.get("kind")
        check(kind in ("source", "config", "metadata", "toolchain"), f"unknown input kind: {kind}")
        if kind == "toolchain":
            check(actual["language"] == "js-ts", "unexpected external toolchain input")
            check(Path(toolchain.get("modulePath", "")).absolute() == ts_module, "unregistered TypeScript module path")
            path = no_links(Path(path_value))
            check(path.is_absolute() and path.parent == ts_module.parent and path.name.endswith(".d.ts"),
                  f"unregistered external input: {path_value}")
        else:
            path = relative_file(root, path_value)
            project_paths.add(path_value)
        check(path.is_file(), f"manifest file is missing: {path_value}")
        data = path.read_bytes()
        check(item.get("sizeBytes") == len(data), f"input size mismatch: {path_value}")
        check(item.get("sha256") == digest(data), f"input fingerprint mismatch: {path_value}")
        captured[path_value] = data
    return captured, project_paths


def verify_span(actual_span, file, captured, label):
    check(file in captured, f"evidence file absent from manifest: {label}: {file}")
    check(isinstance(actual_span, dict), f"missing evidence span: {label}")
    check(all(type(actual_span.get(key)) is int for key in SPAN_KEYS), f"malformed evidence span: {label}")
    start, end = actual_span["startByte"], actual_span["endByte"]
    check(0 <= start <= end <= len(captured[file]), f"byte range outside file: {label}")
    expected = span_from_bytes(captured[file], start, end)
    compare_span(actual_span, expected, label)


def validate_report(actual, case):
    root = fixture_root(case)
    check(isinstance(actual, dict), "empty or non-object report")
    check(actual.get("reportVersion") == "project-loading-v0.1", "wrong report version")
    check(actual.get("language") == case["language"], "wrong report language")
    check(actual.get("projectId") == case["id"], "wrong project identity")
    for key in ("declarations", "imports", "calls", "diagnostics"):
        check(isinstance(actual.get(key), list), f"{key} is not a list")
    toolchain = actual.get("toolchain", {})
    if case["language"] == "python":
        check(toolchain.get("version") == platform.python_version(), "Python toolchain changed")
        check(Path(toolchain.get("executable", "")).absolute() == Path(sys.executable).absolute(), "Python executable changed")
    else:
        registration = json.loads((BASE.parent / "js-ts" / "toolchain.windows-observed.json").read_text(encoding="utf-8"))
        module = no_links(Path(registration["typescriptModule"]))
        check(Path(toolchain.get("modulePath", "")).absolute() == module, "TypeScript module registration changed")
        check(toolchain.get("version") == registration["observedVersion"], "TypeScript observed version changed")
        check(toolchain.get("moduleSha256") == digest(module.read_bytes()), "TypeScript module bytes changed")
    captured, project_paths = manifest_bytes(actual, root)
    missing_required = set(case.get("requiredInputs", [])) - project_paths
    check(not missing_required, f"required project input omitted: {sorted(missing_required)}")
    check(not set(case.get("forbiddenInputs", [])) & project_paths, "excluded input was read")
    sources = {item["path"] for item in actual["inputManifest"] if item["kind"] == "source"}
    check(not set(case.get("forbiddenSourceInputs", [])) & sources, "build script was treated as analysis source")

    completeness = actual.get("completeness")
    check(isinstance(completeness, dict) and type(completeness.get("complete")) is bool, "missing completeness")
    for field in ("missingInputs", "unsupportedModes", "truncations"):
        check(isinstance(completeness.get(field), list), f"missing completeness dimension: {field}")
    if case.get("requiresIncomplete"):
        check(completeness["complete"] is False, "incomplete input became complete")
    if completeness["complete"] is False:
        check(any(completeness[field] for field in ("missingInputs", "unsupportedModes", "truncations")),
              "incomplete report lost every reason")
    else:
        check(not any(completeness[field] for field in ("missingInputs", "unsupportedModes", "truncations")),
              "complete report still contains required gaps")

    codes = {entry.get("code") for entry in actual["diagnostics"]}
    check(all(isinstance(entry.get("code"), str) and isinstance(entry.get("message"), str)
              for entry in actual["diagnostics"]), "malformed diagnostic")
    for wanted in case.get("requiredDiagnostics", []):
        if isinstance(wanted, list):
            check(bool(set(wanted) & codes), f"missing diagnostic from {wanted}")
        else:
            check(wanted in codes, f"missing diagnostic: {wanted}")

    for kind in ("declarations", "imports", "calls"):
        for entry in actual[kind]:
            check(entry.get("file") not in case.get("forbiddenSourceInputs", []), "build-script facts leaked into analysis")
            verify_span(entry.get("span"), entry.get("file"), captured, kind)
    for call in actual["calls"]:
        if "callConfigurations" in case:
            check(call.get("configFile") in case["callConfigurations"], "call leaked across configuration context")
        check(call.get("runtimeTargetMode") == "unknown", "static reference claimed a runtime target")
        expected_binding = "static-signature-reference" if case["language"] == "js-ts" else "lexical-declaration-reference"
        check(call.get("bindingKind") == expected_binding, "binding semantics changed")
        check(call.get("resolution") in ("confirmed", "unresolved"), "unknown call resolution")
        if call["resolution"] == "unresolved":
            check(call.get("target") is None, "unresolved call carries a confirmed target")
        else:
            target = call.get("target")
            check(isinstance(target, dict), "confirmed call lacks target")
            verify_span(target.get("span"), target.get("file"), captured, "call target")
            check(isinstance(target.get("qualifiedName"), str) and target["qualifiedName"], "target lacks lexical name")
    for record in actual["imports"]:
        check(record.get("resolution") in ("resolved", "unresolved"), "unknown import resolution")
        if record["resolution"] == "resolved":
            check(record.get("targetFile") in captured, "resolved import target absent from manifest")

    actual_keys = [(item["file"], item["span"]["startByte"], item["span"]["endByte"], item.get("configFile"))
                   for item in actual["calls"]]
    check(len(actual_keys) == len(set(actual_keys)), "duplicate call within one configuration")
    expected_locations = set()
    for wanted in case.get("calls", []):
        span = anchor_span(root, wanted["file"], wanted["source"], wanted.get("occurrence"))
        location = (wanted["file"], span["startByte"], span["endByte"])
        expected_locations.add(location)
        matches = [call for call in actual["calls"] if (call["file"], call["span"]["startByte"], call["span"]["endByte"]) == location]
        check(matches, f"missing expected call: {wanted['file']}: {wanted['source']}")
        for call in matches:
            compare_span(call["span"], span, wanted["source"])
            if "callee" in wanted:
                check(call.get("callee") == wanted["callee"], "callee changed")
            check(call["resolution"] == wanted["resolution"], f"wrong resolution: {wanted['source']}")
            if wanted.get("target") is None:
                check(call.get("target") is None, "unknown target was guessed")
            else:
                target = call.get("target", {})
                correct = wanted["target"]
                check(target.get("file") == correct["file"], "wrong target file")
                check(re.split(r"[.:]", target.get("qualifiedName", ""))[-1] == correct["name"], "wrong target lexical name")
                expected_span = anchor_span(root, correct["file"], correct["source"], correct.get("occurrence"))
                compare_span(target.get("span"), expected_span, "expected target declaration")
    exact_files = set(case.get("exactCallFiles", []))
    for item in actual["calls"]:
        check(item["file"] in exact_files, "call appeared outside the declared source set")
        check((item["file"], item["span"]["startByte"], item["span"]["endByte"]) in expected_locations, "unexpected additional call")
    if case.get("noCalls"):
        check(not actual["calls"], "rejected dynamic configuration produced call facts")

    for wanted in case.get("declarations", []):
        span = anchor_span(root, wanted["file"], wanted["source"], wanted.get("occurrence"))
        matches = [entry for entry in actual["declarations"] if entry["file"] == wanted["file"] and entry.get("name") == wanted["name"]]
        check(matches, f"missing declaration: {wanted['name']}")
        for entry in matches:
            compare_span(entry["span"], span, wanted["name"])
    for wanted in case.get("imports", []):
        matches = [entry for entry in actual["imports"] if entry["file"] == wanted["file"] and entry.get("moduleSpecifier") == wanted["moduleSpecifier"]]
        check(matches, f"missing import: {wanted['moduleSpecifier']}")
        for entry in matches:
            check(entry["resolution"] == wanted["resolution"], "wrong import resolution")
            if "targetFile" in wanted:
                check(entry.get("targetFile") == wanted["targetFile"], "wrong import target")
    return {"inputs": len(captured), "projectInputs": len(project_paths), "declarations": len(actual["declarations"]),
            "calls": len(actual["calls"]), "confirmedReferences": sum(call["resolution"] == "confirmed" for call in actual["calls"]),
            "diagnostics": len(actual["diagnostics"]), "complete": completeness["complete"]}


def adapters_fingerprint(language):
    files = [BASE / "SPEC.md", EXPECTED, Path(__file__), BASE / "node_bridge.mjs", BASE / "python_bridge.py"]
    adapter = BASE.parent / ("js-ts" if language == "js-ts" else "python")
    files.extend(adapter.glob("*.mjs" if language == "js-ts" else "*.py"))
    if language == "js-ts":
        files.append(adapter / "toolchain.windows-observed.json")
    return {path.relative_to(REPOSITORY).as_posix(): digest(no_links(path).read_bytes()) for path in sorted(set(files))}


def command(language):
    if language == "js-ts":
        node = shutil.which("node")
        check(node, "node is unavailable")
        return [node, str(BASE / "node_bridge.mjs")]
    return [sys.executable, "-B", str(BASE / "python_bridge.py")]


def extract(case):
    request = {"projectId": case["id"], "projectRoot": str(fixture_root(case)), "configFile": case["configFile"]}
    if "limits" in case:
        request["limits"] = case["limits"]
    start = time.monotonic()
    completed = subprocess.run(command(case["language"]), input=json.dumps(request), text=True, encoding="utf-8",
                               capture_output=True, cwd=BASE, timeout=90,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    check(completed.returncode == 0, f"extractor failed ({completed.returncode}): {completed.stderr[-2500:]}")
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"extractor did not return JSON: {error}") from error
    return report, {"elapsedMs": round((time.monotonic() - start) * 1000, 3), "stderr": completed.stderr}


def safe_report_path(name, raw=False):
    check(re.fullmatch(r"[a-z][a-z0-9-]*\.json", name), "invalid report basename")
    no_links(BASE)
    no_links(REPORTS)
    if not REPORTS.exists():
        REPORTS.mkdir()
    check(REPORTS.is_dir(), "reports is not a directory")
    directory = REPORTS / "raw" if raw else REPORTS
    no_links(directory)
    if not directory.exists():
        directory.mkdir()
    check(directory.is_dir(), "report output parent is not a directory")
    destination = no_links(directory / name)
    if destination.exists():
        check(destination.is_file(), "report destination is not a file")
    return destination


def write_report(name, value, raw=False):
    destination = safe_report_path(name, raw=raw)
    content = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    descriptor, temporary = tempfile.mkstemp(prefix=".project-report-", suffix=".tmp", dir=REPORTS)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        no_links(destination)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def mutation_checks(actual, case):
    variants = []
    def add(name, operation):
        value = copy.deepcopy(actual)
        operation(value)
        variants.append((name, value))
    add("empty-report", lambda value: value.clear())
    add("wrong-project", lambda value: value.update(projectId="another-project"))
    if actual["inputManifest"]:
        add("wrong-input-fingerprint", lambda value: value["inputManifest"][0].update(sha256="sha256:" + "0" * 64))
        add("wrong-input-size", lambda value: value["inputManifest"][0].update(sizeBytes=value["inputManifest"][0]["sizeBytes"] + 1))
    if actual["calls"]:
        add("missing-call", lambda value: value["calls"].pop(0))
        add("duplicate-call", lambda value: value["calls"].append(copy.deepcopy(value["calls"][0])))
        add("wrong-call-byte-range", lambda value: value["calls"][0]["span"].update(startByte=value["calls"][0]["span"]["startByte"] + 1))
        add("wrong-codepoint-column", lambda value: value["calls"][0]["span"].update(startColumn=value["calls"][0]["span"]["startColumn"] + 1))
        add("runtime-target-upgrade", lambda value: value["calls"][0].update(runtimeTargetMode="exact"))
        add("binding-kind-upgrade", lambda value: value["calls"][0].update(bindingKind="runtime-execution"))
        if "callConfigurations" in case:
            add("wrong-call-configuration", lambda value: value["calls"][0].update(configFile="another/tsconfig.json"))
        if actual["declarations"]:
            def append_phantom(value):
                declaration = value["declarations"][0]
                phantom = copy.deepcopy(value["calls"][0])
                phantom.update(file=declaration["file"], span=copy.deepcopy(declaration["span"]), callee="phantom",
                               resolution="unresolved", target=None)
                value["calls"].append(phantom)
            add("additional-noncall-fact", append_phantom)
    known = next((index for index, call in enumerate(actual["calls"]) if call["resolution"] == "confirmed"), None)
    if known is not None:
        add("wrong-target-name", lambda value: value["calls"][known]["target"].update(qualifiedName="wrong_target"))
        add("wrong-target-range", lambda value: value["calls"][known]["target"]["span"].update(endByte=value["calls"][known]["target"]["span"]["endByte"] - 1))
        target_file = actual["calls"][known]["target"]["file"]
        alternate = next((entry for entry in actual["declarations"] if entry["file"] == target_file and entry["span"] != actual["calls"][known]["target"]["span"]), None)
        if alternate:
            def swap(value):
                value["calls"][known]["target"]["span"] = copy.deepcopy(alternate["span"])
            add("same-file-other-declaration", swap)
    unknown = next((index for index, call in enumerate(actual["calls"]) if call["resolution"] == "unresolved"), None)
    if unknown is not None:
        add("unknown-upgraded", lambda value: value["calls"][unknown].update(resolution="confirmed", target={"file":value["calls"][unknown]["file"],"qualifiedName":"guessed","span":copy.deepcopy(value["calls"][unknown]["span"])}))
    if case.get("requiresIncomplete"):
        add("incomplete-became-complete", lambda value: value.update(completeness={"complete":True,"missingInputs":[],"unsupportedModes":[],"truncations":[]}))
    if actual["completeness"]["complete"] is False:
        add("completeness-reasons-removed", lambda value: value.update(completeness={"complete":False,"missingInputs":[],"unsupportedModes":[],"truncations":[]}))
    if case.get("requiredDiagnostics"):
        add("required-diagnostics-removed", lambda value: value.update(diagnostics=[]))
    rejected = []
    for name, value in variants:
        try:
            validate_report(value, case)
        except (AssertionError, KeyError, ValueError, TypeError) as error:
            rejected.append({"name":name,"rejected":True,"reason":str(error)})
        else:
            raise AssertionError(f"evaluator accepted deliberate error: {name}")
    return rejected


def validate_saved(saved, before, implementation):
    check(saved.get("inputTreeFingerprint") == digest(json.dumps(before, sort_keys=True).encode()), "saved report has stale fixture inputs")
    check(saved.get("inputTree") == before, "saved report input ledger changed")
    check(saved.get("implementationFingerprints") == implementation, "saved report has stale implementation/specification")
    return saved["actual"], saved["observation"]


def freshness_checks(actual, before, implementation):
    reference = {"inputTreeFingerprint":digest(json.dumps(before, sort_keys=True).encode()), "inputTree":before,
                 "implementationFingerprints":implementation, "actual":actual, "observation":{}}
    rejected = []
    for name, field, replacement in (
        ("stale-input-tree", "inputTreeFingerprint", "sha256:" + "0" * 64),
        ("changed-input-ledger", "inputTree", {}),
        ("stale-implementation", "implementationFingerprints", {}),
    ):
        saved = copy.deepcopy(reference)
        saved[field] = replacement
        try:
            validate_saved(saved, before, implementation)
        except AssertionError as error:
            rejected.append({"name":name,"rejected":True,"reason":str(error)})
        else:
            raise AssertionError(f"stale report was accepted: {name}")
    return rejected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--language", choices=("all", "js-ts", "python"), default="all")
    parser.add_argument("--case", action="append", dest="cases")
    parser.add_argument("--check-existing", action="store_true")
    options = parser.parse_args()
    expectation = json.loads(no_links(EXPECTED).read_text(encoding="utf-8"))
    cases = [case for case in expectation["cases"] if (options.language == "all" or case["language"] == options.language)
             and (not options.cases or case["id"] in options.cases)]
    check(cases, "empty evaluation selection")
    results = []
    for case in cases:
        try:
            root = fixture_root(case)
            before = tree_fingerprints(root)
            for marker in case.get("markers", []):
                check(not (root / marker).exists(), f"execution marker already exists: {marker}")
            implementation = adapters_fingerprint(case["language"])
            if options.check_existing:
                saved = json.loads(safe_report_path(case["id"] + ".json").read_text(encoding="utf-8"))
                actual, observation = validate_saved(saved, before, implementation)
                pure_actual = json.loads(safe_report_path(case["id"] + ".json", raw=True).read_text(encoding="utf-8"))
                check(pure_actual == actual, "raw producer output differs from independently evaluated actual")
            else:
                actual, observation = extract(case)
            counts = validate_report(actual, case)
            mutations = mutation_checks(actual, case)
            stale_rejections = freshness_checks(actual, before, implementation)
            after = tree_fingerprints(root)
            check(before == after, "target project input tree changed during analysis")
            for marker in case.get("markers", []):
                check(not (root / marker).exists(), f"target side effect occurred: {marker}")
            check(implementation == adapters_fingerprint(case["language"]), "implementation changed during evaluation; rerun this case")
            result = {"caseId":case["id"],"passed":True,"counts":counts,"mutationsRejected":len(mutations),
                      "staleReportsRejected":len(stale_rejections),"observation":observation}
            results.append(result)
            if not options.check_existing:
                write_report(case["id"] + ".json", actual, raw=True)
                write_report(case["id"] + ".json", {"reportVersion":"project-loading-evaluation-v0.1","caseId":case["id"],
                             "inputTreeFingerprint":digest(json.dumps(before, sort_keys=True).encode()),"inputTree":before,
                             "implementationFingerprints":implementation,"actual":actual,"observation":observation,
                             "mutationChecks":mutations,"freshnessChecks":stale_rejections})
            print(json.dumps(result, ensure_ascii=False))
        except Exception as error:
            result = {"caseId":case["id"],"passed":False,"error":f"{type(error).__name__}: {error}"}
            results.append(result)
            print(json.dumps(result, ensure_ascii=False))
    passed = all(item["passed"] for item in results)
    report = {"reportVersion":"project-loading-verification-v0.1","evaluatedAtUtc":datetime.now(timezone.utc).isoformat(),
              "python":sys.version,"platform":sys.platform,"passed":passed,"caseCount":len(results),
              "casesPassed":sum(item["passed"] for item in results),"mutationsRejected":sum(item.get("mutationsRejected",0) for item in results),
              "staleReportsRejected":sum(item.get("staleReportsRejected",0) for item in results),
              "results":results,"scope":"Public synthetic full-project loading fixtures; not held-out, runtime, framework, or product acceptance.",
              "freshnessChecked":options.check_existing}
    write_report("verification" + ("-" + options.language.replace("-", "") if options.language != "all" else "") + ".json", report)
    print(json.dumps({key:report[key] for key in ("passed","caseCount","casesPassed","mutationsRejected","staleReportsRejected")}, ensure_ascii=False))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
