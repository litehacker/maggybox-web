#!/usr/bin/env python3
"""Compare generated two-track MIDI with an external reference MIDI."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from typing import Iterable
from urllib.request import urlopen

import pretty_midi

ONSET_TOLERANCE_SEC = 0.18
QUALITY_TARGET_F1 = 0.9


def load_midi(source: str) -> pretty_midi.PrettyMIDI:
    if source.startswith(("http://", "https://")):
        with urlopen(source) as response:
            return pretty_midi.PrettyMIDI(io.BytesIO(response.read()))
    return pretty_midi.PrettyMIDI(str(Path(source)))


def internal_overlaps(notes: Iterable[pretty_midi.Note]) -> int:
    ordered = sorted(notes, key=lambda note: (note.start, note.end))
    return sum(
        1
        for previous, current in zip(ordered, ordered[1:])
        if current.start < previous.end - 1e-6
    )


def cross_track_overlaps(
    upper: Iterable[pretty_midi.Note],
    lower: Iterable[pretty_midi.Note],
) -> int:
    upper_notes = sorted(upper, key=lambda note: note.start)
    lower_notes = sorted(lower, key=lambda note: note.start)
    count = 0
    lower_start = 0
    for note in upper_notes:
        while lower_start < len(lower_notes) and lower_notes[lower_start].end <= note.start:
            lower_start += 1
        index = lower_start
        while index < len(lower_notes) and lower_notes[index].start < note.end:
            if lower_notes[index].end > note.start:
                count += 1
            index += 1
    return count


def notes_by_pitch(notes: Iterable[pretty_midi.Note]) -> dict[int, list[float]]:
    grouped: dict[int, list[float]] = {}
    for note in notes:
        grouped.setdefault(note.pitch, []).append(note.start)
    for onsets in grouped.values():
        onsets.sort()
    return grouped


def match_count(
    reference: Iterable[pretty_midi.Note],
    generated: Iterable[pretty_midi.Note],
    scale: float,
    offset: float,
) -> int:
    reference_by_pitch = notes_by_pitch(reference)
    generated_by_pitch = notes_by_pitch(generated)
    matched = 0
    for pitch, generated_onsets in generated_by_pitch.items():
        reference_onsets = reference_by_pitch.get(pitch, [])
        reference_index = 0
        for generated_onset in generated_onsets:
            transformed = generated_onset * scale + offset
            while (
                reference_index < len(reference_onsets)
                and reference_onsets[reference_index] < transformed - ONSET_TOLERANCE_SEC
            ):
                reference_index += 1
            if (
                reference_index < len(reference_onsets)
                and abs(reference_onsets[reference_index] - transformed) <= ONSET_TOLERANCE_SEC
            ):
                matched += 1
                reference_index += 1
    return matched


def estimate_alignment(
    reference: pretty_midi.PrettyMIDI,
    generated: pretty_midi.PrettyMIDI,
) -> tuple[float, float]:
    if not reference.instruments or not generated.instruments:
        return 1.0, 0.0
    reference_notes = reference.instruments[0].notes
    generated_notes = generated.instruments[0].notes
    if not reference_notes or not generated_notes:
        return 1.0, 0.0

    duration_ratio = reference.get_end_time() / max(generated.get_end_time(), 1e-6)
    center_scale = max(0.85, min(1.15, duration_ratio))
    scales = [center_scale * (0.97 + index * 0.005) for index in range(13)]
    offsets = [-10.0 + index * 0.1 for index in range(201)]
    candidates = (
        (
            match_count(reference_notes, generated_notes, scale, offset),
            -abs(scale - center_scale),
            -abs(offset),
            scale,
            offset,
        )
        for scale in scales
        for offset in offsets
    )
    _matches, _scale_distance, _offset_distance, scale, offset = max(candidates)
    return scale, offset


def track_stats(
    reference: list[pretty_midi.Note],
    generated: list[pretty_midi.Note],
    scale: float,
    offset: float,
) -> dict:
    matched = match_count(reference, generated, scale, offset)
    precision = matched / len(generated) if generated else 0.0
    recall = matched / len(reference) if reference else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    pitches = [note.pitch for note in generated]
    return {
        "referenceNotes": len(reference),
        "generatedNotes": len(generated),
        "generatedPitchRange": [min(pitches), max(pitches)] if pitches else None,
        "internalOverlaps": internal_overlaps(generated),
        "onsetPitchMatches": matched,
        "onsetPitchPrecision": round(precision, 4),
        "onsetPitchRecall": round(recall, 4),
        "onsetPitchF1": round(f1, 4),
    }


def compare(reference: pretty_midi.PrettyMIDI, generated: pretty_midi.PrettyMIDI) -> dict:
    scale, offset = estimate_alignment(reference, generated)
    track_count = max(2, len(reference.instruments), len(generated.instruments))
    tracks = []
    for index in range(track_count):
        reference_notes = (
            reference.instruments[index].notes if index < len(reference.instruments) else []
        )
        generated_notes = (
            generated.instruments[index].notes if index < len(generated.instruments) else []
        )
        tracks.append(track_stats(reference_notes, generated_notes, scale, offset))

    generated_upper = generated.instruments[0].notes if generated.instruments else []
    generated_lower = generated.instruments[1].notes if len(generated.instruments) > 1 else []
    evaluated_tracks = tracks[:2]
    quality_passed = all(
        track["onsetPitchF1"] >= QUALITY_TARGET_F1
        for track in evaluated_tracks
    )
    return {
        "alignment": {"timeScale": round(scale, 6), "offsetSec": round(offset, 3)},
        "referenceTrackCount": len(reference.instruments),
        "generatedTrackCount": len(generated.instruments),
        "generatedCrossTrackOverlaps": cross_track_overlaps(
            generated_upper,
            generated_lower,
        ),
        "tracks": tracks,
        "qualityGate": {
            "metric": "per-track onset-and-pitch F1",
            "target": QUALITY_TARGET_F1,
            "passed": quality_passed,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", help="Reference MIDI path")
    parser.add_argument("generated", help="Generated MIDI path or URL")
    parser.add_argument(
        "--require-target",
        action="store_true",
        help="exit non-zero unless both lead and accompaniment reach the quality target",
    )
    args = parser.parse_args()
    result = compare(load_midi(args.reference), load_midi(args.generated))
    print(json.dumps(result, indent=2))
    if args.require_target and not result["qualityGate"]["passed"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
