import unittest
from decimal import Decimal as D

import billing
from billing import api, audit, ledger


class ApiTest(unittest.TestCase):
    def setUp(self):
        billing.reset()

    def test_invoice_and_pay(self):
        inv = api.handle({"id": "r1", "user": "ana", "action": "invoice", "customer": "acme", "lines": [("x", "12.00")]})
        api.handle({"id": "r2", "user": "bo", "action": "pay", "invoice": inv, "amount": "12.00"})
        self.assertEqual(ledger.balance("acme"), D(0))
        self.assertEqual({e["request_id"] for e in audit.events("ledger.post")}, {"r1", "r2"})
        self.assertEqual(audit.events("payment.apply")[0]["actor"], "bo")

    def test_subscribe_and_cancel(self):
        sub = api.handle({"id": "r3", "user": "cy", "action": "subscribe", "customer": "acme", "plan": "basic"})
        api.handle({"id": "r4", "user": "cy", "action": "cancel", "subscription": sub})
        self.assertEqual(audit.events("subscription.cancel")[0]["request_id"], "r4")

    def test_batch(self):
        results = api.handle({"id": "b1", "user": "ops", "action": "batch", "requests": [
            {"id": "b1.1", "action": "invoice", "customer": "acme", "lines": [("a", "1.00")]},
            {"id": "b1.2", "action": "invoice", "customer": "zen", "lines": [("b", "2.00")]},
        ]})
        self.assertEqual(results, ["INV1", "INV2"])
        self.assertEqual([e["request_id"] for e in audit.events("invoice.create")], ["b1.1", "b1.2"])

    def test_unknown_action(self):
        with self.assertRaises(ValueError):
            api.handle({"id": "r5", "user": "x", "action": "nope"})
