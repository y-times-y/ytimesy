import unittest
from benchmarks.evaluation.report import paired_report


class PairedReportTests(unittest.TestCase):
    def setUp(self):
        self.protocol = {"tasks": [{"id": "task", "benchmark": "fixture"}], "repetitions": 2, "seed": 1}
        self.rows = [
            {"taskId": "task", "repetition": repetition, "arm": arm, "protocolSha256": "hash", "grade": {"passed": arm == "ytimesy", "failure": "infrastructure"}}
            for repetition in range(2) for arm in ("ytimesy", "native-codex")
        ]

    def test_repetitions_do_not_inflate_independent_sample(self):
        result = paired_report(self.protocol, self.rows, "hash")
        self.assertEqual(result["benchmarks"]["fixture"]["independent_tasks"], 1)
        self.assertEqual(result["failures_included_in_denominator"]["infrastructure"], 2)
        self.assertIsNone(result["acceptance_decision"])

    def test_missing_pair_rejected(self):
        with self.assertRaises(ValueError):
            paired_report(self.protocol, self.rows[:-1], "hash")

    def test_duplicate_pair_rejected(self):
        with self.assertRaises(ValueError):
            paired_report(self.protocol, self.rows + [self.rows[0]], "hash")

    def test_changed_protocol_rejected(self):
        with self.assertRaises(ValueError):
            paired_report(self.protocol, self.rows, "other")


if __name__ == "__main__":
    unittest.main()
