import type { NoteEvent, Part, Score, TimelineMeasure } from './types';

/**
 * Recording → Score: everything after the neural network.
 *
 * The transcriber (src/audio/transcriber.ts) hears a recording and reports a
 * flat list of notes: pitch, start, length, loudness. It has no idea which
 * singer sang which note. This module turns that list into the same `Score`
 * a MusicXML import produces, so the band view, mixer, and loop work on a
 * recording without knowing where the parts came from (execution doc §8,
 * "score source abstraction").
 *
 * Three jobs, each a separate exported function so it can be tested alone:
 *
 *   1. How many parts?          `estimatePartCount`
 *   2. Which note is whose?     `splitIntoVoices`
 *   3. Where are the bar lines? `estimateBeatGrid`
 *
 * No DOM, no audio, no TensorFlow — this runs identically under vitest.
 *
 * One property matters more than any other: **notes keep the timing they were
 * heard with.** Nothing is quantised to the estimated beat. If the tempo guess
 * is wrong, bar lines land in the wrong places, and loop-snapping is off; but
 * playback still sounds exactly as the recording was sung, because beats are
 * converted back to seconds through the same tempo they were derived from.
 */

/** One note as the transcriber heard it. Times are seconds into the recording. */
export interface HeardNote {
  startSec: number;
  durationSec: number;
  /** MIDI pitch number; 60 = middle C. Already rounded to a semitone. */
  midiPitch: number;
  /** The model's confidence, 0..1. Used only to decide what to drop. */
  amplitude: number;
}

/** The most parts the splitter will produce. Beyond six, voice-leading gives no useful signal. */
export const MAX_PARTS = 6;

/**
 * How Basic Pitch's raw output is turned into notes.
 *
 * Shared by the app and by scripts/transcribe-fixture.ts, so the committed
 * fixtures are exactly what the app would hear. Tuned on those fixtures: a
 * strict onset threshold is what keeps overtones from being read as extra
 * singers (at 0.5 the Bach fixture gains ~100 phantom notes; at 0.7 it has
 * 303 against a true 302).
 */
export const TRANSCRIBER_SETTINGS = {
  /** How sure the model must be that a note *starts* here, 0..1. */
  onsetThreshold: 0.7,
  /** How sure it must be that a note is still *sounding*, 0..1. */
  frameThreshold: 0.4,
  /** Shortest note kept, in model frames (~11.6 ms each): about 130 ms. */
  minNoteFrames: 11,
  /** Also start notes where a pitch appears without a sharp attack (legato singing). */
  inferOnsets: true,
  /** Sung range, roughly C2–F6. Anything outside is an overtone or noise. */
  minFreqHz: 60,
  maxFreqHz: 1500,
  /** Basic Pitch's "melodia trick" favours one melody line; wrong for part singing. */
  melodiaTrick: false,
} as const;

// ---------------------------------------------------------------------------
// Clean-up
// ---------------------------------------------------------------------------

/**
 * Sort, discard degenerate notes, and fuse same-pitch overlaps.
 *
 * Two overlapping detections at one pitch are one sung note heard twice
 * (typically a harmonic of one voice landing on another's pitch), never two
 * singers, so they are merged into their union.
 */
