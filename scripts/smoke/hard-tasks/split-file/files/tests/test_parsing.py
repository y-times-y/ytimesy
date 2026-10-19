import unittest
from decimal import Decimal as D

from inventory.core import ParseError, dump_lots_csv, load_inventory, parse_adjustments_csv, parse_items_json, parse_lots_csv, validate_lot_rows
from tests.fixtures import ITEMS_JSON, LOTS_CSV


class ParsingTest(unittest.TestCase):
    def setUp(self):
        items, _ = parse_items_json(ITEMS_JSON)
        self.items = {item.sku: item for item in items}

    def test_items(self):
        items, locations = parse_items_json(ITEMS_JSON)
        self.assertEqual([item.sku for item in items], ["BOLT", "FLOUR", "OIL", "EGG"])
        self.assertEqual(items[0].tags, ("hardware",))
        self.assertEqual(locations[1].capacity, None)

    def test_lots_convert_units(self):
        lots = parse_lots_csv(LOTS_CSV, self.items)
        self.assertEqual(lots[3].quantity, D("2.5"))
        self.assertEqual(lots[6].quantity, D(24))

    def test_validation_errors(self):
        bad = "sku,location,quantity,unit,unit_cost,received\nBOLT,A1,x,each,1,2026-01-01\nNOPE,A1,1,each,1,2026-01-01\nBOLT,A1,1,each,-1,2026-01-01\nBOLT,A1,1,each,1,2026-13-01\n"
        errors = validate_lot_rows(bad, self.items)
        self.assertEqual([error.line for error in errors], [2, 3, 4, 5])
        with self.assertRaises(ParseError) as caught:
            parse_lots_csv(bad, self.items)
        self.assertEqual(str(caught.exception), "line 2: bad quantity 'x'")

    def test_missing_columns(self):
        self.assertEqual(str(validate_lot_rows("sku,quantity\n", self.items)[0]), "line 1: missing columns: location, unit, unit_cost, received")

    def test_adjustments(self):
        rows = parse_adjustments_csv("sku,location,delta,reason,when\nEGG,A1,-3,broken,2026-04-02\n", self.items)
        self.assertEqual(rows[0][2], D(-3))
        with self.assertRaises(ParseError):
            parse_adjustments_csv("sku,location,delta,reason,when\nEGG,A1,1,,2026-04-02\n", self.items)

    def test_round_trip(self):
        inv = load_inventory(ITEMS_JSON, LOTS_CSV)
        again = load_inventory(ITEMS_JSON, dump_lots_csv(inv))
        self.assertEqual(again.snapshot(), inv.snapshot())
