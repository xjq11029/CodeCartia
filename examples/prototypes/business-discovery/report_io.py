"""Shared report-only writer; refuse existing links before any write."""

import json
import os
import stat
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def checked_report_path(output):
    root = ROOT / "reports"
    path = Path(os.path.abspath(output))
    if not path.is_relative_to(root) or path == root or path.suffix != ".json":
        raise ValueError("Experiment output must be a JSON file inside reports; inputs, expected data and code are read-only")
    cursor = path
    while cursor != ROOT.parent:
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise ValueError("REPORT_LINK_REFUSED")
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            info = None
        if info and getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            raise ValueError("REPORT_LINK_REFUSED")
        cursor = cursor.parent
    if not path.resolve().is_relative_to(root):
        raise ValueError("REPORT_LINK_REFUSED")
    return path


def write_report(output, value):
    path = checked_report_path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    checked_report_path(path)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
