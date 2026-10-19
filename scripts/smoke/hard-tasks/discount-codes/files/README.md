# shop

A tiny shopping-cart library. Prices are `Decimal` values in `shop/catalog.py`.
The package must work when imported from any working directory.

## Cart

- `Cart.add(sku, qty=1)` / `Cart.remove(sku, qty=1)` change quantities; unknown SKUs raise `ValueError`.
- `Cart.subtotal()` is the sum of unit price x quantity.
- `Cart.total()` is what the customer pays.

## Discount codes

Codes are defined in `shop/codes.json`.

- `Cart.apply_code(code)` applies one code. Codes are case-insensitive. Applying a code replaces any earlier one. An unknown code raises `ValueError` and leaves the current code unchanged.
- `Cart.remove_code()` clears the code.
- `Cart.discount()` returns the current discount as a `Decimal` (0.00 without a code).
- `Cart.total()` is `subtotal - discount`, never below 0.00.

Rules by `type`:

- `percent`: `value` percent of the subtotal, capped at `max_off` when given.
- `fixed`: `value` off.
- `bogo`: for the given `sku`, every second unit is free (floor(qty / 2) units at the unit price).
- `min_subtotal` (any type): while the subtotal is below it the code stays applied but the discount is 0.00; it takes effect once the cart reaches it.

The discount is computed exactly and then rounded to cents with ROUND_HALF_UP. Discounts are recomputed from the cart's current contents every time.
