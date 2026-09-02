#!/usr/bin/env python3
from __future__ import annotations

import unittest

from two_voice import count_internal_overlaps, split_two_voices


def note(
    pitch: int,
    start: float,
    end: float,
    confidence: float = 0.8,
    velocity: int = 90,
) -> dict:
    return {
        "pitch": pitch,
        "start": start,
        "end": end,
        "confidence": confidence,
        "velocity": velocity,
    }


class TwoVoiceTests(unittest.TestCase):
    def assert_monophonic(self, notes: list[dict]) -> None:
        self.assertEqual(count_internal_overlaps(notes), 0)

    def test_empty_and_single_note(self) -> None:
        self.assertEqual(split_two_voices([]), ([], []))
        lead, accompaniment = split_two_voices([note(72, 0.0, 0.5)])
        self.assertEqual([item["pitch"] for item in lead], [72])
        self.assertEqual(accompaniment, [])

    def test_splits_simultaneous_upper_and_lower_lines(self) -> None:
        candidates = [
            note(72, 0.0, 0.4),
            note(60, 0.0, 0.9),
            note(74, 0.5, 0.9),
            note(62, 0.5, 1.4),
            note(76, 1.0, 1.4),
            note(64, 1.0, 1.9),
        ]
        lead, accompaniment = split_two_voices(candidates)
        self.assertGreaterEqual(len(lead), 3)
        self.assertGreaterEqual(len(accompaniment), 2)
        self.assertGreater(
            sum(item["pitch"] for item in lead) / len(lead),
            sum(item["pitch"] for item in accompaniment) / len(accompaniment),
        )
        self.assert_monophonic(lead)
        self.assert_monophonic(accompaniment)

    def test_collapses_duplicate_candidates(self) -> None:
        candidates = [
            note(72, 0.0, 0.4, 0.7),
            note(72, 0.02, 0.45, 0.9),
            note(60, 0.0, 0.8),
        ]
        lead, accompaniment = split_two_voices(candidates)
        selected = lead + accompaniment
        self.assertEqual(sum(item["pitch"] == 72 for item in selected), 1)

    def test_preserves_real_repeated_notes(self) -> None:
        candidates = [
            note(72, 0.0, 0.22),
            note(60, 0.0, 0.7),
            note(72, 0.3, 0.52),
            note(74, 0.6, 0.82),
            note(62, 0.75, 1.3),
        ]
        lead, _ = split_two_voices(candidates)
        starts = [round(item["start"], 2) for item in lead if item["pitch"] == 72]
        self.assertEqual(starts, [0.0, 0.3])

    def test_keeps_at_most_two_notes_per_onset_cluster(self) -> None:
        candidates = [
            note(76, 0.0, 0.4, 0.8),
            note(72, 0.0, 0.4, 0.7),
            note(67, 0.0, 0.8, 0.9),
            note(60, 0.0, 1.0, 0.85),
        ]
        lead, accompaniment = split_two_voices(candidates)
        selected_at_zero = [
            item
            for item in lead + accompaniment
            if abs(item["start"]) < 0.075
        ]
        self.assertLessEqual(len(selected_at_zero), 2)
        self.assert_monophonic(lead)
        self.assert_monophonic(accompaniment)

    def test_resolves_overlaps_inside_each_voice(self) -> None:
        candidates = [
            note(72, 0.0, 0.7),
            note(60, 0.0, 1.2),
            note(74, 0.5, 1.0),
            note(62, 0.8, 1.6),
            note(76, 1.1, 1.5),
        ]
        lead, accompaniment = split_two_voices(candidates)
        self.assert_monophonic(lead)
        self.assert_monophonic(accompaniment)

    def test_output_is_deterministic(self) -> None:
        candidates = [
            note(79, 0.0, 0.4, 0.71),
            note(67, 0.0, 0.9, 0.73),
            note(77, 0.5, 0.9, 0.72),
            note(65, 0.5, 1.4, 0.74),
        ]
        first_result = split_two_voices(candidates)
        second_result = split_two_voices([dict(item) for item in candidates])
        self.assertEqual(first_result, second_result)


if __name__ == "__main__":
    unittest.main()
