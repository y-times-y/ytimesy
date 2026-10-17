"""Inventory tracking: models, parsing, valuation and reports.

This module grew to hold everything. It is organised in four sections,
marked with `# === <name> ===` comments: models, parsing, valuation and
reports.
"""

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

__all__ = [
    # models
    "StockError",
    "Item",
    "Location",
    "Lot",
    "Inventory",
    "Adjustment",
    "register_unit",
    "convert",
    "known_units",
    # parsing
    "ParseError",
    "parse_items_json",
    "parse_lots_csv",
    "validate_lot_rows",
    "load_inventory",
    "parse_adjustments_csv",
    "dump_lots_csv",
    # valuation
    "fifo_cost",
    "stock_value",
    "average_cost",
    "valuation_by_location",
    "margin",
    "reorder_cost",
    "issue_cost",
    # reports
    "render_table",
    "low_stock",
    "low_stock_report",
    "stock_report",
    "valuation_report",
    "aging_report",
    "utilisation_report",
    "adjustments_report",
]


# === models ===

_UNITS = {
    "each": ("each", Decimal(1)),
    "dozen": ("each", Decimal(12)),
    "g": ("g", Decimal(1)),
    "kg": ("g", Decimal(1000)),
    "ml": ("ml", Decimal(1)),
    "l": ("ml", Decimal(1000)),
}


class StockError(Exception):
    """Raised when stock is missing or an operation is impossible."""


def register_unit(name, base, factor):
    """Register a unit as `factor` times an existing base unit."""
    name = name.lower()
    if base not in _UNITS or _UNITS[base][0] != base:
        raise ValueError(f"unknown base unit {base!r}")
    if name in _UNITS:
        raise ValueError(f"unit {name!r} already registered")
    _UNITS[name] = (base, Decimal(str(factor)))


def known_units():
    """Sorted unit names."""
    return sorted(_UNITS)


def convert(quantity, unit, to_unit):
    """Convert quantity between two units with the same base."""
    unit, to_unit = unit.lower(), to_unit.lower()
    try:
        base, factor = _UNITS[unit]
        to_base, to_factor = _UNITS[to_unit]
    except KeyError as error:
        raise ValueError(f"unknown unit {error.args[0]!r}") from None
    if base != to_base:
        raise ValueError(f"cannot convert {unit} to {to_unit}")
    return Decimal(quantity) * factor / to_factor


@dataclass(frozen=True)
class Item:
    sku: str
    name: str
    unit: str = "each"
    reorder_level: Decimal = Decimal(0)
    tags: tuple = ()

    def __post_init__(self):
        if self.unit not in _UNITS:
            raise ValueError(f"unknown unit {self.unit!r}")
        if not self.sku or not self.sku.isupper():
            raise ValueError(f"sku must be upper-case: {self.sku!r}")


@dataclass(frozen=True)
class Location:
    code: str
    name: str
    capacity: Decimal | None = None


@dataclass
class Lot:
    sku: str
    location: str
    quantity: Decimal
    unit_cost: Decimal
    received: date

    def value(self):
        return self.quantity * self.unit_cost


