# Unbraid — Execution Doc (v1)

**Status:** design draft for agent handoff
**Name:** "Unbraid" — the app pulls a braided-together chorus apart so one part
can be practised against the rest. Settled; replaced the provisional
"Harmoneeze" working title.
**Relationship to other work:** standalone. Not part of Kalpataru Grove; no shared infrastructure, no Sanskrit/DH dependencies.

---

## 1. Purpose

A web app that helps a **by-ear learner** internalize **one part** of a multipart song by looping it against the other parts.

The motivating user is someone who never learned to hold a part in a choir setting and wants to sing along with family members who can. The tool's whole job is: *let me hear my line, over and over, at whatever mix and whatever span I want, until it sticks in my ear.*

## 1a. Positioning — why this exists

Tools that already do parts of this: **MuseScore Studio** (free, desktop) has a mixer
with per-part faders, loop in/out points, and tempo control. **Choral Practice** (iOS)
is a MusicXML player built specifically for rehearsing one's own part.

Unbraid is not competing on features. It is competing on **restraint**.

MuseScore Studio is a notation editor with playback attached. The three controls a
by-ear learner needs are buried inside several hundred they don't, arranged for
composing rather than practising. That is a legitimate design for what it is, and a
poor fit for someone who only wants to hear the alto line twelve times in a row.

**The design constraint that follows:** every screen in Unbraid should be usable
by someone who cannot read music and has no interest in editing a score. If a control
exists to serve notation, composition, engraving, or printing, it does not belong in
this app. The correction surface in §5.3 is the sole exception, and it stays at the
level of dragging dots — never notation editing.

**Two concrete differentiators, both already identified:**

1. **Closed SATB.** MuseScore 3.6 could mute individual voices sharing a staff;
   MuseScore 4 removed this and has not restored it, which is why some choir members
   have stayed on 3.6. Most choral sheet music is engraved this way. The
   shared-staff fixture targets exactly this, and solving it is the clearest
   capability advantage available.
2. **Drag-select loop region + fader link modes.** Neither comparison tool offers
   region selection by dragging, nor an "all except my part" gesture.

## 2. Core loop

1. User creates a **project** and uploads a piece of sheet music showing all parts.
2. System interprets the score and extracts each distinct part.
3. User sees a **multi-band visualization** — one horizontal band per part, notes as dots on a pitch scale.
4. User sets the mix (mute/boost individual parts) and selects a loop span.
5. User loops and sings along. Repeat until learned.

There is no assessment step. See §3.

## 3. Non-goals for v1

These are deliberate exclusions. The implementing agent should not add them, and should not build abstractions in anticipation of them beyond what is noted in §8.

- **No sing-back, pitch detection, microphone input, or feedback of any kind.** Looping and repetition is the entire pedagogy. This keeps all audio-input problems off the table.
- **No lyrics, no vocal synthesis, no text-to-speech.** Playback is tones only.
- **No real recordings, no licensed catalog, no stem separation.** Synthesized audio from the parsed score only. (Possible far-future direction; not now.)
- **No accounts, sharing, collaboration, or multi-user features.** Single-user, local-first.
- **No score editing beyond correction of parse errors** (§5.3).
- **No tempo/key transposition** unless it falls out for free from the playback engine.

## 4. Data model

```
Project
  id
  title
  created_at, updated_at
  source_file          # original upload (PDF/PNG/JPG, or MusicXML/MIDI)
  score                # canonical MusicXML (parsed or uploaded directly)
  parts[]              # derived from score
  mix_state            # per-part volume, link mode, last loop region
  notes                # freeform rich text, project-scoped
```

```
Part
  id
  label                # from score: "Soprano", "Alto", "Staff 2", etc.
  events[]             # {onset_beats, duration_beats, midi_pitch}
  clef, key, range     # for laying out the pitch scale
```

Notes are **per project**, not per section. One pane per project, freeform.

## 5. Pipeline

