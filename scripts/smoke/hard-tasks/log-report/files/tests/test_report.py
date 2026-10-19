import unittest

from logpipe.report import summarize

SAMPLE = """
2026-03-02T11:58:10+02:00 GET /a 200 100
2026-03-02T11:59:59+02:00 GET /b 500 300
2026-03-02T09:57:00Z GET /c 200 50
2026-03-02T10:01:00Z POST /d 201 70
2026-03-02T10:02:30Z GET /e 503 90
2026-03-02T10:03:00Z GET /f 200 10
""".splitlines()


class ReportTest(unittest.TestCase):
    def test_sample(self):
        self.assertEqual(
            summarize(SAMPLE),
            "2026-03-02 09:55 requests=3 errors=1 p50=100.0\n"
            "2026-03-02 10:00 requests=3 errors=1 p50=70.0",
        )


if __name__ == "__main__":
    unittest.main()
