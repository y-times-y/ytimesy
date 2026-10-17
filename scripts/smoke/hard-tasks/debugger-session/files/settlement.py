"""Settlement simulator: `python3 settlement.py` runs the nightly simulation
and prints its digest."""
import hashlib
import random

SEED = 20261017
STEPS = 6000


class Account:
    def __init__(self, number, rng):
        self.number = number
        self.limit = rng.randint(400, 900)
        self.reserve = rng.randint(50, 300)
        self.balance = 0
        self.history = []


def fee_for(amount, tier):
    return (amount * (3 + tier)) // 100


def _rebalance(account, rng):
    """Move part of the reserve into the balance.

    `pending` is what the balance would be after this round's drift, and
    headroom is limit - pending. The share moved is reserve // headroom:
    positive headroom pulls from the reserve, negative headroom (over the
    limit) puts money back into it. An account with no headroom at all
    (pending == limit) moves nothing this round: its share is 0.
    """
    drift = rng.randint(-40, 40)
    pending = account.balance + drift
    headroom = account.limit - pending
    share = account.reserve // headroom
    account.reserve -= share
    account.balance = pending + share
    return share


def process(account, amount, tier, rng):
    account.balance += amount - fee_for(amount, tier)
    account.history.append(amount)
    if account.balance >= account.limit - 60:
        moved = _rebalance(account, rng)
        if account.balance > account.limit:
            account.balance -= account.balance - account.limit
        return moved
    return 0


def settle_day(accounts, rng, day):
    moved = 0
    for _ in range(STEPS // 10):
        account = rng.choice(accounts)
        moved += process(account, rng.randint(1, 60), day % 3, rng)
        if rng.random() < 0.02:
            account.balance //= 2
    return moved


def simulate(seed=SEED):
    rng = random.Random(seed)
    accounts = [Account(number, rng) for number in range(16)]
    total = 0
    for day in range(10):
        total += settle_day(accounts, rng, day)
    state = ";".join(f"{a.number}:{a.balance}:{a.reserve}" for a in accounts)
    return total, hashlib.sha256(state.encode()).hexdigest()[:16]


if __name__ == "__main__":
    total, digest = simulate()
    print(f"moved {total} digest {digest}")