export function cleanNotes(notes: HeardNote[]): HeardNote[] {
  const sorted = notes
    .filter((n) => n.durationSec > 0 && Number.isFinite(n.startSec))
    .slice()
    .sort((a, b) => a.startSec - b.startSec || b.midiPitch - a.midiPitch);

  const out: HeardNote[] = [];
  /** Pitch -> index in `out` of the latest note at that pitch. */
  const lastAtPitch = new Map<number, number>();
  for (const note of sorted) {
    const i = lastAtPitch.get(note.midiPitch);
    if (i !== undefined) {
      const prev = out[i];
      const prevEnd = prev.startSec + prev.durationSec;
      if (note.startSec < prevEnd - 1e-6) {
        const end = Math.max(prevEnd, note.startSec + note.durationSec);
        out[i] = {
          ...prev,
          durationSec: end - prev.startSec,
          amplitude: Math.max(prev.amplitude, note.amplitude),
        };
        continue;
      }
    }
    lastAtPitch.set(note.midiPitch, out.length);
    out.push({ ...note });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. How many parts?
// ---------------------------------------------------------------------------

/**
 * Guess how many independent lines the recording carries.
 *
 * Samples the number of simultaneously sounding notes every 20 ms, over the
 * moments where anything sounds at all, and takes a high quantile. A high
 * quantile rather than the maximum, because the transcriber's occasional
 * ghost note (an overtone read as a pitch) would otherwise add a phantom
 * part; and rather than the median, because a shanty's solo verse should not
 * outvote its four-part chorus.
 */
export function estimatePartCount(notes: HeardNote[], quantile = 0.85): number {
  if (notes.length === 0) return 1;
  const step = 0.02;
  const end = Math.max(...notes.map((n) => n.startSec + n.durationSec));
  const counts = new Int16Array(Math.ceil(end / step) + 1);
  for (const n of notes) {
    const a = Math.floor(n.startSec / step);
    const b = Math.floor((n.startSec + n.durationSec) / step);
    for (let i = a; i < b; i++) counts[i]++;
  }
  const sounding = Array.from(counts).filter((c) => c > 0).sort((x, y) => x - y);
  if (sounding.length === 0) return 1;
  const q = sounding[Math.min(sounding.length - 1, Math.floor(quantile * sounding.length))];
  return Math.max(1, Math.min(MAX_PARTS, q));
}

// ---------------------------------------------------------------------------
// 2. Which note is whose?
// ---------------------------------------------------------------------------

/** Notes whose onsets fall within this window are treated as struck together. */
const CHORD_WINDOW_SEC = 0.06;

/**
 * A note still ringing this far past a new onset counts as overlapping it.
 * Below this, the old note is just a legato tail and is trimmed.
 */
const LEGATO_TAIL_SEC = 0.1;

/** Cost, in semitones, of cutting short a voice that is still clearly sounding. */
const BUSY_PENALTY = 7;

/**
 * Cost, in semitones, of leaving a note out, per unit of model confidence.
 *
 * The transcriber's commonest mistake is an overtone heard as an extra note
 * an octave or a twelfth above a real one. Such ghosts are less confident, and
 * placing one forces every real note in its chord down a voice. Letting the
 * splitter drop a note, at a price that scales with confidence, lets it skip
 * the ghost instead. A confident note (~0.8) costs ~10 semitones to drop,
 * more than any sensible placement.
 */
const DROP_COST_PER_CONFIDENCE = 12;

function dropCost(note: HeardNote): number {
  return DROP_COST_PER_CONFIDENCE * note.amplitude;
}

/** Cost, in semitones, of a new note crossing a note held in another voice. */
const CROSSING_PENALTY = 3;


/**
 * Where each voice "lives", as a typical MIDI pitch. Index 0 is the highest.
 *
 * The best evidence is the moments when every voice sings at once: there,
 * sorting the sounding pitches high to low *is* the voice assignment. So the
 * centres are the median pitch per rank across those moments (sampled every
 * 50 ms, which weights by duration).
 *
 * A recording that never reaches full texture (or a part count forced higher
 * than the music supports) has no such moments; then the fallback is pitch
 * quantiles over everything, which is cruder because a long solo skews it.
 */
export function voiceCentres(notes: HeardNote[], voices: number): number[] {
  const step = 0.05;
  const ranks: number[][] = Array.from({ length: voices }, () => []);
  if (notes.length > 0) {
    const end = Math.max(...notes.map((n) => n.startSec + n.durationSec));
    let active: HeardNote[] = [];
    let next = 0;
    for (let t = 0; t < end; t += step) {
      while (next < notes.length && notes[next].startSec <= t) active.push(notes[next++]);
      active = active.filter((n) => n.startSec + n.durationSec > t);
      if (active.length === voices) {
        const sorted = active.map((n) => n.midiPitch).sort((a, b) => b - a);
        sorted.forEach((p, i) => ranks[i].push(p));
      }
    }
  }
  if (ranks[0].length >= 5) return ranks.map(median);

  const weighted = notes
    .map((n) => ({ p: n.midiPitch, w: n.durationSec }))
    .sort((a, b) => a.p - b.p);
  const total = weighted.reduce((sum, x) => sum + x.w, 0);
  const centres: number[] = [];
  for (let v = 0; v < voices; v++) {
    // Highest voice first: the quantile for voice v is (voices - v - 0.5) / voices.
    const target = ((voices - v - 0.5) / voices) * total;
    let acc = 0;
    let pitch = weighted.length > 0 ? weighted[weighted.length - 1].p : 60;
    for (const x of weighted) {
      acc += x.w;
      if (acc >= target) {
        pitch = x.p;
        break;
      }
    }
    centres.push(pitch);
  }
  return centres;
}

/** Notes grouped by near-simultaneous onset, each group sorted high to low. */
export function groupChords(notes: HeardNote[]): HeardNote[][] {
  const chords: HeardNote[][] = [];
  for (const n of notes) {
    const current = chords[chords.length - 1];
    if (current !== undefined && n.startSec - current[0].startSec <= CHORD_WINDOW_SEC) {
      current.push(n);
    } else {
      chords.push([n]);
    }
  }
  for (const c of chords) c.sort((a, b) => b.midiPitch - a.midiPitch);
  return chords;
}

export interface VoiceSplit {
  /** One list per voice, highest voice first. Notes may have been trimmed. */
  voices: HeardNote[][];
  /**
   * Notes left out: extras when a chord holds more pitches than there are
   * voices, and faint notes (likely overtones) that fit no voice's line.
   */
  dropped: number;
}

/**
 * Assign every note to one of `voiceCount` lines.
 *
 * Works chord by chord, left to right, the way a singer reading a hymn would:
 * each voice keeps a sense of where it currently is, and a new chord's notes
 * go to whichever voices can reach them most smoothly. Two rules shape that:
 *
 * - **Voices do not cross.** Within a chord, the highest new note always goes
 *   to a higher voice than the next one down. This is enforced exactly, by
 *   choosing an order-preserving assignment (a dynamic programme over chord
 *   notes × voices), which is what makes closed SATB come apart cleanly.
 * - **Small steps beat big leaps.** The cost of giving a note to a voice is
 *   its distance in semitones from where that voice has been, with a penalty
 *   for interrupting a voice that is still singing.
 *
 * Crossing *against held notes* is discouraged but allowed, since real parts
 * do occasionally cross. A note may also be left out altogether, at a cost
 * that grows with the model's confidence in it (see DROP_COST_PER_CONFIDENCE);
 * that is how overtones, and the extras in a chord with more pitches than
 * voices, are discarded.
 *
 * Finally, unaccompanied stretches are revisited as wholes; see
 * `reassignSoloRuns`.
 */
export function splitIntoVoices(input: HeardNote[], voiceCount: number): VoiceSplit {
  const k = Math.max(1, Math.min(MAX_PARTS, Math.round(voiceCount)));
  const notes = cleanNotes(input);
  const centres = voiceCentres(notes, k);

  const voices: HeardNote[][] = Array.from({ length: k }, () => []);
  /** Last pitch each voice sang, or null if it has not sung yet. */
  const last: (number | null)[] = Array(k).fill(null);
  let dropped = 0;

  /** Where voice v is expected next: its last pitch, pulled gently toward home. */
  const anchor = (v: number): number => {
    const l = last[v];
    return l === null ? centres[v] : 0.75 * l + 0.25 * centres[v];
  };

  for (const members of groupChords(notes)) {
    const t = members[0].startSec;
    const m = members.length;

    // What is each voice doing at this instant?
    const heldPitch: (number | null)[] = voices.map((line) => {
      const prev = line[line.length - 1];
      if (prev === undefined) return null;
      return prev.startSec + prev.durationSec > t + LEGATO_TAIL_SEC ? prev.midiPitch : null;
    });

    const cost = (noteIdx: number, v: number): number => {
      const p = members[noteIdx].midiPitch;
      let c = Math.abs(p - anchor(v));
      if (heldPitch[v] !== null) c += BUSY_PENALTY;
      for (let u = 0; u < k; u++) {
        const h = heldPitch[u];
        if (u === v || h === null) continue;
        // A higher voice (u < v) holding a note below p, or a lower one above it.
        if ((u < v && h < p) || (u > v && h > p)) c += CROSSING_PENALTY;
      }
      return c;
    };

    // Align the chord's notes (high→low) with the voices (high→low), like an
    // edit distance: each note either goes to the next voice down, or is
    // dropped; each voice either takes a note or sits this chord out.
    // dp[i][j]: cheapest handling of the first i notes using the first j voices.
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(k + 1).fill(Infinity));
    const step: ('note' | 'voice' | 'match')[][] = Array.from({ length: m + 1 }, () =>
      Array(k + 1).fill('voice'),
    );
    for (let j = 0; j <= k; j++) dp[0][j] = 0;
    for (let i = 1; i <= m; i++) {
      for (let j = 0; j <= k; j++) {
        const dropNote = dp[i - 1][j] + dropCost(members[i - 1]);
        if (dropNote < dp[i][j]) {
          dp[i][j] = dropNote;
          step[i][j] = 'note';
        }
        if (j === 0) continue;
        const skipVoice = dp[i][j - 1];
        if (skipVoice < dp[i][j]) {
          dp[i][j] = skipVoice;
          step[i][j] = 'voice';
        }
        const match = dp[i - 1][j - 1] + cost(i - 1, j - 1);
        if (match < dp[i][j]) {
          dp[i][j] = match;
          step[i][j] = 'match';
        }
      }
    }
    const assignment: (number | null)[] = Array(m).fill(null);
    for (let i = m, j = k; i > 0; ) {
      const s = step[i][j];
      if (s === 'match') assignment[--i] = --j;
      else if (s === 'note') i--;
      else j--;
    }

    members.forEach((note, i) => {
      const v = assignment[i];
      if (v === null) {
        dropped++;
        return;
      }
      const line = voices[v];
      const prev = line[line.length - 1];
      // One voice sings one note at a time: end the previous one where this begins.
      if (prev !== undefined && prev.startSec + prev.durationSec > note.startSec) {
        line[line.length - 1] = { ...prev, durationSec: Math.max(0.02, note.startSec - prev.startSec) };
      }
      line.push({ ...note });
      last[v] = note.midiPitch;
    });
  }

  return { voices: reassignSoloRuns(voices, centres), dropped };
}

/** Solo runs separated by a silence longer than this are judged separately. */
const RUN_BREAK_SEC = 3;

/** Join cost, in semitones, when a voice has no note near a run's edge. */
const UNKNOWN_JOIN = 4;

/**
 * Give each unaccompanied stretch to the single voice that best carries it.
 *
 * The chord-by-chord pass cannot get a solo right on its own: a lone D4 at
 * the start of a shanty verse could belong to any voice, and whichever it
 * lands in then keeps the rest of the verse. But the music around the solo
 * settles it, because the soloist is usually the voice that carries the line
 * on when the others come in (or that was singing just before).
 *
 * So, after the forward pass, every run of notes that overlap no other voice
 * is scored as a whole against each voice: how far the run sits from the
 * voice's home range, plus how smoothly it joins that voice's notes on either
 * side. The run moves, all together, to the cheapest voice.
 */
function reassignSoloRuns(voices: HeardNote[][], centres: number[]): HeardNote[][] {
  const k = voices.length;
  if (k < 2) return voices;

  const flat = voices
    .flatMap((line, v) => line.map((note) => ({ note, v })))
    .sort((a, b) => a.note.startSec - b.note.startSec);
  const end = (n: HeardNote): number => n.startSec + n.durationSec;

  // A note is "alone" if no other voice's note overlaps it by more than a legato tail.
  const alone = flat.map(({ note, v }) =>
    flat.every(
      (o) =>
        o.v === v ||
        Math.min(end(note), end(o.note)) - Math.max(note.startSec, o.note.startSec) <= LEGATO_TAIL_SEC,
    ),
  );

  const runs: number[][] = [];
  flat.forEach(({ note }, i) => {
    if (!alone[i]) return;
    const run = runs[runs.length - 1];
    const prevIdx = run?.[run.length - 1];
    if (prevIdx === i - 1 && note.startSec - end(flat[prevIdx].note) <= RUN_BREAK_SEC) run.push(i);
    else runs.push([i]);
  });

  const target = flat.map(({ v }) => v);
  for (const run of runs) {
    if (run.length < 2) continue;
    const first = flat[run[0]].note;
    const lastNote = flat[run[run.length - 1]].note;
    const pitches = run.map((i) => flat[i].note.midiPitch);

    let bestV = target[run[0]];
    let bestCost = Infinity;
    for (let v = 0; v < k; v++) {
      const home = pitches.reduce((s, p) => s + Math.abs(p - centres[v]), 0) / pitches.length;

      // Voice v's nearest notes just before and just after the run.
      let before: HeardNote | null = null;
      let after: HeardNote | null = null;
      for (let i = run[0] - 1; i >= 0; i--) {
        if (flat[i].v !== v) continue;
        if (first.startSec - end(flat[i].note) <= RUN_BREAK_SEC) before = flat[i].note;
        break;
      }
      for (let i = run[run.length - 1] + 1; i < flat.length; i++) {
        if (flat[i].v !== v) continue;
        if (flat[i].note.startSec - end(lastNote) <= RUN_BREAK_SEC) after = flat[i].note;
        break;
      }
      const joinIn = before === null ? UNKNOWN_JOIN : Math.abs(first.midiPitch - before.midiPitch);
      const joinOut = after === null ? UNKNOWN_JOIN : Math.abs(lastNote.midiPitch - after.midiPitch);

      const cost = home + joinIn + joinOut;
      if (cost < bestCost) {
        bestCost = cost;
        bestV = v;
      }
    }
    for (const i of run) target[i] = bestV;
  }

  const out: HeardNote[][] = Array.from({ length: k }, () => []);
  flat.forEach(({ note }, i) => out[target[i]].push(note));
  return out;
}

// ---------------------------------------------------------------------------
// 3. Where are the bar lines?
// ---------------------------------------------------------------------------

export interface BeatGrid {
  /** Quarter notes per minute. */
  tempoBpm: number;
  /** Recording time, in seconds, of beat 0 — the first bar line. */
  originSec: number;
  beatsPerBar: number;
}

/** Onset envelope resolution: 100 frames per second. */
const ENV_RATE = 100;

/**
 * Guess a steady beat from when notes start.
 *
 * Builds an onset envelope (a smoothed spike wherever notes begin, taller
 * where more voices begin together), autocorrelates it, and picks the beat
 * period with the strongest self-similarity, weighted toward moderate tempi
 * so that the half- or double-speed reading only wins when it is clearly
 * better. Then finds the beat phase, and the bar phase: the beat, of every
 * `beatsPerBar`, on which the most voices begin together.
 *
 * Assumes one steady tempo and a fixed metre. Neither holds for a freely sung
 * recording, which is why nothing downstream is quantised to this grid.
 */
export function estimateBeatGrid(notes: HeardNote[], beatsPerBar = 4): BeatGrid {
  const fallback: BeatGrid = { tempoBpm: 60, originSec: notes[0]?.startSec ?? 0, beatsPerBar };
  if (notes.length < 8) return fallback;

  const chords = groupChords(cleanNotes(notes));
  const end = chords[chords.length - 1][0].startSec + 1;
  const env = new Float64Array(Math.ceil(end * ENV_RATE) + 1);
  const sigma = 3; // frames, i.e. 30 ms
  for (const c of chords) {
    const centre = c[0].startSec * ENV_RATE;
    for (let d = -3 * sigma; d <= 3 * sigma; d++) {
      const i = Math.round(centre) + d;
      if (i >= 0 && i < env.length) env[i] += c.length * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
  }

  const minLag = Math.round((60 / 200) * ENV_RATE);
  const maxLag = Math.round((60 / 45) * ENV_RATE);
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length && lag < env.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (env.length - lag);
  }

  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * ENV_RATE) / lag;
    // Log-normal preference centred on 100 bpm, about an octave wide.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 100) / 0.9) ** 2);
    // A true beat period also lines up at twice its length.
    const score = (ac[lag] + 0.5 * (ac[2 * lag] ?? 0)) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestScore <= 0) return fallback;

  // The autocorrelation peak is only frame-accurate (10 ms), and over a
  // two-minute song a 1% tempo error drifts the grid by a whole beat. So
  // refine period and phase together: slide a comb of beat ticks across the
  // envelope and keep the period/phase whose ticks collect the most onset
  // energy. ±3% around the peak, 0.5 ms and 10 ms steps.
  const coarse = bestLag / ENV_RATE;
  const comb = (period: number, phase: number): number => {
    let sum = 0;
    for (let t = phase; t * ENV_RATE < env.length; t += period) sum += env[Math.round(t * ENV_RATE)];
    return sum;
  };
  let period = coarse;
  let phase = 0;
  let combBest = -Infinity;
  for (let p = coarse * 0.97; p <= coarse * 1.03; p += 0.0005) {
    for (let ph = 0; ph < p; ph += 1 / ENV_RATE) {
      const c = comb(p, ph);
      if (c > combBest) {
        combBest = c;
        period = p;
        phase = ph;
      }
    }
  }

  // Bar phase: which beat of the bar carries the most weight. Long notes and
  // full chords both tend to fall on downbeats, so each chord counts as its
  // total sung duration, measured in beats.
  const barWeight = Array(beatsPerBar).fill(0);
  for (const c of chords) {
    const beat = Math.round((c[0].startSec - phase) / period);
    const slot = ((beat % beatsPerBar) + beatsPerBar) % beatsPerBar;
    barWeight[slot] += c.reduce((sum, n) => sum + n.durationSec, 0) / period;
  }
  const downbeat = barWeight.indexOf(Math.max(...barWeight));

  // First bar line at or just before the first note.
  const first = chords[0][0].startSec;
  const barSec = period * beatsPerBar;
  const anyBarLine = phase + downbeat * period;
  const originSec = anyBarLine - Math.ceil((anyBarLine - first - 0.05) / barSec) * barSec;

  return { tempoBpm: Math.round(600 / period) / 10, originSec, beatsPerBar };
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

