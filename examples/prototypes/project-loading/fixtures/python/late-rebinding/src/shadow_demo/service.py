from .core import transform


def local_shadow(value):
    result = transform(value)
    transform = None
    return result


def imported_local(value):
    from .core import transform as transform_local
    return transform_local(value)
