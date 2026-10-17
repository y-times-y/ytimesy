"""Invoices."""

from decimal import Decimal

from . import audit, ledger, notifications

INVOICES = {}


def reset():
    INVOICES.clear()


def create_invoice(customer, lines):
    """lines: [(description, amount)]"""
    invoice_id = f"INV{len(INVOICES) + 1}"
    INVOICES[invoice_id] = {"customer": customer, "lines": [], "entries": [], "paid": Decimal(0), "void": False}
    audit.record("invoice.create", invoice=invoice_id, customer=customer)
    for description, amount in lines:
        add_line(invoice_id, description, amount)
    notifications.send(customer, "invoice", invoice=invoice_id, total=total(invoice_id))
    return invoice_id


def add_line(invoice_id, description, amount):
    invoice = INVOICES[invoice_id]
    if invoice["void"]:
        raise ValueError(f"{invoice_id} is void")
    invoice["lines"].append((description, Decimal(amount)))
    invoice["entries"].append(ledger.post(invoice["customer"], amount, f"{invoice_id}: {description}"))
    audit.record("invoice.line", invoice=invoice_id, description=description)


def void_invoice(invoice_id, reason):
    invoice = INVOICES[invoice_id]
    if invoice["paid"]:
        raise ValueError(f"{invoice_id} has payments")
    for entry_id in invoice["entries"]:
        ledger.reverse(entry_id, reason)
    invoice["void"] = True
    audit.record("invoice.void", invoice=invoice_id, reason=reason)


def total(invoice_id):
    return sum((amount for _, amount in INVOICES[invoice_id]["lines"]), Decimal(0))


def outstanding(invoice_id):
    invoice = INVOICES[invoice_id]
    return Decimal(0) if invoice["void"] else total(invoice_id) - invoice["paid"]
