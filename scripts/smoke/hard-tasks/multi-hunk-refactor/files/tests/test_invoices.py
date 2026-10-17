import unittest
from decimal import Decimal as D

import billing
from billing import audit, invoices, ledger, payments, refunds
from billing.legacy_audit import clear_current, set_current


class InvoiceTest(unittest.TestCase):
    def setUp(self):
        billing.reset()
        set_current("t-2", "clerk")

    def tearDown(self):
        clear_current()

    def test_create_and_pay(self):
        inv = invoices.create_invoice("acme", [("widgets", "30.00"), ("shipping", "5.00")])
        self.assertEqual(invoices.total(inv), D("35.00"))
        payments.apply_payment(inv, "20.00")
        self.assertEqual(invoices.outstanding(inv), D("15.00"))
        self.assertEqual(ledger.balance("acme"), D("15.00"))
        with self.assertRaises(ValueError):
            payments.apply_payment(inv, "16.00")
        self.assertEqual([e["kind"] for e in audit.events() if e["kind"].startswith("notify")], ["notify.send", "notify.send"])

    def test_void(self):
        inv = invoices.create_invoice("acme", [("a", "3.00")])
        invoices.void_invoice(inv, "duplicate")
        self.assertEqual(invoices.outstanding(inv), D(0))
        self.assertEqual(ledger.balance("acme"), D(0))
        with self.assertRaises(ValueError):
            invoices.add_line(inv, "b", "1.00")

    def test_refund(self):
        inv = invoices.create_invoice("acme", [("a", "10.00")])
        pay = payments.apply_payment(inv, "10.00")
        self.assertEqual(refunds.refund(pay, "4.00", "damaged"), D("6.00"))
        with self.assertRaises(ValueError):
            refunds.refund(pay, "7.00", "too much")
        self.assertEqual(ledger.balance("acme"), D("4.00"))
        self.assertTrue(all(e["request_id"] == "t-2" for e in audit.events()))
