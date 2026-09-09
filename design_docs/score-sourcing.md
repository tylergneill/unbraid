# Where multi-part scores actually come from

Notes from building the Mudcat wizard (branch `mudcat-abc`, September 2026). The
wizard works; the conclusion is that it is pointed at the wrong corpus. Written
down because the finding is worth more than the code, and because the next
attempt at this should start here rather than rediscovering it.

## The workflow we want

> I'm listening to a song on Spotify and decide to learn it. I look it up on a
> website. It reliably confirms it has the parts I'm looking for. I pay
> something reasonable — $10. I download MusicXML. Unbraid takes care of the
> rest.

Nothing about that is unreasonable. It does not exist, and the reasons are
structural rather than technical.

## What the Mudcat branch established

The pipeline does what it claims: search Mudcat, extract ABC from forum posts,
convert to MusicXML, hand it to the normal import path. It found and correctly
converted a real four-part arrangement — "Babylon is Fallen", a Sacred Harp
setting in thread 4024, three singing voices across 12 bars, no warnings.

Finding that one took sampling something like 150 threads.

**ABC notation is overwhelmingly monophonic in practice.** The format supports
multiple voices perfectly well — `V:` blocks, inline `[V:n]` switches, chord
stacks — and the converter handles all of it. But ABC's community is
traditional dance and session music, which is single-line by nature. Fiddle
tunes, jigs, reels: one voice each.

Searches across Mudcat and abcnotation.com for *harmony*, *SATB*, *four part*,
*voices*, *descant*, *polyphony*, *canon* returned no multi-voice tunes at all.
Every Wellerman on abcnotation.com is a melody line with lyrics.

The one exception is shape-note / Sacred Harp, whose repertoire is *defined* by
being four-part. That is where the single hit came from, and it is the only
corner of the ABC world where searching for harmony is likely to pay.

## Why the good sources don't work either

Each of these was considered and ruled out:

- **CPDL** — genuinely free, genuinely four-part, but choral/sacred. Wrong
  repertoire.
- **Hymnary.org** — same problem, more so. It indexes hymnals. A whaling shanty
  was never going to be in there.
- **IMSLP** — public domain only, so nothing written after roughly 1930.
- **musescore.com** — *does* have the popular and Disney material, much of it
  properly multi-part. Most of it is not free to download, and their terms
  prohibit scraping. This is the catalogue we want and cannot have.

The pattern is consistent: **multi-part vocal arrangements of popular music are
a commercial product.** That is exactly why they sit behind paywalls, and no
choice of source changes it.

## Why paying doesn't fix it either

Even granting the $10:

- **The catalogue is legally fragmented.** Every arrangement is licensed
  separately, so Musicnotes, Sheet Music Direct and Hal Leonard each carry
  different overlapping subsets. Nobody can legally build a union catalogue,
  which is why no site can answer "who has an SATB version of this song".
- **Voicing metadata is vague on purpose.** SATB vs SAB vs 2-part vs
  piano/vocal-with-melody is often only discoverable from a watermarked image
  of page one. The vagueness converts browsers into buyers.
- **MusicXML is rarely the product.** The industry sells printable paper,
  because structured data is trivially redistributable. Musicnotes' interactive
  scores are MusicXML-backed and can sometimes export, but it is restricted and
  title-dependent.

So the flow breaks at the last mile: you pay, and you get a PDF.

## Where that points

The blocker is not *finding* scores. It is that the thing you can legally buy is
a PDF, and unbraid reads MusicXML.

That gap is already on the roadmap. The execution doc lists OMR — optical music
recognition, reading notes off an image or PDF — as M2/M3, with a note-level
correction surface alongside it. That correction surface matters: OMR on dense
choral scores is unreliable enough that the output needs fixing by hand, which
is presumably why the two were planned together.

If the goal is the Spotify-to-practice workflow above, **OMR ingest is the piece
that unlocks it**, and scraping notation off forums is not. A bought PDF is a
legitimate, licensed source; making it readable is a tooling problem we control,
unlike catalogue licensing, which we do not.

## Status of the Mudcat wizard

Committed on `mudcat-abc`, not merged. It works, has tests, and is dev-only
(the scraping runs in the Vite dev server; production builds hide the entry
point). Worth keeping for shape-note searches, where it demonstrably finds
things. Not worth extending until there is a corpus that justifies it.

The ABC→MusicXML converter is the reusable part: pitch, keys, accidentals,
durations, broken rhythm, chords, ties, `V:` voices, inline `[V:n]` switches,
bar lines and repeats. It works on ABC from anywhere, not just Mudcat, and does
not depend on the scraping half at all.