### 5.1 Ingest

Accept: PDF, PNG, JPG (scanned/photographed score), **and** MusicXML / MIDI directly.

> **Build the direct-import path first.** See §9 — this is the single most important sequencing decision in the doc.

### 5.2 Score interpretation (OMR)

Convert page images into structured music. Canonical internal format: **MusicXML**.

Candidate engines (evaluate, don't assume):
- **Audiveris** — mature open-source OMR, Java, outputs MusicXML. Best-supported option; expect a JVM dependency in the stack.
- **oemer** — end-to-end neural OMR, Python, lighter to deploy, generally weaker on dense multi-staff scores.
- Commercial OMR APIs — better accuracy, but introduce cost and a network dependency; evaluate only if open-source accuracy proves unusable.

**Part extraction:** each staff/voice in the MusicXML becomes a Part. Handle the common cases: separate staves per part (easy), and multiple voices on one staff, e.g. SA sharing a treble staff (harder — must split by voice, not just staff). Divisi and cross-staff beaming can be punted; log a warning and take a best guess.

### 5.3 Correction surface

OMR **will** produce errors on real-world scores. The user must be able to see and fix them without leaving the app. Minimum viable correction:

- Per-part: rename, delete, merge/split
- Per-note: drag a dot to a different pitch, nudge onset, delete
- "Re-import" to start over

This does not need to be a notation editor. Editing the dots on the piano-roll is sufficient and is much cheaper to build.

### 5.4 Synthesis & playback

- **Web Audio API**, with **Tone.js** for scheduling and transport.
- One instrument instance per part, so per-part gain is trivial.
- Timbre: a simple sustained tone is acceptable, but a soundfont/sampled voice-like patch is much easier to sing against than a raw oscillator. Worth the effort.
- Sample-accurate loop points; no audible gap or click at the loop seam. This is the single most important quality bar in the app — a clicky loop makes it unusable for its purpose.

## 6. Interface

### 6.1 Landing page — project organizer

- List of existing projects (title, thumbnail or part count, last opened)
- "New project" → upload → parse → straight into the project view
- Rename / delete

Minimal. It is a launcher, not a dashboard.

### 6.2 Project view

**Part bands (the main surface)**

- One horizontal band per part, stacked vertically.
- Within a band: notes rendered as clearly visible **dots** positioned on a vertical pitch scale, laid out left-to-right in time. Piano-roll idiom, not staff notation.
- Shared horizontal time axis across all bands, aligned.
- Playhead sweeps across all bands together.
- Band height should be generous enough that pitch contour is readable at a glance — contour is the thing the user is trying to learn.

**Mixer**

- Each band carries its own volume control, 0–100.
- 0 = fully silent, so the user can strip everything back to their own line.
- A **link mode** toggle with three states:
  1. **All** — moving one fader moves every band together
  2. **All except focus** — moving one fader moves every band *except* the designated focus part (this is the "turn everyone else down" gesture, and will be the most-used mode)
  3. **Independent** — every fader moves alone
- A part must be markable as the **focus part** for mode 2 to have a referent. Clicking a band's label is a reasonable gesture.

**Loop & transport**

- Drag horizontally over the time axis to define a **loop region** (typical use: a ~15-second span).
- Whole-song loop as the default state when no region is selected.
- Play / pause / stop, loop on-off, playhead scrub.
- Tempo control is desirable (slow practice is standard for by-ear work) — implement if cheap, since the synth engine makes it nearly free.

**Notes pane**

- One freeform text area per project.
- Intended for things like what the lyrics mean, historical background, or anything that helps the user enjoy the song.
- Autosave. Collapsible so it doesn't compete with the bands for space.

## 7. Stack recommendation

- Frontend: React + TypeScript
- Audio: Tone.js over Web Audio
- Rendering: Canvas or SVG for the bands — Canvas if note density causes DOM performance trouble
- Storage: browser-local (IndexedDB) for v1; no server persistence needed
- OMR: server-side worker if Audiveris (JVM), otherwise consider WASM/in-browser to stay serverless

Local-first keeps deployment trivial and sidesteps every question about uploaded copyrighted sheet music sitting on a server.

## 8. Extension seams (design for, don't build)

- **Audio source abstraction.** Parts should be addressed through an interface that doesn't assume synthesis, so a future recording-backed part can slot in.
- **Score source abstraction.** OMR is one producer of MusicXML among several.
- Everything else can be built concretely.

## 9. Sequencing

The risk in this project is **not** the mixer, the loop, or the playback — those are well-trodden. The risk is entirely in OMR accuracy on real scores, which is genuinely unreliable and could sink the schedule.

Therefore:

- **Milestone 1 — the practice instrument.** MusicXML/MIDI import only. Bands, dots, mixer, link modes, loop region, transport, notes pane, project list. *At the end of this milestone the app is already fully usable to its intended user*, because public-domain MusicXML for hymns, folk songs, and choral repertoire is widely available. This is the milestone that must land.
- **Milestone 2 — OMR ingest.** Add image/PDF upload behind the same interface. Evaluate engines against a handful of real scores before committing.
- **Milestone 3 — correction surface.** Note-level editing on the piano roll. Almost certainly required the moment M2 meets a real photographed score.
- **Milestone 4 — polish.** Tempo control, better timbres, keyboard shortcuts.

If OMR turns out to be a swamp, M1 still stands on its own and the project is still a success.

## 10. Reference test case — "The Wellerman"

Milestone 1 should be built and validated against this piece specifically.

**Why it's a good first target**

- The underlying song is a traditional New Zealand shanty in the public domain. Note that *individual arrangements are separately copyrighted* — for a test corpus, use a freely-licensed multipart arrangement, not a purchased choral edition.
- Multipart arrangements are abundant. MuseScore alone carries SATB, TTBB, SAB, and men's-choir versions, most exportable to MusicXML/MIDI. Check the uploader's license before bundling anything as a fixture.
- Its structure is a genuine workout for the feature set, not a toy case.

**What it will stress-test**

1. **Repeats and voltas.** Strophic verse/chorus form means the MusicXML almost certainly contains repeat barlines and first/second endings. The parser must **unroll repeats into a linear timeline** before the piano roll can render or the transport can scrub. This is a real chunk of work and is easy to overlook until the playhead does something wrong.
2. **Sparse parts.** Call-and-response shanty texture means some voices rest for long stretches. Bands must stay legible and vertically aligned when a part is empty for many bars.
3. **Overlapping/split voices.** Many arrangements put two voices on one staff. This is the multi-voice case flagged in §5.2 — worth confronting early rather than in Milestone 2.
4. **Loop-region ergonomics.** A repeating chorus is exactly the kind of span the drag-select is for. If looping the chorus of the Wellerman feels good, the core interaction works.

Recommendation: pick one SATB arrangement, commit its MusicXML into the repo as a test fixture, and treat "can I learn the bass line of the Wellerman chorus with this" as the acceptance test for Milestone 1.

## 11. Open questions

1. ~~**Name.**~~ *Resolved:* the app is **Unbraid**. The earlier *harmony + ease*
   candidates are abandoned — "Harmonease" collided with *HarmonEase Innovations*
   (assistive devices for pianists, close enough in the music space to be a real
   conflict) and "Harmoneeze" only dodged that by mangling the spelling. "Unbraid"
   describes what the app actually does — separating braided voices — and carries
   the visual mark. Trademark search before anything public is still worth doing.
2. **Multi-voice staves.** How aggressively should v1 try to split two voices sharing one staff? Affects a lot of real choral sheet music.
3. **Part labeling.** Fall back to what when the score has no part names — "Staff 1/2/3"? Infer from clef and range?
4. **Score display.** Is the piano-roll enough, or does the user also want the original score image visible alongside for reference?
