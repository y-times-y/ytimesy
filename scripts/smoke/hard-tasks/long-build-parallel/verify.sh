git diff --quiet HEAD -- build.py assets tests || { echo "build.py, assets/ or tests/ were modified"; exit 1; }
test -f dist/bundle.json || { echo "dist/bundle.json is missing"; exit 1; }
python3 - <<'PY'
import hashlib, hmac, json, os, sys
bundle = json.load(open("dist/bundle.json"))
signature = bundle.pop("signature", None)
if signature != hmac.new(b"release-build-dev-key", json.dumps(bundle, sort_keys=True).encode(), hashlib.sha256).hexdigest():
    sys.exit("dist/bundle.json was not written by build.py")
chain = hashlib.sha256()
for name in sorted(n for n in os.listdir("assets") if n.endswith(".js")):
    chain.update(open(os.path.join("assets", name), "rb").read())
if bundle["digest"] != chain.hexdigest() or len(bundle["modules"]) != 24:
    sys.exit("bundle does not match assets/")
if bundle["finished"] - bundle["started"] < 140:
    sys.exit("bundle was not produced by a full build")
print("bundle ok")
PY
python3 -m unittest discover -s tests -t . 2>&1 | tail -3
cd "$hidden" && PYTHONPATH="$repo" python3 -c '
from decimal import Decimal as D
from pricing import line_total
assert isinstance(line_total("1", 1), D)
assert line_total("0.005", 1) == D("0.01")
assert line_total("2.675", 1) == D("2.68")
assert line_total("10", 3, 33) == D("20.10")
assert line_total("0.10", 3) == D("0.30")
print("pricing ok")'
