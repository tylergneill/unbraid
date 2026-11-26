# unbraid

Minimalistic interface for practicing a cappella harmonies.

Upload a score (or a recording), turn everyone else down, loop the tricky bit, and
sing along until it sticks. There is no assessment, no microphone, and no notation editing —
looping and repetition is the entire pedagogy.

This is **Milestone 1** of [the execution doc](design_docs/unbraid-execution-doc.md):
the practice instrument, with MusicXML import, plus an experimental second way in:
importing a recording, which is transcribed and split into parts. OMR (image/PDF
ingest) and the note-level correction surface are M2/M3 and are not built.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm test         # 154 tests
npm run build    # typecheck + production bundle
```

Everything runs in the browser. There is no server, and no uploaded score or
recording ever leaves the machine — projects live in IndexedDB.

## What it does

- **Import** MusicXML (`.musicxml`, `.xml`) and compressed MusicXML (`.mxl`).
- **Import a recording** (`.mp3`, `.m4a`; `.wav` and `.aac` also work) on its own
  tab. See [From a recording](#from-a-recording) below.
- **Unroll repeats** into a linear timeline, so the playhead matches what you hear
  rather than what is printed. Repeated bars are labelled `7'` on the ruler.
- **Split voices sharing a staff** into separate parts, so an SA-on-one-treble-staff
  score gives four faders rather than two.
- **Band view**: one piano-roll lane per part, dots on a pitch scale, shared time axis.
- **Lyrics** on that same time axis, so each word sits above the note it is sung
  on. The strip starts above the bands and moves to just below your part once
  you claim one. Text shrinks to stay aligned; where a piece is too dense for
  words at the current zoom, it shows one dot per syllable rather than words in
  the wrong place. Playback stays tones only — the words are there to read.
- **Mixer** with three fader link modes, including *All but mine* — move everyone
  except your part.
- **Loop** any span by dragging across the bar ruler; snaps to bar lines.
- **Tempo** from 40% to 130% for slow practice.
- **Notes pane**, autosaved per project.

Keyboard: <kbd>space</kbd> play/pause · <kbd>S</kbd> just my part · <kbd>L</kbd>
clear loop · <kbd>0</kbd> reset faders · <kbd>Esc</kbd> stop.

## From a recording

The landing page has two tabs. *From a score* reads MusicXML exactly. *From a
recording* listens to an audio file and makes its best guess at the parts, then
opens it in the same band view, so the mixer, loop and tempo all work as usual.
Playback is still the synthesised tones, not the recording.

It happens in three steps, all in the browser:

