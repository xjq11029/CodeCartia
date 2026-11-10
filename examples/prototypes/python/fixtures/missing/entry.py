from absent import encode as unknown_alias
import importlib


def dispatch(module_name, receiver):
    unknown_alias("missing")
    importlib.import_module(module_name)
    receiver.encode("typed-boundary")
