"""Static-input policy for this explicitly authorized external observation."""
import hashlib
import json
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent
REPORTS = BASE / "reports"
POLICY_VERSION = "external-static-inputs-v0.1"
EXCLUDED_DIRECTORIES = {
    ".git", ".hg", ".svn", "models", "dll", "public", "logs", "records",
    "recordings", "__pycache__", ".venv", "venv", ".tox",
}
STATIC_SUFFIXES = {".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts", ".py", ".json", ".toml", ".cfg"}
RUNTIME_SUFFIXES = {".dll", ".so", ".dylib", ".onnx", ".pt", ".pth", ".h5", ".hdf5", ".tflite", ".bin", ".db", ".sqlite", ".sqlite3", ".npy", ".npz", ".pkl", ".pickle", ".mp4", ".avi", ".m3u8", ".jpg", ".jpeg", ".png", ".wav", ".log"}


def digest(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def no_links(path):
    current = Path(path).absolute()
    while True:
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("Linked input/output refused: " + str(current))
        if current == current.parent:
            return
        current = current.parent


def relative_to_root(path, root):
    if not isinstance(path, (str, bytes, os.PathLike)):
        return None
    candidate = Path(os.fsdecode(path)).absolute()
    try:
        return candidate.relative_to(root)
    except ValueError:
        return None


def blocked_relative(relative):
    parts = [part.lower() for part in relative.parts]
    return any(part in EXCLUDED_DIRECTORIES for part in parts) or relative.name.lower().startswith(".env") or relative.suffix.lower() in RUNTIME_SUFFIXES


def readable_static(relative):
    return not blocked_relative(relative) and (relative.suffix.lower() in STATIC_SUFFIXES or relative.name.lower() in {"readme.md", "agents.md", "requirements.txt"} or relative.as_posix() == "bin/www")


def snapshot(root):
    """Hash allowed owned source/config files, never dependency trees or runtime data."""
    no_links(root)
    records, exclusions, unreadable = {}, [], []
    stack = [root]
    while stack:
        directory = stack.pop()
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(entry.path)
            relative = path.relative_to(root)
            if blocked_relative(relative) or entry.name == "node_modules":
                exclusions.append(relative.as_posix())
                continue
            if entry.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
                exclusions.append(relative.as_posix())
                continue
            if entry.is_dir(follow_symlinks=False):
                stack.append(path)
            elif entry.is_file(follow_symlinks=False) and readable_static(relative):
                try:
                    before = path.stat()
                    if before.st_size > 8 * 1024 * 1024:
                        unreadable.append({"path": relative.as_posix(), "reason": "snapshot-file-byte-limit", "sizeBytes": before.st_size})
                        continue
                    data = path.read_bytes()
                    after = path.stat()
                    records[relative.as_posix()] = {"path": relative.as_posix(), "sha256": digest(data), "sizeBytes": len(data), "mtimeNs": str(after.st_mtime_ns), "changedDuringRead": (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino)}
                except OSError as error:
                    unreadable.append({"path": relative.as_posix(), "reason": type(error).__name__})
    return {"scope": "Allowed owned static source/config/README/requirements; node_modules and runtime data excluded.", "files": [records[key] for key in sorted(records)], "excludedPaths": sorted(exclusions), "unreadable": unreadable}


def snapshot_changes(before, after):
    first = {item["path"]: item for item in before["files"]}
    last = {item["path"]: item for item in after["files"]}
    changes = []
    for name in sorted(first.keys() | last.keys()):
        old, new = first.get(name), last.get(name)
        if old is None or new is None:
            changes.append({"path": name, "change": "added" if old is None else "removed"})
        elif old["sha256"] != new["sha256"]:
            changes.append({"path": name, "change": "content", "beforeSha256": old["sha256"], "afterSha256": new["sha256"]})
        elif old["mtimeNs"] != new["mtimeNs"]:
            changes.append({"path": name, "change": "mtime-only", "beforeMtimeNs": old["mtimeNs"], "afterMtimeNs": new["mtimeNs"]})
        if (old and old["changedDuringRead"]) or (new and new["changedDuringRead"]):
            changes.append({"path": name, "change": "changed-during-snapshot-read"})
    return changes


def write_json(name, value):
    relative = Path(name)
    if relative.anchor or ".." in relative.parts or relative.suffix != ".json":
        raise ValueError("Output must be a relative JSON report")
    target = REPORTS / relative
    no_links(target)
    if target.exists() and (not target.is_file() or target.stat().st_nlink > 1):
        raise ValueError("Nonregular/hardlinked report refused")
    target.parent.mkdir(parents=True, exist_ok=True)
    no_links(target)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target
