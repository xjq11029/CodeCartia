from pathlib import Path

Path(__file__).with_name("EXECUTED_MODULE").write_text("unexpected", encoding="utf-8")


def keep_declaration(value):
    return value
