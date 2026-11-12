"""Developer regressions for project loading; the independent oracle is separate.

These tests create disposable projects below this experiment's reports directory.
They exercise refusal, lexical uncertainty and evidence boundaries, not product
accuracy.  They never read project-loading/expected or execute target modules.
"""
import sys

sys.dont_write_bytecode = True

import json
import os
import shutil
import symtable
import uuid
from contextlib import contextmanager
from pathlib import Path

from project_extract import BASE, _no_links, _relative, analyze_project, digest, write_report


REPORTS = BASE / "reports"
CONFIG = b'''[project]
name = "lexical-probe"
version = "0.0.0"
[tool.setuptools.package-dir]
"" = "src"
[tool.setuptools.packages.find]
where = ["src"]
'''
CORE = b"def target(value):\n    return value\n\ndef other(value):\n    return value\n"
SERVICE = b"from . import target\n\ndef entry(value):\n    return target(value)\n"
DEFAULT_FILES = {
    "pyproject.toml": CONFIG,
    "src/probe_pkg/__init__.py": b"from .core import target\n",
    "src/probe_pkg/core.py": CORE,
    "src/probe_pkg/service.py": SERVICE,
}


@contextmanager
def project(overrides=None):
    _no_links(REPORTS)
    REPORTS.mkdir(exist_ok=True)
    # Default mkdir permissions inherit the workspace ACL.  Python 3.14's
    # mkdtemp(0700) can make a directory inaccessible to a Windows sandbox token.
    root = REPORTS / (".project-probe-" + uuid.uuid4().hex)
    root.mkdir()
    root = root.resolve()
    if root.parent != REPORTS.resolve():
        raise ValueError("UNSAFE_TEMPORARY_PROJECT")
    try:
        files = dict(DEFAULT_FILES)
        files.update(overrides or {})
        for name, raw in files.items():
            path = _relative(root, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        yield root
    finally:
        # Recursive cleanup is restricted to the exact directory created above.
        if root.parent != REPORTS.resolve() or not root.name.startswith(".project-probe-"):
            raise ValueError("UNSAFE_TEMPORARY_PROJECT_CLEANUP")
        _no_links(root)
        shutil.rmtree(root)


def snapshot(root):
    return {path.relative_to(root).as_posix(): digest(path.read_bytes()) for path in root.rglob("*") if path.is_file()}


def analyze(root, **extra):
    return analyze_project({"projectId": "python-project-regression", "projectRoot": str(root), **extra})


def selected(report, callee="target"):
    matches = [call for call in report["calls"] if call["callee"] == callee]
    if len(matches) != 1:
        raise AssertionError("Expected one call to " + callee + "; got " + str(len(matches)))
    return matches[0]


def main():
    checks, skipped = [], []

    def check(name, condition):
        checks.append({"name": name, "passed": bool(condition)})

    def refuses(name, operation, code):
        try:
            operation()
        except ValueError as error:
            check(name, code in str(error))
        else:
            check(name, False)

    with project() as root:
        before = snapshot(root)
        report = analyze(root)
        call = selected(report)
        check("relative-package-reexport", call["resolution"] == "confirmed" and call["target"]["qualifiedName"] == "probe_pkg.core.target")
        check("whole-target-declaration", CORE[call["target"]["span"]["startByte"]:call["target"]["span"]["endByte"]] == b"def target(value):\n    return value")
        check("manifest-from-captured-bytes", all(item["sha256"] == before[item["path"]] and item["sizeBytes"] == (root / item["path"]).stat().st_size for item in report["inputManifest"]))
        check("runtime-and-depth-stay-unknown", all(item["runtimeTargetMode"] == "unknown" for item in report["calls"]) and not report["completeness"]["complete"])
        check("no-module-import-or-bytecode", snapshot(root) == before and not any(name.startswith("probe_pkg") for name in sys.modules))
        refuses("relative-config-traversal", lambda: analyze(root, configFile="../pyproject.toml"), "INPUT_OUTSIDE_REGISTERED_ROOT")
        refuses("absolute-config-refused", lambda: analyze(root, configFile=str(root / "pyproject.toml")), "INPUT_OUTSIDE_REGISTERED_ROOT")
        limited = analyze(root, limits={"maxFiles": 1})
        check("file-budget-does-not-confirm-partial-project", limited["observed"]["filesRead"] == 1 and not limited["calls"] and bool(limited["completeness"]["truncations"]))
        limited = analyze(root, limits={"maxImportDepth": 1})
        check("import-budget-stays-unknown", selected(limited)["resolution"] == "unresolved" and "maxImportDepth" in limited["completeness"]["truncations"])
        refuses("negative-budget-refused", lambda: analyze(root, limits={"maxFiles": 0}), "INVALID_EXPLORATION_LIMIT")
        refuses("output-outside-reports-refused", lambda: write_report(report, "expected/cases.json"), "OUTPUT_OUTSIDE_REPORT_DIRECTORY")
        inside = (root / "capture.json").relative_to(BASE).as_posix()
        refuses("output-inside-project-refused", lambda: write_report(report, inside), "OUTPUT_OVERLAPS_INPUT_OR_INVALID_FORMAT")
        link = REPORTS / (".project-hardlink-" + uuid.uuid4().hex + ".json")
        try:
            os.link(root / "src/probe_pkg/core.py", link)
            refuses("hardlinked-output-refused", lambda: write_report(report, link.relative_to(BASE).as_posix()), "LINK_OUTPUT_REFUSED")
            check("hardlink-target-unchanged", snapshot(root) == before)
        finally:
            if link.exists():
                link.unlink()

    with project({"src/probe_pkg/core.py": b"def identity(fn):\n    return fn\n\n@identity\ndef target(value):\n    return value\n"}) as root:
        report = analyze(root)
        check("decorated-import-not-promoted", selected(report)["target"] is None and any(item["code"] == "DECORATOR_BINDING_UNKNOWN" for item in report["diagnostics"]))

    variants = [
        ("whole-function-local-rebinding", b"from .core import target\ndef entry(value):\n    target(value)\n    target = value\n", "ASSIGNMENT_BINDING_UNKNOWN"),
        ("parameter-shadowing", b"from .core import target\ndef entry(target):\n    return target(1)\n", "PARAMETER_TARGET_UNKNOWN"),
        ("with-alias-shadowing", b"from .core import target\ndef entry(value):\n    with value as target:\n        target(1)\n", "ASSIGNMENT_BINDING_UNKNOWN"),
        ("exception-alias-shadowing", b"from .core import target\ndef entry():\n    try:\n        pass\n    except Exception as target:\n        target(1)\n", "ASSIGNMENT_BINDING_UNKNOWN"),
        ("match-capture-shadowing", b"from .core import target\ndef entry(value):\n    match value:\n        case {'name': target}:\n            target(1)\n", "ASSIGNMENT_BINDING_UNKNOWN"),
        ("star-import-not-promoted", b"from .core import target\nfrom .core import *\ndef entry(value):\n    return target(value)\n", "STAR_IMPORT_UNSUPPORTED"),
        ("dynamic-namespace-not-promoted", b"from .core import target\nexec('target = None')\ndef entry(value):\n    return target(value)\n", "DYNAMIC_NAMESPACE_UNKNOWN"),
    ]
    for name, service, diagnostic in variants:
        with project({"src/probe_pkg/service.py": service}) as root:
            report = analyze(root)
            check(name, selected(report)["target"] is None and any(item["code"] == diagnostic for item in report["diagnostics"]))

    with project({"src/probe_pkg/core.py": b"def mutate():\n    global target\n    target = None\n\ndef target(value):\n    return value\n"}) as root:
        report = analyze(root)
        check("later-declaration-does-not-erase-global-write", selected(report)["target"] is None and any(item["code"] == "ASSIGNMENT_BINDING_UNKNOWN" for item in report["diagnostics"]))

    walrus_service = b"from .core import target, other\ndef entry(value):\n    values = [(target := item) for item in []]\n    return target(value)\ndef stable(value):\n    return other(value)\n"
    lexical_table = symtable.symtable(walrus_service.decode("utf-8"), "walrus.py", "exec")
    check("comprehension-walrus-local-by-python-symtable", next(table for table in lexical_table.get_children() if table.get_name() == "entry").lookup("target").is_local())
    with project({"src/probe_pkg/service.py": walrus_service}) as root:
        report = analyze(root)
        check("comprehension-walrus-invalidates-outer-binding", selected(report)["target"] is None and any(item["code"] == "ASSIGNMENT_BINDING_UNKNOWN" for item in report["diagnostics"]))
        check("comprehension-write-keeps-unaffected-binding", selected(report, "other")["resolution"] == "confirmed" and selected(report, "other")["target"]["qualifiedName"] == "probe_pkg.core.other")

    for name, service, known in [
        ("lambda-body-walrus-stays-in-lambda", b"from .core import target\ndef entry(value):\n    closure = lambda: (target := value)\n    return target(value)\n", True),
        ("lambda-default-walrus-writes-enclosing-scope", b"from .core import target\ndef entry(value):\n    closure = lambda argument=(target := value): argument\n    return target(value)\n", False),
    ]:
        with project({"src/probe_pkg/service.py": service}) as root:
            call = selected(analyze(root))
            check(name, (call["resolution"] == "confirmed") == known and (known or call["target"] is None))

    for name, replacement in [
        ("global-function-definition-writes-module", b"def mutate():\n    global target\n    def target(value):\n        return value + 1\n"),
        ("global-import-writes-module", b"def mutate():\n    global target\n    from .peer import alternate as target\n"),
    ]:
        with project({"src/probe_pkg/core.py": CORE + replacement, "src/probe_pkg/peer.py": b"def alternate(value):\n    return value\n"}) as root:
            report = analyze(root)
            check(name, selected(report)["target"] is None and any(item["code"] == "ASSIGNMENT_BINDING_UNKNOWN" for item in report["diagnostics"]))

    for name, replacement in [
        ("nonlocal-function-definition-writes-enclosing-scope", b"    def mutate():\n        nonlocal target\n        def target(value):\n            return value + 1\n"),
        ("nonlocal-import-writes-enclosing-scope", b"    def mutate():\n        nonlocal target\n        from .core import other as target\n"),
        ("nonlocal-write-follows-enclosing-nonlocal-alias", b"    def middle():\n        nonlocal target\n        def mutate():\n            nonlocal target\n            from .core import other as target\n"),
    ]:
        service = b"def entry(value):\n    def target(argument):\n        return argument\n" + replacement + b"    return target(value)\n"
        with project({"src/probe_pkg/service.py": service}) as root:
            report = analyze(root)
            check(name, selected(report)["target"] is None and any(item["code"] == "ASSIGNMENT_BINDING_UNKNOWN" for item in report["diagnostics"]))

    for name, mutation in [("module-attribute-write", b"core.target = None"), ("module-setattr-write", b"setattr(core, 'target', None)")]:
        service = b"from . import core\n" + mutation + b"\ndef entry(value):\n    return core.target(value)\n"
        with project({"src/probe_pkg/service.py": service}) as root:
            report = analyze(root)
            check(name, selected(report, "core.target")["target"] is None and any(item["code"] == "ATTRIBUTE_WRITE_BOUNDARY" for item in report["diagnostics"]))

    for name, mutation in [
        ("module-dictionary-write", b"core.__dict__['target'] = None"),
        ("module-dictionary-delete", b"del core.__dict__['target']"),
        ("module-dictionary-dynamic-key-write", b"key = 'target'\ncore.__dict__[key] = None"),
    ]:
        service = b"from . import core\n" + mutation + b"\ndef entry(value):\n    return core.target(value)\n"
        with project({"src/probe_pkg/service.py": service}) as root:
            report = analyze(root)
            check(name, selected(report, "core.target")["target"] is None and any(item["code"] == "ATTRIBUTE_WRITE_BOUNDARY" for item in report["diagnostics"]))

    with project({"src/probe_pkg/core.py": CORE + b"def inside(value):\n    return target(value)\n", "src/probe_pkg/service.py": b"from . import core\ncore.__dict__['target'] = None\n"}) as root:
        report = analyze(root)
        check("module-write-also-invalidates-internal-global-lookup", selected(report)["target"] is None and any(item["code"] == "ATTRIBUTE_WRITE_BOUNDARY" for item in report["diagnostics"]))

    unicode_service = 'from .core import target\r\ndef entry(value):\r\n    标记 = "中文😀"; return target(value)\r\n'.encode("utf-8")
    bom_core = b"\xef\xbb\xbfdef target(value):\r\n    return value\r\n"
    with project({"src/probe_pkg/service.py": unicode_service, "src/probe_pkg/core.py": bom_core}) as root:
        call = selected(analyze(root))
        span, target_span = call["span"], call["target"]["span"]
        check("unicode-crlf-call-bytes", unicode_service[span["startByte"]:span["endByte"]] == b"target(value)")
        check("unicode-codepoint-columns", span["startLine"] == 3 and span["startColumn"] == len('    标记 = "中文😀"; return ') + 1)
        check("bom-declaration-position", target_span["startByte"] == 3 and target_span["startColumn"] == 1 and bom_core[target_span["startByte"]:target_span["endByte"]] == b"def target(value):\r\n    return value")

    with project({"pyproject.toml": CONFIG.replace(b'where = ["src"]', b'where = ["../outside"]')}) as root:
        refuses("source-root-traversal-refused", lambda: analyze(root), "INPUT_OUTSIDE_REGISTERED_ROOT")

    with project() as root, project() as external:
        link = root / "src" / "linked_package"
        try:
            if sys.platform == "win32":
                import _winapi
                _winapi.CreateJunction(str(external), str(link))
            else:
                link.symlink_to(external, target_is_directory=True)
            before = snapshot(external)
            refuses("linked-input-directory-refused", lambda: analyze(root), "LINK_INPUT_REFUSED")
            check("linked-target-unchanged", snapshot(external) == before)
        finally:
            if link.is_symlink():
                link.unlink()
            elif link.exists():
                link.rmdir()
        file_link = root / "src/probe_pkg/linked.py"
        try:
            try:
                file_link.symlink_to(external / "src/probe_pkg/core.py")
            except OSError as error:
                skipped.append({"name": "file-symlink-input-refused", "reason": "File symlink creation unavailable; winerror=" + str(getattr(error, "winerror", None)) + ", errno=" + str(error.errno)})
            else:
                refuses("file-symlink-input-refused", lambda: analyze(root), "LINK_INPUT_REFUSED")
        finally:
            if file_link.is_symlink():
                file_link.unlink()

    inert = b"from pathlib import Path\nPath(__file__).with_name('EXECUTED').write_text('unexpected')\n"
    with project({"src/probe_pkg/core.py": inert, "setup.py": inert, "build/backend.py": inert, "pyproject.toml": CONFIG + b"[tool.setuptools.dynamic]\nversion = {attr = 'probe_pkg.__version__'}\n"}) as root:
        before = snapshot(root)
        report = analyze(root)
        check("dynamic-metadata-never-evaluated", any(item["code"] == "DYNAMIC_PROJECT_CONFIG" for item in report["diagnostics"]) and report["buildBackendExecuted"] is False)
        check("backend-outside-source-discovery", all(item["file"] != "setup.py" and not item["file"].startswith("build/") for item in report["calls"]))
        check("source-build-tree-unchanged", snapshot(root) == before and not list(root.rglob("EXECUTED")))

    result = {
        "status": "checks-passed" if all(item["passed"] for item in checks) else "checks-failed",
        "scope": "Developer regressions for static Python project loading, lexical uncertainty, coordinates and read/write refusal; independent project-loading oracle is separate.",
        "passed": sum(item["passed"] for item in checks), "total": len(checks), "checks": checks, "skipped": skipped,
        "extractorSha256": digest((BASE / "project_extract.py").read_bytes()),
        "verifierSha256": digest(Path(__file__).read_bytes()),
    }
    destination = _relative(REPORTS.resolve(), "project-verification.json")
    if destination.exists() and destination.stat().st_nlink > 1:
        raise ValueError("LINK_OUTPUT_REFUSED")
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("status", "passed", "total", "skipped")}, ensure_ascii=False))
    for item in checks:
        if not item["passed"]:
            print(item["name"])
    return 0 if result["status"] == "checks-passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
