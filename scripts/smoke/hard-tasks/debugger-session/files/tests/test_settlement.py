import random
import unittest

import settlement


class FeeTest(unittest.TestCase):
    def test_fee_by_tier(self):
        self.assertEqual(settlement.fee_for(100, 0), 3)
        self.assertEqual(settlement.fee_for(100, 2), 5)

    def test_rebalance_pulls_from_reserve(self):
        account = settlement.Account(0, random.Random(1))
        account.limit, account.reserve, account.balance = 500, 1000, 400
        rng = random.Random(3)
        moved = settlement._rebalance(account, rng)
        self.assertGreater(moved, 0)
        self.assertEqual(account.reserve, 1000 - moved)


if __name__ == "__main__":
    unittest.main()
