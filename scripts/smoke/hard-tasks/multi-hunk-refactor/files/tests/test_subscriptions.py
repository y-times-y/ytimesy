import unittest
from decimal import Decimal as D

import billing
from billing import audit, invoices, ledger, payments, subscriptions
from billing.legacy_audit import clear_current, set_current


class SubscriptionTest(unittest.TestCase):
    def setUp(self):
        billing.reset()
        set_current("t-3", "system")

    def tearDown(self):
        clear_current()

    def test_start_and_renew(self):
        sub = subscriptions.start("acme", "pro")
        subscriptions.renew(sub)
        self.assertEqual(len(subscriptions.SUBSCRIPTIONS[sub]["invoices"]), 2)
        self.assertEqual(ledger.balance("acme"), D("50.00"))

    def test_cancel_unpaid_voids(self):
        sub = subscriptions.start("acme", "basic")
        subscriptions.cancel(sub)
        self.assertEqual(ledger.balance("acme"), D(0))
        with self.assertRaises(ValueError):
            subscriptions.renew(sub)

    def test_cancel_paid_refunds(self):
        sub = subscriptions.start("acme", "pro")
        inv = subscriptions.SUBSCRIPTIONS[sub]["invoices"][-1]
        payments.apply_payment(inv, "25.00")
        subscriptions.cancel(sub, refund_unused=True, used_fraction=D("0.4"))
        self.assertEqual(audit.events("refund")[0]["amount"], "15.00")
        self.assertEqual(ledger.balance("acme"), D("15.00"))
        self.assertEqual(invoices.outstanding(inv), D(0))
