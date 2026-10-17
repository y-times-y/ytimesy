set -eo pipefail
test ! -e billing/legacy_audit.py || { echo "legacy_audit.py still exists"; exit 1; }
test -f billing/context.py && test -f tests/test_context.py
if grep -rIn legacy_audit --include='*.py' --exclude-dir=.git .; then echo "legacy_audit still referenced"; exit 1; fi
out=$(python3 -m unittest discover -s tests -t . 2>&1) || { echo "$out" | tail -15; exit 1; }
echo "$out" | tail -3
ran=$(echo "$out" | sed -n 's/^Ran \([0-9]*\) test.*/\1/p')
[ "${ran:-0}" -ge 14 ] || { echo "only $ran tests ran (expected the original 12 plus new context tests)"; exit 1; }
ctx=$(python3 -m unittest tests.test_context 2>&1 | sed -n 's/^Ran \([0-9]*\) test.*/\1/p')
[ "${ctx:-0}" -ge 1 ] || { echo "tests/test_context.py has no tests"; exit 1; }
repo=$(pwd)
hidden=$(mktemp -d)
cat > "$hidden/hidden_context.py" <<'PY'
import dataclasses
import importlib
import inspect
import unittest
from decimal import Decimal as D

import billing
from billing import api, audit, invoices, ledger, notifications, payments, refunds, subscriptions
from billing.context import RequestContext

THREADED = {
    audit: ["record"],
    ledger: ["post", "reverse"],
    invoices: ["create_invoice", "add_line", "void_invoice"],
    payments: ["charge", "apply_payment"],
    refunds: ["refund"],
    subscriptions: ["start", "renew", "cancel"],
    notifications: ["send"],
}


def trail(kind=None):
    return [(e["kind"], e["request_id"], e["actor"]) for e in audit.events(kind)]


class Hidden(unittest.TestCase):
    def setUp(self):
        billing.reset()

    def test_context_type(self):
        self.assertTrue(dataclasses.is_dataclass(RequestContext))
        self.assertEqual([f.name for f in dataclasses.fields(RequestContext)], ["request_id", "actor"])
        ctx = RequestContext("r", "u")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            ctx.actor = "x"

    def test_signatures(self):
        for module, names in THREADED.items():
            for name in names:
                params = list(inspect.signature(getattr(module, name)).parameters.values())
                self.assertEqual(params[0].name, "context", f"{module.__name__}.{name}")
                self.assertIs(params[0].default, inspect.Parameter.empty, f"{module.__name__}.{name}")
        for func in (ledger.balance, invoices.total, invoices.outstanding, audit.events, api.handle):
            self.assertNotIn("context", inspect.signature(func).parameters, func.__name__)
        with self.assertRaises(TypeError):
            audit.record("ledger.post")

    def test_legacy_gone(self):
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("billing.legacy_audit")

    def test_direct_calls_use_given_context(self):
        a, b = RequestContext("A", "ann"), RequestContext("B", "ben")
        inv = invoices.create_invoice(a, "acme", [("x", "8.00")])
        pay = payments.apply_payment(b, inv, "8.00")
        refunds.refund(a, pay, "3.00", "late")
        self.assertEqual(trail("invoice.create"), [("invoice.create", "A", "ann")])
        self.assertEqual(trail("payment.charge"), [("payment.charge", "B", "ben")])
        self.assertEqual(trail("refund"), [("refund", "A", "ann")])
        self.assertEqual([e[1] for e in trail("notify.send")], ["A", "B", "A"])
        self.assertEqual([e[1] for e in trail("ledger.post")], ["A", "B", "A"])
        self.assertEqual(ledger.balance("acme"), D("3.00"))

    def test_subscription_flow(self):
        c = RequestContext("S", "sys")
        sub = subscriptions.start(c, "acme", "pro")
        inv = subscriptions.SUBSCRIPTIONS[sub]["invoices"][-1]
        payments.apply_payment(RequestContext("P", "pat"), inv, "25.00")
        subscriptions.cancel(RequestContext("C", "cal"), sub, refund_unused=True, used_fraction=D("0.2"))
        self.assertEqual(trail("refund"), [("refund", "C", "cal")])
        self.assertEqual(audit.events("refund")[0]["amount"], "20.00")
        self.assertTrue(all(e[1] and e[2] for e in trail()))
        sub2 = subscriptions.start(c, "zen", "basic")
        subscriptions.cancel(RequestContext("V", "vic"), sub2)
        self.assertEqual(trail("ledger.reverse"), [("ledger.reverse", "V", "vic")])
        self.assertEqual(ledger.balance("zen"), D(0))

    def test_api_and_batch(self):
        inv = api.handle({"id": "r1", "user": "ana", "action": "invoice", "customer": "acme", "lines": [("a", "5.00")]})
        out = api.handle({"id": "b1", "user": "ops", "action": "batch", "requests": [
            {"id": "b1.1", "action": "pay", "invoice": inv, "amount": "5.00"},
            {"id": "b1.2", "action": "subscribe", "customer": "zen", "plan": "basic"},
        ]})
        self.assertEqual(len(out), 2)
        self.assertEqual(trail("batch.done"), [("batch.done", "b1", "ops")])
        self.assertEqual(trail("payment.apply"), [("payment.apply", "b1.1", "ops")])
        self.assertEqual(trail("subscription.start"), [("subscription.start", "b1.2", "ops")])
        self.assertEqual(trail("invoice.create"), [("invoice.create", "r1", "ana"), ("invoice.create", "b1.2", "ops")])
        self.assertTrue(all(e[1] is not None and e[2] is not None for e in trail()))


if __name__ == "__main__":
    unittest.main()
PY
cd "$hidden" && PYTHONPATH="$repo" python3 hidden_context.py 2>&1 | tail -4