/** Part names, highest first. Deliberately not "Soprano": a TTBB recording has none. */
function voiceLabel(index: number, count: number): string {
  if (count === 1) return 'Melody';
  if (index === 0) return 'Voice 1 (top)';
  if (index === count - 1) return `Voice ${count} (bottom)`;
  return `Voice ${index + 1}`;
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface RecordingOptions {
  title: string;
  /** How many parts to split into. Omit, or pass 'auto', to estimate. */
  partCount?: number | 'auto';
  beatsPerBar?: number;
}

/**
 * Build a playable `Score` from what the transcriber heard.
 *
 * Silent voices (which can happen when the part count is forced higher than
 * the music supports) are dropped rather than shown as empty bands.
 */
export function scoreFromRecording(heard: HeardNote[], options: RecordingOptions): Score {
  const notes = cleanNotes(heard);
  if (notes.length === 0) {
    throw new Error('No notes were heard in that recording.');
  }

  const auto = options.partCount === undefined || options.partCount === 'auto';
  const k = auto ? estimatePartCount(notes) : (options.partCount as number);
  const { voices, dropped } = splitIntoVoices(notes, k);
  const grid = estimateBeatGrid(notes, options.beatsPerBar ?? 4);

  const secPerBeat = 60 / grid.tempoBpm;
  const toBeats = (sec: number): number => Math.max(0, (sec - grid.originSec) / secPerBeat);
  const bar = grid.beatsPerBar;

  const kept = voices.filter((line) => line.length > 0);
  const parts: Part[] = kept.map((line, i) => {
    const events: NoteEvent[] = line.map((n) => {
      const onsetBeats = toBeats(n.startSec);
      return {
        onsetBeats,
        durationBeats: n.durationSec / secPerBeat,
        midiPitch: n.midiPitch,
        measureNumber: String(Math.floor(onsetBeats / bar) + 1),
      };
    });
    const pitches = line.map((n) => n.midiPitch);
    return {
      id: `voice-${i + 1}`,
      label: voiceLabel(i, kept.length),
      events,
      // G (treble) for anything centred at or above A3, else F (bass).
      clef: median(pitches) >= 57 ? 'G' : 'F',
      // A recording carries no key signature; nothing in the app reads one yet.
      keyFifths: 0,
      range: { minMidi: Math.min(...pitches), maxMidi: Math.max(...pitches) },
      source: { partId: 'recording', voice: String(i + 1) },
    };
  });

  const endBeats = Math.max(
    ...parts.flatMap((p) => p.events.map((e) => e.onsetBeats + e.durationBeats)),
  );
  const barCount = Math.max(1, Math.ceil(endBeats / bar));
  const measures: TimelineMeasure[] = Array.from({ length: barCount }, (_, i) => ({
    number: String(i + 1),
    index: i,
    startBeats: i * bar,
    durationBeats: bar,
    pass: 0,
  }));

  const warnings = [
    `Transcribed from a recording, split into ${parts.length} part${parts.length === 1 ? '' : 's'}` +
      `${auto ? ' (estimated)' : ''}. Bar lines assume a steady ${grid.tempoBpm} bpm in ` +
      `${bar}/4, so they may drift; the notes themselves keep the recording's own timing.`,
  ];
  if (dropped > 0) {
    warnings.push(
      `${dropped} faint note${dropped === 1 ? '' : 's'} fit no part's line and ` +
        `${dropped === 1 ? 'was' : 'were'} left out (usually overtones, not singers). ` +
        `If a part seems to be missing notes, try importing again with more parts.`,
    );
  }

  return {
    title: options.title,
    parts,
    measures,
    durationBeats: barCount * bar,
    tempoBpm: grid.tempoBpm,
    lyrics: [],
    warnings,
  };
}