1. **Hear the notes.** [Basic Pitch](https://github.com/spotify/basic-pitch-ts)
   (Spotify, Apache-2.0), a ~900 KB polyphonic pitch model, runs on
   TensorFlow.js, on the GPU via WebGL where available. It reports every
   pitch it hears with a start and a length, but not who sang it. TensorFlow.js
   (~1 MB) is loaded only when a recording is first imported; score users never
   download it. The thresholds are in `TRANSCRIBER_SETTINGS`.
2. **Split them into parts** (`splitIntoVoices`). Chord by chord, notes are
   matched to voices high to low (voices never cross within a chord), each
   note going to whichever voice can reach it by the smallest step. A faint
   note that fits no voice's line (usually an overtone) is left out rather
   than shoving every other voice down. Then each unaccompanied stretch,
   such as a shanty's solo verse, is reassigned whole to the voice that best
   carries it on into, or in from, the surrounding harmony. The part count is
   estimated from how many notes usually sound together, or set by hand (1–6).
3. **Find the bar lines** (`estimateBeatGrid`). A steady tempo and downbeat are
   estimated from where notes begin. Notes are *not* snapped to this grid: they
   keep the recording's own timing, so a wrong guess only misplaces bar lines
   (and loop-snapping), never the music.

**How good is it?** On the two synthetic fixtures below, 96–99% of correctly
heard notes land in the right part, and both tempi and the shanty's downbeat
come out exact. A real recording will do worse: breath, consonants, vibrato,
room sound, and unison doubling all cost accuracy. It does best on unaccompanied
singing with one clear voice per part (a quartet rather than a choir) and steady
tempo. Parts are named *Voice 1 (top)* … rather than SATB, since a recording does
not say which voices it holds.

Known limits: bar lines assume one tempo and 4/4 throughout; no lyrics; an
inner voice the transcriber misses can pull its neighbours into the wrong part
for that chord. Fixing individual notes is the M3 correction surface.

## Layout

```
src/core/      parsing and domain logic — no DOM, no audio, fully tested
  types.ts       the data model (§4)
  xmlParse.ts    dependency-free XML reader (Node + tests)
  domXml.ts      the same interface over DOMParser (browser)
  musicxml.ts    score parsing: voices, ties, backup/forward cursor
  unroll.ts      repeat and volta expansion
  ingest.ts      file sniffing and .mxl unzipping
  mixer.ts       fader link modes
  timeline.ts    loop regions, snapping, pitch ranges
  transcription.ts  recording → Score: part count, voice split, beat grid
src/audio/     Tone.js transport and one synth per part
  transcriber.ts decoding and Basic Pitch inference (lazy-loaded)
src/storage/   IndexedDB projects
src/ui/        React components
  Lyrics.tsx     the lyric strip: extraction is in musicxml.ts, fitting here
tests/         vitest
scripts/       regenerating the audio fixtures (see fixtures/audio/README.md)
```

The parser is written against a small `XmlElement` interface with two
implementations, so identical parsing code runs in the browser and under Node.
Time is in quarter notes everywhere; MusicXML `divisions` never escape the parser.

## Tests

```
tests/parser.test.ts   the fixtures, with exact known-good assertions
tests/unit.test.ts     one behaviour each, over hand-written minimal scores
tests/mixer.test.ts    link modes, loop regions, timeline helpers
tests/lyrics.test.ts   lyric extraction, and the fitting the strip depends on
tests/transcription.test.ts  recording import: part count, voice split, beat grid
```

Every test runs off `fixtures/`, which is committed. Nothing reads `downloads/`,
so the suite means the same thing on a fresh clone as it does here — a test that
skips itself when a file is missing is not coverage.

| Fixture | What it pins down |
|---|---|
| `wellerman-fixture-simple` | repeats and voltas: **16 written measures unroll to 22** |
| `wellerman-fixture-shared-staff` | two voices per staff yield **4 parts, not 2** |
| `cut-time-fixture` | 2/2, `divisions=2`, dotted notes, and **no tempo marking** |
| `bach-bwv269` | a real score: pickup bar, ties, dense accidentals, counterpoint |
| `lyrics-fixture` | words under a **non-first** part, repeated by a repeat, with an elision and a second verse to ignore |
| `audio/*.notes.json` | what Basic Pitch heard in synthetic performances of `bach-bwv269` and `wellerman-fixture-simple`; the score is ground truth for who sang each note |

The load-bearing assertion is the unroll count: if it reports 16, repeats are not
being expanded and the playhead will drift out of sync with the bands.

`cut-time-fixture` exists for a specific regression. A score naming no tempo has
to be read through its notated beat unit — 2/2 means the beat is a half note, so
the fallback is 200 quarter notes per minute. Read as quarters, a shanty plays at
half speed and the playhead visibly lags the harmony.

`.mxl` ingest is covered by zipping a fixture at test time, so the container
manifest path is exercised without committing anyone's arrangement.

`lyrics-fixture` pins the two things real exports get wrong. Words are engraved
under one staff only, and often not the first, so lyrics are collected from
whichever part carries the most rather than from part one. And `<syllabic>` is
not a usable hyphen signal: MuseScore marks the separate words `put`/`to` and
`Billy`/`of` as begin/end exactly as it marks the genuinely split `bul`/`ly`, so
trusting it prints "Soon- may the Weller- men come". Only a hyphen the exporter
actually wrote is kept.

## Verified end to end

The acceptance test from the fixture README — load the simple fixture, mute
everything but Bass, loop the chorus, play — was run in the browser and works.

The real arrangements in `downloads/` are the *human* end-to-end test: load one,
mark your line, and sing. That directory is gitignored, since those are
third-party scores with their own licensing.

## Licence

[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — share and
adapt freely, with attribution, non-commercially, under the same terms. See
[LICENSE](LICENSE).

This covers the source and its own assets, not third-party dependencies (Basic
Pitch and its model are Apache-2.0) and not any score or recording you import —
imported material stays under its own rights holders' terms and never leaves your
browser.

## Known gaps

Untested territory, inherited from the test corpus: tuplets, mid-piece tempo or
key changes, D.S./coda jumps, multi-measure rests, and transposing instruments.
Chords, grace notes, and ties are handled. Divisi and cross-staff beaming take a
best guess and log a warning, per §5.2.