@dataclass
class Inventory:
    items: dict = field(default_factory=dict)
    locations: dict = field(default_factory=dict)
    lots: list = field(default_factory=list)
    adjustments: list = field(default_factory=list)

    def add_item(self, item):
        if item.sku in self.items:
            raise StockError(f"duplicate item {item.sku}")
        self.items[item.sku] = item

    def add_location(self, location):
        if location.code in self.locations:
            raise StockError(f"duplicate location {location.code}")
        self.locations[location.code] = location

    def item(self, sku):
        try:
            return self.items[sku]
        except KeyError:
            raise StockError(f"unknown item {sku}") from None

    def receive(self, lot):
        self.item(lot.sku)
        if lot.location not in self.locations:
            raise StockError(f"unknown location {lot.location}")
        if lot.quantity <= 0:
            raise StockError("quantity must be positive")
        capacity = self.locations[lot.location].capacity
        if capacity is not None and self.location_total(lot.location) + lot.quantity > capacity:
            raise StockError(f"location {lot.location} is full")
        self.lots.append(lot)
        self.lots.sort(key=lambda each: (each.received, each.sku, each.location))

    def lots_for(self, sku, location=None):
        """Lots for sku, oldest first."""
        return [
            lot
            for lot in self.lots
            if lot.sku == sku and lot.quantity > 0 and (location is None or lot.location == location)
        ]

    def on_hand(self, sku, location=None):
        return sum((lot.quantity for lot in self.lots_for(sku, location)), Decimal(0))

    def location_total(self, location):
        return sum((lot.quantity for lot in self.lots if lot.location == location), Decimal(0))

    def issue(self, sku, quantity, location=None):
        """Remove quantity, oldest lots first. Returns [(lot, taken)]."""
        quantity = Decimal(quantity)
        if quantity <= 0:
            raise StockError("quantity must be positive")
        if self.on_hand(sku, location) < quantity:
            raise StockError(f"not enough {sku}")
        taken = []
        for lot in self.lots_for(sku, location):
            if quantity == 0:
                break
            part = min(lot.quantity, quantity)
            lot.quantity -= part
            quantity -= part
            taken.append((lot, part))
        self.lots = [lot for lot in self.lots if lot.quantity > 0]
        return taken

    def transfer(self, sku, quantity, source, target):
        """Move stock between locations, keeping each lot's cost and date."""
        if target not in self.locations:
            raise StockError(f"unknown location {target}")
        moved = self.issue(sku, quantity, source)
        for lot, part in moved:
            self.receive(Lot(sku, target, part, lot.unit_cost, lot.received))
        return sum((part for _, part in moved), Decimal(0))


    def adjust(self, sku, location, delta, reason, when):
        """Stock-take correction: positive delta adds a zero-cost lot, negative issues."""
        delta = Decimal(delta)
        if not reason:
            raise StockError("an adjustment needs a reason")
        if delta > 0:
            self.receive(Lot(sku, location, delta, Decimal(0), when))
        elif delta < 0:
            self.issue(sku, -delta, location)
        self.adjustments.append(Adjustment(sku, location, delta, reason, when))
        return delta

    def snapshot(self):
        """{(sku, location): quantity} for everything on hand."""
        totals = {}
        for lot in self.lots:
            key = (lot.sku, lot.location)
            totals[key] = totals.get(key, Decimal(0)) + lot.quantity
        return dict(sorted(totals.items()))

    def utilisation(self, location):
        """Fraction of a location's capacity in use (None when unlimited)."""
        capacity = self.locations[location].capacity
        if not capacity:
            return None
        return self.location_total(location) / capacity


@dataclass(frozen=True)
class Adjustment:
    sku: str
    location: str
    delta: Decimal
    reason: str
    when: date

# === parsing ===


class ParseError(ValueError):
    """Raised for malformed input; carries the 1-based line number."""

    def __init__(self, line, message):
        super().__init__(f"line {line}: {message}")
        self.line = line


def _parse_quantity(text, unit, item_unit):
    """Quantity in the item's unit; `unit` may be any convertible unit."""
    try:
        value = Decimal(text.strip())
    except ArithmeticError:
        raise ValueError(f"bad quantity {text!r}") from None
    if unit and unit.lower() != item_unit:
        value = convert(value, unit, item_unit)
    return value


def _parse_money(text):
    text = text.strip().lstrip("$")
    try:
        value = Decimal(text)
    except ArithmeticError:
        raise ValueError(f"bad amount {text!r}") from None
    if value < 0:
        raise ValueError("amount must not be negative")
    return value


def _parse_date(text):
    try:
        return date.fromisoformat(text.strip())
    except ValueError:
        raise ValueError(f"bad date {text!r}") from None


def parse_items_json(text):
    """Items and locations from a JSON document."""
    data = json.loads(text)
    items = [
        Item(
            sku=row["sku"],
            name=row["name"],
            unit=row.get("unit", "each"),
            reorder_level=Decimal(str(row.get("reorder_level", 0))),
            tags=tuple(row.get("tags", ())),
        )
        for row in data.get("items", [])
    ]
    locations = [
        Location(
            code=row["code"],
            name=row["name"],
            capacity=None if row.get("capacity") is None else Decimal(str(row["capacity"])),
        )
        for row in data.get("locations", [])
    ]
    return items, locations


LOT_COLUMNS = ("sku", "location", "quantity", "unit", "unit_cost", "received")


def validate_lot_rows(text, items):
    """Return a list of ParseError for the lot CSV; empty when valid."""
    errors = []
    reader = csv.DictReader(io.StringIO(text))
    missing = [name for name in LOT_COLUMNS if name not in (reader.fieldnames or [])]
    if missing:
        return [ParseError(1, f"missing columns: {', '.join(missing)}")]
    for number, row in enumerate(reader, start=2):
        sku = (row["sku"] or "").strip()
        if sku not in items:
            errors.append(ParseError(number, f"unknown sku {sku!r}"))
            continue
        try:
            _parse_quantity(row["quantity"] or "", row["unit"], items[sku].unit)
            _parse_money(row["unit_cost"] or "")
            _parse_date(row["received"] or "")
        except ValueError as error:
            errors.append(ParseError(number, str(error)))
    return errors


