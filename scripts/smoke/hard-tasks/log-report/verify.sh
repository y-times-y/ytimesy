set -eo pipefail
git diff --quiet HEAD -- tests
python3 -m unittest discover -s tests -t . 2>&1 | tail -3
repo=$(pwd)
hidden=$(mktemp -d)
cat > "$hidden/hidden_report.py" <<'PY'
import unittest

from logpipe.report import summarize


class Hidden(unittest.TestCase):
    def test_negative_offset_and_midnight(self):
        lines = [
            "2026-12-31T20:31:00-05:30 GET /x 200 40",
            "2026-12-31T20:34:59-05:30 GET /y 502 60",
            "2027-01-01T02:05:00+00:00 GET /z 200 7",
        ]
        self.assertEqual(
            summarize(lines),
            "2027-01-01 02:00 requests=2 errors=1 p50=50.0\n"
            "2027-01-01 02:05 requests=1 errors=0 p50=7.0",
        )

    def test_ordering_across_hours_and_days(self):
        lines = [
            "2026-05-02T00:00:01Z GET /a 200 1",
            "2026-05-01T23:59:00Z GET /b 200 2",
            "2026-05-01T09:59:00Z GET /c 200 3",
            "2026-05-01T10:00:00Z GET /d 200 4",
        ]
        self.assertEqual(
            summarize(lines, minutes=1).splitlines(),
            [
                "2026-05-01 09:59 requests=1 errors=0 p50=3.0",
                "2026-05-01 10:00 requests=1 errors=0 p50=4.0",
                "2026-05-01 23:59 requests=1 errors=0 p50=2.0",
                "2026-05-02 00:00 requests=1 errors=0 p50=1.0",
            ],
        )

    def test_even_median_and_wide_window(self):
        lines = [
            "2026-01-01T08:10:00+01:00 GET /a 200 10",
            "2026-01-01T08:20:00+01:00 GET /b 200 20",
            "2026-01-01T08:25:00+01:00 GET /c 500 35",
            "2026-01-01T08:29:59+01:00 GET /d 200 1000",
        ]
        self.assertEqual(
            summarize(lines, minutes=30),
            "2026-01-01 07:00 requests=4 errors=1 p50=27.5",
        )


if __name__ == "__main__":
    unittest.main()
PY
cd "$hidden" && PYTHONPATH="$repo" python3 hidden_report.py 2>&1 | tail -4
