#!/usr/bin/env python3
"""Acoustic fingerprint of a .wav, for proving two voices are actually different.

Run with the voice venv's python (numpy and soundfile live there):

    /tmp/golem-voice-venv/bin/python scripts/voice-fingerprint.py a.wav b.wav

Prints one JSON object: {"files": [{path, medianF0, mels: [...]}, ...]}

─── Why these two measures ───────────────────────────────────────────
medianF0 is pitch — the single most audible difference between speakers, and
the one that separates a man's voice from a woman's without any modelling.

mels is a 24-band long-term average spectrum: the average energy distribution
across the clip, which captures timbre — the thing that distinguishes two men
with similar pitch. It is deliberately long-term rather than frame-by-frame,
because the comparison here is between recordings of DIFFERENT sentences, and
anything time-aligned would be measuring the words instead of the voice.

Neither is a speaker-identification system, and neither claims to be. They are
enough to answer the only question asked of them: did changing voice_id change
the sound, or just the label.
"""

import json
import sys

import numpy as np
import soundfile as sf

SR_ASSUMED = 24_000
# Human speech f0: roughly 60 Hz (deep male) to 400 Hz (high female). Searching
# wider mostly finds octave errors on harmonics.
F0_MIN, F0_MAX = 60.0, 400.0
FRAME_MS, HOP_MS = 40, 20
N_MELS = 24


def hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def mel_filterbank(n_fft, sr, n_mels=N_MELS, fmin=50.0, fmax=8000.0):
    """Triangular mel filters — the standard construction, written out because
    the venv has numpy but not librosa and adding a dependency for 15 lines of
    arithmetic is a worse trade than the 15 lines."""
    edges = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    bins = np.floor((n_fft + 1) * edges / sr).astype(int)
    bins = np.clip(bins, 0, n_fft // 2)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for i in range(n_mels):
        lo, mid, hi = bins[i], bins[i + 1], bins[i + 2]
        if mid > lo:
            fb[i, lo:mid] = np.linspace(0, 1, mid - lo, endpoint=False)
        if hi > mid:
            fb[i, mid:hi] = np.linspace(1, 0, hi - mid, endpoint=False)
    return fb


def frames(x, frame, hop):
    if len(x) < frame:
        return np.empty((0, frame))
    n = 1 + (len(x) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    return x[idx]


def median_f0(x, sr):
    """Autocorrelation pitch, median over voiced frames.

    Frames below an energy floor are dropped rather than counted as 0 Hz —
    silence between words is most of a short clip, and averaging it in would
    drag every voice toward the same number.
    """
    frame, hop = int(sr * FRAME_MS / 1000), int(sr * HOP_MS / 1000)
    fr = frames(x, frame, hop)
    if len(fr) == 0:
        return None

    energy = np.sqrt((fr ** 2).mean(axis=1))
    voiced = fr[energy > max(energy.max() * 0.15, 1e-4)]
    if len(voiced) == 0:
        return None

    lag_min, lag_max = int(sr / F0_MAX), int(sr / F0_MIN)
    out = []
    for f in voiced:
        f = f - f.mean()
        ac = np.correlate(f, f, mode="full")[len(f) - 1:]
        if ac[0] <= 0:
            continue
        window = ac[lag_min:lag_max]
        if len(window) == 0:
            continue
        lag = lag_min + int(np.argmax(window))
        # A weak peak means the frame is not really periodic (a fricative, say),
        # and its "pitch" would be noise.
        if ac[lag] / ac[0] < 0.3:
            continue
        out.append(sr / lag)
    return float(np.median(out)) if out else None


def ltas_mels(x, sr):
    """Long-term average spectrum in mel bands, L1-normalised.

    Normalised so loudness cannot masquerade as timbre: a quieter recording of
    the same voice must land in the same place.
    """
    n_fft = 1024
    fr = frames(x, n_fft, n_fft // 2)
    if len(fr) == 0:
        return [0.0] * N_MELS
    spec = np.abs(np.fft.rfft(fr * np.hanning(n_fft), axis=1)) ** 2
    mels = mel_filterbank(n_fft, sr) @ spec.mean(axis=0)
    mels = np.log(mels + 1e-10)
    mels = mels - mels.mean()
    norm = np.abs(mels).sum()
    return (mels / norm if norm > 0 else mels).tolist()


def main(paths):
    out = []
    for path in paths:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
        mono = audio.mean(axis=1)
        out.append(
            {
                "path": path,
                "sampleRate": sr,
                "seconds": round(len(mono) / sr, 2),
                "peak": float(np.abs(mono).max()),
                "medianF0": median_f0(mono, sr),
                "mels": ltas_mels(mono, sr),
            }
        )
    print(json.dumps({"files": out}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: voice-fingerprint.py <wav> [wav ...]")
    main(sys.argv[1:])
