# Audio import fixtures

What the transcriber heard in two synthetic performances of committed score
fixtures. Each file is a JSON array of notes, as the app's transcriber returns
them before any part splitting:

```json
{ "startSec": 0.0, "durationSec": 0.52, "midiPitch": 62, "amplitude": 0.81 }
```

| File | Performance of | Tempo |
|---|---|---|
| `bach-bwv269-synth.notes.json` | `../bach-bwv269.musicxml` | 80 bpm |
| `wellerman-simple-synth.notes.json` | `../wellerman-fixture-simple.musicxml` | 110 bpm |

## Why synthetic

A recording of real singers has no answer key: nobody can say for certain which
singer produced each detected note. A performance rendered *from a score* does,
because the score is the answer. The tests match every heard note back to the
score and check that the splitter put it in the voice that sang it.

The cost is realism. `scripts/synth-choir.py` gives each part a vowel-ish,
harmonic-rich tone with vibrato and a little timing jitter, but no consonants,
breath, intonation drift, or room. These fixtures test the splitting and beat
logic, not how well Basic Pitch copes with real voices.

The audio is not committed, only what was heard in it; the notes are all the
tests need, and they keep the repository small.

## Regenerating

Needs `ffmpeg` on PATH, and Python with numpy and scipy.

```bash
npx tsx scripts/score-to-json.ts fixtures/bach-bwv269.musicxml > /tmp/bach.json
python3 scripts/synth-choir.py /tmp/bach.json 80 /tmp/bach.wav
ffmpeg -i /tmp/bach.wav -b:a 160k /tmp/bach.mp3
npx tsx scripts/transcribe-fixture.ts /tmp/bach.mp3 fixtures/audio/bach-bwv269-synth.notes.json
```

and likewise for `wellerman-fixture-simple` at 110 bpm. The synthesiser is
seeded, so the same score and tempo give the same audio. `transcribe-fixture.ts`
runs the same model with the same `TRANSCRIBER_SETTINGS` as the app, on
TensorFlow.js's CPU backend: slow, about a minute and a half per minute of audio,
but identical output.

Rerun the fixtures after changing `TRANSCRIBER_SETTINGS`, or the tests will be
checking notes the app no longer produces.
