"""Read a Python project's static metadata and a bounded lexical source slice.

This experiment does not import target modules, execute build backends, inspect
the interpreter's import paths, or infer runtime call targets.  Only raw input
bytes captured by this loader can supply declaration and import evidence.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import ast
import fnmatch
import hashlib
import io
import json
import os
import platform
import stat
import tokenize
import tomllib
from pathlib import Path


BASE = Path(__file__).resolve().parent
DEFAULT_LIMITS = {
    "maxFiles": 512,
    "maxFileBytes": 2 * 1024 * 1024,
    "maxTotalBytes": 16 * 1024 * 1024,
    "maxDirectories": 4096,
    "maxAstNodes": 100000,
    "maxImportDepth": 32,
}
EXCLUDED_DIRECTORIES = {".git", ".hg", ".svn", ".venv", "venv", ".tox", "__pycache__", "node_modules"}
BASE_UNSUPPORTED = {"runtime-targets-and-reachability", "types-and-frameworks", "general-dataflow", "installed-dependency-resolution"}


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _no_links(path):
    cursor = Path(path).absolute()
    while True:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("LINK_INPUT_REFUSED: " + str(cursor))
        if cursor == cursor.parent:
            break
        cursor = cursor.parent


def _relative(root, value, allow_root=False):
    relative = Path(value)
    if relative.anchor or ".." in relative.parts or any(":" in part for part in relative.parts):
        raise ValueError("INPUT_OUTSIDE_REGISTERED_ROOT: " + str(value))
    candidate = root / relative
    _no_links(candidate)
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root) or (resolved == root and not allow_root):
        raise ValueError("INPUT_OUTSIDE_REGISTERED_ROOT: " + str(value))
    return candidate


def _position(raw, offset):
    bom = 3 if raw.startswith(b"\xef\xbb\xbf") else 0
    prefix = raw[bom:offset].decode("utf-8")
    lines = prefix.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return len(lines), len(lines[-1]) + 1


class Source:
    def __init__(self, file, module, raw, text, tree, is_package):
        self.file, self.module, self.raw, self.text, self.tree = file, module, raw, text, tree
        self.is_package = is_package
        self.bom = 3 if raw.startswith(b"\xef\xbb\xbf") else 0
        self.starts = [0]
        encoded = text.encode("utf-8")
        index = 0
        while index < len(encoded):
            if encoded[index:index + 2] == b"\r\n":
                index += 2
                self.starts.append(index)
            elif encoded[index] in (10, 13):
                index += 1
                self.starts.append(index)
            else:
                index += 1

    def span(self, node):
        start = self.bom + self.starts[node.lineno - 1] + node.col_offset
        end = self.bom + self.starts[node.end_lineno - 1] + node.end_col_offset
        start_line, start_column = _position(self.raw, start)
        end_line, end_column = _position(self.raw, end)
        return {"startByte": start, "endByte": end, "startLine": start_line, "startColumn": start_column, "endLine": end_line, "endColumn": end_column}


class Inputs:
    def __init__(self, root, limits):
        self.root, self.limits = root, limits
        self.manifest, self.raw, self.queries, self.diagnostics = {}, {}, {}, []
        self.missing, self.unsupported, self.truncations = set(), set(BASE_UNSUPPORTED), set()
        self.total_bytes = 0
        self.directory_count = 0
        self.ast_nodes = 0
        self.max_ast_nodes_per_source = 0
        self.import_depth = 0

    def diagnostic(self, code, message, file=None, span=None):
        item = {"code": code, "message": message}
        if file is not None:
            item["file"] = file
        if span is not None:
            item["span"] = span
        if item not in self.diagnostics:
            self.diagnostics.append(item)

    def missing_input(self, identifier, message, file=None):
        self.missing.add(identifier)
        self.diagnostic("INPUT_MISSING", message, file)

    def truncate(self, limit, file=None):
        key = limit + (":" + file if file else "")
        self.truncations.add(key)
        self.diagnostic("INPUT_BUDGET_EXCEEDED", "Exploration budget exceeded: " + limit, file)

    def read(self, path, kind):
        _no_links(path)
        relative = path.relative_to(self.root).as_posix()
        if relative in self.raw:
            return self.raw[relative]
        self.queries[relative] = {"path": relative, "exists": path.is_file()}
        if not path.is_file():
            self.missing_input(relative, "Registered input is absent.", relative)
            return None
        if len(self.manifest) >= self.limits["maxFiles"]:
            self.truncate("maxFiles", relative)
            return None
        before = path.stat()
        if not stat.S_ISREG(before.st_mode):
            raise ValueError("NON_REGULAR_INPUT_REFUSED: " + relative)
        if before.st_size > self.limits["maxFileBytes"]:
            self.truncate("maxFileBytes", relative)
            return None
        if self.total_bytes + before.st_size > self.limits["maxTotalBytes"]:
            self.truncate("maxTotalBytes", relative)
            return None
        with path.open("rb") as handle:
            opened = os.fstat(handle.fileno())
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise ValueError("INPUT_CHANGED_DURING_READ: " + relative)
            raw = handle.read(self.limits["maxFileBytes"] + 1)
            after = os.fstat(handle.fileno())
        _no_links(path)
        if (opened.st_size, opened.st_mtime_ns, opened.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
            raise ValueError("INPUT_CHANGED_DURING_READ: " + relative)
        if len(raw) > self.limits["maxFileBytes"]:
            self.truncate("maxFileBytes", relative)
            return None
        if self.total_bytes + len(raw) > self.limits["maxTotalBytes"]:
            self.truncate("maxTotalBytes", relative)
            return None
        self.total_bytes += len(raw)
        self.raw[relative] = raw
        self.manifest[relative] = {"path": relative, "kind": kind, "sha256": digest(raw), "sizeBytes": len(raw)}
        return raw


def _string_list(value, name):
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("INVALID_STATIC_CONFIGURATION: " + name)
    return value


def _configuration(inputs, config_file):
    config_path = _relative(inputs.root, config_file)
    if config_path.name != "pyproject.toml":
        raise ValueError("CONFIG_FORMAT_REFUSED: expected pyproject.toml")
    raw = inputs.read(config_path, "config")
    config = {}
    if raw is not None:
        try:
            config = tomllib.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
            inputs.diagnostic("INVALID_PROJECT_CONFIG", str(error), config_file)
            inputs.unsupported.add("invalid-project-configuration")
    project = config.get("project", {})
    tool = config.get("tool", {})
    setuptools = tool.get("setuptools", {}) if isinstance(tool, dict) else {}
    if not isinstance(project, dict) or not isinstance(setuptools, dict):
        inputs.diagnostic("INVALID_PROJECT_CONFIG", "Project and setuptools metadata must be tables.", config_file)
        inputs.unsupported.add("invalid-project-configuration")
        project, setuptools = {}, {}
    if project.get("dynamic") or setuptools.get("dynamic"):
        inputs.diagnostic("DYNAMIC_PROJECT_CONFIG", "Dynamic metadata is retained as unknown; no attribute provider or backend is imported.", config_file)
        inputs.unsupported.add("dynamic-project-metadata")
    # Capture legacy build scripts as inert bytes, even when sources live in src/.
    for name in ("setup.py", "setup.cfg"):
        path = _relative(inputs.root, name)
        if path.exists():
            inputs.read(path, "metadata")
            if name in inputs.manifest:
                inputs.manifest[name]["metadataKind"] = "build-config"
            inputs.diagnostic("DYNAMIC_PROJECT_CONFIG", "Legacy build configuration is not evaluated.", name)
            inputs.unsupported.add("legacy-build-configuration")
    package_dir = setuptools.get("package-dir", {})
    packages = setuptools.get("packages", {})
    roots, include, exclude, namespaces = [], ["*"], [], True
    try:
        if not isinstance(package_dir, dict) or any(not isinstance(value, str) for value in package_dir.values()):
            raise ValueError("INVALID_STATIC_CONFIGURATION: package-dir")
        if any(name for name in package_dir):
            inputs.diagnostic("PROJECT_LAYOUT_UNSUPPORTED", "Named package-dir remapping is outside this slice.", config_file)
            inputs.unsupported.add("named-package-directory-remapping")
        if isinstance(packages, dict):
            find = packages.get("find", {})
            if not isinstance(find, dict):
                raise ValueError("INVALID_STATIC_CONFIGURATION: packages.find")
            if "where" in find:
                roots = _string_list(find["where"], "packages.find.where")
            if "include" in find:
                include = _string_list(find["include"], "packages.find.include")
            if "exclude" in find:
                exclude = _string_list(find["exclude"], "packages.find.exclude")
            namespaces = find.get("namespaces", True)
            if not isinstance(namespaces, bool):
                raise ValueError("INVALID_STATIC_CONFIGURATION: packages.find.namespaces")
        elif packages:
            inputs.diagnostic("PROJECT_LAYOUT_UNSUPPORTED", "Explicit package lists are outside this discovery slice.", config_file)
            inputs.unsupported.add("explicit-package-list")
        if not roots and "" in package_dir:
            roots = [package_dir[""]]
        if roots and "" in package_dir and package_dir[""] not in roots:
            inputs.diagnostic("PROJECT_LAYOUT_UNSUPPORTED", "Conflicting package-dir and find.where require a broader packaging model.", config_file)
            inputs.unsupported.add("conflicting-package-roots")
    except ValueError as error:
        inputs.diagnostic("INVALID_PROJECT_CONFIG", str(error), config_file)
        inputs.unsupported.add("invalid-project-configuration")
        roots = []
    explicit = bool(roots)
    if not roots:
        conventional_src = _relative(inputs.root, "src")
        roots = ["src"] if conventional_src.is_dir() else ["."]
    checked_roots = []
    for value in sorted(set(roots)):
        path = _relative(inputs.root, value, allow_root=True)
        relative = path.relative_to(inputs.root).as_posix()
        if not path.is_dir():
            inputs.missing_input(relative, "Static source root is absent.", relative)
        checked_roots.append(path)
    dependencies = project.get("dependencies", [])
    if dependencies:
        inputs.diagnostic("DEPENDENCY_ENVIRONMENT_UNVERIFIED", "Dependency metadata was read without querying or modifying an installed environment.", config_file)
    return checked_roots, {
        "mode": "static-setuptools-roots" if explicit else "conventional-static-roots",
        "sourceRoots": [path.relative_to(inputs.root).as_posix() for path in checked_roots],
        "include": include, "exclude": exclude, "namespaces": namespaces,
        "excludedDirectoryNames": sorted(EXCLUDED_DIRECTORIES),
        "declaredDependencies": dependencies,
        "buildSystem": config.get("build-system", {}),
        "buildBackendExecuted": False,
    }


def _discover(inputs, roots, discovery):
    sources, seen_files = [], set()
    for source_root in roots:
        if not source_root.is_dir():
            continue
        stack = [source_root]
        while stack:
            directory = stack.pop()
            _no_links(directory)
            inputs.directory_count += 1
            if inputs.directory_count > inputs.limits["maxDirectories"]:
                inputs.truncate("maxDirectories", directory.relative_to(inputs.root).as_posix())
                return sources
            for path in sorted(directory.iterdir(), key=lambda value: value.name):
                _no_links(path)
                if path.is_dir():
                    if path.name not in EXCLUDED_DIRECTORIES and path.name.isidentifier():
                        if discovery["namespaces"] or (path / "__init__.py").is_file():
                            stack.append(path)
                    continue
                if path.suffix != ".py" or path.name == "setup.py" or path in seen_files:
                    continue
                seen_files.add(path)
                relative_source = path.relative_to(source_root)
                parts = list(relative_source.with_suffix("").parts)
                is_package = parts[-1] == "__init__"
                if is_package:
                    parts.pop()
                if not parts or any(not part.isidentifier() for part in parts):
                    inputs.diagnostic("MODULE_NAME_UNSUPPORTED", "Source path does not map to an unambiguous module name.", path.relative_to(inputs.root).as_posix())
                    inputs.unsupported.add("nonstandard-module-name")
                    continue
                module = ".".join(parts)
                package = module if is_package else module.rpartition(".")[0]
                if package and (not any(fnmatch.fnmatchcase(package, pattern) for pattern in discovery["include"]) or any(fnmatch.fnmatchcase(package, pattern) for pattern in discovery["exclude"])):
                    continue
                raw = inputs.read(path, "source")
                if raw is None:
                    continue
                file = path.relative_to(inputs.root).as_posix()
                try:
                    encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
                    if encoding.lower().replace("_", "-") not in ("utf-8", "utf-8-sig"):
                        inputs.diagnostic("SOURCE_ENCODING_UNSUPPORTED", "Only original UTF-8/UTF-8-BOM sources are mapped by this slice.", file)
                        inputs.unsupported.add("non-utf8-source")
                        continue
                    text = raw.decode("utf-8-sig")
                    tree = ast.parse(text, filename=file)
                    node_count = sum(1 for _ in ast.walk(tree))
                    inputs.ast_nodes += node_count
                    inputs.max_ast_nodes_per_source = max(inputs.max_ast_nodes_per_source, node_count)
                    if node_count > inputs.limits["maxAstNodes"]:
                        inputs.truncate("maxAstNodes", file)
                        continue
                except UnicodeDecodeError as error:
                    inputs.diagnostic("INVALID_UTF8", str(error), file)
                    inputs.unsupported.add("invalid-source-encoding")
                    continue
                except (SyntaxError, RecursionError, ValueError) as error:
                    inputs.diagnostic("SOURCE_PARSE_FAILED", str(error), file)
                    inputs.unsupported.add("unparsed-source")
                    continue
                sources.append(Source(file, module, raw, text, tree, is_package))
    return sources


def unknown(code):
    return {"kind": "unknown", "code": code}


class Scope:
    def __init__(self, name, source, node, parent=None, blocked=None):
        self.name, self.source, self.node, self.parent = name, source, node, parent
        self.bindings, self.calls, self.writes = {}, [], []
        self.blocked = blocked
        self.dynamic = False
        self.star_import = False
        self.shared_writes = []
        self.declared_globals = set()
        self.declared_nonlocals = set()


class Bindings:
    def __init__(self, sources, inputs):
        self.inputs = inputs
        self.modules, self.namespaces, self.ambiguous = {}, set(), set()
        self.scopes, self.declarations, self.imports = [], [], []
        self.attribute_writes = set()
        for source in sources:
            scope = Scope(source.module, source, source.tree)
            if source.module in self.modules:
                self.ambiguous.add(source.module)
                inputs.diagnostic("AMBIGUOUS_MODULE_INPUT", "Multiple discovered files have this module name: " + source.module, source.file)
                inputs.unsupported.add("ambiguous-module-paths")
            self.modules[source.module] = scope
            for index in range(1, len(source.module.split("."))):
                self.namespaces.add(".".join(source.module.split(".")[:index]))
            self.scan(scope)
        # A nested function may be visited before a later module declaration.
        # Apply shared writes only after every namespace has been indexed.
        for scope in self.scopes:
            for name, is_global in scope.shared_writes:
                parent = scope.parent
                while parent:
                    local_namespace = parent.parent is not None and not isinstance(parent.node, ast.ClassDef) and name not in parent.declared_globals and name not in parent.declared_nonlocals
                    if (is_global and parent.parent is None) or (not is_global and local_namespace and name in parent.bindings):
                        parent.bindings[name] = unknown("ASSIGNMENT_BINDING_UNKNOWN")
                        break
                    parent = parent.parent
        for scope in self.scopes:
            for target in scope.writes:
                if isinstance(target, ast.Attribute):
                    base = self.expression(scope, target.value)
                    if base["kind"] == "module":
                        self.attribute_writes.add((base["module"], target.attr))
                elif isinstance(target, ast.Subscript) and isinstance(target.value, ast.Attribute) and target.value.attr == "__dict__":
                    base = self.expression(scope, target.value.value)
                    if base["kind"] == "module":
                        key = target.slice.value if isinstance(target.slice, ast.Constant) and isinstance(target.slice.value, str) else "*"
                        self.attribute_writes.add((base["module"], key))
                        inputs.unsupported.add("module-namespace-mutation")
                        inputs.diagnostic("ATTRIBUTE_WRITE_BOUNDARY", "Observed module dictionary write/delete invalidates affected exported bindings; nonliteral keys invalidate all exports.", scope.source.file, scope.source.span(target))
            for node, _ in scope.calls:
                if isinstance(node.func, ast.Name) and node.func.id in ("setattr", "delattr") and len(node.args) >= 2:
                    base = self.expression(scope, node.args[0])
                    if base["kind"] == "module":
                        name = node.args[1].value if isinstance(node.args[1], ast.Constant) and isinstance(node.args[1].value, str) else "*"
                        self.attribute_writes.add((base["module"], name))
        self.resolve_import_records()

    def module_exists(self, name):
        return name in self.modules or name in self.namespaces

    def import_base(self, source, node):
        if not node.level:
            return node.module or ""
        package = source.module if source.is_package else source.module.rpartition(".")[0]
        parts = package.split(".") if package else []
        if node.level > len(parts):
            return None
        return ".".join(parts[:len(parts) - node.level + 1] + ([node.module] if node.module else []))

    def scan(self, scope):
        self.scopes.append(scope)
        assigned, bound_names, global_names, nonlocal_names = set(), set(), set(), set()

        def bind(name, value):
            bound_names.add(name)
            if name in scope.bindings:
                assigned.add(name)
            scope.bindings[name] = value

        def write(node):
            if isinstance(node, ast.Name):
                assigned.add(node.id)
            elif isinstance(node, (ast.Tuple, ast.List)):
                for element in node.elts:
                    write(element)
            elif isinstance(node, ast.Starred):
                write(node.value)
            elif isinstance(node, (ast.Attribute, ast.Subscript)):
                scope.writes.append(node)

        def enclosing_expression_writes(node):
            # PEP 572 gives comprehension walrus targets to the containing
            # non-comprehension scope. Lambda bodies form their own scope;
            # their default arguments still belong to the enclosing scope.
            if isinstance(node, ast.Lambda):
                for default in list(node.args.defaults) + [item for item in node.args.kw_defaults if item is not None]:
                    enclosing_expression_writes(default)
                return
            if isinstance(node, ast.NamedExpr):
                write(node.target)
            for child in ast.iter_child_nodes(node):
                enclosing_expression_writes(child)

        def unsupported_expression(node):
            enclosing_expression_writes(node)
            self.inputs.unsupported.add("lambda-and-comprehension-scopes")
            self.inputs.diagnostic("NESTED_EXPRESSION_SCOPE_UNSUPPORTED", "Nested expression scope has no lexical target proof in this slice.", scope.source.file, scope.source.span(node))
            for child in ast.walk(node):
                if isinstance(child, ast.Call):
                    scope.calls.append((child, "NESTED_EXPRESSION_SCOPE_UNSUPPORTED"))

        def visit(node, conditional=False):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                full_name = scope.name + "." + node.name
                is_class = isinstance(node, ast.ClassDef)
                kind = "class" if is_class else "async-function" if isinstance(node, ast.AsyncFunctionDef) else "function"
                self.declarations.append({"file": scope.source.file, "name": node.name, "qualifiedName": full_name, "kind": kind, "span": scope.source.span(node)})
                reason = scope.blocked or ("CLASS_SCOPE_UNSUPPORTED" if is_class else "DECORATOR_BINDING_UNKNOWN" if node.decorator_list else "CONDITIONAL_BINDING_UNKNOWN" if conditional else None)
                bind(node.name, unknown(reason) if reason else {"kind": "function", "source": scope.source, "node": node, "qualifiedName": full_name})
                if reason:
                    self.inputs.diagnostic(reason, "Declaration is recorded, but its callable binding is not confirmed.", scope.source.file, scope.source.span(node))
                    self.inputs.unsupported.add(reason.lower().replace("_", "-"))
                child = Scope(full_name, scope.source, node, scope, scope.blocked or ("CLASS_SCOPE_UNSUPPORTED" if is_class else None))
                self.scan(child)
                expressions = list(node.decorator_list)
                if is_class:
                    expressions += list(node.bases) + [item.value for item in node.keywords]
                else:
                    expressions += list(node.args.defaults) + [item for item in node.args.kw_defaults if item is not None]
                    annotations = [item.annotation for item in node.args.posonlyargs + node.args.args + node.args.kwonlyargs if item.annotation]
                    annotations += [item.annotation for item in (node.args.vararg, node.args.kwarg) if item and item.annotation]
                    annotations += [node.returns] if node.returns else []
                    annotations += list(getattr(node, "type_params", []))
                    for annotation in annotations:
                        annotation_calls = [item for item in ast.walk(annotation) if isinstance(item, ast.Call)]
                        if annotation_calls:
                            self.inputs.unsupported.add("annotation-evaluation-scope")
                            scope.calls.extend((item, "ANNOTATION_SCOPE_UNVERIFIED") for item in annotation_calls)
                for expression in expressions:
                    visit(expression, conditional)
                return
            if isinstance(node, (ast.Lambda, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)):
                unsupported_expression(node)
                return
            if isinstance(node, ast.Import):
                for alias in node.names:
                    record = {"file": scope.source.file, "moduleSpecifier": alias.name, "span": scope.source.span(node), "module": alias.name}
                    self.imports.append(record)
                    module = alias.name if alias.asname else alias.name.split(".")[0]
                    bind(alias.asname or module, unknown("CONDITIONAL_BINDING_UNKNOWN") if conditional else {"kind": "module", "module": module})
            elif isinstance(node, ast.ImportFrom):
                base = self.import_base(scope.source, node)
                self.imports.append({"file": scope.source.file, "moduleSpecifier": "." * node.level + (node.module or ""), "span": scope.source.span(node), "module": base})
                for alias in node.names:
                    if alias.name == "*":
                        scope.star_import = True
                        self.inputs.unsupported.add("star-import-bindings")
                        self.inputs.diagnostic("STAR_IMPORT_UNSUPPORTED", "Star imports do not supply known bindings in this slice.", scope.source.file, scope.source.span(node))
                    else:
                        reason = "CONDITIONAL_BINDING_UNKNOWN" if conditional else "RELATIVE_IMPORT_OUTSIDE_PACKAGE" if base is None else None
                        bind(alias.asname or alias.name, unknown(reason) if reason else {"kind": "from", "module": base, "name": alias.name})
            elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    write(target)
            elif isinstance(node, ast.Delete):
                for target in node.targets:
                    write(target)
            elif isinstance(node, getattr(ast, "TypeAlias", ())):
                write(node.name)
            elif isinstance(node, (ast.For, ast.AsyncFor)):
                write(node.target)
            elif isinstance(node, (ast.With, ast.AsyncWith)):
                for item in node.items:
                    if item.optional_vars:
                        write(item.optional_vars)
            elif isinstance(node, ast.ExceptHandler) and node.name:
                assigned.add(node.name)
            elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
                assigned.add(node.name)
            elif isinstance(node, ast.MatchMapping) and node.rest:
                assigned.add(node.rest)
            elif isinstance(node, ast.Global):
                global_names.update(node.names)
            elif isinstance(node, ast.Nonlocal):
                nonlocal_names.update(node.names)
            elif isinstance(node, ast.Call):
                scope.calls.append((node, scope.blocked))
                if isinstance(node.func, ast.Name) and node.func.id in ("exec", "eval", "globals", "locals"):
                    scope.dynamic = True
                    self.inputs.unsupported.add("dynamic-namespace-bindings")
            nested_conditional = conditional or isinstance(node, (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try, ast.TryStar, ast.With, ast.AsyncWith, ast.Match))
            for child in ast.iter_child_nodes(node):
                visit(child, nested_conditional)

        for statement in scope.node.body:
            visit(statement)
        for name in assigned:
            scope.bindings[name] = unknown("ASSIGNMENT_BINDING_UNKNOWN")
        scope.declared_globals = global_names
        scope.declared_nonlocals = nonlocal_names
        for name in global_names | nonlocal_names:
            scope.bindings[name] = unknown("GLOBAL_NONLOCAL_BINDING_UNKNOWN")
            if name in assigned or name in bound_names:
                scope.shared_writes.append((name, name in global_names))
        if isinstance(scope.node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            args = scope.node.args
            for argument in args.posonlyargs + args.args + args.kwonlyargs + [item for item in (args.vararg, args.kwarg) if item]:
                scope.bindings[argument.arg] = unknown("ASSIGNMENT_BINDING_UNKNOWN" if argument.arg in assigned else "PARAMETER_TARGET_UNKNOWN")

    def resolve(self, binding, trail=()):
        if binding["kind"] not in ("module", "from"):
            return binding
        module = binding["module"]
        if module in self.ambiguous:
            return unknown("AMBIGUOUS_MODULE_INPUT")
        if not self.module_exists(module):
            return unknown("MODULE_INPUT_MISSING")
        if binding["kind"] == "module":
            return binding
        key = (module, binding["name"])
        if key in trail:
            return unknown("IMPORT_CYCLE_UNRESOLVED")
        self.inputs.import_depth = max(self.inputs.import_depth, len(trail) + 1)
        if len(trail) >= self.inputs.limits["maxImportDepth"]:
            self.inputs.truncate("maxImportDepth")
            return unknown("IMPORT_BUDGET_EXCEEDED")
        if key in self.attribute_writes or (module, "*") in self.attribute_writes:
            return unknown("ATTRIBUTE_WRITE_BOUNDARY")
        target_scope = self.modules.get(module)
        if target_scope:
            if target_scope.dynamic:
                return unknown("DYNAMIC_NAMESPACE_UNKNOWN")
            if target_scope.star_import:
                return unknown("STAR_IMPORT_UNSUPPORTED")
            if binding["name"] in target_scope.bindings:
                return self.resolve(target_scope.bindings[binding["name"]], trail + (key,))
        submodule = module + "." + binding["name"]
        if self.module_exists(submodule):
            return self.resolve({"kind": "module", "module": submodule}, trail + (key,))
        return unknown("EXPORTED_NAME_UNKNOWN")

    def lookup(self, scope, name):
        while scope:
            if scope.dynamic:
                return unknown("DYNAMIC_NAMESPACE_UNKNOWN")
            if scope.star_import:
                return unknown("STAR_IMPORT_UNSUPPORTED")
            if scope.parent is None and ((scope.source.module, name) in self.attribute_writes or (scope.source.module, "*") in self.attribute_writes):
                return unknown("ATTRIBUTE_WRITE_BOUNDARY")
            if name in scope.bindings:
                return self.resolve(scope.bindings[name])
            scope = scope.parent
        return unknown("NAME_BINDING_UNKNOWN")

    def expression(self, scope, expression):
        if isinstance(expression, ast.Name):
            return self.lookup(scope, expression.id)
        if isinstance(expression, ast.Attribute):
            base = self.expression(scope, expression.value)
            if base["kind"] == "module":
                return self.resolve({"kind": "from", "module": base["module"], "name": expression.attr})
            if base.get("code") in ("MODULE_INPUT_MISSING", "AMBIGUOUS_MODULE_INPUT", "ATTRIBUTE_WRITE_BOUNDARY"):
                return base
            return unknown("TYPE_ATTRIBUTE_UNVERIFIED")
        return unknown("DYNAMIC_EXPRESSION_UNRESOLVED")

    def resolve_import_records(self):
        for record in self.imports:
            module = record.pop("module")
            if module in self.ambiguous:
                record["resolution"] = "unresolved"
                self.inputs.diagnostic("AMBIGUOUS_MODULE_INPUT", "Import has multiple registered source candidates.", record["file"], record["span"])
            elif module and self.module_exists(module):
                if module in self.modules:
                    record["resolution"] = "resolved"
                    record["targetFile"] = self.modules[module].source.file
                else:
                    record["resolution"] = "unresolved"
                    self.inputs.unsupported.add("namespace-package-import-identity")
                    self.inputs.diagnostic("NAMESPACE_IMPORT_IDENTITY_UNSUPPORTED", "Namespace directory has no single source file for this report's import identity.", record["file"], record["span"])
            else:
                record["resolution"] = "unresolved"
                code = "RELATIVE_IMPORT_OUTSIDE_PACKAGE" if module is None else "MODULE_INPUT_MISSING"
                self.inputs.missing.add("module:" + (module or record["moduleSpecifier"]))
                self.inputs.diagnostic(code, "Import cannot be resolved from captured project sources; installed environments are not queried.", record["file"], record["span"])

    def calls(self):
        calls = []
        for scope in self.scopes:
            for node, forced_reason in scope.calls:
                binding = unknown(forced_reason) if forced_reason else self.expression(scope, node.func)
                known = binding["kind"] == "function"
                target = {"file": binding["source"].file, "qualifiedName": binding["qualifiedName"], "span": binding["source"].span(binding["node"])} if known else None
                fact = {"file": scope.source.file, "owner": scope.name, "callee": ast.get_source_segment(scope.source.text, node.func), "span": scope.source.span(node), "bindingKind": "lexical-declaration-reference", "resolution": "confirmed" if known else "unresolved", "target": target, "runtimeTargetMode": "unknown", "executionReachability": "not-evaluated"}
                calls.append(fact)
                if not known:
                    code = binding.get("code", "NON_FUNCTION_TARGET_UNKNOWN")
                    self.inputs.diagnostic(code, "Call has no lexical declaration proof within the supported static modes.", scope.source.file, fact["span"])
        return calls


def analyze_project(request):
    """Return a report using captured project bytes; never write to the project."""
    if not isinstance(request, dict) or not isinstance(request.get("projectId"), str) or not request["projectId"].strip():
        raise ValueError("INVALID_PROJECT_REQUEST: projectId is required")
    if not isinstance(request.get("projectRoot"), str) or not Path(request["projectRoot"]).is_absolute():
        raise ValueError("INVALID_PROJECT_REQUEST: projectRoot must be absolute")
    root = Path(request["projectRoot"])
    _no_links(root)
    root = root.resolve()
    if not root.is_dir():
        raise ValueError("PROJECT_ROOT_MISSING")
    limits = dict(DEFAULT_LIMITS)
    supplied = request.get("limits", {})
    if not isinstance(supplied, dict):
        raise ValueError("INVALID_EXPLORATION_LIMITS")
    for key, value in supplied.items():
        if key not in limits or isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError("INVALID_EXPLORATION_LIMIT: " + str(key))
        limits[key] = value
    config_file = request.get("configFile", "pyproject.toml")
    if not isinstance(config_file, str) or not config_file:
        raise ValueError("INVALID_CONFIG_FILE")
    inputs = Inputs(root, limits)
    roots, discovery = _configuration(inputs, config_file)
    sources = _discover(inputs, roots, discovery)
    bindings = Bindings(sources, inputs)
    calls = bindings.calls()
    order = lambda fact: (fact["file"], fact["span"]["startByte"], fact.get("moduleSpecifier", fact.get("name", "")))
    return {
        "reportVersion": "project-loading-v0.1", "language": "python", "projectId": request["projectId"],
        "projectRoot": str(root), "configFile": Path(config_file).as_posix(),
        "toolchain": {"name": "Python stdlib ast/tomllib", "version": platform.python_version(), "executable": sys.executable, "extractorSha256": digest(Path(__file__).read_bytes())},
        "effectiveLimits": limits, "discovery": discovery,
        "budgetSemantics": {"maxFiles": "all-captured-config-metadata-and-source-files", "maxAstNodes": "per-source-file-before-fact-extraction", "maxImportDepth": "per-import-reference-chain", "astParsing": "File byte limits apply before parsing; the AST node limit does not bound parser CPU or memory."},
        "observed": {"filesRead": len(inputs.manifest), "bytesRead": inputs.total_bytes, "directoriesVisited": inputs.directory_count, "sourcesParsed": len(sources), "astNodes": inputs.ast_nodes, "maxAstNodesPerSource": inputs.max_ast_nodes_per_source, "maxImportDepth": inputs.import_depth},
        "inputManifest": [inputs.manifest[key] for key in sorted(inputs.manifest)],
        "inputQueries": [inputs.queries[key] for key in sorted(inputs.queries)],
        "declarations": sorted(bindings.declarations, key=order),
        "imports": sorted(bindings.imports, key=order), "calls": sorted(calls, key=order),
        "diagnostics": sorted(inputs.diagnostics, key=lambda item: (item.get("file", ""), item.get("span", {}).get("startByte", -1), item["code"], item["message"])),
        "completeness": {"complete": False, "missingInputs": sorted(inputs.missing), "unsupportedModes": sorted(inputs.unsupported), "truncations": sorted(inputs.truncations)},
        "targetModulesExecuted": False, "buildBackendExecuted": False, "expectedReadByExtractor": False,
        "scopeLimitations": [
            "Confirmed calls identify lexical declarations only; reachability and runtime targets remain unknown.",
            "Static source roots, UTF-8 sources, package imports and finite re-exports are an exploration slice, not Python framework or packaging conformance.",
            "No import hooks, setup/backend execution, dependency installation or installed-environment search is performed.",
            "Existing path links and read-time file changes are refused; concurrent path replacement is not proven safe on every platform.",
        ],
    }


def write_report(report, output):
    relative = Path(output)
    if relative.is_absolute():
        try:
            relative = relative.relative_to(BASE)
        except ValueError as error:
            raise ValueError("OUTPUT_OUTSIDE_REPORT_DIRECTORY") from error
    try:
        relative = relative.relative_to("reports")
    except ValueError as error:
        raise ValueError("OUTPUT_OUTSIDE_REPORT_DIRECTORY") from error
    reports_root = BASE / "reports"
    _no_links(reports_root)
    destination = _relative(reports_root.resolve(), relative)
    if destination.suffix != ".json" or destination.resolve().is_relative_to(Path(report["projectRoot"]).resolve()):
        raise ValueError("OUTPUT_OVERLAPS_INPUT_OR_INVALID_FORMAT")
    if destination.exists() and destination.stat().st_nlink > 1:
        raise ValueError("LINK_OUTPUT_REFUSED")
    destination.parent.mkdir(parents=True, exist_ok=True)
    _no_links(destination)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--config-file", default="pyproject.toml")
    parser.add_argument("--limits", type=json.loads, default={})
    parser.add_argument("--output")
    options = parser.parse_args()
    report = analyze_project({"projectId": options.project_id, "projectRoot": str(Path(options.project_root).absolute()), "configFile": options.config_file, "limits": options.limits})
    if options.output:
        destination = write_report(report, options.output)
        print(json.dumps({"output": str(destination), "inputs": len(report["inputManifest"]), "calls": len(report["calls"]), "diagnostics": len(report["diagnostics"])}, ensure_ascii=False))
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
