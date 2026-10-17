set -eo pipefail
test -f csvstat.py
clean=$(mktemp -d)
cp csvstat.py "$clean/"
cd "$clean"
printf 'name,score,note\nada," 3 ","x, y"\nbob,4.5,\n"cy, jr",nan,ok\ndee,,\neve,abc\nfay,10,"he said ""hi"""\nshort\n' > data.csv
out=$(python3 csvstat.py data.csv --column score --format json)
python3 - "$out" <<'PY'
import json, sys
got = json.loads(sys.argv[1])
want = {"column": "score", "count": 3, "skipped": 4, "mean": 5.8333, "median": 4.5, "min": 3.0, "max": 10.0}
assert set(got) == set(want), got
for key, value in want.items():
    assert (abs(got[key] - value) < 1e-9) if isinstance(value, float) else got[key] == value, (key, got[key], value)
PY
out=$(python3 csvstat.py - --column score --format json < data.csv)
python3 -c "import json,sys; assert json.loads(sys.argv[1])['count'] == 3" "$out"
printf 'a,b\n1,x\n2,y\n3,z\n4,w\n' > even.csv
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['median']==2.5 and d['mean']==2.5 and d['skipped']==0, d" "$(python3 csvstat.py even.csv --column a --format json)"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert d['count']==0 and d['skipped']==4 and d['mean'] is None and d['median'] is None and d['min'] is None and d['max'] is None, d" "$(python3 csvstat.py even.csv --column b --format json)"
text=$(python3 csvstat.py data.csv --column score)
[ "$(printf '%s\n' "$text" | head -n 1)" = "column: score" ] || { echo "text: $text"; exit 1; }
printf '%s\n' "$text" | grep -qx 'mean: 5.8333' || { echo "text: $text"; exit 1; }
printf '%s\n' "$(python3 csvstat.py even.csv --column b)" | grep -qx 'mean: n/a'
set +e
python3 csvstat.py data.csv --column missing_col > out.txt 2> err.txt; code=$?
set -e
[ "$code" = 2 ] && grep -q missing_col err.txt || { echo "missing column: exit $code"; cat err.txt; exit 1; }
set +e
python3 csvstat.py nope.csv --column a > /dev/null 2> err2.txt; code=$?
set -e
[ "$code" = 2 ] && grep -q nope.csv err2.txt || { echo "missing file: exit $code"; exit 1; }
echo "csvstat ok"
