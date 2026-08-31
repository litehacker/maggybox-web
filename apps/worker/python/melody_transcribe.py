#!/usr/bin/env python3
"""
MaggyBox melody → MIDI decoder.

Pipeline (hop = 10 ms):
  1. 16 kHz mono, high-pass ~80 Hz
  2. HPSS harmonic residual
  3. CQT + harmonic-summation salience (MELODIA-style)
  4. CREPE F0 (pYIN fallback)
  5. Fuse the two streams
  6. Contour Viterbi over MIDI 48–84
  7. SuperFlux onsets split same-pitch repeats
  8. Median-cents notes, hysteresis, merge, octave guard, RMS velocity

Usage: python melody_transcribe.py <input.wav> <output.mid>
"""
from __future__ import annotations

import sys
from typing import Iterable

import numpy as np
import librosa
import pretty_midi

SR = 16000
HOP = 160  # 10 ms at 16 kHz
FMIN_CQT = float(librosa.note_to_hz("C2"))
BINS_PER_OCTAVE = 36
N_OCTAVES = 4
N_HARMONICS = 8
HARMONIC_ALPHA = 0.8
MELODY_FMIN = float(librosa.note_to_hz("C3"))  # ~130 Hz
MELODY_FMAX = float(librosa.note_to_hz("C6"))  # ~1047 Hz
MIDI_LO = 48
MIDI_HI = 84
HIGHPASS_HZ = 80.0
FUSE_CENTS = 50.0
CREPE_HIGH_CONF = 0.8
SALIENCE_PEAK_RATIO = 2.0
VOICING_ENTER = 0.75
VOICING_EXIT = 0.25
MIN_NOTE_SEC = 0.07
MERGE_GAP_SEC = 0.07
ONSET_EDGE_SEC = 0.04
MEDIAN_FRAMES = 5


def _as1d(value) -> np.ndarray:
    if hasattr(value, "detach"):
        value = value.detach().cpu().numpy()
    return np.asarray(value, dtype=np.float64).reshape(-1)


def _highpass(y: np.ndarray, sr: int) -> np.ndarray:
    try:
        from scipy.signal import butter, sosfilt

        sos = butter(4, HIGHPASS_HZ, btype="highpass", fs=sr, output="sos")
        return sosfilt(sos, y).astype(np.float32)
    except Exception:
        return librosa.effects.preemphasis(y)


