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


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: fallback_transcribe.py <input.wav> <output.mid>", file=sys.stderr)
        return 2

    wav_path, out_path = sys.argv[1], sys.argv[2]

    # 22.05 kHz mono — matches Stage A output.
    y, sr = librosa.load(wav_path, sr=22050, mono=True)
    if y.size == 0:
        print("empty audio", file=sys.stderr)
        return 1

    hop_length = 256
    frame_length = 2048

    f0, voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sr,
        frame_length=frame_length,
        hop_length=hop_length,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=hop_length)

    # Segment the pitch track into notes: merge consecutive frames with the
    # same quantized MIDI pitch; frames below 80% voicing probability split notes.
    segments = []
    current = None  # {"pitch": int, "start": float}

    def close(seg, end):
        if seg is not None:
            segments.append({"pitch": seg["pitch"], "start": seg["start"], "end": end})

    last_t = float(times[-1]) if times.size else 0.0
    for t, f, v in zip(times, f0, voiced_prob):
        if f is None or np.isnan(f) or v < 0.8:
            close(current, float(t))
            current = None
            continue
        pitch = int(round(float(librosa.hz_to_midi(float(f)))))
        if current is not None and current["pitch"] == pitch:
            continue
        close(current, float(t))
        current = {"pitch": pitch, "start": float(t)}
    close(current, last_t)

    # Drop segments too short to sound (quantization noise).
    min_dur = 0.05
    segments = [s for s in segments if s["end"] - s["start"] >= min_dur]

    pm = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)  # acoustic grand
    for seg in segments:
        instrument.notes.append(
            pretty_midi.Note(
                velocity=90,
                pitch=seg["pitch"],
                start=seg["start"],
                end=max(seg["end"], seg["start"] + min_dur),
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
