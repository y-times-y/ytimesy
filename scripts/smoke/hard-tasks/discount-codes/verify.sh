git diff --quiet HEAD -- tests/test_cart.py
python3 -m unittest discover -s tests -t . 2>&1 | tail -3
[ "$(git ls-files --others --exclude-standard tests | grep -c '\.py$')" -ge 1 ] || git diff --name-only HEAD -- tests | grep -q . || { echo "no new tests added"; exit 1; }
cat > "$hidden/hidden_discounts.py" <<'PY'
import unittest
from decimal import Decimal as D

from shop import Cart


def cart(**items):
    c = Cart()
    for sku, qty in items.items():
        c.add(sku, qty)
    return c


class Hidden(unittest.TestCase):
    def test_percent(self):
        c = cart(apple=3, cheese=1)
        c.apply_code("SAVE10")
        self.assertEqual(c.discount(), D("0.93"))
        self.assertEqual(c.total(), D("8.37"))

    def test_percent_cap(self):
        c = cart(wine=5)
        c.apply_code("save10")
        self.assertEqual(c.discount(), D("5.00"))
        self.assertEqual(c.total(), D("59.95"))

    def test_half_up(self):
        c = cart(bread=1)
        c.apply_code("Save10")
        self.assertEqual(c.discount(), D("0.23"))
        self.assertEqual(c.total(), D("2.02"))

    def test_minimum_then_reached(self):
        c = cart(wine=3)
        c.apply_code("bigspend")
        self.assertEqual(c.discount(), D("0.00"))
        self.assertEqual(c.total(), D("38.97"))
        c.add("wine")
        self.assertEqual(c.discount(), D("10.39"))
        self.assertEqual(c.total(), D("41.57"))
        c.remove("wine", 2)
        self.assertEqual(c.total(), D("25.98"))

    def test_bogo(self):
        c = cart(bread=5, apple=1)
        c.apply_code("BREADBOGO")
        self.assertEqual(c.discount(), D("4.50"))
        self.assertEqual(c.total(), D("7.25"))
        single = cart(bread=1)
        single.apply_code("breadbogo")
        self.assertEqual(single.total(), D("2.25"))

    def test_fixed_with_minimum(self):
        small = cart(apple=2)
        small.apply_code("FIVEOFF")
        self.assertEqual(small.total(), D("1.00"))
        big = cart(cheese=3)
        big.apply_code("fiveoff")
        self.assertEqual(big.total(), D("18.40"))

    def test_replace_unknown_and_remove(self):
        c = cart(cheese=3)
        c.apply_code("SAVE10")
        c.apply_code("FIVEOFF")
        self.assertEqual(c.total(), D("18.40"))
        with self.assertRaises(ValueError):
            c.apply_code("NOPE")
        self.assertEqual(c.total(), D("18.40"))
        c.remove_code()
        self.assertEqual(c.discount(), D("0.00"))
        self.assertEqual(c.total(), D("23.40"))

    def test_no_code(self):
        self.assertEqual(cart(apple=1).discount(), D("0.00"))


if __name__ == "__main__":
    unittest.main()
PY
cd "$hidden" && PYTHONPATH="$repo" python3 hidden_discounts.py 2>&1 | tail -4
