"""Evaluation integrity tests; no model required. python3 test-common-eval.py"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("scorer", Path(__file__).with_name("score-common-eval.py"))
scorer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scorer)


class EvaluationIntegrity(unittest.TestCase):
    def fixture(self):
        samples = [{"name": str(i), "role": "composed-diagnostic", "group": "english-word",
                    "writer": "w", "expected": "good", "target": "good", "strokes": [[[0, 0]]]} for i in range(2)]
        rows = [{"kind": "result", "name": "0", "final": True, "end": 1, "elapsed_ms": 10,
                 "candidates": [{"text": "god"}, {"text": "good"}]},
                {"kind": "error", "name": "1", "final": True, "end": 1, "elapsed_ms": 20}]
        return samples, rows, {"english-word": ["good", "hello"]}

    def test_failures_and_candidate_rank_stay_in_denominator(self):
        result = scorer.score(*self.fixture())
        group = result["by_role_and_group"]["composed-diagnostic/english-word"]
        self.assertEqual(group["samples"], 2)
        self.assertEqual(group["top1_accuracy"], 0)
        self.assertEqual(group["top5_accuracy"], .5)
        self.assertEqual(group["errors"], 1)
        self.assertEqual(group["cer"], 5 / 8)
        self.assertEqual(group["compute_p95_ms"], 20)

    def test_missing_duplicate_and_unknown_results_cannot_look_successful(self):
        samples, rows, targets = self.fixture()
        for bad in [rows[:1], rows + rows[:1], rows + [{**rows[0], "name": "unknown"}]]:
            with self.assertRaises(ValueError):
                scorer.score(samples, bad, targets)

    def test_composed_and_development_ink_do_not_fill_natural_coverage(self):
        result = scorer.score(*self.fixture())
        coverage = result["coverage"]["english-word"]
        self.assertEqual(coverage["any_ink_missing"], ["hello"])
        self.assertEqual(coverage["acceptance_missing_20_natural_writers"], ["good", "hello"])
        self.assertFalse(result["acceptance"]["passed"])

    def test_case_and_spaces_are_not_silently_normalized(self):
        self.assertEqual(scorer.distance("good", "Good"), 1)
        self.assertEqual(scorer.distance("中 API 30", "中API30"), 2)

    def test_missing_pen_up_is_detected_even_when_final_exists(self):
        samples, rows, targets = self.fixture()
        samples[0]["incremental"] = True
        samples[0]["strokes"] *= 2
        rows[0]["end"] = 2
        with self.assertRaises(ValueError):
            scorer.score(samples, rows, targets)

    def test_negative_empty_output_is_correct_but_engine_error_is_not(self):
        samples, rows, targets = self.fixture()
        for s in samples:
            s.update(group="negative", expected="", target="circle")
        rows[0]["candidates"] = []
        result = scorer.score(samples, rows, {"negative": ["circle"]})
        group = result["by_role_and_group"]["composed-diagnostic/negative"]
        self.assertEqual(group["top1_accuracy"], .5)
        self.assertIsNone(group["cer"])
        self.assertEqual(len(result["failures"]), 1)

    def test_retry_identity_and_stable_prefix_violations_are_reported(self):
        samples, rows, targets = self.fixture()
        rows[0].update(retry_equal=False, ids_equal=False, stable_text="goal")
        inv = scorer.score(samples, rows, targets)["invariants"]
        self.assertEqual(list(inv.values()), [1, 1, 1])


if __name__ == "__main__":
    unittest.main()
