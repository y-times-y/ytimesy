import unittest
from decimal import Decimal

from shop import Cart


class CartTest(unittest.TestCase):
    def test_subtotal(self):
        cart = Cart()
        cart.add("apple", 3)
        cart.add("cheese")
        self.assertEqual(cart.subtotal(), Decimal("9.30"))
        self.assertEqual(cart.total(), Decimal("9.30"))

    def test_remove(self):
        cart = Cart()
        cart.add("bread", 2)
        cart.remove("bread")
        self.assertEqual(cart.subtotal(), Decimal("2.25"))

    def test_unknown_sku(self):
        with self.assertRaises(ValueError):
            Cart().add("caviar")


if __name__ == "__main__":
    unittest.main()
