"""Refunds of payments."""

from decimal import Decimal

from . import audit, ledger, notifications, payments


def refund(payment_id, amount, reason):
    payment = payments.PAYMENTS[payment_id]
    amount = Decimal(amount)
    if amount > payment["amount"] - payment["refunded"]:
        raise ValueError("refund exceeds the payment")
    payment["refunded"] += amount
    ledger.post(payment["customer"], amount, f"refund of {payment_id}")
    audit.record("refund", payment=payment_id, amount=str(amount), reason=reason)
    notifications.send(payment["customer"], "refund", amount=amount)
    return payment["amount"] - payment["refunded"]
