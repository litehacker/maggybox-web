#!/usr/bin/env python3
"""
MaggyBox melody → MIDI.

Lead isolation uses a fixed Kim Vocal 2 MDX model before Spotify Basic Pitch
(Bittner et al., ICASSP 2022):
https://engineering.atspotify.com/2022/6/meet-basic-pitch
https://github.com/spotify/basic-pitch

The model is a lightweight CNN on a harmonic CQT. It jointly predicts
onsets, note frames, and a pitch contour — that is why repeated notes
on the same pitch become separate events, which a raw F0 tracker cannot do.

We call `basic_pitch.inference.predict` (not the CLI), then deterministically
select two internally monophonic tracks. The lead comes from the isolated vocal
stem; the lower accompaniment comes from the full mix so the separator cannot
erase harmonic candidates.

Fallback if separation fails: Basic Pitch on the full mix. Fallback if
Basic Pitch is missing: librosa pYIN.

Usage: python melody_transcribe.py <input.wav> <output.mid>
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Iterable

import numpy as np
import librosa
import pretty_midi

from two_voice import count_internal_overlaps, split_two_voices

MELODY_FMIN = float(librosa.note_to_hz("C2"))
MELODY_FMAX = float(librosa.note_to_hz("C7"))
MIN_NOTE_SEC = 0.05
SEPARATOR_MODEL = os.environ.get("AUDIO_SEPARATOR_MODEL", "Kim_Vocal_2.onnx")


def transcribe_basic_pitch(wav_path: str) -> list[dict]:
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
        melodia_trick=False,
    )
    notes: list[dict] = []
    for start, end, pitch, amplitude, _bends in note_events:
        notes.append(
            {
                "pitch": int(pitch),
                "start": float(start),
                "end": float(end),
                "confidence": float(amplitude),
                "velocity": int(np.clip(np.round(40 + 87 * float(amplitude)), 40, 127)),
            }
        )
    return notes


def _prepare_ffmpeg_path() -> None:
    """Expose npm-bundled ffmpeg to audio-separator on local Windows runs."""
    ffmpeg_bin = os.environ.get("FFMPEG_BIN")
    if not ffmpeg_bin or ffmpeg_bin == "ffmpeg":
        return
    ffmpeg_dir = str(Path(ffmpeg_bin).resolve().parent)
    current_path = os.environ.get("PATH", "")
    if ffmpeg_dir not in current_path.split(os.pathsep):
        os.environ["PATH"] = os.pathsep.join((ffmpeg_dir, current_path))


def transcribe_with_separation(wav_path: str) -> tuple[list[dict], list[dict]]:
    """Use isolated vocals for lead selection and the mix for accompaniment."""
    from audio_separator.separator import Separator

    _prepare_ffmpeg_path()
    default_model_dir = Path.home() / ".cache" / "audio-separator"
    model_dir = os.environ.get("AUDIO_SEPARATOR_MODEL_DIR", str(default_model_dir))
    work_dir = str(Path(wav_path).resolve().parent)
    with TemporaryDirectory(prefix="maggybox-stems-", dir=work_dir) as output_dir:
        separator = Separator(
            log_level=logging.WARNING,
            model_file_dir=model_dir,
            output_dir=output_dir,
            output_format="WAV",
            output_single_stem="Vocals",
            use_soundfile=True,
        )
        separator.load_model(model_filename=SEPARATOR_MODEL)
        outputs = separator.separate(wav_path)
        vocal_output = next(
            (output for output in outputs if "vocal" in output.lower()),
            None,
        )
        if vocal_output is None:
            raise RuntimeError("vocal separator produced no vocal stem")
        vocal_path = Path(vocal_output)
        if not vocal_path.is_absolute():
            vocal_path = Path(output_dir, vocal_path)

        vocal_lead, _discarded = split_two_voices(transcribe_basic_pitch(str(vocal_path)))
        _discarded, accompaniment = split_two_voices(transcribe_basic_pitch(wav_path))
        return vocal_lead, accompaniment


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
            notes.append({**current, "end": end, "confidence": 0.5, "velocity": 90})
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


def make_instrument(name: str, notes: Iterable[dict]) -> pretty_midi.Instrument:
    instrument = pretty_midi.Instrument(program=0, name=name)
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
    return instrument


def write_midi(lead: Iterable[dict], accompaniment: Iterable[dict], out_path: str) -> int:
    lead_notes = list(lead)
    accompaniment_notes = list(accompaniment)
    pm = pretty_midi.PrettyMIDI()
    pm.instruments.append(make_instrument("Lead Melody", lead_notes))
    pm.instruments.append(make_instrument("Lower Accompaniment", accompaniment_notes))
    count = len(lead_notes) + len(accompaniment_notes)
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
        try:
            lead, accompaniment = transcribe_with_separation(wav_path)
            engine = "mdx-vocals+basic-pitch"
        except Exception as err:
            print(
                f"vocal separation failed ({err}); using full-mix Basic Pitch",
                file=sys.stderr,
            )
            lead, accompaniment = split_two_voices(transcribe_basic_pitch(wav_path))
            engine = "basic-pitch"
    except Exception as err:
        print(f"basic-pitch failed ({err}); falling back to pYIN", file=sys.stderr)
        lead = transcribe_pyin(wav_path)
        accompaniment = []
        engine = "pyin"

    if count_internal_overlaps(lead) or count_internal_overlaps(accompaniment):
        print("internal voice overlap invariant failed", file=sys.stderr)
        return 1

    written = write_midi(lead, accompaniment, out_path)
    if written == 0:
        print("no voiced notes detected", file=sys.stderr)
        return 1
    print(f"wrote {written} notes via {engine} to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
