"""python3 -m inventory.cli <items.json> <lots.csv> <report> [--today YYYY-MM-DD]"""

import sys
from datetime import date

from . import core


def run(items_json, lots_csv, report, today=None):
    inventory = core.load_inventory(items_json, lots_csv)
    if report == "stock":
        return core.stock_report(inventory)
    if report == "value":
        return core.valuation_report(inventory)
    if report == "low":
        return core.low_stock_report(inventory)
    if report == "aging":
        return core.aging_report(inventory, today or date.today())
    if report == "locations":
        return core.utilisation_report(inventory)
    raise SystemExit(f"unknown report {report!r}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    today = None
    if "--today" in argv:
        index = argv.index("--today")
        today = date.fromisoformat(argv[index + 1])
        del argv[index : index + 2]
    items_path, lots_path, report = argv
    with open(items_path) as items, open(lots_path) as lots:
        print(run(items.read(), lots.read(), report, today))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
