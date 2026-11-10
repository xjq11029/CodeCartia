"""Independent oracle: no imports from extract.py and no extraction logic."""

import ast
import hashlib
import json
import symtable
from pathlib import Path


STEP_FIELDS = ("kind", "implementation", "subject", "object", "condition", "field", "value", "call", "requires", "authorization", "callPath")
ROOT = Path(__file__).resolve().parent


def compare(actual, expected, project_root):
    errors = []
    root = Path(project_root).resolve()
    try:
        if actual["schemaVersion"] != "business-discovery-experiment/0.1" or actual["analysisMode"] != "static":
            errors.append("Wrong schema or source mode")
        if actual["projectId"] != expected["projectId"]:
            errors.append("Wrong project identity")
        if actual["projectDiagnostics"]:
            errors.append("Unexpected project diagnostics")
        registration_raw = (root / "project.json").read_bytes()
        registered = json.loads(registration_raw)["sources"]
        profile_raw = (ROOT / "technical-profile.json").read_bytes()
        profile = json.loads(profile_raw)
        if actual["projectRegistrationSha256"] != hashlib.sha256(registration_raw).hexdigest():
            errors.append("Project registration fingerprint mismatch")
        if actual["technicalProfile"] != {"sha256": hashlib.sha256(profile_raw).hexdigest(),
                                          "contractSha256": hashlib.sha256((ROOT / profile["evidenceDocument"]).read_bytes()).hexdigest()}:
            errors.append("Technical profile or contract fingerprint mismatch")
        captured_sources = {name: (root / name).read_bytes() for name in registered}
        fingerprints = {name: hashlib.sha256(raw).hexdigest() for name, raw in captured_sources.items()}
        source_trees = {name: ast.parse(raw.decode("utf-8"), filename=name) for name, raw in captured_sources.items()}
        source_scopes = {name: symtable.symtable(raw.decode("utf-8"), name, "exec") for name, raw in captured_sources.items()}
        if actual["inputManifest"] != [{"path": name, "sha256": fingerprints[name]} for name in registered]:
            errors.append("Input manifest does not exactly match registered sources")

        def evidence(value):
            name = value["file"]
            if name not in fingerprints or value["sha256"] != fingerprints[name]:
                errors.append("Evidence fingerprint or input registration mismatch")
                return
            raw = captured_sources[name].splitlines(keepends=True)
            start, end = value["line"] - 1, value["endLine"] - 1
            if start < 0 or end < start or end >= len(raw):
                errors.append("Invalid evidence line range")
                return
            if value["coordinateUnit"] != "python-utf8-bytes":
                errors.append("Wrong coordinate unit")
            segment = (raw[start][value["startColumn"]:value["endColumn"]] if start == end else
                       raw[start][value["startColumn"]:] + b"".join(raw[start + 1:end]) + raw[end][:value["endColumn"]])
            if segment.decode("utf-8") != value["text"]:
                errors.append("Evidence text does not match original bytes")

        def source_anchor(value, expected_type, owner=None):
            candidates = [node for node in ast.walk(source_trees[value["file"]])
                          if type(node).__name__ == expected_type and
                          (getattr(node, "lineno", None), getattr(node, "col_offset", None), getattr(node, "end_lineno", None), getattr(node, "end_col_offset", None)) ==
                          (value["line"], value["startColumn"], value["endLine"], value["endColumn"])]
            if len(candidates) != 1:
                errors.append(f"Evidence is not an exact {expected_type} AST anchor")
                return [value["file"], value["line"], value["startColumn"], expected_type], None
            node = candidates[0]
            if owner:
                module, name = owner.rsplit(".", 1)
                functions = [item for item in source_trees[value["file"]].body if isinstance(item, ast.FunctionDef) and item.name == name]
                if value["file"] != f"{module}.py" or len(functions) != 1 or not any(item is node for item in ast.walk(functions[0])):
                    errors.append("Evidence belongs to another implementation")
            return [value["file"], value["line"], value["startColumn"], expected_type], node

        def source_callee(value, node, owner=None):
            if node is None or not isinstance(node, ast.Call):
                return None
            imports = {}
            for item in source_trees[value["file"]].body:
                if isinstance(item, ast.ImportFrom):
                    imports.update({alias.asname or alias.name: f"{item.module}.{alias.name}" for alias in item.names})
                elif isinstance(item, ast.Import):
                    imports.update({alias.asname or alias.name: alias.name for alias in item.names})
            local_names = set()
            if owner:
                functions = [item for item in source_trees[value["file"]].body if isinstance(item, ast.FunctionDef) and item.name == owner.rsplit(".", 1)[1]]
                if functions:
                    scopes = [scope for scope in source_scopes[value["file"]].get_children()
                              if scope.get_name() == functions[0].name and scope.get_lineno() == functions[0].lineno]
                    if scopes:
                        local_names = {symbol.get_name() for symbol in scopes[0].get_symbols() if symbol.is_local() or symbol.is_imported()}
            def qualify(target):
                if isinstance(target, ast.Name):
                    return None if target.id in local_names else imports.get(target.id, f"{Path(value['file']).stem}.{target.id}")
                if isinstance(target, ast.Attribute):
                    prefix = qualify(target.value)
                    return f"{prefix}.{target.attr}" if prefix else None
                return None
            return qualify(node.func)

        actual_rows = []
        seen = set()
        seen_ids = set()
        seen_step_ids = set()
        for scenario in actual["scenarios"]:
            entry = scenario["entry"]
            key = (entry["method"], entry["address"], entry["handler"])
            registration = entry["evidence"]
            registration_key = (*key, registration["file"], registration["line"], registration["startColumn"], registration["endLine"], registration["endColumn"])
            if registration_key in seen:
                errors.append("Duplicate scenario")
            seen.add(registration_key)
            evidence(entry["evidence"])
            entry_anchor, entry_node = source_anchor(entry["evidence"], "Call")
            if source_callee(entry["evidence"], entry_node) != profile["entry"]["symbol"]:
                errors.append("Entry evidence does not call the registered entry API")
            location = entry["evidence"]
            expected_id = f"{Path(location['file']).stem}:{location['line']}:{location['startColumn']}:{location['endLine']}:{location['endColumn']}:{entry['method']}:{entry['address']}:{entry['handler']}"
            if scenario["id"] != expected_id or scenario["id"] in seen_ids:
                errors.append("Scenario identity is duplicated or does not match its full registration anchor")
            seen_ids.add(scenario["id"])
            if scenario["authorizationDecision"] != "unknown":
                errors.append("Experiment must not invent a concrete authorization decision")
            if scenario["unresolvedCandidates"]:
                errors.append("Unexpected candidate")
            if scenario["name"] != f"{entry['method']} {entry['address']} → {entry['handler']}":
                errors.append("Scenario label is not the source-anchor template")
            call_rows = []
            edges = {(call["caller"], call["callee"]) for call in scenario["calls"]}
            for call in scenario["calls"]:
                evidence(call["evidence"])
                anchor, call_node = source_anchor(call["evidence"], "Call", call["caller"])
                if source_callee(call["evidence"], call_node, call["caller"]) != call["callee"]:
                    errors.append("Call evidence points to a different target")
                call_rows.append({"caller": call["caller"], "callee": call["callee"], "bindings": call["bindings"], "anchor": anchor})
            step_rows = []
            for index, step in enumerate(scenario["steps"]):
                evidence(step["evidence"])
                node_type = {"authorization-check": "Call", "business-check": "Call", "memory-write": "Assign", "unknown-call": "Call", "unclassified-guard": "If"}.get(step["kind"])
                if node_type is None:
                    errors.append("Unexpected step kind outside this fixture oracle")
                    node_type = "unknown"
                anchor, step_node = source_anchor(step["evidence"], node_type, step["implementation"])
                if step["kind"] in ("authorization-check", "business-check"):
                    if "technicalEvidence" not in step or "technicalApi" not in step:
                        errors.append("A classified check is missing mandatory technical API evidence")
                        continue
                    evidence(step["technicalEvidence"])
                    source_anchor(step["technicalEvidence"], "FunctionDef")
                    definitions = [item for item in profile["checks"] if item["symbol"] == step["technicalApi"] and item["kind"] == step["kind"]]
                    if len(definitions) != 1:
                        errors.append("Technical API classification is not registered")
                    else:
                        module, name = step["technicalApi"].rsplit(".", 1)
                        if step["technicalEvidence"]["file"] != f"{module}.py" or not step["technicalEvidence"]["text"].startswith(f"def {name}("):
                            errors.append("Technical API evidence points at another implementation")
                    if source_callee(step["evidence"], step_node, step["implementation"]) != step["technicalApi"]:
                        errors.append("Check evidence does not call the claimed technical API in its lexical scope")
                if step["kind"] == "memory-write" and isinstance(step_node, ast.Assign):
                    if len(step_node.targets) != 1 or not isinstance(step_node.targets[0], ast.Attribute) or step_node.targets[0].attr != step["field"]:
                        errors.append("Memory-write evidence targets a different field")
                if step["id"] != f"{scenario['id']}:step:{index}" or step["id"] in seen_step_ids:
                    errors.append("Step identity is duplicated or outside its scenario")
                seen_step_ids.add(step["id"])
                if step["index"] != index or not step["callPath"] or step["callPath"][0] != entry["handler"] or step["callPath"][-1] != step["implementation"]:
                    errors.append("Invalid step order or call context")
                if any(pair not in edges for pair in zip(step["callPath"], step["callPath"][1:])):
                    errors.append("Call path contains an unsupported intermediate edge")
                if any(not isinstance(item, int) or item < 0 or item >= index for item in step["requires"] + step["authorization"]):
                    errors.append("Invalid prefix reference")
                    continue
                bindings = []
                for checkpoint_index in step["authorization"]:
                    checkpoint = scenario["steps"][checkpoint_index]
                    if checkpoint["kind"] != "authorization-check" or checkpoint["object"] != step["object"] or checkpoint_index not in step["requires"]:
                        errors.append("Authorization binding crosses object, order or check category")
                    bindings.append({"checkpointId": checkpoint["id"], "subject": checkpoint["subject"], "object": step["object"],
                                     "coverage": "same-object-call-prefix", "decision": "unknown"})
                if bindings != step["authorizationBindings"]:
                    errors.append("Authorization binding fields or evidence reference mismatch")
                step_rows.append({**{key: value for key, value in step.items() if key in STEP_FIELDS}, "anchor": anchor})
            actual_rows.append({"entry": list(key), "entryAnchor": entry_anchor, "complete": scenario["complete"],
                                "calls": call_rows,
                                "diagnostics": [item["code"] for item in scenario["diagnostics"]],
                                "steps": step_rows})
        by_entry = lambda item: (*item["entry"], *item["entryAnchor"])
        if sorted(actual_rows, key=by_entry) != sorted(expected["scenarios"], key=by_entry):
            errors.append("Scenario/step/condition/call/binding projection differs from independent expected data")
        if actual["sharedImplementations"] != expected["sharedImplementations"]:
            errors.append("Shared implementations differ")
        if not expected["scenarios"] or not actual["scenarios"]:
            errors.append("Empty scenario denominator cannot pass")
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        errors.append(f"Malformed actual result: {exc}")
    return errors
