from decimal import Decimal

CATALOG = {
    "apple": Decimal("0.50"),
    "bread": Decimal("2.25"),
    "cheese": Decimal("7.80"),
    "wine": Decimal("12.99"),
}


def unit_price(sku):
    try:
        return CATALOG[sku]
    except KeyError:
        raise ValueError(f"unknown sku: {sku}") from None
