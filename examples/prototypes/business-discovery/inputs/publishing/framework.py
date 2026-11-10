REGISTRY = []


class AccessRejected(PermissionError):
    pass


class InvalidOperation(ValueError):
    pass


def register(method, address, handler):
    REGISTRY.append((method, address, handler))


def enforce(subject, resource, predicate):
    if not predicate:
        raise AccessRejected()


def validate(resource, predicate):
    if not predicate:
        raise InvalidOperation()
