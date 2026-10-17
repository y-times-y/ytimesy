"""Apply a stock-take file to an inventory and summarise the result."""

from inventory.core import StockError, adjustments_report, parse_adjustments_csv, stock_value


def apply_stock_take(inventory, csv_text):
    """Apply every adjustment; returns (value change, report text)."""
    before = stock_value(inventory)
    for sku, location, delta, reason, when in parse_adjustments_csv(csv_text, inventory.items):
        try:
            inventory.adjust(sku, location, delta, reason, when)
        except StockError as error:
            raise StockError(f"{sku} at {location}: {error}") from None
    return stock_value(inventory) - before, adjustments_report(inventory)
