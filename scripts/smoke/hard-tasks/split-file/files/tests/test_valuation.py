import unittest
from decimal import Decimal as D

from inventory.core import StockError, average_cost, fifo_cost, issue_cost, load_inventory, margin, reorder_cost, stock_value, valuation_by_location
from tests.fixtures import ITEMS_JSON, LOTS_CSV


class ValuationTest(unittest.TestCase):
    def setUp(self):
        self.inv = load_inventory(ITEMS_JSON, LOTS_CSV)

    def test_fifo_cost(self):
        self.assertEqual(fifo_cost(self.inv, "BOLT", 70), D("7.10"))
        self.assertEqual(self.inv.on_hand("BOLT"), D(150))
        with self.assertRaises(StockError):
            fifo_cost(self.inv, "OIL", 1)

    def test_values(self):
        self.assertEqual(stock_value(self.inv, "BOLT"), D("16.30"))
        self.assertEqual(stock_value(self.inv), D("30.80"))
        self.assertEqual(average_cost(self.inv, "BOLT"), D("0.11"))
        self.assertEqual(average_cost(self.inv, "FLOUR"), D("1.29"))

    def test_by_location(self):
        self.assertEqual(valuation_by_location(self.inv), {"A1": D("18.30"), "B2": D("12.50")})

    def test_margin(self):
        self.assertEqual(margin(self.inv, "BOLT", 70, "0.25"), (D("10.40"), D("59.4")))

    def test_issue_cost(self):
        self.assertEqual(issue_cost(self.inv.issue("FLOUR", 3)), D("3.75"))

    def test_reorder_cost(self):
        self.inv.issue("FLOUR", 1)
        total, lines = reorder_cost(self.inv, {"FLOUR": 1.1, "EGG": "0.30"})
        self.assertEqual(lines, [("EGG", D(24), D("7.20")), ("FLOUR", D("7.5"), D("8.25"))])
        self.assertEqual(total, D("15.45"))
