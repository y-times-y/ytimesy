import unittest
from datetime import date
from decimal import Decimal as D

from inventory.core import Inventory, Item, Location, Lot, StockError, convert, load_inventory, register_unit
from tests.fixtures import ITEMS_JSON, LOTS_CSV


class ModelsTest(unittest.TestCase):
    def setUp(self):
        self.inv = load_inventory(ITEMS_JSON, LOTS_CSV)

    def test_convert(self):
        self.assertEqual(convert(2, "kg", "g"), D(2000))
        self.assertEqual(convert(3, "dozen", "each"), D(36))
        with self.assertRaises(ValueError):
            convert(1, "kg", "l")

    def test_register_unit(self):
        register_unit("Case", "each", 24)
        self.assertEqual(convert(2, "case", "each"), D(48))
        with self.assertRaises(ValueError):
            register_unit("case", "each", 6)

    def test_item_validation(self):
        with self.assertRaises(ValueError):
            Item("bolt", "lower")
        with self.assertRaises(ValueError):
            Item("X", "x", unit="parsec")

    def test_on_hand(self):
        self.assertEqual(self.inv.on_hand("BOLT"), D(150))
        self.assertEqual(self.inv.on_hand("BOLT", "A1"), D(100))
        self.assertEqual(self.inv.on_hand("FLOUR"), D("3.5"))
        self.assertEqual(self.inv.on_hand("EGG"), D(24))

    def test_issue_fifo(self):
        taken = self.inv.issue("BOLT", 70)
        self.assertEqual([(lot.received.isoformat(), part) for lot, part in taken], [("2026-01-05", D(60)), ("2026-02-10", D(10))])
        self.assertEqual(self.inv.on_hand("BOLT"), D(80))
        with self.assertRaises(StockError):
            self.inv.issue("BOLT", 81)

    def test_transfer(self):
        self.assertEqual(self.inv.transfer("BOLT", 55, "A1", "B2"), D(55))
        self.assertEqual(self.inv.on_hand("BOLT", "A1"), D(45))
        self.assertEqual(self.inv.on_hand("BOLT", "B2"), D(105))

    def test_capacity(self):
        inv = Inventory()
        inv.add_item(Item("X", "x"))
        inv.add_location(Location("S", "small", D(10)))
        inv.receive(Lot("X", "S", D(8), D(1), date(2026, 1, 1)))
        with self.assertRaises(StockError):
            inv.receive(Lot("X", "S", D(3), D(1), date(2026, 1, 2)))
        self.assertEqual(inv.utilisation("S"), D("0.8"))

    def test_adjust_and_snapshot(self):
        self.inv.adjust("EGG", "A1", -6, "broken", date(2026, 4, 1))
        self.inv.adjust("OIL", "B2", 1, "found", date(2026, 4, 1))
        self.assertEqual(self.inv.on_hand("EGG"), D(18))
        self.assertEqual(self.inv.snapshot()[("OIL", "B2")], D("1.5"))
        self.assertEqual(len(self.inv.adjustments), 2)
        with self.assertRaises(StockError):
            self.inv.adjust("EGG", "A1", 1, "", date(2026, 4, 1))
