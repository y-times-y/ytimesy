import unittest
from decimal import Decimal as D

import billing
from billing import audit, ledger
from billing.legacy_audit import clear_current, set_current


class LedgerTest(unittest.TestCase):
    def setUp(self):
        billing.reset()
        set_current("t-1", "tester")

    def tearDown(self):
        clear_current()

    def test_post_and_balance(self):
        ledger.post("acme", "10.00", "a")
        ledger.post("acme", "-2.50", "b")
        self.assertEqual(ledger.balance("acme"), D("7.50"))
        self.assertEqual(audit.events("ledger.post")[0]["request_id"], "t-1")

    def test_reverse(self):
        entry = ledger.post("acme", "4.00", "a")
        ledger.reverse(entry, "oops")
        self.assertEqual(ledger.balance("acme"), D(0))
        self.assertEqual(audit.events("ledger.reverse")[0]["actor"], "tester")
        with self.assertRaises(ValueError):
            ledger.reverse(entry, "again")
