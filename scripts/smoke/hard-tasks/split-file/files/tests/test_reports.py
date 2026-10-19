import unittest
from datetime import date
from decimal import Decimal as D

from inventory.core import aging_report, low_stock, low_stock_report, render_table, stock_report, utilisation_report, valuation_report
from inventory.sync import apply_stock_take
from tests.fixtures import ITEMS_JSON, LOTS_CSV
from inventory import load_inventory


class ReportsTest(unittest.TestCase):
    def setUp(self):
        self.inv = load_inventory(ITEMS_JSON, LOTS_CSV)

    def test_render_table(self):
        self.assertEqual(render_table(["a", "num"], [("x", 1), ("long", 22)]), "a     num\n----  ---\nx       1\nlong   22")

    def test_low_stock(self):
        self.assertEqual(low_stock(self.inv), [("EGG", D(24), D(24)), ("FLOUR", D("3.5"), D(5))])
        self.inv.receive(type(self.inv.lots[0])("EGG", "A1", D(1), D(1), date(2026, 4, 1)))
        self.assertEqual(len(low_stock(self.inv)), 1)
        self.assertIn("FLOUR", low_stock_report(self.inv))

    def test_stock_report(self):
        self.assertEqual(stock_report(self.inv, "B2").splitlines()[:3], ["Stock at Back room", "sku    name       qty  unit", "-----  ---------  ---  ----"])

    def test_valuation_report(self):
        self.assertEqual(valuation_report(self.inv).splitlines()[-1], "TOTAL  178.0            30.80")

    def test_aging(self):
        self.assertEqual(aging_report(self.inv, date(2026, 4, 1)).splitlines()[2:], ["0-30         7.50", "31-90       19.30", "90+          4.00"])

    def test_utilisation(self):
        self.assertIn("A1    Aisle 1     125  13%", utilisation_report(self.inv))

    def test_stock_take(self):
        change, report = apply_stock_take(self.inv, "sku,location,delta,reason,when\nBOLT,A1,-60,lost,2026-04-01\nEGG,A1,12,found,2026-04-01\n")
        self.assertEqual(change, D("-6.00"))
        self.assertIn("2026-04-01  BOLT  A1          -60  lost", report)
