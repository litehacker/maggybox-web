#!/usr/bin/env python3
"""
Fallback transcriber for MaggyBox (melody-dominant material).

Monophonic pitch tracking via librosa.pyin, note segmentation, MIDI output via
pretty_midi. Preserves absolute note pitch and timing.

Usage: python fallback_transcribe.py <input.wav> <output.mid>
"""
import sys

import numpy as np
import librosa
import pretty_midi


def _normalize(y: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak <= 0:
        return y
    return y / peak * 0.9


def _segment(f0: np.ndarray, voiced_prob: np.ndarray, times: np.ndarray, voicing_min: float) -> list[dict]:
    segments: list[dict] = []
    current = None

    def close(seg, end: float) -> None:
        if seg is not None:
            segments.append({"pitch": seg["pitch"], "start": seg["start"], "end": end})

    last_t = float(times[-1]) if times.size else 0.0
    for t, f, v in zip(times, f0, voiced_prob):
        hz = float(f) if f is not None and not np.isnan(f) else None
        if hz is None or float(v) < voicing_min:
            close(current, float(t))
            current = None
            continue
        pitch = int(round(float(librosa.hz_to_midi(hz))))
        pitch = max(0, min(127, pitch))
        if current is not None and current["pitch"] == pitch:
            continue
        close(current, float(t))
        current = {"pitch": pitch, "start": float(t)}
    close(current, last_t)
    return segments


def _pyin_notes(y: np.ndarray, sr: int, voicing_min: float) -> list[dict]:
    hop_length = 256
    f0, _voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
        frame_length=2048,
        hop_length=hop_length,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)
    min_dur = 0.05
    return [s for s in _segment(f0, voiced_prob, times, voicing_min) if s["end"] - s["start"] >= min_dur]


def transcribe(y: np.ndarray, sr: int) -> list[dict]:
    y = _normalize(y)
    y_harm, _y_perc = librosa.effects.hpss(y)
    for source in (y_harm, y):
        for voicing_min in (0.4, 0.2):
            notes = _pyin_notes(source, sr, voicing_min)
            if notes:
                return notes
    return []


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: fallback_transcribe.py <input.wav> <output.mid>", file=sys.stderr)
        return 2

    wav_path, out_path = sys.argv[1], sys.argv[2]

    y, sr = librosa.load(wav_path, sr=22050, mono=True)
    if y.size == 0:
        print("empty audio", file=sys.stderr)
        return 1

    segments = transcribe(y, sr)
    pm = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)
    for seg in segments:
        instrument.notes.append(
            pretty_midi.Note(
                velocity=90,
                pitch=seg["pitch"],
                start=seg["start"],
                end=max(seg["end"], seg["start"] + 0.05),
            )
        )
    pm.instruments.append(instrument)

    if len(instrument.notes) == 0:
        print("no voiced notes detected", file=sys.stderr)
        return 1

    pm.write(out_path)
    print(f"wrote {len(instrument.notes)} notes to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
