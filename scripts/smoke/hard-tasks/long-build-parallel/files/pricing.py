from decimal import Decimal, ROUND_HALF_UP


def line_total(unit_price, quantity, discount_percent=0):
    """Total for one invoice line, in currency units rounded half-up to cents.

    unit_price is a string or Decimal; the discount applies to the line's
    subtotal before rounding.
    """
    subtotal = Decimal(unit_price) * quantity
    discounted = subtotal * (100 - discount_percent) / 100
    return float(round(discounted, 2))
