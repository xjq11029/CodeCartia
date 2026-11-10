from framework import register
from services import open_loan, close_loan


def borrow(principal, volume):
    return open_loan(principal, volume)


def return_volume(principal, volume):
    return close_loan(principal, volume)


register("POST", "/loans/open", borrow)
register("POST", "/loans/close", return_volume)