def parse_lots_csv(text, items):
    """Lots from CSV; quantities are converted to each item's unit."""
    errors = validate_lot_rows(text, items)
    if errors:
        raise errors[0]
    lots = []
    for row in csv.DictReader(io.StringIO(text)):
        item = items[row["sku"].strip()]
        lots.append(
            Lot(
                sku=item.sku,
                location=row["location"].strip(),
                quantity=_parse_quantity(row["quantity"], row["unit"], item.unit),
                unit_cost=_parse_money(row["unit_cost"]),
                received=_parse_date(row["received"]),
            )
        )
    return lots


def load_inventory(items_json, lots_csv):
    """An Inventory built from an items JSON document and a lots CSV."""
    inventory = Inventory()
    items, locations = parse_items_json(items_json)
    for item in items:
        inventory.add_item(item)
    for location in locations:
        inventory.add_location(location)
    for lot in parse_lots_csv(lots_csv, inventory.items):
        inventory.receive(lot)
    return inventory



ADJUSTMENT_COLUMNS = ("sku", "location", "delta", "reason", "when")


def parse_adjustments_csv(text, items):
    """[(sku, location, delta, reason, when)] from a stock-take CSV."""
    reader = csv.DictReader(io.StringIO(text))
    missing = [name for name in ADJUSTMENT_COLUMNS if name not in (reader.fieldnames or [])]
    if missing:
        raise ParseError(1, f"missing columns: {', '.join(missing)}")
    rows = []
    for number, row in enumerate(reader, start=2):
        sku = (row["sku"] or "").strip()
        if sku not in items:
            raise ParseError(number, f"unknown sku {sku!r}")
        try:
            delta = _parse_quantity(row["delta"] or "", None, items[sku].unit)
            when = _parse_date(row["when"] or "")
        except ValueError as error:
            raise ParseError(number, str(error)) from None
        reason = (row["reason"] or "").strip()
        if not reason:
            raise ParseError(number, "missing reason")
        rows.append((sku, row["location"].strip(), delta, reason, when))
    return rows


