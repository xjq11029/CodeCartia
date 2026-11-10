from mathops import encode as emit
import mathops as helpers
from reexport import pass_through as forwarded


def local(value):
    return value


def dispatch(value):
    emit(value)
    helpers.decode(value)
    local(value)
    forwarded(value)
