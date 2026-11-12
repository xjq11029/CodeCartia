from . import core


def marker(item):
    return item


def comprehension_binding(value):
    [(marker := None) for _ in (0,)]
    return marker(value)


def shared(item):
    return item


def rewrite_global():
    global shared

    def shared(item):
        return None


def use_shared(value):
    return shared(value)


def outer(value):
    def local_target(item):
        return item

    def rewrite_nonlocal():
        nonlocal local_target
        from .unmodified import alternative as local_target

    return local_target(value)


core.__dict__["dispatch"] = None


def use_dictionary(value):
    return core.dispatch(value)


def stable(item):
    return item


def use_stable(value):
    return stable(value)
