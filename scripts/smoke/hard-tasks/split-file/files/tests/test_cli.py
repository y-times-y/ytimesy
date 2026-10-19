import os
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO

from inventory.cli import main
from tests.fixtures import ITEMS_JSON, LOTS_CSV


class CliTest(unittest.TestCase):
    def test_main(self):
        with tempfile.TemporaryDirectory() as tmp:
            items, lots = os.path.join(tmp, "items.json"), os.path.join(tmp, "lots.csv")
            with open(items, "w") as handle:
                handle.write(ITEMS_JSON)
            with open(lots, "w") as handle:
                handle.write(LOTS_CSV)
            out = StringIO()
            with redirect_stdout(out):
                main([items, lots, "aging", "--today", "2026-04-01"])
        self.assertTrue(out.getvalue().startswith("age (days)  value"))