def _normalize(y: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak <= 0:
        return y
    return (y / peak * 0.9).astype(np.float32)


def _hz_to_midi(hz: np.ndarray | float) -> np.ndarray | float:
    hz_arr = np.asarray(hz, dtype=np.float64)
    midi = 69.0 + 12.0 * np.log2(np.maximum(hz_arr, 1e-8) / 440.0)
    if np.isscalar(hz):
        return float(midi)
    return midi


def _midi_to_hz(midi: float) -> float:
    return float(440.0 * (2.0 ** ((midi - 69.0) / 12.0)))


def _cents(hz: float) -> float:
    return 100.0 * float(_hz_to_midi(hz))


def _median_filter(x: np.ndarray, width: int) -> np.ndarray:
    if width < 2 or x.size == 0:
        return x
    k = width if width % 2 else width + 1
    pad = k // 2
    xp = np.pad(x, pad, mode="edge")
    return np.array([np.median(xp[i : i + k]) for i in range(x.size)], dtype=x.dtype)


def harmonic_salience(mag: np.ndarray, bins_per_octave: int = BINS_PER_OCTAVE) -> np.ndarray:
    """MELODIA-style weighted sum of harmonic CQT bins onto each fundamental."""
    n_bins, _n_frames = mag.shape
    salience = np.zeros_like(mag, dtype=np.float64)
    for harmonic in range(1, N_HARMONICS + 1):
        shift = int(round(bins_per_octave * np.log2(harmonic)))
        weight = HARMONIC_ALPHA ** (harmonic - 1)
        if shift == 0:
            salience += weight * mag
        elif shift < n_bins:
            salience[: n_bins - shift] += weight * mag[shift:]
    return salience


def cqt_salience_stream(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    n_bins = BINS_PER_OCTAVE * N_OCTAVES
    mag = np.abs(
        librosa.cqt(
            y,
            sr=sr,
            hop_length=HOP,
            fmin=FMIN_CQT,
            n_bins=n_bins,
            bins_per_octave=BINS_PER_OCTAVE,
        )
    )
    salience = harmonic_salience(mag)
    freqs = librosa.cqt_frequencies(n_bins=n_bins, fmin=FMIN_CQT, bins_per_octave=BINS_PER_OCTAVE)
    lo = int(np.searchsorted(freqs, MELODY_FMIN, side="left"))
    hi = int(np.searchsorted(freqs, MELODY_FMAX, side="right")) - 1
    lo = max(0, min(lo, n_bins - 1))
    hi = max(lo, min(hi, n_bins - 1))
    band = salience[lo : hi + 1]
    peak_idx = np.argmax(band, axis=0) + lo
    f_sal = freqs[peak_idx]
    peak = salience[peak_idx, np.arange(salience.shape[1])]
    median = np.median(band, axis=0) + 1e-8
    clear = peak / median >= SALIENCE_PEAK_RATIO
    peak_p95 = float(np.percentile(peak, 95)) + 1e-8
    conf = np.clip(peak / peak_p95, 0.0, 1.0)
    conf = np.where(clear, np.maximum(conf, 0.35), conf * 0.5)
    return f_sal.astype(np.float64), conf.astype(np.float64), clear


def crepe_stream(y: np.ndarray, sr: int, n_frames: int) -> tuple[np.ndarray, np.ndarray] | None:
    try:
        import torch
        import torchcrepe
    except Exception:
        return None
    try:
        audio = torch.tensor(y, dtype=torch.float32)[None, :]
        pitch, periodicity = torchcrepe.predict(
            audio,
            sr,
            HOP,
            fmin=50.0,
            fmax=MELODY_FMAX,
            model="tiny",
            batch_size=1024,
            device="cpu",
            return_periodicity=True,
            decoder=torchcrepe.decode.viterbi,
        )
        f0 = _as1d(pitch)
        conf = np.clip(_as1d(periodicity), 0.0, 1.0)
        return _match_length(f0, n_frames), _match_length(conf, n_frames)
    except Exception as err:
        print(f"CREPE failed ({err}); using pYIN", file=sys.stderr)
        return None


def pyin_stream(y: np.ndarray, sr: int, n_frames: int) -> tuple[np.ndarray, np.ndarray]:
    f0, _flag, voiced_prob = librosa.pyin(
        y,
        fmin=MELODY_FMIN,
        fmax=MELODY_FMAX,
        sr=sr,
        hop_length=HOP,
        frame_length=2048,
    )
    hz = np.nan_to_num(np.asarray(f0, dtype=np.float64), nan=0.0)
    conf = np.nan_to_num(np.asarray(voiced_prob, dtype=np.float64), nan=0.0)
    voiced = hz > 0
    return _match_length(np.where(voiced, hz, 0.0), n_frames), _match_length(np.where(voiced, conf, 0.0), n_frames)


def _match_length(x: np.ndarray, n: int) -> np.ndarray:
    if x.size == n:
        return x
    if x.size > n:
        return x[:n]
    out = np.zeros(n, dtype=np.float64)
    out[: x.size] = x
    return out


def fuse_streams(
    f_sal: np.ndarray,
    sal_conf: np.ndarray,
    sal_clear: np.ndarray,
    f_f0: np.ndarray,
    f0_conf: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    n = f_sal.size
    fused_hz = np.zeros(n, dtype=np.float64)
    fused_conf = np.zeros(n, dtype=np.float64)
    for i in range(n):
        crepe_voiced = f_f0[i] > 0 and f0_conf[i] >= 0.21
        sal_voiced = sal_clear[i] and f_sal[i] > 0
        if crepe_voiced and sal_voiced and abs(_cents(f_f0[i]) - _cents(f_sal[i])) <= FUSE_CENTS:
            fused_hz[i] = f_f0[i]
            fused_conf[i] = max(float(f0_conf[i]), float(sal_conf[i]))
        elif f0_conf[i] >= CREPE_HIGH_CONF and f_f0[i] > 0:
            fused_hz[i] = f_f0[i]
            fused_conf[i] = float(f0_conf[i])
        elif sal_voiced:
            fused_hz[i] = f_sal[i]
            fused_conf[i] = max(float(sal_conf[i]), 0.4)
        else:
            fused_hz[i] = 0.0
            fused_conf[i] = 0.0
    voiced = fused_hz > 0
    if np.any(voiced):
        smoothed = _median_filter(fused_hz, MEDIAN_FRAMES)
        fused_hz = np.where(voiced, smoothed, 0.0)
    return fused_hz, fused_conf


def viterbi_contour(fused_hz: np.ndarray, fused_conf: np.ndarray) -> np.ndarray:
    n_pitch = MIDI_HI - MIDI_LO + 1
    unvoiced = n_pitch
    n_states = n_pitch + 1
    n_frames = fused_hz.size

    trans = np.zeros((n_states, n_states), dtype=np.float64)
    for src in range(n_states):
        for dst in range(n_states):
            src_u = src == unvoiced
            dst_u = dst == unvoiced
            if src_u and dst_u:
                trans[src, dst] = 0.0
            elif src_u and not dst_u:
                trans[src, dst] = 2.5
            elif not src_u and dst_u:
                trans[src, dst] = 1.5
            else:
                delta = abs(src - dst)
                if delta <= 2:
                    trans[src, dst] = 0.0
                elif delta <= 7:
                    trans[src, dst] = 1.5 * delta
                else:
                    trans[src, dst] = 25.0

    emit = np.empty((n_frames, n_states), dtype=np.float64)
    sigma = 0.5
    pitches = np.arange(MIDI_LO, MIDI_HI + 1, dtype=np.float64)
    voiced = (fused_hz > 0) & (fused_conf > 0.05)
    obs = np.zeros(n_frames, dtype=np.float64)
    obs[voiced] = np.asarray(_hz_to_midi(fused_hz[voiced]), dtype=np.float64)
    conf = fused_conf.astype(np.float64)
    pitch_cost = 0.5 * ((obs[:, None] - pitches[None, :]) / sigma) ** 2 - np.log(conf[:, None] + 1e-3)
    emit[:, :n_pitch] = np.where(voiced[:, None], pitch_cost, 6.0)
    emit[:, unvoiced] = np.where(voiced, 3.0 + 4.0 * conf, 0.4)

    dp = np.empty((n_frames, n_states), dtype=np.float64)
    ptr = np.zeros((n_frames, n_states), dtype=np.int32)
    dp[0] = emit[0]
    for t in range(1, n_frames):
        incoming = dp[t - 1][:, None] + trans
        ptr[t] = incoming.argmin(axis=0)
        dp[t] = emit[t] + incoming.min(axis=0)

    state = int(dp[-1].argmin())
    path = np.empty(n_frames, dtype=np.int32)
    for t in range(n_frames - 1, -1, -1):
        path[t] = state
        state = int(ptr[t, state]) if t > 0 else state
    midi = np.full(n_frames, np.nan)
    voiced_states = path != unvoiced
    midi[voiced_states] = path[voiced_states] + MIDI_LO
    return midi


def superflux_onsets(y: np.ndarray, sr: int) -> np.ndarray:
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, max_size=3)
    return librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        units="time",
        backtrack=False,
    )


def _rms_frames(y: np.ndarray, sr: int, n_frames: int) -> np.ndarray:
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    return _match_length(np.asarray(rms, dtype=np.float64), n_frames)


def contour_to_notes(
    midi_path: np.ndarray,
    fused_hz: np.ndarray,
    fused_conf: np.ndarray,
    times: np.ndarray,
) -> list[dict]:
    notes: list[dict] = []
    voiced = False
    start_i = 0
    cents_buf: list[float] = []

    def close(end_i: int) -> None:
        nonlocal voiced, cents_buf
        if not voiced:
            return
        end_i = max(end_i, start_i + 1)
        if not cents_buf:
            voiced = False
            return
        pitch = int(round(np.median(cents_buf) / 100.0))
        pitch = max(0, min(127, pitch))
        notes.append({"pitch": pitch, "start": float(times[start_i]), "end": float(times[min(end_i, len(times) - 1)])})
        voiced = False
        cents_buf = []

    for i, (midi, conf, hz) in enumerate(zip(midi_path, fused_conf, fused_hz)):
        has_pitch = not np.isnan(midi)
        if not voiced:
            if has_pitch and conf >= VOICING_ENTER:
                voiced = True
                start_i = i
                cents_buf = [_cents(hz) if hz > 0 else 100.0 * float(midi)]
            continue
        current_cents = _cents(hz) if hz > 0 else 100.0 * float(midi)
        if (not has_pitch) or conf < VOICING_EXIT:
            close(i)
            continue
        if abs(current_cents - np.median(cents_buf)) > FUSE_CENTS:
            close(i)
            voiced = True
            start_i = i
            cents_buf = [current_cents]
            continue
        cents_buf.append(current_cents)
    close(len(times) - 1)
    return notes


def split_same_pitch(notes: list[dict], onsets: np.ndarray, rms: np.ndarray, times: np.ndarray) -> list[dict]:
    if notes == [] or onsets.size == 0:
        return notes
    hop_sec = float(times[1] - times[0]) if times.size > 1 else 0.01
    out: list[dict] = []
    for note in notes:
        cuts = [note["start"]]
        for onset in onsets:
            if onset <= note["start"] + ONSET_EDGE_SEC or onset >= note["end"] - ONSET_EDGE_SEC:
                continue
            frame = int(np.clip(np.round(onset / hop_sec), 0, rms.size - 1))
            pre = float(np.mean(rms[max(0, frame - 6) : frame])) if frame > 0 else 0.0
            post = float(np.mean(rms[frame : min(rms.size, frame + 3)]))
            dip = float(np.min(rms[max(0, frame - 4) : min(rms.size, frame + 1)]))
            if dip < 0.7 * max(pre, post, 1e-8) and post > dip * 1.2:
                cuts.append(float(onset))
        cuts.append(note["end"])
        cuts = sorted(cuts)
        for start, end in zip(cuts, cuts[1:]):
            if end - start >= MIN_NOTE_SEC * 0.5:
                out.append({"pitch": note["pitch"], "start": start, "end": end})
    return out


def merge_and_drop(notes: list[dict]) -> list[dict]:
    if not notes:
        return notes
    notes = sorted(notes, key=lambda n: n["start"])
    merged: list[dict] = [dict(notes[0])]
    for note in notes[1:]:
        prev = merged[-1]
        gap = note["start"] - prev["end"]
        if note["pitch"] == prev["pitch"] and 0 <= gap < MERGE_GAP_SEC:
            prev["end"] = max(prev["end"], note["end"])
        else:
            merged.append(dict(note))
    return [n for n in merged if n["end"] - n["start"] >= MIN_NOTE_SEC]


def octave_guard(notes: list[dict], fused_hz: np.ndarray, times: np.ndarray) -> list[dict]:
    if len(notes) < 2:
        return notes
    midi_obs = np.where(fused_hz > 0, _hz_to_midi(fused_hz), np.nan)
    for i in range(1, len(notes)):
        delta = abs(notes[i]["pitch"] - notes[i - 1]["pitch"])
        if delta != 12:
            continue
        center = notes[i]["start"]
        mask = (times >= center - 0.5) & (times <= center + 0.5) & np.isfinite(midi_obs)
        if not np.any(mask):
            continue
        med = float(np.nanmedian(midi_obs[mask]))
        current = notes[i]["pitch"]
        previous = notes[i - 1]["pitch"]
        if abs(current - med) > abs(previous - med):
            notes[i]["pitch"] = previous
    return notes


def velocities(notes: list[dict], rms: np.ndarray, times: np.ndarray) -> list[dict]:
    if not notes:
        return notes
    hop_sec = float(times[1] - times[0]) if times.size > 1 else 0.01
    window = max(1, int(round(0.03 / hop_sec)))
    energies: list[float] = []
    for note in notes:
        start = int(np.clip(np.round(note["start"] / hop_sec), 0, rms.size - 1))
        chunk = rms[start : start + window]
        energies.append(float(np.sqrt(np.mean(np.square(chunk)))) if chunk.size else 0.0)
    lo, hi = np.percentile(energies, [10, 90])
    span = max(float(hi - lo), 1e-8)
    for note, energy in zip(notes, energies):
        unit = float(np.clip((energy - lo) / span, 0.0, 1.0))
        note["velocity"] = int(round(45 + 67 * unit))
    return notes


def drop_quiet(notes: list[dict], rms: np.ndarray, times: np.ndarray) -> list[dict]:
    if not notes:
        return notes
    hop_sec = float(times[1] - times[0]) if times.size > 1 else 0.01
    energies: list[float] = []
    for note in notes:
        start = int(np.clip(np.round(note["start"] / hop_sec), 0, rms.size - 1))
        end = int(np.clip(np.round(note["end"] / hop_sec), start + 1, rms.size))
        chunk = rms[start:end]
        energies.append(float(np.mean(chunk)) if chunk.size else 0.0)
    median = float(np.median(energies)) if energies else 0.0
    if median <= 0:
        return notes
    return [note for note, energy in zip(notes, energies) if energy >= 0.12 * median]


def transcribe(y: np.ndarray, sr: int) -> list[dict]:
    y = _normalize(_highpass(y, sr))
    harmonic, _percussive = librosa.effects.hpss(y)
    f_sal, sal_conf, sal_clear = cqt_salience_stream(harmonic, sr)
    n_frames = f_sal.size
    crepe = crepe_stream(harmonic, sr, n_frames)
    if crepe is None:
        f_f0, f0_conf = pyin_stream(harmonic, sr, n_frames)
    else:
        f_f0, f0_conf = crepe
    fused_hz, fused_conf = fuse_streams(f_sal, sal_conf, sal_clear, f_f0, f0_conf)
    if not np.any(fused_hz > 0):
        f_f0, f0_conf = pyin_stream(harmonic, sr, n_frames)
        fused_hz, fused_conf = fuse_streams(f_sal, sal_conf, sal_clear, f_f0, f0_conf)
    midi_path = viterbi_contour(fused_hz, fused_conf)
    times = librosa.times_like(fused_hz, sr=sr, hop_length=HOP)
    notes = contour_to_notes(midi_path, fused_hz, fused_conf, times)
    rms = _rms_frames(harmonic, sr, n_frames)
    notes = split_same_pitch(notes, superflux_onsets(harmonic, sr), rms, times)
    notes = merge_and_drop(notes)
    notes = drop_quiet(notes, rms, times)
    notes = octave_guard(notes, fused_hz, times)
    notes = velocities(notes, rms, times)
    return notes


def write_midi(notes: Iterable[dict], out_path: str) -> int:
    pm = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)
    count = 0
    for note in notes:
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
    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    if y.size == 0:
        print("empty audio", file=sys.stderr)
        return 1

    notes = transcribe(y, sr)
    written = write_midi(notes, out_path)
    if written == 0:
        print("no voiced notes detected", file=sys.stderr)
        return 1
    print(f"wrote {written} notes to {out_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
