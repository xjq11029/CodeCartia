"""Read-only, finite Python AST experiment. Does not import target modules."""

import argparse
import ast
import copy
import hashlib
import json
import symtable
import sys
from pathlib import Path

sys.dont_write_bytecode = True

from report_io import write_report


ROOT = Path(__file__).resolve().parent
PROFILE = ROOT / "technical-profile.json"
MAX_DEPTH = 8
MAX_STEPS = 100


def digest(data):
    return hashlib.sha256(data).hexdigest()


def within(root, name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Unregistered path outside input root: {name}")
    return path


def shape(node):
    return ast.dump(node, include_attributes=False)


def simple_parameters(node):
    args = node.args
    if args.posonlyargs or args.kwonlyargs or args.vararg or args.kwarg or args.defaults or args.kw_defaults or node.decorator_list:
        raise ValueError("Only undecorated functions with required positional parameters are supported")
    return [arg.arg for arg in args.args]


def expression(node, bindings):
    class Replace(ast.NodeTransformer):
        def visit_Name(self, current):
            return copy.deepcopy(bindings.get(current.id, current))

    return ast.fix_missing_locations(Replace().visit(copy.deepcopy(node)))


def symbolic(node, bindings):
    return ast.unparse(expression(node, bindings))


def supported_expression(node):
    allowed = (ast.Name, ast.Attribute, ast.Constant, ast.Compare, ast.BoolOp, ast.UnaryOp,
               ast.Load, ast.And, ast.Or, ast.Not, ast.Eq, ast.NotEq, ast.Lt, ast.LtE,
               ast.Gt, ast.GtE, ast.Is, ast.IsNot)
    return all(isinstance(item, allowed) for item in ast.walk(node))


class Extractor:
    def __init__(self, project):
        self.root = Path(project).resolve()
        registration_raw = within(self.root, "project.json").read_bytes()
        profile_raw = PROFILE.read_bytes()
        self.registration = json.loads(registration_raw)
        self.profile = json.loads(profile_raw)
        contract_path = within(ROOT, self.profile["evidenceDocument"])
        if contract_path.parent != ROOT or contract_path.suffix != ".md":
            raise ValueError("Technical evidence must be a top-level Markdown contract, not input or oracle data")
        contract_raw = contract_path.read_bytes()
        self.registration_sha256 = digest(registration_raw)
        self.profile_fingerprints = {"sha256": digest(profile_raw), "contractSha256": digest(contract_raw)}
        self.modules = {}
        self.functions = {}
        self.function_locals = {}
        self.project_diagnostics = []
        self.input_manifest = []
        for name in self.registration["sources"]:
            path = within(self.root, name)
            if path.suffix != ".py" or len(Path(name).parts) != 1:
                raise ValueError("This finite experiment supports registered flat Python modules only")
            raw = path.read_bytes()
            source = raw.decode("utf-8")
            source_fingerprint = digest(raw)
            tree = ast.parse(source, filename=name)
            symbol_table = symtable.symtable(source, name, "exec")
            module = path.stem
            if module in self.modules:
                raise ValueError("Duplicate module")
            imports = {}
            bound_names = set()
            for node in tree.body:
                if isinstance(node, ast.ImportFrom) and node.level == 0:
                    for alias in node.names:
                        local_name = alias.asname or alias.name
                        if local_name in bound_names:
                            raise ValueError("Repeated module name bindings are outside this finite mode")
                        bound_names.add(local_name)
                        imports[local_name] = f"{node.module}.{alias.name}"
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        local_name = alias.asname or alias.name
                        if local_name in bound_names:
                            raise ValueError("Repeated module name bindings are outside this finite mode")
                        bound_names.add(local_name)
                        imports[local_name] = alias.name
                elif isinstance(node, ast.FunctionDef):
                    if node.name in bound_names:
                        raise ValueError("Repeated module name bindings are outside this finite mode")
                    bound_names.add(node.name)
                    key = f"{module}.{node.name}"
                    if key in self.functions:
                        raise ValueError("Repeated function definitions are unsupported")
                    self.functions[key] = (module, node)
                    scopes = [scope for scope in symbol_table.get_children()
                              if scope.get_name() == node.name and scope.get_lineno() == node.lineno]
                    if len(scopes) != 1:
                        raise ValueError("Function lexical scope could not be identified uniquely")
                    self.function_locals[key] = {symbol.get_name() for symbol in scopes[0].get_symbols()
                                                 if symbol.is_local() or symbol.is_parameter() or symbol.is_imported()}
            self.modules[module] = {"tree": tree, "imports": imports, "name": name, "source": source,
                                    "sha256": source_fingerprint}
            self.input_manifest.append({"path": name, "sha256": source_fingerprint})
        self.checks = {item["symbol"]: item for item in self.profile["checks"]}
        self.validate_profile()
        self.validate_module_scope()

    def validate_module_scope(self):
        """Avoid resolving a registered name through an ignored rebinding/effect."""
        api_module = self.profile["entry"]["symbol"].rsplit(".", 1)[0]
        for module, data in self.modules.items():
            if module == api_module:
                continue
            for node in data["tree"].body:
                if isinstance(node, ast.ImportFrom):
                    if node.level or node.module not in self.modules or any(alias.name == "*" for alias in node.names):
                        raise ValueError("Only explicit imports from registered modules are supported")
                elif isinstance(node, ast.Import):
                    if any(alias.name not in self.modules for alias in node.names):
                        raise ValueError("An imported module is outside the captured input set")
                elif isinstance(node, ast.FunctionDef):
                    simple_parameters(node)
                    if node.returns or any(argument.annotation for argument in node.args.args):
                        raise ValueError("Executable type annotations are outside this finite input mode")
                elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and self.resolve(module, node.value.func, {}) == self.profile["entry"]["symbol"]:
                    continue
                else:
                    raise ValueError("Module rebinding, decorators, classes and unregistered effects are outside this finite input mode")

    def evidence(self, module, node):
        data = self.modules[module]
        return {"file": data["name"], "line": node.lineno, "endLine": node.end_lineno,
                "startColumn": node.col_offset, "endColumn": node.end_col_offset,
                "coordinateUnit": "python-utf8-bytes", "sha256": data["sha256"],
                "text": ast.get_source_segment(data["source"], node)}

    def resolve(self, module, node, bindings, local_names=frozenset()):
        if isinstance(node, ast.Name):
            if node.id in bindings or node.id in local_names:
                return None
            return self.modules[module]["imports"].get(node.id, f"{module}.{node.id}")
        if isinstance(node, ast.Attribute):
            prefix = self.resolve(module, node.value, bindings, local_names)
            return f"{prefix}.{node.attr}" if prefix else None
        return None

    def validate_profile(self):
        entry = self.profile["entry"]
        api_module = entry["symbol"].rsplit(".", 1)[0]
        # Importing or rebinding a built-in exception or API would invalidate this
        # deliberately small framework contract; do not silently trust the name.
        allowed_functions = {item["symbol"].rsplit(".", 1)[1] for item in [entry, *self.checks.values()]}
        allowed_classes = {item["exception"] for item in self.checks.values()}
        for node in self.modules[api_module]["tree"].body:
            valid_registry = (isinstance(node, ast.Assign) and len(node.targets) == 1 and
                              isinstance(node.targets[0], ast.Name) and node.targets[0].id == entry["registry"] and
                              isinstance(node.value, ast.List) and not node.value.elts)
            if not (valid_registry or isinstance(node, ast.FunctionDef) and node.name in allowed_functions or
                    isinstance(node, ast.ClassDef) and node.name in allowed_classes):
                raise ValueError("Technical API module contains unregistered imports, bindings or effects")
        definitions = [entry, *self.checks.values()]
        for config in definitions:
            if config["symbol"] not in self.functions:
                raise ValueError(f"Technical API implementation missing: {config['symbol']}")
            module, function = self.functions[config["symbol"]]
            parameters = simple_parameters(function)
            if config is entry:
                expected = ast.parse(f"{entry['registry']}.append(({', '.join(parameters)}))").body
                if len(parameters) != 3 or [entry["methodArgument"], entry["addressArgument"], entry["handlerArgument"]] != [0, 1, 2]:
                    raise ValueError("Unsupported entry profile")
            else:
                index = config["predicateArgument"]
                if len(parameters) != index + 1:
                    raise ValueError("Unsupported technical check signature")
                expected = ast.parse(f"if not {parameters[index]}:\n    raise {config['exception']}()\n").body
                classes = [node for node in self.modules[module]["tree"].body if isinstance(node, ast.ClassDef) and node.name == config["exception"]]
                if len(classes) != 1 or [ast.unparse(base) for base in classes[0].bases] != [config["exceptionBase"]] or classes[0].decorator_list or classes[0].keywords or len(classes[0].body) != 1 or not isinstance(classes[0].body[0], ast.Pass):
                    raise ValueError("Technical check exception no longer matches its registered contract")
            if [shape(node) for node in function.body] != [shape(node) for node in expected]:
                raise ValueError(f"Technical API body no longer matches its registered contract: {config['symbol']}")

    def extract(self):
        scenarios = []
        entry_symbol = self.profile["entry"]["symbol"]
        for module, data in self.modules.items():
            for node in data["tree"].body:
                if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef)):
                    continue
                # The only supported module assignment is the literal registration table.
                if (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id == self.profile["entry"]["registry"] and isinstance(node.value, ast.List) and not node.value.elts
                        and module == entry_symbol.rsplit(".", 1)[0]):
                    continue
                call = node.value if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) else None
                if call is None or self.resolve(module, call.func, {}) != entry_symbol:
                    self.project_diagnostics.append({"code": "unsupported-module-effect", "evidence": self.evidence(module, node)})
                    continue
                if len(call.args) != 3 or call.keywords or not all(isinstance(arg, ast.Constant) and isinstance(arg.value, str) for arg in call.args[:2]):
                    self.project_diagnostics.append({"code": "dynamic-entry", "evidence": self.evidence(module, node)})
                    continue
                target = self.resolve(module, call.args[2], {})
                if target not in self.functions:
                    self.project_diagnostics.append({"code": "unresolved-entry", "evidence": self.evidence(module, node)})
                    continue
                key = f"{module}:{node.lineno}:{node.col_offset}:{node.end_lineno}:{node.end_col_offset}:{call.args[0].value}:{call.args[1].value}:{target}"
                scenario = {"id": key, "entry": {"method": call.args[0].value, "address": call.args[1].value,
                            "handler": target, "evidence": self.evidence(module, node)},
                            "name": f"{call.args[0].value} {call.args[1].value} → {target}",
                            "steps": [], "calls": [], "diagnostics": [], "unresolvedCandidates": [],
                            "complete": True, "authorizationDecision": "unknown"}
                _, function = self.functions[target]
                try:
                    params = simple_parameters(function)
                except ValueError:
                    scenario["diagnostics"].append({"code": "unsupported-handler-signature", "evidence": self.evidence(module, node)})
                    scenario["complete"] = False
                    scenarios.append(scenario)
                    continue
                bindings = {parameter: ast.parse(f"entry.arg{index}", mode="eval").body for index, parameter in enumerate(params)}
                state = {"requires": [], "authorizations": [], "stack": [], "modified": set()}
                self.walk_function(target, bindings, scenario, state)
                scenarios.append(scenario)
        if self.project_diagnostics:
            for scenario in scenarios:
                scenario["complete"] = False
        usages = {}
        for scenario in scenarios:
            for implementation in {step["implementation"] for step in scenario["steps"]}:
                usages.setdefault(implementation, set()).add(scenario["id"])
        return {"schemaVersion": "business-discovery-experiment/0.1", "analysisMode": "static",
                "projectId": self.registration["projectId"], "budget": {"maxDepth": MAX_DEPTH, "maxSteps": MAX_STEPS},
                "projectRegistrationSha256": self.registration_sha256,
                "technicalProfile": self.profile_fingerprints,
                "inputManifest": self.input_manifest, "projectDiagnostics": self.project_diagnostics,
                "scenarios": scenarios,
                "sharedImplementations": sorted(key for key, entries in usages.items() if len(entries) > 1)}

    def add_step(self, scenario, state, implementation, node, kind, **fields):
        module = self.functions[implementation][0]
        index = len(scenario["steps"])
        resource = fields.get("object")
        covered = [item for item in state["authorizations"] if item["object"] == resource] if resource is not None else []
        step = {"id": f"{scenario['id']}:step:{index}", "index": index, "kind": kind,
                "implementation": implementation, "subject": None, "object": None,
                "requires": list(state["requires"]), "authorization": [item["index"] for item in covered],
                "authorizationBindings": [{"checkpointId": item["id"], "subject": item["subject"], "object": resource,
                                            "coverage": "same-object-call-prefix", "decision": "unknown"} for item in covered],
                "evidence": self.evidence(module, node), "callPath": list(state["stack"]), **fields}
        scenario["steps"].append(step)
        return step

    def unknown(self, scenario, state, implementation, node, code, **fields):
        step = self.add_step(scenario, state, implementation, node, code, **fields)
        scenario["complete"] = False
        scenario["diagnostics"].append({"code": code, "stepId": step["id"], "evidence": step["evidence"]})
        return step

    def walk_function(self, target, bindings, scenario, state):
        module, function = self.functions[target]
        if target in state["stack"] or len(state["stack"]) >= MAX_DEPTH:
            self.unknown(scenario, state, target, function, "call-budget-exceeded")
            return False
        state["stack"].append(target)
        try:
            for node in function.body:
                if len(scenario["steps"]) >= MAX_STEPS:
                    self.unknown(scenario, state, target, node, "step-budget-exceeded")
                    return False
                if isinstance(node, ast.Return):
                    if isinstance(node.value, ast.Call):
                        return self.walk_call(target, node.value, bindings, scenario, state)
                    if node.value is not None and not supported_expression(node.value):
                        self.unknown(scenario, state, target, node, "unsupported-return")
                        return False
                    return True
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                    if not self.walk_call(target, node.value, bindings, scenario, state):
                        return False
                    continue
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Attribute):
                    attribute = node.targets[0]
                    if isinstance(attribute.value, ast.Name) and attribute.value.id in bindings and supported_expression(node.value):
                        resource = symbolic(attribute.value, bindings)
                        self.add_step(scenario, state, target, node, "memory-write", object=resource,
                                      field=attribute.attr, value=symbolic(node.value, bindings))
                        state["modified"].add(resource)
                        continue
                if isinstance(node, ast.If) and not node.orelse and len(node.body) == 1 and isinstance(node.body[0], ast.Raise) and supported_expression(node.test):
                    condition = ast.UnaryOp(op=ast.Not(), operand=node.test)
                    step = self.unknown(scenario, state, target, node, "unclassified-guard", condition=symbolic(condition, bindings))
                    state["requires"].append(step["index"])
                    continue
                if isinstance(node, ast.Pass):
                    continue
                self.unknown(scenario, state, target, node, "unsupported-statement")
                return False
            return True
        finally:
            state["stack"].pop()

    def walk_call(self, caller, call, bindings, scenario, state):
        module = self.functions[caller][0]
        target = self.resolve(module, call.func, bindings, self.function_locals[caller])
        if call.keywords or any(isinstance(item, ast.Starred) for item in call.args):
            self.unknown(scenario, state, caller, call, "unsupported-call-arguments")
            return False
        if target in self.checks:
            config = self.checks[target]
            _, function = self.functions[target]
            if len(call.args) != len(simple_parameters(function)) or not all(supported_expression(arg) for arg in call.args):
                self.unknown(scenario, state, caller, call, "unsupported-check-expression")
                return False
            resource = symbolic(call.args[config["objectArgument"]], bindings)
            # This experiment deliberately does not solve post-mutation value versions.
            if resource in state["modified"]:
                self.unknown(scenario, state, caller, call, "check-after-mutation")
                return False
            fields = {"object": resource, "condition": symbolic(call.args[config["predicateArgument"]], bindings),
                      "technicalApi": target, "technicalEvidence": self.evidence(self.functions[target][0], function)}
            if "subjectArgument" in config:
                fields["subject"] = symbolic(call.args[config["subjectArgument"]], bindings)
            step = self.add_step(scenario, state, caller, call, config["kind"], **fields)
            state["requires"].append(step["index"])
            if config["kind"] == "authorization-check":
                state["authorizations"].append(step)
            return True
        if target in self.functions:
            _, function = self.functions[target]
            try:
                params = simple_parameters(function)
            except ValueError:
                params = None
            if params is None or len(params) != len(call.args) or not all(supported_expression(arg) for arg in call.args):
                self.unknown(scenario, state, caller, call, "unsupported-local-call")
                return False
            scenario["calls"].append({"caller": caller, "callee": target, "evidence": self.evidence(module, call),
                                      "bindings": {param: symbolic(arg, bindings) for param, arg in zip(params, call.args)}})
            callee_bindings = {param: expression(arg, bindings) for param, arg in zip(params, call.args)}
            return self.walk_function(target, callee_bindings, scenario, state)
        self.unknown(scenario, state, caller, call, "unknown-call", call=symbolic(call, bindings))
        return False


def extract(project):
    return Extractor(project).extract()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = extract(args.project)
    output = write_report(args.output, result)
    print(json.dumps({"projectId": result["projectId"], "scenarios": len(result["scenarios"]), "output": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
