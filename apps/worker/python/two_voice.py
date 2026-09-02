"""Deterministic assignment of noisy note candidates into two monophonic voices."""
from __future__ import annotations

from dataclasses import dataclass, replace
from math import sqrt
from statistics import median
from typing import Iterable

MIN_NOTE_SEC = 0.05
ONSET_CLUSTER_SEC = 0.075
DUPLICATE_ONSET_SEC = 0.045
BEAM_WIDTH = 96
MAX_CLUSTER_CANDIDATES = 8
LEAD_TARGET_MEDIAN = 74
LEAD_MIN_PITCH = 65
LEAD_MAX_PITCH = 84
ACCOMPANIMENT_TARGET_MEDIAN = 63
ACCOMPANIMENT_MIN_PITCH = 53
ACCOMPANIMENT_MAX_PITCH = 72


@dataclass(frozen=True)
class Candidate:
    id: int
    pitch: int
    start: float
    end: float
    confidence: float
    velocity: int

    @property
    def duration(self) -> float:
        return self.end - self.start

    def as_note(self) -> dict:
        return {
            "pitch": self.pitch,
            "start": self.start,
            "end": self.end,
            "confidence": self.confidence,
            "velocity": self.velocity,
        }


@dataclass(frozen=True)
class VoiceHead:
    pitch: int
    start: float
    end: float


@dataclass(frozen=True)
class BeamState:
    score: float
    lead_head: VoiceHead | None
    accompaniment_head: VoiceHead | None
    lead_ids: tuple[int, ...]
    accompaniment_ids: tuple[int, ...]


def _candidate_from_dict(note: dict, candidate_id: int) -> Candidate | None:
    start = float(note["start"])
    end = float(note["end"])
    pitch = int(note["pitch"])
    if end - start < MIN_NOTE_SEC or not 0 <= pitch <= 127:
        return None
    return Candidate(
        id=candidate_id,
        pitch=pitch,
        start=start,
        end=end,
        confidence=max(0.0, min(1.0, float(note.get("confidence", 0.5)))),
        velocity=max(1, min(127, int(note.get("velocity", 90)))),
    )


def normalize_candidates(notes: Iterable[dict]) -> list[Candidate]:
    """Drop unusable events and collapse near-identical Basic Pitch fragments."""
    candidates = [
        candidate
        for candidate_id, note in enumerate(notes)
        if (candidate := _candidate_from_dict(note, candidate_id)) is not None
    ]
    candidates.sort(key=lambda note: (note.pitch, note.start, note.end, -note.confidence))

    merged: list[Candidate] = []
    for candidate in candidates:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous.pitch == candidate.pitch
            and abs(previous.start - candidate.start) <= DUPLICATE_ONSET_SEC
        ):
            preferred = candidate if candidate.confidence > previous.confidence else previous
            merged[-1] = replace(
                preferred,
                start=min(previous.start, candidate.start),
                end=max(previous.end, candidate.end),
                confidence=max(previous.confidence, candidate.confidence),
                velocity=max(previous.velocity, candidate.velocity),
            )
        else:
            merged.append(candidate)

    chronological = sorted(merged, key=lambda note: (note.start, -note.pitch, -note.confidence))
    return [replace(note, id=index) for index, note in enumerate(chronological)]


def _onset_clusters(candidates: list[Candidate]) -> list[list[Candidate]]:
    clusters: list[list[Candidate]] = []
    for candidate in candidates:
        if not clusters or candidate.start - clusters[-1][0].start > ONSET_CLUSTER_SEC:
            clusters.append([candidate])
        else:
            clusters[-1].append(candidate)
    return clusters


def _limit_cluster(cluster: list[Candidate]) -> list[Candidate]:
    if len(cluster) <= MAX_CLUSTER_CANDIDATES:
        return cluster
    ranked = sorted(
        cluster,
        key=lambda note: (
            -(3.0 * note.confidence + 0.25 * sqrt(note.duration)),
            -note.pitch,
            note.start,
        ),
    )
    selected = ranked[: MAX_CLUSTER_CANDIDATES - 2]
    selected.extend((min(cluster, key=lambda note: note.pitch), max(cluster, key=lambda note: note.pitch)))
    unique = {note.id: note for note in selected}
    return sorted(unique.values(), key=lambda note: (-note.pitch, -note.confidence, note.start))


def _pitch_position(pitch: int, cluster: list[Candidate]) -> float:
    if len(cluster) < 2:
        return 0.5
    low = min(note.pitch for note in cluster)
    high = max(note.pitch for note in cluster)
    return 0.5 if high == low else (pitch - low) / (high - low)


