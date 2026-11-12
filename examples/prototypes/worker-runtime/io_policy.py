"""All experiment writes stay under this directory's reports, without links."""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat

ROOT = Path(__file__).resolve().parent
REPORTS = ROOT / "reports"


def safe_output(path: str | Path) -> Path:
    candidate = Path(os.path.abspath(path))
    if not candidate.is_relative_to(REPORTS) or candidate == REPORTS:
        raise ValueError("output must be a file inside worker-runtime/reports")
    cursor = candidate
    while cursor != ROOT:
        if cursor.exists() or cursor.is_symlink():
            info = cursor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError("reparse point in output path")
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                raise ValueError("hard-linked output file")
        cursor = cursor.parent
    if not candidate.resolve().is_relative_to(REPORTS.resolve()):
        raise ValueError("resolved output escaped report root")
    candidate.parent.mkdir(parents=True, exist_ok=True)
    return candidate


def write_json(path: str | Path, value: object) -> None:
    safe_output(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
