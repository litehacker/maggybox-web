import unittest

import pretty_midi

from compare_midi import compare


def make_midi(track_pitches: list[list[int]]) -> pretty_midi.PrettyMIDI:
    midi = pretty_midi.PrettyMIDI()
    for track_index, pitches in enumerate(track_pitches):
        instrument = pretty_midi.Instrument(program=0, name=f"Track {track_index}")
        for index, pitch in enumerate(pitches):
            start = index * 0.5
            instrument.notes.append(
                pretty_midi.Note(
                    velocity=90,
                    pitch=pitch,
                    start=start,
                    end=start + 0.4,
                )
            )
        midi.instruments.append(instrument)
    return midi


class CompareMidiTests(unittest.TestCase):
    def test_identical_two_track_midi_passes_quality_gate(self) -> None:
        reference = make_midi([[72, 74, 75], [60, 62]])
        result = compare(reference, make_midi([[72, 74, 75], [60, 62]]))

        self.assertTrue(result["qualityGate"]["passed"])
        self.assertEqual([track["onsetPitchF1"] for track in result["tracks"]], [1.0, 1.0])

    def test_poor_accompaniment_cannot_be_hidden_by_lead(self) -> None:
        reference = make_midi([[72, 74, 75], [60, 62]])
        result = compare(reference, make_midi([[72, 74, 75], [65, 67]]))

        self.assertEqual(result["tracks"][0]["onsetPitchF1"], 1.0)
        self.assertEqual(result["tracks"][1]["onsetPitchF1"], 0.0)
        self.assertFalse(result["qualityGate"]["passed"])


if __name__ == "__main__":
    unittest.main()
