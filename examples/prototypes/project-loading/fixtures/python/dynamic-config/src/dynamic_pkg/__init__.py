from pathlib import Path

Path(__file__).with_name("EXECUTED_MODULE").write_text("unexpected", encoding="utf-8")
__version__ = "0.0.0"
