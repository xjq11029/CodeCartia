"""Run the trusted repository extractor; never import the target project."""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
entry = Path(__file__).resolve().parent.parent / "python" / "project_extract.py"
spec = importlib.util.spec_from_file_location("codecartia_project_extract", entry)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

request = json.load(sys.stdin)
report = module.analyze_project(request)
sys.stdout.write(json.dumps(report, ensure_ascii=False))
