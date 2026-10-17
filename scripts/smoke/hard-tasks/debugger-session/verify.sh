test -f answer.txt || { echo "answer.txt is missing"; exit 1; }
[ "$(tr -s '[:space:]' ' ' < answer.txt | sed 's/^ //;s/ $//')" = "10 -2 181" ] || { echo "answer.txt: $(cat answer.txt)"; exit 1; }
out=$(timeout 60 python3 settlement.py 2>&1) || { echo "$out" | tail -5; exit 1; }
[ "$out" = "moved -8096 digest e819f1eeb3690a67" ] || { echo "settlement.py printed: $out"; exit 1; }
cd "$hidden" && PYTHONPATH="$repo" python3 - <<'PY'
import random
import settlement
class Acct:
    pass
rng = random.Random(5)
state = rng.getstate()
drift = rng.randint(-40, 40)
rng.setstate(state)
a = Acct(); a.number = 0; a.limit = 500; a.reserve = 120; a.balance = 500 - drift
assert settlement._rebalance(a, rng) == 0 and a.reserve == 120 and a.balance == 500, vars(a)
rng.setstate(state)
b = Acct(); b.number = 1; b.limit = 500; b.reserve = 120; b.balance = 510 - drift
assert settlement._rebalance(b, rng) == -12 and b.reserve == 132, vars(b)
print("answer and fix ok")
PY
