from mathops import encode as emit
import mathops as helpers


def shadow(emit):
    return emit("shadow")


def rebound(value):
    emit(value)
    emit = value
    return emit("rebound")


def patched(value):
    helpers.encode = value
    return helpers.encode("patch")


def dynamic(factory):
    target = factory()
    return target("dynamic")


def first():
    def same(value):
        return value
    return same("one")


def second():
    def same(value):
        return value
    return same("two")


def factory(function):
    return function


@factory
def wrapped(value):
    return value


def decoration_boundary():
    return wrapped("decorated")
