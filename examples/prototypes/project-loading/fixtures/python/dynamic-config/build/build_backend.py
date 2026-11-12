from pathlib import Path

Path(__file__).resolve().parents[1].joinpath("EXECUTED_BACKEND").write_text("unexpected", encoding="utf-8")


def get_requires_for_build_wheel(config_settings=None):
    return []
