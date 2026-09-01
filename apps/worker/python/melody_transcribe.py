#!/usr/bin/env python3
"""
MaggyBox melody → MIDI.

Note source is Spotify Basic Pitch (Bittner et al., ICASSP 2022):
https://engineering.atspotify.com/2022/6/meet-basic-pitch
https://github.com/spotify/basic-pitch

The model is a lightweight CNN on a harmonic CQT. It jointly predicts
onsets, note frames, and a pitch contour — that is why repeated notes
on the same pitch become separate events, which a raw F0 tracker cannot do.

We call `basic_pitch.inference.predict` (not the CLI), then write a single
piano track. Frequency is limited to the lead/melody band so bass and drums
do not fill the roll.

Fallback if basic-pitch is missing: librosa pYIN.

Usage: python melody_transcribe.py <input.wav> <output.mid>
"""
from __future__ import annotations

import sys
from typing import Iterable

import numpy as np
import librosa
import pretty_midi

MELODY_FMIN = float(librosa.note_to_hz("C2"))
MELODY_FMAX = float(librosa.note_to_hz("C7"))
MIN_NOTE_SEC = 0.05


def transcribe_basic_pitch(wav_path: str) -> list[dict]:
    import logging

    logging.getLogger("root").setLevel(logging.ERROR)
    from basic_pitch.inference import predict

    # Spotify defaults: onset 0.5, frame 0.3, melodia_trick True.
    # Slightly lower onset threshold so sung/lead attacks are not dropped.
    _output, _midi, note_events = predict(
        wav_path,
        onset_threshold=0.4,
        frame_threshold=0.3,
        minimum_note_length=80.0,
        minimum_frequency=MELODY_FMIN,
        maximum_frequency=MELODY_FMAX,
        multiple_pitch_bends=False,
        melodia_trick=True,
    )
    notes: list[dict] = []
    for start, end, pitch, amplitude, _bends in note_events:
        notes.append(
            {
                "pitch": int(pitch),
                "start": float(start),
                "end": float(end),
                "velocity": int(np.clip(np.round(40 + 87 * float(amplitude)), 40, 127)),
            }
        )
    return notes


def drop_accompaniment(notes: list[dict]) -> list[dict]:
    """Keep the lead: drop notes covered by a higher pitch, and notes more than
    an octave below the median of the transcription."""
    if len(notes) < 2:
        return notes
    kept: list[dict] = []
    for note in notes:
        duration = max(note["end"] - note["start"], 1e-6)
        covered = False
        for other in notes:
            if other is note or other["pitch"] <= note["pitch"]:
                continue
            overlap = min(note["end"], other["end"]) - max(note["start"], other["start"])
            if overlap > 0.45 * duration:
                covered = True
                break
        if not covered:
            kept.append(note)
    if not kept:
        kept = notes
    median = float(np.median([n["pitch"] for n in kept]))
    return [n for n in kept if n["pitch"] >= median - 12]


def transcribe_pyin(wav_path: str) -> list[dict]:
    """Last-resort monophonic fallback if basic-pitch is not installed."""
    y, sr = librosa.load(wav_path, sr=22050, mono=True)
    y = librosa.util.normalize(y) * 0.9
    harmonic, _ = librosa.effects.hpss(y)
    hop = 256
    f0, _flag, voiced = librosa.pyin(
        harmonic,
        fmin=MELODY_FMIN,
        fmax=MELODY_FMAX,
        sr=sr,
        hop_length=hop,
        frame_length=2048,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=hop)
    notes: list[dict] = []
    current: dict | None = None

    def close(end: float) -> None:
        nonlocal current
        if current is None:
            return
        if end - current["start"] >= MIN_NOTE_SEC:
            notes.append({**current, "end": end, "velocity": 90})
        current = None

    for t, hz, conf in zip(times, f0, voiced):
        if hz is None or not np.isfinite(hz) or float(conf) < 0.3:
            close(float(t))
            continue
        pitch = int(np.clip(np.round(librosa.hz_to_midi(float(hz))), 0, 127))
        if current is not None and current["pitch"] == pitch:
            continue
        close(float(t))
        current = {"pitch": pitch, "start": float(t)}
    close(float(times[-1]) if times.size else 0.0)
    return notes


def write_midi(notes: Iterable[dict], out_path: str) -> int:
    pm = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)
    count = 0
    for note in sorted(notes, key=lambda n: (n["start"], n["pitch"])):
        start = float(note["start"])
        end = max(float(note["end"]), start + MIN_NOTE_SEC)
        instrument.notes.append(
            pretty_midi.Note(
                velocity=int(note.get("velocity", 90)),
                pitch=int(note["pitch"]),
                start=start,
                end=end,
            )
        )
        count += 1
    pm.instruments.append(instrument)
    if count == 0:
        return 0
    pm.write(out_path)
    return count


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: melody_transcribe.py <input.wav> <output.mid>", file=sys.stderr)
        return 2

    wav_path, out_path = sys.argv[1], sys.argv[2]

    try:
        notes = drop_accompaniment(transcribe_basic_pitch(wav_path))
        engine = "basic-pitch"
    except Exception as err:
        print(f"basic-pitch failed ({err}); falling back to pYIN", file=sys.stderr)
        notes = transcribe_pyin(wav_path)
        engine = "pyin"

    written = write_midi(notes, out_path)
    if written == 0:
        print("no voiced notes detected", file=sys.stderr)
        return 1
    print(f"wrote {written} notes via {engine} to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
