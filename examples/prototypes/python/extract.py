"""Read registered text and bind a deliberately small set of Python declarations.

No target imports, import hooks, execution, inferred types or framework semantics.
The output is a local report, not a product schema or a runtime call graph.
"""
import argparse
import ast
import hashlib
import json
import platform
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

BASE = Path(__file__).resolve().parent


def digest(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()


def contained(root, relative):
    root = Path(root).absolute()
    relative = Path(relative)
    candidate = root / relative
    if relative.is_absolute() or not candidate.resolve().is_relative_to(root.resolve()) or candidate.resolve() == root.resolve():
        raise ValueError("INPUT_OUTSIDE_REGISTERED_ROOT")
    cursor = candidate
    while cursor != root.parent:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("LINK_INPUT_REFUSED")
        cursor = cursor.parent
    return candidate


def byte_position(raw, offset):
    if offset < 0 or offset > len(raw):
        raise ValueError("BYTE_ENDPOINT_OUTSIDE_INPUT")
    if 0 < offset < len(raw) and raw[offset - 1:offset + 1] == b"\r\n":
        raise ValueError("BYTE_ENDPOINT_INSIDE_CRLF")
    bom = 3 if raw.startswith(b"\xef\xbb\xbf") else 0
    if 0 < offset < bom:
        raise ValueError("BYTE_ENDPOINT_INSIDE_BOM")
    try:
        prefix = raw[bom:offset].decode("utf-8") if offset >= bom else ""
    except UnicodeDecodeError as error:
        raise ValueError("BYTE_ENDPOINT_INSIDE_CODEPOINT") from error
    lines = prefix.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return {"line": len(lines), "column": len(lines[-1]) + 1}


@dataclass
class Source:
    project: str
    file: str
    raw: bytes
    text: str
    tree: ast.AST | None

    def span(self, node):
        encoded = self.text.encode("utf-8")
        starts = [0]
        index = 0
        while index < len(encoded):
            if encoded[index:index + 2] == b"\r\n":
                index += 2
                starts.append(index)
            elif encoded[index] in (10, 13):
                index += 1
                starts.append(index)
            else:
                index += 1
        bom = len(self.raw) - len(encoded)
        start = starts[node.lineno - 1] + node.col_offset + bom
        end = starts[node.end_lineno - 1] + node.end_col_offset + bom
        a, b = byte_position(self.raw, start), byte_position(self.raw, end)
        return {"inputId": f"{self.project}:{self.file}", "inputFingerprint": digest(self.raw), "mappingStatus": "exact", "coordinatePolicyId": "raw-bytes-codepoints-v0.1", "nativePositions": {"tool": "Python ast", "version": platform.python_version(), "unit": "UTF-8-byte-column", "lineBase": 1, "columnBase": 0, "endConvention": "exclusive", "startLine": node.lineno, "startColumn": node.col_offset, "endLine": node.end_lineno, "endColumn": node.end_col_offset}, "normalized": {"startByte": start, "endByte": end, "startLine": a["line"], "startColumn": a["column"], "endLine": b["line"], "endColumn": b["column"]}}


@dataclass
class Scope:
    name: str
    source: Source
    node: ast.AST
    parent: "Scope | None"
    bindings: dict = field(default_factory=dict)
    calls: list = field(default_factory=list)
    writes: list = field(default_factory=list)


class Project:
    def __init__(self, sources, diagnostics):
        self.sources = sources
        self.diagnostics = diagnostics
        self.modules = {}
        self.scopes = []
        self.attribute_writes = set()
        for source in sources:
            if source.tree is not None:
                scope = Scope(Path(source.file).stem, source, source.tree, None)
                self.modules[scope.name] = scope
                self.scan_scope(scope)
        for scope in self.scopes:
            for target in scope.writes:
                if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name):
                    binding = self.lookup(scope, target.value.id)
                    if binding.get("kind") == "module":
                        self.attribute_writes.add((binding["module"], target.attr))

    def scan_scope(self, scope):
        self.scopes.append(scope)
        assigned = set()

        def bind(name, value):
            if name in scope.bindings:
                assigned.add(name)
            scope.bindings[name] = value

        def write(target):
            if isinstance(target, ast.Name):
                assigned.add(target.id)
            elif isinstance(target, (ast.Tuple, ast.List)):
                for element in target.elts:
                    write(element)
            elif isinstance(target, ast.Attribute):
                scope.writes.append(target)

        def visit(node, conditional=False):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                full_name = scope.name + "." + node.name
                unknown = "DECORATOR_BINDING_UNKNOWN" if node.decorator_list else "CONDITIONAL_BINDING_UNKNOWN" if conditional else None
                bind(node.name, {"kind": "unknown", "code": unknown} if unknown else {"kind": "function", "target": full_name, "source": scope.source, "node": node})
                child = Scope(full_name, scope.source, node, scope)
                self.scan_scope(child)
                # Defaults and explicit decorator call expressions execute in the outer scope.
                for expression in list(node.decorator_list) + list(node.args.defaults) + [d for d in node.args.kw_defaults if d is not None]:
                    visit(expression, conditional)
                return
            if isinstance(node, ast.ClassDef):
                bind(node.name, {"kind": "unknown", "code": "CLASS_SCOPE_UNSUPPORTED"})
                return
            if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                self.diagnostics.append({"code": "NESTED_EXPRESSION_SCOPE_UNSUPPORTED", "project": scope.source.project, "file": scope.source.file, "evidence": scope.source.span(node)})
                return
            if isinstance(node, ast.Import):
                for alias in node.names:
                    bind(alias.asname or alias.name.split(".")[0], {"kind": "module", "module": alias.name} if not conditional else {"kind": "unknown", "code": "CONDITIONAL_BINDING_UNKNOWN"})
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    bind(alias.asname or alias.name, {"kind": "from", "module": node.module, "name": alias.name} if not node.level and alias.name != "*" and not conditional else {"kind": "unknown", "code": "IMPORT_MODE_UNSUPPORTED"})
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    write(target)
            elif isinstance(node, (ast.For, ast.AsyncFor)):
                write(node.target)
            elif isinstance(node, (ast.Global, ast.Nonlocal)):
                for name in node.names:
                    assigned.add(name)
            elif isinstance(node, ast.Call):
                scope.calls.append(node)
            nested_conditional = conditional or isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.With, ast.AsyncWith, ast.Match))
            for child in ast.iter_child_nodes(node):
                visit(child, nested_conditional)

        for statement in scope.node.body:
            visit(statement)
        for name in assigned:
            scope.bindings[name] = {"kind": "unknown", "code": "ASSIGNMENT_BINDING_UNKNOWN"}
        if isinstance(scope.node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = scope.node.args
            for argument in args.posonlyargs + args.args + args.kwonlyargs + [a for a in (args.vararg, args.kwarg) if a]:
                if argument.arg not in assigned:
                    scope.bindings[argument.arg] = {"kind": "unknown", "code": "PARAMETER_TARGET_UNKNOWN"}

    def resolve_import(self, binding, trail=()):
        if binding.get("kind") not in ("module", "from"):
            return binding
        module = binding["module"]
        if module not in self.modules:
            return {"kind": "unknown", "code": "MODULE_INPUT_MISSING"}
        if binding["kind"] == "module":
            return binding
        key = (module, binding["name"])
        if key in trail:
            return {"kind": "unknown", "code": "IMPORT_CYCLE_UNRESOLVED"}
        target = self.modules[module].bindings.get(binding["name"], {"kind": "unknown", "code": "EXPORTED_NAME_UNKNOWN"})
        return self.resolve_import(target, trail + (key,))

    def lookup(self, scope, name):
        while scope:
            if name in scope.bindings:
                return self.resolve_import(scope.bindings[name])
            scope = scope.parent
        return {"kind": "unknown", "code": "NAME_BINDING_UNKNOWN"}

    def call_binding(self, scope, callee):
        if isinstance(callee, ast.Name):
            return self.lookup(scope, callee.id)
        if isinstance(callee, ast.Attribute) and isinstance(callee.value, ast.Name):
            base = self.lookup(scope, callee.value.id)
            if base["kind"] == "module":
                if (base["module"], callee.attr) in self.attribute_writes:
                    return {"kind": "unknown", "code": "ATTRIBUTE_WRITE_BOUNDARY"}
                return self.resolve_import({"kind": "from", "module": base["module"], "name": callee.attr})
            if base.get("code") == "MODULE_INPUT_MISSING":
                return base
            return {"kind": "unknown", "code": "TYPE_ATTRIBUTE_UNVERIFIED"}
        return {"kind": "unknown", "code": "DYNAMIC_EXPRESSION_UNRESOLVED"}

    def facts(self):
        result = []
        for scope in self.scopes:
            for node in scope.calls:
                binding = self.call_binding(scope, node.func)
                known = binding["kind"] == "function"
                evidence = scope.source.span(node)
                code = None if known else binding.get("code", "NON_FUNCTION_TARGET_UNKNOWN")
                fact = {"project": scope.source.project, "file": scope.source.file, "owner": scope.name, "callee": ast.get_source_segment(scope.source.text, node.func), "text": ast.get_source_segment(scope.source.text, node), "mode": "confirmed" if known else "unresolved", "bindingKind": "lexical-declaration-reference", "target": binding["target"] if known else None, "targetEvidence": binding["source"].span(binding["node"]) if known else None, "code": code, "evidence": evidence, "production": "automatic", "runtimeTargetMode": "unknown", "executionReachability": "not-evaluated", "runtimeObserved": False}
                result.append(fact)
                if code:
                    self.diagnostics.append({"code": code, "project": scope.source.project, "file": scope.source.file, "evidence": evidence})
        return result


def extract(output="reports/actual.json", manifest_path=None):
    started = time.perf_counter()
    registry_path = contained(BASE, manifest_path or "inputs.json")
    if registry_path != BASE / "inputs.json" and not registry_path.is_relative_to(BASE / "reports"):
        raise ValueError("INPUT_REGISTRY_NOT_REGISTERED")
    output_path = contained(BASE / "reports", Path(output).relative_to("reports"))
    if output_path.suffix != ".json":
        raise ValueError("REPORT_FORMAT_REFUSED")
    registry_bytes = registry_path.read_bytes()
    registry = json.loads(registry_bytes)
    diagnostics, inputs, facts, queries = [], [], [], []
    for entry in registry["projects"]:
        root = contained(BASE, entry["root"])
        if not root.is_relative_to(BASE / "fixtures"):
            raise ValueError("INPUT_ROOT_NOT_REGISTERED")
        sources = []
        for relative in entry["files"]:
            source_path = contained(root, relative)
            if Path(relative).name != relative or source_path.suffix != ".py":
                raise ValueError("ONLY_REGISTERED_FLAT_PYTHON_SOURCES")
            queries.append({"path": source_path.relative_to(BASE).as_posix(), "exists": source_path.is_file()})
            if not source_path.is_file():
                diagnostics.append({"code": "INPUT_MISSING", "project": entry["id"], "file": relative})
                continue
            raw = source_path.read_bytes()
            record = {"inputId": f"{entry['id']}:{relative}", "path": source_path.relative_to(BASE).as_posix(), "fingerprint": digest(raw), "byteLength": len(raw), "encoding": "UTF-8"}
            inputs.append(record)
            try:
                source_text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                diagnostics.append({"code": "INVALID_UTF8", "project": entry["id"], "file": relative})
                continue
            try:
                tree = ast.parse(source_text, filename=relative)
            except SyntaxError as error:
                tree = None
                diagnostics.append({"code": "SYNTAX_ERROR", "project": entry["id"], "file": relative, "line": error.lineno, "message": error.msg})
            sources.append(Source(entry["id"], relative, raw, source_text, tree))
        facts.extend(Project(sources, diagnostics).facts())
    report = {"reportFormatVersion": "python-local-ast-v1", "experimentId": registry["experimentId"], "status": "local-executed", "contractReference": "M1-02 source-span and local binding subset; not schema conformance", "toolchain": {"name": "Python ast", "version": platform.python_version(), "executable": sys.executable, "platform": platform.platform()}, "extractorFingerprint": digest(Path(__file__).read_bytes()), "registryFingerprint": digest(registry_bytes), "expectedReadByExtractor": False, "targetModulesExecuted": False, "inputs": inputs, "inputQueries": queries, "facts": facts, "diagnostics": diagnostics, "durationMs": (time.perf_counter() - started) * 1000, "completeness": {"complete": False, "freshness": "current", "unsupportedModes": ["runtime-targets-and-reachability", "types-and-frameworks", "full-project-loading", "class-lambda-comprehension-scopes", "general-dataflow", "worker-and-public-schema"]}, "scopeLimitations": ["Confirmed means a lexical declaration reference in the registered flat-module subset, never proof of a runtime call target or execution.", "Parameters, assignments, decorators and observed module attribute writes remain unknown; no import hooks, type inference or fixture execution.", "Real project loading, packaging environments, framework semantics and all-language depth remain unverified."]}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="reports/actual.json")
    options = parser.parse_args()
    actual = extract(options.output)
    print(json.dumps({"status": actual["status"], "facts": len(actual["facts"]), "diagnostics": len(actual["diagnostics"])}))
