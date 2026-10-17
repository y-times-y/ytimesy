"""Subscriptions: each period is invoiced up front."""

from decimal import Decimal

from . import audit, invoices, notifications, payments, refunds

PLANS = {"basic": Decimal("10.00"), "pro": Decimal("25.00")}
SUBSCRIPTIONS = {}


def reset():
    SUBSCRIPTIONS.clear()


def start(customer, plan):
    sub_id = f"S{len(SUBSCRIPTIONS) + 1}"
    SUBSCRIPTIONS[sub_id] = {"customer": customer, "plan": plan, "invoices": [], "active": True}
    audit.record("subscription.start", subscription=sub_id, plan=plan)
    renew(sub_id)
    return sub_id


def renew(sub_id):
    sub = SUBSCRIPTIONS[sub_id]
    if not sub["active"]:
        raise ValueError(f"{sub_id} is cancelled")
    invoice_id = invoices.create_invoice(sub["customer"], [(f"{sub['plan']} plan", PLANS[sub["plan"]])])
    sub["invoices"].append(invoice_id)
    audit.record("subscription.renew", subscription=sub_id, invoice=invoice_id)
    return invoice_id


def cancel(sub_id, refund_unused=False, used_fraction=Decimal(0)):
    """Cancel; optionally refund the unused part of the latest paid period."""
    sub = SUBSCRIPTIONS[sub_id]
    sub["active"] = False
    latest = sub["invoices"][-1]
    if invoices.INVOICES[latest]["paid"] == 0:
        invoices.void_invoice(latest, "cancelled before payment")
    elif refund_unused:
        for payment_id, payment in payments.PAYMENTS.items():
            if payment.get("invoice") == latest:
                unused = (payment["amount"] * (1 - Decimal(used_fraction))).quantize(Decimal("0.01"))
                refunds.refund(payment_id, unused, "unused period")
    audit.record("subscription.cancel", subscription=sub_id)
    notifications.send(sub["customer"], "cancelled", plan=sub["plan"])
