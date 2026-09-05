# Unbraid test fixtures

Two MusicXML files for building and validating Milestone 1.

## Provenance — read this first

These are **not** a transcription of any published Wellerman arrangement. They are an
original shanty-style SATB setting in D minor, written from scratch as a test fixture,
and are yours to use, modify, and commit without restriction.

That is deliberate. Every SATB Wellerman you'll find online is somebody's copyrighted
arrangement with unclear licensing, and none of them come with known-correct ground
truth. A fixture you wrote is one where you know exactly what the parser *should*
produce, which is the whole point of a fixture.

Swap in a real arrangement later, once you have one you're confident about the
provenance of — the simplest route being to enter one yourself in MuseScore Studio
(the free desktop app) and export to MusicXML.

## The files

### `wellerman-fixture-simple.musicxml`

Four separate parts (Soprano, Alto, Tenor, Bass), one staff each. This is the
Milestone 1 target — the shape a well-behaved score arrives in.

### `wellerman-fixture-shared-staff.musicxml`

Identical music, but Soprano+Alto share one treble staff as voices 1 and 2, and
Tenor+Bass share a bass staff the same way. This is how a great deal of real choral
sheet music is actually laid out.

A naive parser reads this as **two** parts named "Women" and "Men". A correct one
reads **four**. If your implementation gets four bands out of this file, the
multi-voice problem in §5.2 of the execution doc is solved.

## What they exercise

| Feature | Where |
|---|---|
| Repeat barlines + 1st/2nd endings | mm. 1–8. **16 written measures unroll to 22.** |
| Sparse parts | A/T/B rest through the whole verse (mm. 1–8) — the shanty's solo leader. |
| Two voices per staff | The shared-staff fixture, throughout. |
| Loop-region ergonomics | The chorus is mm. 9–16 (mm. 15–22 unrolled). |
| Accidentals against key | C♯ in the m14 dominant, against a one-flat key signature. |

## Acceptance test for Milestone 1

Load `wellerman-fixture-simple.musicxml`, mute everything except Bass, loop the
chorus, and sing along. If that works end to end, the core of the app is done.

The unroll count is the single most useful assertion to write first: if your parser
reports 16 measures rather than 22, repeats aren't being expanded and the playhead
will drift out of sync with the bands.

## `real-bach-bwv269.musicxml` — the reality check

A Bach chorale (BWV 269), exported from the music21 corpus. Public domain, and
already SATB four-part vocal music — the exact texture Unbraid targets.

This file is **not** a controlled fixture. It's messy in the way real scores are:
pickup bar, fermatas, ties, dense accidentals, 24 measures of actual counterpoint.
Use it as the anti-overfitting test — the fixtures prove the parser is *correct*,
this proves it's *general*.

There are 433 Bach files in that corpus, all freely licensed and all four-part.
`corpus.parse('bach/bwv269')` then `.write('musicxml', fp=...)` gets you as many
real test files as you want, in bulk, with no licensing question at all.

### Known gaps in the current test set

None of these files exercise: tuplets, mid-piece tempo or key changes, D.S./coda
jumps, multi-measure rests, transposing instruments, or `.mxl` (zipped MusicXML,
which is what most real exports actually are). Handle `.mxl` early — it's a one-line
unzip, but it's the first thing a user will hand the app.
