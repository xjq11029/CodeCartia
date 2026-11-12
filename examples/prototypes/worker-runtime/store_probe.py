"""Trusted subprocess used only to interrupt a real SQLite commit window."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time

from store import Store
from io_policy import safe_output


def main():
    path = safe_output(sys.argv[1])
    operation = json.loads(path.read_text(encoding="utf-8"))
    store = Store(operation["database"])
    def pause_before_commit():
        print("transaction-prepared", flush=True)
        while True:
            time.sleep(0.1)
    state = store.publish(operation["attemptKey"], operation["snapshotPayload"], operation["inputFingerprint"],
                          before_commit=pause_before_commit if operation["point"] == "before-commit" else None)
    print("transaction-committed:" + state, flush=True)
    while True:
        time.sleep(0.1)


if __name__ == "__main__":
    main()
