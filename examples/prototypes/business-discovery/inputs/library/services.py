from framework import enforce, validate
from shared import record


def open_loan(actor, item):
    enforce(actor, item, actor.role == "member" and actor.tenant == item.tenant)
    validate(item, item.available)
    item.state = "borrowed"
    record(item)
    return item


def close_loan(actor, item):
    enforce(actor, item, actor.role == "staff" and actor.tenant == item.tenant)
    validate(item, item.state == "borrowed")
    item.state = "available"
    record(item)
    return item
