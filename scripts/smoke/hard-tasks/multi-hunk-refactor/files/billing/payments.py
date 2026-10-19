"""Payments against invoices."""

from decimal import Decimal

from . import audit, invoices, ledger, notifications

PAYMENTS = {}


def reset():
    PAYMENTS.clear()


def charge(customer, amount):
    """Charge a card; returns a payment id (always succeeds here)."""
    payment_id = f"P{len(PAYMENTS) + 1}"
    PAYMENTS[payment_id] = {"customer": customer, "amount": Decimal(amount), "refunded": Decimal(0)}
    audit.record("payment.charge", payment=payment_id, amount=str(amount))
    return payment_id


def apply_payment(invoice_id, amount):
    invoice = invoices.INVOICES[invoice_id]
    amount = Decimal(amount)
    if amount > invoices.outstanding(invoice_id):
        raise ValueError("payment exceeds the outstanding amount")
    payment_id = charge(invoice["customer"], amount)
    PAYMENTS[payment_id]["invoice"] = invoice_id
    invoice["paid"] += amount
    ledger.post(invoice["customer"], -amount, f"payment {payment_id}")
    audit.record("payment.apply", payment=payment_id, invoice=invoice_id)
    notifications.send(invoice["customer"], "receipt", amount=amount, invoice=invoice_id)
    return payment_id
