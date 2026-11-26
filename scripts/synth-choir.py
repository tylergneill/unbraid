"""Render a score's parts as a rough "choir" recording, for testing audio import.

    npx tsx scripts/score-to-json.ts fixtures/bach-bwv269.musicxml > bach.json
    python3 scripts/synth-choir.py bach.json 80 bach.wav
    ffmpeg -i bach.wav -b:a 160k bach.mp3

Each part is a harmonic-rich tone with a vowel-ish spectral tilt, vibrato that
fades in, a soft envelope, and a little timing jitter, so the transcriber sees
something closer to singers than to sine waves. It is still far easier than a
real recording: no consonants, no breath, perfect intonation, no room. The
point is exact ground truth (the score), not realism.

Needs numpy and scipy.
"""
import json, sys
import numpy as np
from scipy.io import wavfile

SR = 44100
rng = np.random.default_rng(7)

def voice(midi, dur, seed_phase):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = 440 * 2 ** ((midi - 69) / 12)
    # Vibrato fades in, as a singer's does.
    vib_depth = 0.25 * np.clip(t / 0.35, 0, 1)  # semitones
    f = f0 * 2 ** (vib_depth * np.sin(2 * np.pi * 5.3 * t + seed_phase) / 12)
    phase = 2 * np.pi * np.cumsum(f) / SR
    sig = np.zeros(n)
    for h in range(1, 9):
        if f0 * h > 6000:
            break
        # Crude vowel colouring: lift harmonics near 700 Hz and 1100 Hz.
        fh = f0 * h
        w = (1 / h) * (1 + 1.5 * np.exp(-((fh - 700) / 250) ** 2) + np.exp(-((fh - 1100) / 300) ** 2))
        sig += w * np.sin(h * phase)
    env = np.minimum(1, t / 0.04) * np.minimum(1, (dur - t) / 0.06).clip(0, 1)
    return sig * env

def render(path, out, beat_sec):
    data = json.load(open(path))
    total = max(e['onsetBeats'] + e['durationBeats'] for p in data['parts'] for e in p['events'])
    mix = np.zeros(int((total * beat_sec + 1.5) * SR))
    gains = [0.9, 0.8, 0.8, 0.9]
    for i, part in enumerate(data['parts']):
        ph = rng.uniform(0, 6.28)
        for e in part['events']:
            on = e['onsetBeats'] * beat_sec + rng.normal(0, 0.012)
            dur = e['durationBeats'] * beat_sec * 0.97
            s = voice(e['midiPitch'], dur, ph) * gains[i]
            a = max(0, int(on * SR))
            mix[a:a + len(s)] += s[: len(mix) - a]
    mix += rng.normal(0, 0.003, len(mix))  # room noise
    mix /= np.abs(mix).max() * 1.1
    wavfile.write(out, SR, (mix * 32767).astype(np.int16))

if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('usage: synth-choir.py <parts.json> <quarter-note bpm> <out.wav>')
    render(sys.argv[1], sys.argv[3], 60 / float(sys.argv[2]))
