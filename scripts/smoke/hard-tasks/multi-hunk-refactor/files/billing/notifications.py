"""Customer notifications (recorded, not actually sent)."""

from . import audit

TEMPLATES = {
    "invoice": "Invoice {invoice} for {total} is ready.",
    "receipt": "We received {amount} for invoice {invoice}.",
    "refund": "We refunded {amount}.",
    "cancelled": "Your {plan} subscription is cancelled.",
}


def send(customer, template, **data):
    message = TEMPLATES[template].format(**data)
    audit.record("notify.send", customer=customer, template=template)
    return message
