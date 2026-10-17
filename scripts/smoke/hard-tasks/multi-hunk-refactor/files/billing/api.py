"""Request entry point."""

from . import audit, invoices, payments, refunds, subscriptions
from .legacy_audit import clear_current, set_current


def handle(request):
    set_current(request["id"], request["user"])
    try:
        return _dispatch(request)
    finally:
        clear_current()


def _dispatch(request):
    action = request["action"]
    if action == "invoice":
        return invoices.create_invoice(request["customer"], request["lines"])
    if action == "void":
        return invoices.void_invoice(request["invoice"], request["reason"])
    if action == "pay":
        return payments.apply_payment(request["invoice"], request["amount"])
    if action == "refund":
        return refunds.refund(request["payment"], request["amount"], request["reason"])
    if action == "subscribe":
        return subscriptions.start(request["customer"], request["plan"])
    if action == "renew":
        return subscriptions.renew(request["subscription"])
    if action == "cancel":
        return subscriptions.cancel(request["subscription"], request.get("refund_unused", False), request.get("used_fraction", 0))
    if action == "batch":
        results = [handle(dict(sub, user=request["user"])) for sub in request["requests"]]
        audit.record("batch.done", count=len(results))
        return results
    raise ValueError(f"unknown action {action!r}")
