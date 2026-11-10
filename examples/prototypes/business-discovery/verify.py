"""Run original-input extraction, independent checks and evaluator mutations."""

import copy
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True

from evaluate import compare
from extract import extract
from report_io import write_report


ROOT = Path(__file__).resolve().parent
REPORTS = ROOT / "reports"
READS = []
AUDITING = False


def audit(event, args):
    if AUDITING and event == "open" and isinstance(args[0], (str, bytes)):
        READS.append(str(Path(args[0]).resolve()))


sys.addaudithook(audit)


@contextmanager
def temporary_inputs():
    # Inherit the workspace ACL on Windows; Python 3.14 TemporaryDirectory uses
    # mode 0700, which cannot be re-opened under some restricted desktop tokens.
    path = (ROOT / f".source-probes-{uuid.uuid4().hex}").resolve()
    if not path.is_relative_to(ROOT) or path == ROOT:
        raise AssertionError("Temporary path escaped experiment directory")
    path.mkdir()
    try:
        yield path
    finally:
        if not path.resolve().is_relative_to(ROOT) or path.resolve() == ROOT:
            raise AssertionError("Cleanup target escaped experiment directory")
        shutil.rmtree(path)


def run_extract(project):
    global AUDITING
    READS.clear()
    AUDITING = True
    try:
        actual = extract(project)
    finally:
        AUDITING = False
    if any("expected" in Path(item).parts or Path(item).name in {"evaluate.py", "verify.py"} for item in READS):
        raise AssertionError("Extractor read an oracle or evaluator")
    return actual, list(READS)


def save(name, value):
    write_report(REPORTS / name, value)


def must_reject(name, actual, expected, project, mutate):
    changed = copy.deepcopy(actual)
    mutate(changed)
    errors = compare(changed, expected, project)
    if not errors:
        raise AssertionError(f"Evaluator accepted mutant: {name}")
    return {"name": name, "status": "rejected", "reasons": errors}