def _emission_score(
    note: Candidate,
    role: str,
    cluster: list[Candidate],
    global_center: float,
) -> float:
    position = _pitch_position(note.pitch, cluster)
    pitch_distance = max(-1.0, min(1.0, (note.pitch - global_center) / 12.0))
    score = 3.0 * note.confidence + 0.2 * min(sqrt(note.duration), 1.5) - 0.9
    if role == "lead":
        score += 0.65 * position + 0.35 * pitch_distance
        if note.pitch < global_center - 7:
            score -= 0.25 * (global_center - 7 - note.pitch)
        if note.duration > 2.5:
            score -= 0.25
    else:
        target_pitch = global_center + 2
        score += 0.2 * position
        score -= 0.07 * abs(note.pitch - target_pitch)
        score += 0.35 * min(note.duration, 1.5)
        if note.pitch < global_center - 8:
            score -= 0.25 * (global_center - 8 - note.pitch)
        if note.duration < 0.14:
            score -= 0.3
    return score


def _transition_score(note: Candidate, head: VoiceHead | None) -> float:
    if head is None or note.start - head.end > 3.0:
        return 0.0
    leap = abs(note.pitch - head.pitch)
    score = 0.18 if leap == 0 else 0.0
    if leap > 3:
        score -= min(2.5, 0.075 * (leap - 3) ** 1.35)
    overlap = max(0.0, head.end - note.start)
    if overlap > 0:
        score -= 0.45 * min(1.0, overlap / max(note.duration, MIN_NOTE_SEC))
    return score


def _crossing_score(
    lead: Candidate | None,
    accompaniment: Candidate | None,
    state: BeamState,
) -> float:
    score = 0.0
    if lead is not None and accompaniment is not None:
        gap = lead.pitch - accompaniment.pitch
        if gap <= 0:
            return -100.0
        if 2 <= gap <= 7:
            score += 0.6
        elif gap <= 12:
            score += 0.2
        else:
            score -= 0.25 * (gap - 12)

    accompaniment_head = state.accompaniment_head
    if (
        lead is not None
        and accompaniment_head is not None
        and lead.start < accompaniment_head.end
        and lead.pitch <= accompaniment_head.pitch
    ):
        score -= 4.0

    lead_head = state.lead_head
    if (
        accompaniment is not None
        and lead_head is not None
        and accompaniment.start < lead_head.end
        and accompaniment.pitch >= lead_head.pitch
    ):
        score -= 4.0
    return score


def _cluster_choices(cluster: list[Candidate]) -> list[tuple[Candidate | None, Candidate | None]]:
    choices: list[tuple[Candidate | None, Candidate | None]] = [(None, None)]
    for candidate in cluster:
        choices.append((candidate, None))
        choices.append((None, candidate))
    for lead in cluster:
        for accompaniment in cluster:
            if lead.id != accompaniment.id and lead.pitch > accompaniment.pitch:
                choices.append((lead, accompaniment))
    return choices


def _advance_state(
    state: BeamState,
    lead: Candidate | None,
    accompaniment: Candidate | None,
    cluster: list[Candidate],
    global_center: float,
) -> BeamState:
    score = state.score + _crossing_score(lead, accompaniment, state)
    lead_head = state.lead_head
    accompaniment_head = state.accompaniment_head
    lead_ids = state.lead_ids
    accompaniment_ids = state.accompaniment_ids

    if lead is not None:
        score += _emission_score(lead, "lead", cluster, global_center)
        score += _transition_score(lead, lead_head)
        lead_head = VoiceHead(lead.pitch, lead.start, lead.end)
        lead_ids += (lead.id,)
    if accompaniment is not None:
        score += _emission_score(accompaniment, "accompaniment", cluster, global_center)
        score += _transition_score(accompaniment, accompaniment_head)
        accompaniment_head = VoiceHead(
            accompaniment.pitch,
            accompaniment.start,
            accompaniment.end,
        )
        accompaniment_ids += (accompaniment.id,)

    return BeamState(
        score=score,
        lead_head=lead_head,
        accompaniment_head=accompaniment_head,
        lead_ids=lead_ids,
        accompaniment_ids=accompaniment_ids,
    )


def _state_key(state: BeamState) -> tuple:
    def head_key(head: VoiceHead | None) -> tuple[int, int]:
        if head is None:
            return (-1, -1)
        return (head.pitch, round(head.end / ONSET_CLUSTER_SEC))

    return (*head_key(state.lead_head), *head_key(state.accompaniment_head))


def _prune(states: list[BeamState]) -> list[BeamState]:
    best_by_head: dict[tuple, BeamState] = {}
    for state in states:
        key = _state_key(state)
        previous = best_by_head.get(key)
        if previous is None or state.score > previous.score:
            best_by_head[key] = state
    return sorted(
        best_by_head.values(),
        key=lambda state: (-state.score, state.lead_ids, state.accompaniment_ids),
    )[:BEAM_WIDTH]


