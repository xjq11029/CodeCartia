"""Call the trusted Python API with runtime-data and target-write guards."""
import sys

sys.dont_write_bytecode = True

import importlib.util
import json
import os
from pathlib import Path

from policy import POLICY_VERSION, blocked_relative, readable_static, relative_to_root


def main():
    request = json.loads(sys.argv[1])
    root = Path(request["projectRoot"]).absolute()
    implementation = Path(__file__).resolve().parent.parent / "python/project_extract.py"
    spec = importlib.util.spec_from_file_location("trusted_external_python_loader", implementation)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    # Initialize codecs before collecting target-only access observations.
    b"".decode("utf-8-sig")
    reads, excluded, rejected_reads, rejected_writes, executions = set(), set(), [], [], []
    original_scandir = os.scandir

    class StaticScandir:
        def __init__(self, directory):
            self.inner = original_scandir(directory)
            self.iterator = self.filtered()

        def filtered(self):
            for entry in self.inner:
                relative = relative_to_root(entry.path, root)
                if relative is not None and blocked_relative(relative):
                    excluded.add(relative.as_posix())
                else:
                    yield entry

        def __iter__(self):
            return self

        def __next__(self):
            return next(self.iterator)

        def __enter__(self):
            return self

        def __exit__(self, *arguments):
            self.close()

        def close(self):
            self.inner.close()

    def guarded_scandir(directory):
        relative = relative_to_root(directory, root)
        if relative is None:
            return original_scandir(directory)
        if blocked_relative(relative):
            rejected_reads.append(relative.as_posix())
            raise PermissionError("Runtime directory is outside this observation")
        return StaticScandir(directory)

    def audit(event, arguments):
        if event == "open":
            relative = relative_to_root(arguments[0], root)
            if relative is None:
                return
            mode, flags = arguments[1], arguments[2]
            write_mode = (isinstance(mode, str) and any(char in mode for char in "wax+")) or (isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)))
            if write_mode:
                rejected_writes.append(relative.as_posix())
                raise PermissionError("External project writes are forbidden")
            if not readable_static(relative):
                rejected_reads.append(relative.as_posix())
                raise PermissionError("Only authorized static inputs may be read")
            reads.add(relative.as_posix())
        elif event in {"os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.truncate", "os.link", "os.symlink"}:
            for argument in arguments[:2]:
                relative = relative_to_root(argument, root)
                if relative is not None:
                    rejected_writes.append(relative.as_posix())
                    raise PermissionError("External project mutations are forbidden")
        elif event == "exec":
            relative = relative_to_root(getattr(arguments[0], "co_filename", None), root)
            if relative is not None:
                executions.append(relative.as_posix())
                raise PermissionError("Target module execution is forbidden")

    os.scandir = guarded_scandir
    sys.addaudithook(audit)
    report = module.analyze_project(request)
    result = {"raw": report, "accessAudit": {"policyVersion": POLICY_VERSION, "projectRoot": root.as_posix(), "staticReadAttempts": sorted(reads), "excludedDiscoveryPaths": sorted(excluded), "rejectedReadAttempts": rejected_reads, "rejectedWriteAttempts": rejected_writes, "rejectedExecutionAttempts": executions}}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