def main():
    report = {"status": "running", "python": platform.python_version(), "platform": platform.platform(),
              "implementationFingerprints": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in ("extract.py", "evaluate.py", "verify.py", "report_io.py")},
              "fixtures": [], "evaluatorMutations": [], "sourceProbes": []}
    results = {}
    for name in ("library", "publishing"):
        project = ROOT / "inputs" / name
        expected = json.loads((ROOT / "expected" / f"{name}.json").read_text(encoding="utf-8"))
        actual, reads = run_extract(project)
        errors = compare(actual, expected, project)
        if errors:
            raise AssertionError(f"{name}: {errors}")
        save(f"{name}.json", actual)
        report["fixtures"].append({"name": name, "status": "passed", "scenarios": len(actual["scenarios"]),
                                   "steps": sum(len(item["steps"]) for item in actual["scenarios"]),
                                   "partialScenarios": sum(not item["complete"] for item in actual["scenarios"]),
                                   "extractorReadFiles": [str(Path(item).relative_to(ROOT)) if Path(item).is_relative_to(ROOT) else f"<python-runtime>/{Path(item).name}" for item in sorted(set(reads))],
                                   "expectedSha256": hashlib.sha256((ROOT / "expected" / f"{name}.json").read_bytes()).hexdigest()})
        results[name] = (actual, expected, project)

    actual, expected, project = results["library"]
    mutations = [
        ("empty-output", lambda value: value.update(scenarios=[])),
        ("extra-scenario", lambda value: value["scenarios"].append(copy.deepcopy(value["scenarios"][0]))),
        ("fake-candidate", lambda value: value["scenarios"][0]["unresolvedCandidates"].append("invented.target")),
        ("fake-step", lambda value: value["scenarios"][0]["steps"].append(copy.deepcopy(value["scenarios"][0]["steps"][2]))),
        ("missing-cross-function-step", lambda value: value["scenarios"][0]["steps"].pop()),
        ("missing-call", lambda value: value["scenarios"][0]["calls"].pop()),
        ("wrong-authorization-object", lambda value: value["scenarios"][0]["steps"][2]["authorizationBindings"][0].update(object="entry.arg0")),
        ("invented-check-binding", lambda value: value["scenarios"][0]["steps"][2]["authorization"].append(1)),
        ("condition-omission", lambda value: value["scenarios"][0]["steps"][0].update(condition="True")),
        ("false-decision", lambda value: value["scenarios"][0].update(authorizationDecision="allow")),
        ("wrong-evidence", lambda value: value["scenarios"][0]["steps"][0]["evidence"].update(text="invented")),
        ("merge-shared-scenarios", lambda value: value["scenarios"].pop()),
        ("wrong-project-fingerprint", lambda value: value.update(projectRegistrationSha256="0" * 64)),
        ("wrong-technical-profile", lambda value: value["technicalProfile"].update(sha256="0" * 64)),
        ("wrong-technical-contract", lambda value: value["technicalProfile"].update(contractSha256="0" * 64)),
        ("wrong-technical-classification", lambda value: value["scenarios"][0]["steps"][0].update(technicalApi="framework.validate")),
        ("unrelated-valid-assignment-evidence", lambda value: value["scenarios"][0]["steps"][0].update(evidence=copy.deepcopy(value["scenarios"][0]["steps"][2]["evidence"]))),
        ("unrelated-valid-call-evidence", lambda value: value["scenarios"][0]["steps"][0].update(evidence=copy.deepcopy(value["scenarios"][0]["steps"][1]["evidence"]))),
        ("missing-technical-evidence", lambda value: value["scenarios"][0]["steps"][0].pop("technicalEvidence")),
        ("wrong-call-parameter-binding", lambda value: value["scenarios"][0]["calls"][0]["bindings"].update(actor="entry.arg99")),
        ("invented-middle-call-context", lambda value: value["scenarios"][0]["steps"][0]["callPath"].insert(1, "invented.fake")),
        ("duplicate-scenario-id", lambda value: value["scenarios"][1].update(id=value["scenarios"][0]["id"])),
        ("duplicate-step-id", lambda value: value["scenarios"][0]["steps"][1].update(id=value["scenarios"][0]["steps"][0]["id"])),
    ]
    for name, mutate in mutations:
        report["evaluatorMutations"].append(must_reject(name, actual, expected, project, mutate))
    publishing, publishing_expected, publishing_root = results["publishing"]
    report["evaluatorMutations"].append(must_reject("hide-unknown", publishing, publishing_expected, publishing_root,
                                                   lambda value: value["scenarios"][0].update(complete=True, diagnostics=[])))

    # Source transformations are separate from the hand-authored fixture oracle.
    # They test identity independence and conservative boundaries, not new
    # field-specific expected answers fed into extraction.
    with temporary_inputs() as temporary:
        temp = Path(temporary).resolve()
        if not temp.is_relative_to(ROOT):
            raise AssertionError("Temporary cleanup target escaped experiment directory")
        renamed = temp / "renamed"
        shutil.copytree(ROOT / "inputs" / "library", renamed)
        replacements = {"/loans/open": "/custom/new", "/loans/close": "/custom/finish", '"member"': '"读者🔒"', '"staff"': '"operator-y"'}
        for path in renamed.glob("*.py"):
            text = path.read_text(encoding="utf-8")
            for before, after in replacements.items():
                text = text.replace(before, after)
            path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
        renamed_actual, _ = run_extract(renamed)
        renamed_expected = copy.deepcopy(expected)
        renamed_expected["scenarios"][0]["entry"][1] = "/custom/new"
        renamed_expected["scenarios"][1]["entry"][1] = "/custom/finish"
        renamed_expected["scenarios"][0]["steps"][0]["condition"] = "entry.arg0.role == '读者🔒' and entry.arg0.tenant == entry.arg1.tenant"
        renamed_expected["scenarios"][1]["steps"][0]["condition"] = "entry.arg0.role == 'operator-y' and entry.arg0.tenant == entry.arg1.tenant"
        errors = compare(renamed_actual, renamed_expected, renamed)
        if errors:
            raise AssertionError(f"Source rename/CRLF probe: {errors}")
        report["sourceProbes"].append({"name": "route-role-rename-unicode-and-crlf", "status": "passed"})

        broken = temp / "broken-api"
        shutil.copytree(ROOT / "inputs" / "library", broken)
        api_path = broken / "framework.py"
        api_path.write_text(api_path.read_text(encoding="utf-8").replace("if not predicate:", "if predicate:", 1), encoding="utf-8")
        try:
            run_extract(broken)
        except ValueError as exc:
            report["sourceProbes"].append({"name": "technical-api-semantics-changed", "status": "rejected", "reason": str(exc)})
        else:
            raise AssertionError("Changed technical API was still trusted")

        wrong_object = temp / "different-object"
        shutil.copytree(ROOT / "inputs" / "library", wrong_object)
        service_path = wrong_object / "services.py"
        service_path.write_text(service_path.read_text(encoding="utf-8").replace("record(item)", "record(actor)", 1), encoding="utf-8")
        changed, _ = run_extract(wrong_object)
        last = changed["scenarios"][0]["steps"][-1]
        if last["object"] != "entry.arg0" or last["authorization"] or last["authorizationBindings"]:
            raise AssertionError("A checkpoint was transferred to another object")
        report["sourceProbes"].append({"name": "different-object-does-not-inherit-check", "status": "passed"})

        altered_order = temp / "check-after-write"
        shutil.copytree(ROOT / "inputs" / "library", altered_order)
        service_path = altered_order / "services.py"
        service_path.write_text(service_path.read_text(encoding="utf-8").replace("    validate(item, item.available)\n    item.state = \"borrowed\"", "    item.state = \"borrowed\"\n    validate(item, item.available)"), encoding="utf-8")
        changed, _ = run_extract(altered_order)
        first = changed["scenarios"][0]
        if first["complete"] or "check-after-mutation" not in [item["code"] for item in first["diagnostics"]]:
            raise AssertionError("Post-write check was treated as an unchanged value")
        report["sourceProbes"].append({"name": "post-mutation-check-is-unknown", "status": "passed"})

        racing = temp / "capture-race"
        shutil.copytree(ROOT / "inputs" / "library", racing)
        source_path = (racing / "services.py").resolve()
        captured_raw = source_path.read_bytes()
        original_read = Path.read_bytes
        source_reads = []

        def racing_read(path):
            raw = original_read(path)
            if path.resolve() == source_path:
                source_reads.append(raw)
                source_path.write_bytes(raw.replace(b'"member"', b'"changed-after-capture"'))
            return raw

        with patch.object(Path, "read_bytes", racing_read):
            changed, _ = run_extract(racing)
        manifest = {item["path"]: item["sha256"] for item in changed["inputManifest"]}
        step = changed["scenarios"][0]["steps"][0]
        if len(source_reads) != 1 or manifest["services.py"] != hashlib.sha256(captured_raw).hexdigest() or step["evidence"]["sha256"] != manifest["services.py"] or "'member'" not in step["condition"]:
            raise AssertionError("AST and evidence did not retain the same single captured byte version")
        report["sourceProbes"].append({"name": "single-read-ast-fingerprint-race", "status": "passed"})

        rebound = temp / "rebound-name"
        shutil.copytree(ROOT / "inputs" / "library", rebound)
        service_path = rebound / "services.py"
        service_path.write_text(service_path.read_text(encoding="utf-8") + "\nenforce = lambda *args: None\n", encoding="utf-8")
        try:
            run_extract(rebound)
        except ValueError as exc:
            report["sourceProbes"].append({"name": "module-api-rebinding", "status": "rejected", "reason": str(exc)})
        else:
            raise AssertionError("Rebound API name retained a confirmed technical interpretation")

        shadow_variants = {
            "late-local-assignment": "    enforce = None\n",
            "late-local-definition": "    def enforce(*args):\n        pass\n",
            "late-local-import": "    from framework import enforce\n",
            "late-local-delete": "    del enforce\n",
            "late-loop-target": "    for enforce in []:\n        pass\n",
        }
        for name, declaration in shadow_variants.items():
            shadowed = temp / name
            shutil.copytree(ROOT / "inputs" / "library", shadowed)
            service_path = shadowed / "services.py"
            service_path.write_text(service_path.read_text(encoding="utf-8").replace("    return item", declaration + "    return item", 1), encoding="utf-8")
            changed, _ = run_extract(shadowed)
            first = changed["scenarios"][0]
            if first["complete"] or [step["kind"] for step in first["steps"]] != ["unknown-call"] or any(step["authorization"] or step["authorizationBindings"] for step in first["steps"]):
                raise AssertionError(f"Function-wide local scope was ignored: {name}")
            report["sourceProbes"].append({"name": name, "status": "passed-unknown"})

        global_change = temp / "global-declaration"
        shutil.copytree(ROOT / "inputs" / "library", global_change)
        service_path = global_change / "services.py"
        service_path.write_text(service_path.read_text(encoding="utf-8").replace("def open_loan(actor, item):\n", "def open_loan(actor, item):\n    global enforce\n"), encoding="utf-8")
        changed, _ = run_extract(global_change)
        first = changed["scenarios"][0]
        if first["complete"] or [step["kind"] for step in first["steps"]] != ["unsupported-statement"]:
            raise AssertionError("Unsupported global/nonlocal effects were silently skipped")
        report["sourceProbes"].append({"name": "global-declaration-is-unknown", "status": "passed-unknown"})

        alias_shadow = temp / "late-module-alias"
        shutil.copytree(ROOT / "inputs" / "publishing", alias_shadow)
        application_path = alias_shadow / "application.py"
        application_path.write_text(application_path.read_text(encoding="utf-8").replace("    return article", "    import framework as fw\n    return article", 1), encoding="utf-8")
        changed, _ = run_extract(alias_shadow)
        first = changed["scenarios"][0]
        if first["complete"] or [step["kind"] for step in first["steps"]] != ["unknown-call"]:
            raise AssertionError("An imported module alias escaped function-wide local binding")
        report["sourceProbes"].append({"name": "late-module-alias-is-unknown", "status": "passed-unknown"})

        same_line = temp / "same-line-entries"
        shutil.copytree(ROOT / "inputs" / "library", same_line)
        routes_path = same_line / "routes.py"
        first_registration = 'register("POST", "/same", borrow)'
        second_registration = 'register("POST", "/same", return_volume)'
        original_routes = routes_path.read_text(encoding="utf-8")
        original_registrations = 'register("POST", "/loans/open", borrow)\nregister("POST", "/loans/close", return_volume)'
        routes_path.write_text(original_routes.replace(original_registrations, first_registration + "; " + second_registration), encoding="utf-8")
        changed, _ = run_extract(same_line)
        same_line_expected = copy.deepcopy(expected)
        for row in same_line_expected["scenarios"]:
            row["entry"][1] = "/same"
        same_line_expected["scenarios"][1]["entryAnchor"] = ["routes.py", 13, len(first_registration.encode("utf-8")) + 2, "Call"]
        errors = compare(changed, same_line_expected, same_line)
        ids = [row["id"] for row in changed["scenarios"]]
        step_ids = [step["id"] for row in changed["scenarios"] for step in row["steps"]]
        if errors or len(ids) != len(set(ids)) or len(step_ids) != len(set(step_ids)):
            raise AssertionError(f"Same-line registrations lost distinct anchors: {errors}")
        report["sourceProbes"].append({"name": "same-line-same-address-distinct-identities", "status": "passed"})

        routes_path.write_text(original_routes.replace(original_registrations, first_registration + "; " + second_registration + "; " + first_registration), encoding="utf-8")
        changed, _ = run_extract(same_line)
        repeated_expected = copy.deepcopy(same_line_expected)
        third = copy.deepcopy(repeated_expected["scenarios"][0])
        third["entryAnchor"] = ["routes.py", 13, len((first_registration + "; " + second_registration + "; ").encode("utf-8")), "Call"]
        repeated_expected["scenarios"].append(third)
        repeated_expected["sharedImplementations"] = ["services.open_loan", "shared.record"]
        errors = compare(changed, repeated_expected, same_line)
        if errors:
            raise AssertionError(f"Repeated handler registrations lost their distinct entry anchors: {errors}")
        report["sourceProbes"].append({"name": "same-line-repeated-handler-distinct-identities", "status": "passed"})

    for protected in (ROOT / "inputs" / "library" / "services.py", ROOT / "expected" / "library.json", ROOT / "extract.py"):
        before = protected.read_bytes()
        result = subprocess.run([sys.executable, "-B", str(ROOT / "extract.py"), "--project", str(project), "--output", str(protected)], capture_output=True, text=True, encoding="utf-8")
        if result.returncode == 0 or protected.read_bytes() != before or "JSON file inside reports" not in result.stderr:
            raise AssertionError("CLI did not protect an input, oracle or source-code path")
        report["sourceProbes"].append({"name": f"cli-protects-{protected.relative_to(ROOT).as_posix()}", "status": "rejected"})

    # Native links target only a fresh disposable sentinel, never inputs/oracles.
    with temporary_inputs() as temporary:
        sentinel = temporary / "sentinel.json"
        sentinel.write_text("unchanged", encoding="utf-8")
        for placement in ("parent", "final"):
            link = REPORTS / (f"link-{uuid.uuid4().hex}" + (".json" if placement == "final" else ""))
            if not link.absolute().is_relative_to(REPORTS) or not temporary.resolve().is_relative_to(ROOT):
                raise AssertionError("Output-link test path escaped experiment directory")
            try:
                if sys.platform == "win32":
                    import _winapi
                    _winapi.CreateJunction(str(temporary), str(link))
                else:
                    link.symlink_to(temporary, target_is_directory=True)
                output = link / "sentinel.json" if placement == "parent" else link
                try:
                    save(str(output.relative_to(REPORTS)), {"shouldNotWrite": True})
                except ValueError as exc:
                    if "REPORT_LINK_REFUSED" not in str(exc):
                        raise
                else:
                    raise AssertionError("Verifier followed an output link")
                if sentinel.read_text(encoding="utf-8") != "unchanged":
                    raise AssertionError("Verifier changed the disposable linked sentinel")
                report["sourceProbes"].append({"name": f"verifier-{placement}-directory-link", "status": "rejected"})
                result = subprocess.run([sys.executable, "-B", str(ROOT / "extract.py"), "--project", str(project), "--output", str(output)], capture_output=True, text=True, encoding="utf-8")
                if result.returncode == 0 or "REPORT_LINK_REFUSED" not in result.stderr or sentinel.read_text(encoding="utf-8") != "unchanged":
                    raise AssertionError("CLI followed an output link")
                report["sourceProbes"].append({"name": f"cli-{placement}-directory-link", "status": "rejected"})
            finally:
                # Remove the link itself, never recursively traverse its target.
                if not link.absolute().is_relative_to(REPORTS):
                    raise AssertionError("Link cleanup escaped report directory")
                if link.is_symlink():
                    link.unlink()
                elif link.exists():
                    link.rmdir()

    report["status"] = "passed"
    report["limitations"] = ["公开合成开发用例，非独立保留项目；已做独立代码与反例复核", "只验证登记的合成 API 与有限 Python AST 模式", "不计算具体授权 allow/deny，不证明持久化", "不是完整 BS/AP、跨语言或跨项目泛化验收", "当前 Windows 实测父目录与最终路径目录 junction；文件 symlink 与其他平台未实测，也未验证并发替换链接的竞态防护"]
    save("verification.json", report)
    print(json.dumps({"status": report["status"], "fixtures": len(report["fixtures"]), "evaluatorMutantsRejected": len(report["evaluatorMutations"]), "sourceProbes": len(report["sourceProbes"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