def _note_strength(note: dict) -> float:
    return float(note.get("confidence", 0.5)) + 0.1 * (note["end"] - note["start"])


def _merge_duplicate(previous: dict, current: dict) -> None:
    previous["end"] = max(previous["end"], current["end"])
    previous["confidence"] = max(
        float(previous.get("confidence", 0.5)),
        float(current.get("confidence", 0.5)),
    )
    previous["velocity"] = max(
        int(previous.get("velocity", 90)),
        int(current.get("velocity", 90)),
    )


def _resolve_conflicts(current: dict, result: list[dict]) -> dict | None:
    while result and current["start"] < result[-1]["end"]:
        previous = result[-1]
        onset_gap = current["start"] - previous["start"]
        if previous["pitch"] == current["pitch"] and onset_gap <= DUPLICATE_ONSET_SEC:
            _merge_duplicate(previous, current)
            return None
        if onset_gap >= MIN_NOTE_SEC:
            previous["end"] = current["start"]
            return current
        if _note_strength(current) > _note_strength(previous):
            result.pop()
        else:
            return None
    return current


def enforce_monophony(notes: Iterable[dict]) -> list[dict]:
    """Resolve duplicate and overlapping events while preserving real retriggers."""
    ordered = sorted(
        (dict(note) for note in notes),
        key=lambda note: (float(note["start"]), -float(note.get("confidence", 0.5)), -int(note["pitch"])),
    )
    result: list[dict] = []
    for current in ordered:
        current["start"] = float(current["start"])
        current["end"] = float(current["end"])
        resolved = _resolve_conflicts(current, result)
        if resolved and resolved["end"] - resolved["start"] >= MIN_NOTE_SEC:
            result.append(resolved)
    return result


def place_voice_in_register(
    notes: list[dict],
    target_median: int,
    minimum_pitch: int,
    maximum_pitch: int,
) -> list[dict]:
    """Move a complete voice by octaves, then fold only register outliers."""
    if not notes:
        return []
    source_median = float(median(note["pitch"] for note in notes))
    octave_shift = 12 * round((target_median - source_median) / 12)
    placed: list[dict] = []
    for source in notes:
        note = dict(source)
        pitch = int(note["pitch"]) + octave_shift
        while pitch < minimum_pitch:
            pitch += 12
        while pitch > maximum_pitch:
            pitch -= 12
        note["pitch"] = pitch
        placed.append(note)
    return placed


def split_two_voices(notes: Iterable[dict]) -> tuple[list[dict], list[dict]]:
    """Select lead and lower accompaniment paths from polyphonic candidates."""
    candidates = normalize_candidates(notes)
    if not candidates:
        return [], []
    if len(candidates) == 1:
        return [candidates[0].as_note()], []

    pitches = sorted(candidate.pitch for candidate in candidates)
    global_center = float(median(pitches))

    states = [BeamState(0.0, None, None, (), ())]
    for raw_cluster in _onset_clusters(candidates):
        cluster = _limit_cluster(raw_cluster)
        advanced = [
            _advance_state(state, lead, accompaniment, cluster, global_center)
            for state in states
            for lead, accompaniment in _cluster_choices(cluster)
        ]
        states = _prune(advanced)

    best = states[0]
    by_id = {candidate.id: candidate for candidate in candidates}
    lead = enforce_monophony(by_id[candidate_id].as_note() for candidate_id in best.lead_ids)
    accompaniment = enforce_monophony(
        by_id[candidate_id].as_note() for candidate_id in best.accompaniment_ids
    )

    if lead and accompaniment:
        lead_mean = sum(note["pitch"] for note in lead) / len(lead)
        accompaniment_mean = sum(note["pitch"] for note in accompaniment) / len(accompaniment)
        if lead_mean < accompaniment_mean:
            lead, accompaniment = accompaniment, lead
    elif not lead and accompaniment:
        lead, accompaniment = accompaniment, []
    lead = place_voice_in_register(
        lead,
        LEAD_TARGET_MEDIAN,
        LEAD_MIN_PITCH,
        LEAD_MAX_PITCH,
    )
    accompaniment = place_voice_in_register(
        accompaniment,
        ACCOMPANIMENT_TARGET_MEDIAN,
        ACCOMPANIMENT_MIN_PITCH,
        ACCOMPANIMENT_MAX_PITCH,
    )
    return lead, accompaniment


def count_internal_overlaps(notes: Iterable[dict]) -> int:
    ordered = sorted(notes, key=lambda note: (note["start"], note["end"]))
    return sum(
        1
        for previous, current in zip(ordered, ordered[1:])
        if current["start"] < previous["end"] - 1e-6
    )
