import unittest
from decimal import Decimal

from pricing import line_total


class PricingTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(line_total("2.50", 4), Decimal("10.00"))

    def test_half_up(self):
        self.assertEqual(line_total("0.125", 1), Decimal("0.13"))
        self.assertEqual(line_total("1.005", 1), Decimal("1.01"))

    def test_discount(self):
        self.assertEqual(line_total("19.99", 3, 15), Decimal("50.97"))


if __name__ == "__main__":
    unittest.main()
