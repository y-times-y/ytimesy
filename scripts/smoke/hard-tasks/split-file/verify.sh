set -eo pipefail
for m in models parsing valuation reports; do test -f "inventory/$m.py"; done
out=$(python3 -m unittest discover -s tests -t . 2>&1) || { echo "$out" | tail -15; exit 1; }
echo "$out" | tail -3
ran=$(echo "$out" | sed -n 's/^Ran \([0-9]*\) test.*/\1/p')
[ "${ran:-0}" -ge 28 ] || { echo "only $ran tests ran (expected the original 28+)"; exit 1; }
for m in models parsing valuation reports core; do python3 -c "import inventory.$m" || { echo "inventory.$m does not import on its own"; exit 1; }; done
repo=$(pwd)
hidden=$(mktemp -d)
cat > "$hidden/hidden_split.py" <<'PY'
import ast
import importlib
import os
import unittest
from datetime import date
from decimal import Decimal as D

REPO = os.environ["REPO"]
HOME = {
    "models": ["StockError", "Item", "Location", "Lot", "Inventory", "Adjustment", "register_unit", "convert", "known_units"],
    "parsing": ["ParseError", "parse_items_json", "parse_lots_csv", "validate_lot_rows", "load_inventory", "parse_adjustments_csv", "dump_lots_csv"],
    "valuation": ["fifo_cost", "stock_value", "average_cost", "valuation_by_location", "margin", "reorder_cost", "issue_cost"],
    "reports": ["render_table", "low_stock", "low_stock_report", "stock_report", "valuation_report", "aging_report", "utilisation_report", "adjustments_report"],
}


def tree(path):
    with open(os.path.join(REPO, path)) as handle:
        return ast.parse(handle.read())


class Hidden(unittest.TestCase):
    def test_names_live_in_their_module_and_core_reexports(self):
        core = importlib.import_module("inventory.core")
        for module, names in HOME.items():
            mod = importlib.import_module(f"inventory.{module}")
            for name in names:
                obj = getattr(mod, name)
                self.assertEqual(obj.__module__, f"inventory.{module}", name)
                self.assertIs(getattr(core, name), obj, name)
        self.assertEqual(sorted(core.__all__), sorted(n for names in HOME.values() for n in names))

    def test_core_is_thin(self):
        for node in tree("inventory/core.py").body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                continue
            if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
                continue
            if isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if all(isinstance(t, ast.Name) and t.id == "__all__" for t in targets):
                    continue
            self.fail(f"core.py defines more than re-exports: line {node.lineno}")

    def test_no_duplicate_definitions(self):
        seen = {}
        for module in HOME:
            for node in ast.walk(tree(f"inventory/{module}.py")):
                if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.col_offset == 0:
                    self.assertNotIn(node.name, seen, f"{node.name} defined in {seen.get(node.name)} and {module}")
                    seen[node.name] = module
                if isinstance(node, ast.Assign) and node.col_offset == 0:
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id in ("_UNITS", "CENT", "LOT_COLUMNS", "AGING_BUCKETS"):
                            self.assertNotIn(target.id, seen, f"{target.id} duplicated")
                            seen[target.id] = module

    def test_callers_do_not_use_core(self):
        paths = [f"inventory/{name}" for name in os.listdir(os.path.join(REPO, "inventory")) if name.endswith(".py") and name != "core.py"]
        paths += [f"tests/test_{name}.py" for name in ("models", "parsing", "valuation", "reports", "cli")]
        for path in paths:
            if not os.path.exists(os.path.join(REPO, path)):
                continue
            for node in ast.walk(tree(path)):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    self.assertFalse(module in ("core", "inventory.core") or module.endswith(".core"), f"{path} imports {module}")
                    if module in ("", "inventory") or node.level:
                        self.assertNotIn("core", [alias.name for alias in node.names], path)
                if isinstance(node, ast.Import):
                    self.assertNotIn("inventory.core", [alias.name for alias in node.names], path)

    def test_shared_unit_registry(self):
        from inventory import core, models, parsing, valuation
        models.register_unit("crate", "each", 30)
        self.assertIn("crate", core.known_units())
        inv = models.Inventory()
        inv.add_item(models.Item("PEAR", "Pear"))
        inv.add_location(models.Location("X", "x"))
        lots = parsing.parse_lots_csv("sku,location,quantity,unit,unit_cost,received\nPEAR,X,2,crate,0.105,2026-01-01\n", inv.items)
        inv.receive(lots[0])
        self.assertEqual(inv.on_hand("PEAR"), D(60))
        self.assertEqual(valuation.stock_value(inv), D("6.30"))
        with self.assertRaises(models.StockError):
            valuation.fifo_cost(inv, "PEAR", 61)

    def test_reports_use_shared_money(self):
        from inventory import models, reports
        inv = models.Inventory()
        inv.add_item(models.Item("NUT", "Nut", reorder_level=D(10)))
        inv.add_location(models.Location("X", "x", D(40)))
        inv.receive(models.Lot("NUT", "X", D(3), D("0.335"), date(2025, 1, 1)))
        self.assertEqual(reports.aging_report(inv, date(2026, 1, 1)).splitlines()[-1], "90+          1.01")
        self.assertEqual(reports.low_stock(inv), [("NUT", D(3), D(10))])
        self.assertIn("X     x       3  8%", reports.utilisation_report(inv))

    def test_package_api(self):
        import inventory
        from inventory import cli, sync
        self.assertIs(inventory.load_inventory, importlib.import_module("inventory.parsing").load_inventory)
        self.assertIs(inventory.Lot, importlib.import_module("inventory.models").Lot)
        self.assertTrue(callable(cli.run) and callable(sync.apply_stock_take))


if __name__ == "__main__":
    unittest.main()
PY
cd "$hidden" && REPO="$repo" PYTHONPATH="$repo" python3 hidden_split.py 2>&1 | tail -4
