from decimal import Decimal

from .catalog import unit_price


class Cart:
    def __init__(self):
        self.items = {}

    def add(self, sku, qty=1):
        unit_price(sku)
        self.items[sku] = self.items.get(sku, 0) + qty

    def remove(self, sku, qty=1):
        unit_price(sku)
        left = self.items.get(sku, 0) - qty
        if left > 0:
            self.items[sku] = left
        else:
            self.items.pop(sku, None)

    def subtotal(self):
        return sum(
            (unit_price(sku) * qty for sku, qty in self.items.items()),
            Decimal("0.00"),
        )

    def total(self):
        return self.subtotal()
