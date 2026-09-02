# MIDI transcription quality log

This is the agent-facing regression log for deterministic MIDI transcription.
Update it whenever a user supplies another audio/reference-MIDI pair. Reference
audio and MIDI files stay outside the repository; only measurements and
actionable findings belong here.

## Acceptance metric

- Compare the two tracks separately: `Lead Melody` and `Lower Accompaniment`.
- A match requires the same MIDI pitch and an onset within 180 ms after one
  global linear time alignment.
- The acceptance target is **at least 0.90 onset-and-pitch F1 on each track**.
  A combined score is not used because the larger lead track would hide a poor
  accompaniment result.
- Generated tracks must remain internally monophonic.
- Run `python apps/worker/python/compare_midi.py <reference.mid> <generated.mid>
  --require-target` to enforce the gate.

## Reference corpus

### Mabel — Mad Love

- Source: YouTube video `hY1tULEr4-4`.
- External reference: 2 tracks, 504 lead notes and 136 accompaniment notes.
- Reference arrangement: rigid 92 BPM sixteenth-note grid. The audio is about
  99 BPM, so comparison requires a 1.0744 time scale and roughly -1.9 s offset.
- The accompaniment is a manually stylized four-note repeating arrangement,
  not a literal lower voice isolated from the recording.

Results on 2026-09-02:

- Full-mix Basic Pitch + two-voice decoder: lead F1 0.7089;
  accompaniment F1 0.0129; gate failed.
- Kim Vocal 2 MDX lead + full-mix accompaniment: lead F1 **0.7500**;
  accompaniment F1 0.0129; gate failed.

Candidate-oracle measurements:

- Full-mix Basic Pitch can cover at most 88.1% of reference lead onsets and
  50.7% of accompaniment onsets, even if an oracle chooses candidates.
- Vocal separation improves deterministic lead selection, but its Basic Pitch
  candidate oracle is 85.5%; separation alone cannot reach the 90% gate.
- The production decoder therefore must not claim 90% accuracy yet.

## Room for improvement

Prioritized work for the next reference samples:

1. Add beat/downbeat estimation and sixteenth-grid quantization. Split sustained
   vocal notes at detected syllable onsets so repeated same-pitch notes are not
   lost by Basic Pitch.
2. Replace accompaniment candidate selection with key/chord-progression
   estimation and a deterministic music-box accompaniment pattern. The supplied
   reference accompaniment is an arrangement, not an audio stem.
3. Evaluate a vocal-specific note-event model. CREPE/pYIN pitch frames alone do
   not solve note onset segmentation.
4. Build a multi-song corpus before further weight tuning. Do not optimize
   decoder constants against only this song.
5. Add duration/offset-aware note metrics after onset-and-pitch F1 is stable.
6. If exact reproduction is required for already-known songs, store a
   user-supplied corrected MIDI as a per-song override. Keep this separate from
   claims about general transcription accuracy.

## Updating this log

For each new sample, record the source ID, reference track/note counts, alignment,
per-track precision/recall/F1, decoder version, and the dominant error pattern.
Retain previous results so regressions remain visible.
