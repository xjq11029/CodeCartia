from pathlib import Path

# Executing this fixture would create a marker and raise an exception.
Path(__file__).with_suffix(".executed").write_text("fixture was executed")
raise RuntimeError("This fixture must only be parsed")


def pure(value):
    return value


def unreachable():
    return pure("syntax-only")