def dump_lots_csv(inventory):
    """The inventory's lots as CSV in the same format parse_lots_csv reads."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(LOT_COLUMNS)
    for lot in inventory.lots:
        unit = inventory.items[lot.sku].unit
        writer.writerow([lot.sku, lot.location, lot.quantity, unit, lot.unit_cost, lot.received.isoformat()])
    return out.getvalue()

# === valuation ===

CENT = Decimal("0.01")


def _money(value):
    """Round to cents, half up."""
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def fifo_cost(inventory, sku, quantity, location=None):
    """Cost of issuing quantity of sku, oldest lots first, without issuing it."""
    remaining = Decimal(quantity)
    if inventory.on_hand(sku, location) < remaining:
        raise StockError(f"not enough {sku}")
    cost = Decimal(0)
    for lot in inventory.lots_for(sku, location):
        if remaining == 0:
            break
        part = min(lot.quantity, remaining)
        cost += part * lot.unit_cost
        remaining -= part
    return _money(cost)


def stock_value(inventory, sku=None):
    """Total value of stock at cost, for one sku or everything."""
    lots = inventory.lots if sku is None else inventory.lots_for(sku)
    return _money(sum((lot.value() for lot in lots), Decimal(0)))


def average_cost(inventory, sku):
    """Weighted average unit cost of what is on hand (None when out of stock)."""
    quantity = inventory.on_hand(sku)
    if not quantity:
        return None
    total = sum((lot.value() for lot in inventory.lots_for(sku)), Decimal(0))
    return _money(total / quantity)


def valuation_by_location(inventory):
    """{location code: value}, every known location included."""
    totals = {code: Decimal(0) for code in inventory.locations}
    for lot in inventory.lots:
        totals[lot.location] += lot.value()
    return {code: _money(value) for code, value in sorted(totals.items())}


def margin(inventory, sku, quantity, unit_price):
    """(profit, margin percent) for selling quantity at unit_price under FIFO."""
    revenue = _money(Decimal(quantity) * Decimal(unit_price))
    cost = fifo_cost(inventory, sku, quantity)
    profit = revenue - cost
    percent = Decimal(0) if not revenue else (profit * 100 / revenue).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    return profit, percent



def reorder_cost(inventory, supplier_prices, target_multiple=2):
    """Cost of topping every low item up to target_multiple x its reorder level.

    supplier_prices maps sku to unit price; items without a price are skipped.
    Returns (total, [(sku, quantity, cost)]).
    """
    lines = []
    for sku in sorted(inventory.items):
        item = inventory.items[sku]
        if not item.reorder_level or sku not in supplier_prices:
            continue
        on_hand = inventory.on_hand(sku)
        if on_hand > item.reorder_level:
            continue
        quantity = item.reorder_level * target_multiple - on_hand
        lines.append((sku, quantity, _money(quantity * Decimal(str(supplier_prices[sku])))))
    return sum((line[2] for line in lines), Decimal("0.00")), lines


def issue_cost(taken):
    """Cost of the [(lot, quantity)] pairs Inventory.issue returns."""
    return _money(sum((lot.unit_cost * part for lot, part in taken), Decimal(0)))

# === reports ===


def render_table(headers, rows):
    """Plain-text table: left-aligned text, right-aligned numbers."""
    cells = [[str(value) for value in row] for row in rows]
    widths = [len(header) for header in headers]
    for row in cells:
        for index, value in enumerate(row):
            widths[index] = max(widths[index], len(value))
    numeric = [
        bool(rows) and all(isinstance(row[index], (int, Decimal)) for row in rows)
        for index in range(len(headers))
    ]

    def line(values):
        parts = [
            value.rjust(widths[index]) if numeric[index] else value.ljust(widths[index])
            for index, value in enumerate(values)
        ]
        return "  ".join(parts).rstrip()

    out = [line(headers), "  ".join("-" * width for width in widths)]
    out += [line(row) for row in cells]
    return "\n".join(out)


def low_stock(inventory):
    """Items at or below their reorder level, as (sku, on hand, reorder level)."""
    found = []
    for sku in sorted(inventory.items):
        item = inventory.items[sku]
        quantity = inventory.on_hand(sku)
        if item.reorder_level and quantity <= item.reorder_level:
            found.append((sku, quantity, item.reorder_level))
    return found


def low_stock_report(inventory):
    rows = low_stock(inventory)
    if not rows:
        return "No items below reorder level."
    return render_table(["sku", "on hand", "reorder at"], rows)


def stock_report(inventory, location=None):
    """On-hand quantity per item, optionally for one location."""
    rows = []
    for sku in sorted(inventory.items):
        item = inventory.items[sku]
        quantity = inventory.on_hand(sku, location)
        rows.append((sku, item.name, quantity, item.unit))
    title = "Stock" if location is None else f"Stock at {inventory.locations[location].name}"
    return title + "\n" + render_table(["sku", "name", "qty", "unit"], rows)


def valuation_report(inventory):
    rows = []
    for sku in sorted(inventory.items):
        quantity = inventory.on_hand(sku)
        if quantity:
            rows.append((sku, quantity, average_cost(inventory, sku), stock_value(inventory, sku)))
    rows.append(("TOTAL", sum((row[1] for row in rows), Decimal(0)), "", stock_value(inventory)))
    return render_table(["sku", "qty", "avg cost", "value"], rows)


AGING_BUCKETS = ((30, "0-30"), (90, "31-90"), (None, "90+"))


def aging_report(inventory, today):
    """Stock value by age of the lot (days since received)."""
    totals = {label: Decimal(0) for _, label in AGING_BUCKETS}
    for lot in inventory.lots:
        age = (today - lot.received).days
        for limit, label in AGING_BUCKETS:
            if limit is None or age <= limit:
                totals[label] += lot.value()
                break
    rows = [(label, _money(totals[label])) for _, label in AGING_BUCKETS]
    return render_table(["age (days)", "value"], rows)


def utilisation_report(inventory):
    """Capacity use per location, as whole percents."""
    rows = []
    for code in sorted(inventory.locations):
        share = inventory.utilisation(code)
        used = "-" if share is None else f"{(share * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)}%"
        rows.append((code, inventory.locations[code].name, inventory.location_total(code), used))
    return render_table(["code", "name", "qty", "used"], rows)


def adjustments_report(inventory):
    if not inventory.adjustments:
        return "No adjustments."
    rows = [
        (entry.when.isoformat(), entry.sku, entry.location, entry.delta, entry.reason)
        for entry in inventory.adjustments
    ]
    return render_table(["date", "sku", "location", "delta", "reason"], rows)
