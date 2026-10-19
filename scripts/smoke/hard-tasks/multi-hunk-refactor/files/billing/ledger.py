"""Double-entry-ish ledger: one signed entry per posting."""

from decimal import Decimal

from . import audit

ENTRIES = {}
_NEXT = [1]


def reset():
    ENTRIES.clear()
    _NEXT[0] = 1


def post(account, amount, memo):
    entry_id = f"L{_NEXT[0]}"
    _NEXT[0] += 1
    ENTRIES[entry_id] = {"account": account, "amount": Decimal(amount), "memo": memo, "reversed": False}
    audit.record("ledger.post", entry=entry_id, account=account, amount=str(amount))
    return entry_id


def reverse(entry_id, reason):
    entry = ENTRIES[entry_id]
    if entry["reversed"]:
        raise ValueError(f"{entry_id} already reversed")
    entry["reversed"] = True
    new_id = post(entry["account"], -entry["amount"], f"reversal of {entry_id}: {reason}")
    audit.record("ledger.reverse", entry=entry_id, reversal=new_id, reason=reason)
    return new_id


def balance(account):
    return sum((e["amount"] for e in ENTRIES.values() if e["account"] == account), Decimal(0))
