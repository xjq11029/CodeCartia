from pathlib import Path

Path(__file__).with_name("EXECUTED_SETUP").write_text("unexpected", encoding="utf-8")
