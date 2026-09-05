import type { LyricSyllable, NoteEvent, Part, Score, TimelineMeasure } from './types';
import { pitchToMidi } from './pitch';
import { childNumber, childText, hasChild, type XmlElement } from './xml';
import { unrollMeasures, type UnrolledStep } from './unroll';

/** Fallback when the score names no tempo. */
const DEFAULT_TEMPO_BPM = 100;
/** Fallback when a part's first measure declares no <divisions>. */
const DEFAULT_DIVISIONS = 1;

/** A note as read from one written measure, before unrolling. */
interface RawNote {
  /** Onset in quarters from the start of its own written measure. */
  offsetBeats: number;
  durationBeats: number;
  midiPitch: number;
  voice: string;
  staff: string;
  tieStart: boolean;
  tieStop: boolean;
  /** Sung text attached to this note, already trimmed. Empty when none. */
  lyric: string;
}

/** Everything read from one written measure of one MusicXML part. */
interface RawMeasure {
  number: string;
  notes: RawNote[];
  /** Length in quarters: from the time signature, or the notes if absent. */
  durationBeats: number;
}

/** Per-part state that carries across measures (MusicXML is stateful). */
interface PartState {
  divisions: number;
  beats: number;
  beatType: number;
  /** Staff number -> clef sign, e.g. "1" -> "G". */
  clefs: Map<string, string>;
  keyFifths: number;
}

/**
 * Read a <note>. Returns null for elements that consume no new time slot in
 * the way this parser tracks it (rests advance the cursor but produce no
 * event; chord members share the previous note's onset).
 */
function readNoteDuration(note: XmlElement, divisions: number): number {
  return childNumber(note, 'duration', 0) / divisions;
}

function readTies(note: XmlElement): { start: boolean; stop: boolean } {
  let start = false;
  let stop = false;
  // <tie> is the sounding tie; <tied> inside <notations> is the engraved slur
  // of a tie. Real exporters vary in which they emit, so accept either.
  for (const t of note.children('tie')) {
    if (t.attr('type') === 'start') start = true;
    if (t.attr('type') === 'stop') stop = true;
  }
  const notations = note.child('notations');
  if (notations !== null) {
    for (const t of notations.children('tied')) {
      if (t.attr('type') === 'start') start = true;
      if (t.attr('type') === 'stop') stop = true;
    }
  }
  return { start, stop };
}

/**
 * Read the sung syllable attached to a `<note>`.
 *
 * Only the first lyric line is taken. A second `<lyric number="2">` is a verse
 * alternative — printing both interleaved would be unreadable in a single
 * horizontal strip, and verse switching is not something this tool offers.
 *
 * The text is taken as written, including any hyphen the exporter put there
 * (`tong-`, `cap-`). `<syllabic>` is deliberately *not* used to add hyphens.
 * It ought to mean "this syllable continues into the next", but real exports
 * misuse it constantly: in the Wellerman TTBB fixture MuseScore marks the
 * separate words `put`/`to`, `Billy`/`of` and `Soon`/`may` as begin/end
 * because the singer entered them as melismas, while genuinely split words
 * (`bul`/`ly`, `tong-`/`uin'`) look no different. Adding a hyphen on that
 * signal would print "Soon- may the Weller- men come". The literal text is the
 * only trustworthy source, so it is what gets shown.
 *
 * `<elision>` (two syllables under one note) is joined with a tie character
 * rather than dropped, since dropping one loses a word.
 */
function readLyric(note: XmlElement): string {
  const lyric = note.child('lyric');
  if (lyric === null) return '';

  // The lyric line number: absent means the only line, which is line 1.
  const number = lyric.attr('number');
  if (number !== null && number.trim() !== '' && number.trim() !== '1') return '';

  // A note can hold several <text> runs separated by <elision>.
  const texts = lyric.children('text').map((t) => t.text().trim());
  const text = texts.filter((t) => t !== '').join('\u203f');
  if (text === '') return '';

  return text;
}

/** Apply an <attributes> element to the running part state. */
function applyAttributes(attrs: XmlElement, state: PartState): void {
  const divisions = childNumber(attrs, 'divisions', 0);
  if (divisions > 0) state.divisions = divisions;

  const key = attrs.child('key');
  if (key !== null) state.keyFifths = childNumber(key, 'fifths', state.keyFifths);

  const time = attrs.child('time');
  if (time !== null) {
    state.beats = childNumber(time, 'beats', state.beats);
    state.beatType = childNumber(time, 'beat-type', state.beatType);
  }

  for (const clef of attrs.children('clef')) {
    const sign = childText(clef, 'sign') ?? 'G';
    state.clefs.set(clef.attr('number') ?? '1', sign.trim());
  }
}

/**
 * Read one written measure of one part.
 *
 * MusicXML measures are a cursor-based format: notes advance a time cursor,
 * <backup> rewinds it (this is how a second voice on the same staff is
 * written), and <forward> skips ahead. Getting these right is what makes
 * multi-voice staves work at all.
 */
function readMeasure(measure: XmlElement, state: PartState): RawMeasure {
  const notes: RawNote[] = [];
  let cursor = 0;
  let maxCursor = 0;
  /** Onset of the note most recently placed, for <chord> members. */
  let lastOnset = 0;

  for (const el of measure.children()) {
    switch (el.tag) {
      case 'attributes':
        applyAttributes(el, state);
        break;

      case 'backup':
        cursor -= childNumber(el, 'duration', 0) / state.divisions;
        if (cursor < 0) cursor = 0;
        break;

      case 'forward':
        cursor += childNumber(el, 'duration', 0) / state.divisions;
        maxCursor = Math.max(maxCursor, cursor);
        break;

      case 'note': {
        const isChord = hasChild(el, 'chord');
        const isGrace = hasChild(el, 'grace');
        const duration = isGrace ? 0 : readNoteDuration(el, state.divisions);
        // A chord member sounds with the previous note rather than after it.
        const onset = isChord ? lastOnset : cursor;

        const pitch = el.child('pitch');
        if (pitch !== null && !isGrace) {
          const step = childText(pitch, 'step') ?? 'C';
          const octave = childNumber(pitch, 'octave', 4);
          const alter = childNumber(pitch, 'alter', 0);
          const ties = readTies(el);
          notes.push({
            offsetBeats: onset,
            durationBeats: duration,
            midiPitch: pitchToMidi(step.trim(), octave, alter),
            voice: (childText(el, 'voice') ?? '1').trim(),
            staff: (childText(el, 'staff') ?? '1').trim(),
            tieStart: ties.start,
            tieStop: ties.stop,
            lyric: readLyric(el),
          });
        }

        // Rests and pitched notes both advance the cursor; chord members and
        // grace notes do not.
        if (!isChord) {
          lastOnset = cursor;
          cursor += duration;
          maxCursor = Math.max(maxCursor, cursor);
        }
        break;
      }

      default:
        break;
    }
  }

  // Prefer the notated time signature for measure length: a measure where every
  // part rests, or a partially-filled pickup, still occupies its full width.
  const notated = state.beats * (4 / state.beatType);
  const durationBeats = notated > 0 ? notated : maxCursor;

  return {
    number: measure.attr('number') ?? '',
    notes,
    durationBeats,
  };
}

/** Quarter notes per beat for a `<beat-unit>` name, e.g. "half" -> 2. */
const BEAT_UNIT_QUARTERS: Record<string, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
};

/** A `<metronome>` marking as quarter notes per minute, or null. */
function metronomeToQuarterBpm(metronome: XmlElement): number | null {
  const perMinute = childNumber(metronome, 'per-minute', 0);
  if (perMinute <= 0) return null;

  const unit = (childText(metronome, 'beat-unit') ?? 'quarter').trim().toLowerCase();
  let quarters = BEAT_UNIT_QUARTERS[unit];
  if (quarters === undefined) return null;

  // A dot adds half again to the beat unit; two dots add a quarter more.
  const dots = metronome.children('beat-unit-dot').length;
  for (let i = 0; i < dots; i++) quarters *= 1.5;

  return perMinute * quarters;
}

/**
 * Playback tempo in quarter notes per minute.
 *
 * `<sound tempo>` is already defined as quarter notes per minute, so it wins
 * when present. Failing that, a `<metronome>` marking is converted through its
 * beat unit — "half = 100" in cut time is 200 quarters per minute, not 100.
 *
 * When the score says nothing at all (real exports often don't), the default
 * is scaled by the notated beat unit for the same reason: a 2/2 shanty taken
 * at 100 quarter-notes per minute plays at half the speed anyone would sing
 * it, and the playhead visibly lags the music.
 */
function readTempo(root: XmlElement, beatType: number): number {
  let metronomeBpm: number | null = null;

  for (const part of root.children('part')) {
    for (const measure of part.children('measure')) {
      for (const el of measure.children()) {
        // <sound> appears both directly and wrapped in <direction>.
        const sounds =
          el.tag === 'sound' ? [el] : el.tag === 'direction' ? el.children('sound') : [];
        for (const sound of sounds) {
          const raw = sound.attr('tempo');
          if (raw === null) continue;
          const tempo = Number(raw);
          if (Number.isFinite(tempo) && tempo > 0) return tempo;
        }

        if (metronomeBpm === null && el.tag === 'direction') {
          for (const type of el.children('direction-type')) {
            const metronome = type.child('metronome');
            if (metronome !== null) {
              metronomeBpm = metronomeToQuarterBpm(metronome);
              if (metronomeBpm !== null) break;
            }
          }
        }
      }
    }
  }

  if (metronomeBpm !== null) return metronomeBpm;

  // Scale the default by the notated beat: half-note beats (2/2) get twice the
  // quarter-note rate, so cut time is not played at half speed.
  const quartersPerBeat = beatType > 0 ? 4 / beatType : 1;
  return DEFAULT_TEMPO_BPM * quartersPerBeat;
}

function readTitle(root: XmlElement, fallback: string): string {
  const work = root.child('work');
  const workTitle = work === null ? null : childText(work, 'work-title');
  if (workTitle !== null && workTitle.trim() !== '') return workTitle.trim();

  const movement = childText(root, 'movement-title');
  if (movement !== null && movement.trim() !== '') return movement.trim();

  // MuseScore often puts the visible title only in a credit element.
  for (const credit of root.children('credit')) {
    const words = childText(credit, 'credit-words');
    if (words !== null && words.trim() !== '') return words.trim().split('\n')[0];
  }
  return fallback;
}

/** Display name for a part, falling back sensibly (§11.3). */
function partLabel(scorePart: XmlElement | null, partId: string): string {
  if (scorePart !== null) {
    const name = childText(scorePart, 'part-name');
    if (name !== null && name.trim() !== '') return name.trim();

    const instrument = scorePart.child('score-instrument');
    const instName = instrument === null ? null : childText(instrument, 'instrument-name');
    if (instName !== null && instName.trim() !== '') return instName.trim();
  }
  return `Part ${partId}`;
}

/**
 * Merge tied notes into single sounding events.
 *
 * A tie means "hold the previous note", not "play it again", so the pair must
 * become one event or the loop will re-articulate a held note. Events are
 * matched by pitch: a tie-stop extends the most recent open tie at the same
 * pitch. Ties left unclosed (which real scores do contain) simply stand as
 * ordinary notes.
 */
function mergeTies(events: (NoteEvent & { tieStart: boolean; tieStop: boolean })[]): NoteEvent[] {
  const out: NoteEvent[] = [];
  /** Pitch -> index in `out` of an event awaiting its tie-stop. */
  const open = new Map<number, number>();

  for (const ev of events) {
    const openIndex = ev.tieStop ? open.get(ev.midiPitch) : undefined;

    if (openIndex !== undefined) {
      const target = out[openIndex];
      // Extend through this note, measuring from the held note's own onset so
      // that any rounding in the intervening rests cannot accumulate.
      target.durationBeats = ev.onsetBeats + ev.durationBeats - target.onsetBeats;
      if (!ev.tieStart) open.delete(ev.midiPitch);
      continue;
    }

    const { tieStart, tieStop, ...plain } = ev;
    void tieStop;
    out.push({ ...plain });
    if (tieStart) open.set(ev.midiPitch, out.length - 1);
  }

  return out;
}

/**
 * Collect the sung text onto the unrolled timeline.
 *
 * Two things make this a score-level job rather than a per-part one. First,
 * choral exports normally engrave the words under a single staff even though
 * every part sings them, so reading lyrics from "your" part would show nothing
 * for three singers out of four. Second, the words have to follow the repeat
 * structure: a repeated bar is sung again, so its syllables are emitted again
 * at the new time.
 *
 * The source part is the one carrying the most syllables. Ties are why the
 * lowest voice is not simply used: a held note carries one syllable, so a part
 * that sustains has fewer, and the part with the most is the one actually
 * carrying the text.
 */
function collectLyrics(
  rawByPart: RawMeasure[][],
  steps: UnrolledStep[],
  measures: TimelineMeasure[],
): LyricSyllable[] {
  let bestIndex = -1;
  let bestCount = 0;
  rawByPart.forEach((raws, index) => {
    let count = 0;
    for (const raw of raws) {
      for (const note of raw.notes) if (note.lyric !== '') count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestIndex = index;
    }
  });
  if (bestIndex === -1) return [];

  const raws = rawByPart[bestIndex];
  const syllables: LyricSyllable[] = [];

  for (const [index, step] of steps.entries()) {
    const raw = raws[step.writtenIndex];
    if (raw === undefined) continue;
    const start = measures[index].startBeats;

    // Sort by offset so a syllable written after a <backup> still reads in
    // time order, and de-duplicate onsets: a chord carries its word once.
    const seen = new Set<number>();
    const sung = raw.notes
      .filter((note) => note.lyric !== '')
      .sort((a, b) => a.offsetBeats - b.offsetBeats);

    for (const note of sung) {
      if (seen.has(note.offsetBeats)) continue;
      seen.add(note.offsetBeats);
      syllables.push({
        onsetBeats: start + note.offsetBeats,
        text: note.lyric,
        measureNumber: raw.number,
      });
    }
  }

  return syllables;
}

/**
 * Parse a MusicXML document into a playable `Score`.
 *
 * The pipeline is: read every written measure of every part into raw form,
 * unroll the repeat structure into a linear performance order, then lay each
 * part's notes onto that timeline. Voices sharing a staff are split into
 * separate parts here — the §5.2 requirement, and what makes the shared-staff
 * fixture produce four bands rather than two.
 */
export function parseMusicXml(root: XmlElement, fallbackTitle = 'Untitled'): Score {
  const warnings: string[] = [];

  if (root.tag === 'score-timewise') {
    throw new Error(
      'This file is timewise MusicXML, which Unbraid cannot read yet. Re-export it as partwise MusicXML.',
    );
  }
  if (root.tag !== 'score-partwise') {
    throw new Error(`This does not look like a MusicXML score (root element is <${root.tag}>).`);
  }

  const xmlParts = root.children('part');
  if (xmlParts.length === 0) throw new Error('This score contains no parts.');

  // <part-list> carries the display names, keyed by part id.
  const partList = root.child('part-list');
  const scoreParts = new Map<string, XmlElement>();
  if (partList !== null) {
    for (const sp of partList.children('score-part')) {
      const id = sp.attr('id');
      if (id !== null) scoreParts.set(id, sp);
    }
  }

  // Read all parts into raw measures first; unrolling needs the full picture.
  const rawByPart: RawMeasure[][] = [];
  const stateByPart: PartState[] = [];

  for (const part of xmlParts) {
    const state: PartState = {
      divisions: DEFAULT_DIVISIONS,
      beats: 4,
      beatType: 4,
      clefs: new Map(),
      keyFifths: 0,
    };
    const raws = part.children('measure').map((m) => readMeasure(m, state));
    rawByPart.push(raws);
    stateByPart.push(state);
  }

  // Repeat structure is a property of the score, not of one part. Read it from
  // the part with the most measures so a part that stops early cannot truncate
  // the timeline.
  let structuralIndex = 0;
  for (let i = 1; i < xmlParts.length; i++) {
    if (rawByPart[i].length > rawByPart[structuralIndex].length) structuralIndex = i;
  }
  const structuralMeasures = xmlParts[structuralIndex].children('measure');
  const steps: UnrolledStep[] = unrollMeasures(structuralMeasures, warnings);

  const measureCounts = new Set(rawByPart.map((r) => r.length));
  if (measureCounts.size > 1) {
    warnings.push(
      `Parts disagree on measure count (${[...measureCounts].join(', ')}); shorter parts were padded with silence.`,
    );
  }

  // Lay the unrolled steps out in time. Measure length is taken from the
  // structural part so every band shares one grid.
  const measures: TimelineMeasure[] = [];
  let cursor = 0;
  for (const [index, step] of steps.entries()) {
    const raw = rawByPart[structuralIndex][step.writtenIndex];
    const durationBeats = raw?.durationBeats ?? 0;
    measures.push({
      number: raw?.number ?? String(step.writtenIndex + 1),
      index,
      startBeats: cursor,
      durationBeats,
      pass: step.pass,
    });
    cursor += durationBeats;
  }
  const durationBeats = cursor;

  // Split each MusicXML part into one Part per voice.
  const parts: Part[] = [];

  xmlParts.forEach((xmlPart, partIndex) => {
    const partId = xmlPart.attr('id') ?? `P${partIndex + 1}`;
    const raws = rawByPart[partIndex];
    const state = stateByPart[partIndex];
    const label = partLabel(scoreParts.get(partId) ?? null, partId);

    // Which voices appear in this part, in order of first appearance?
    const voiceOrder: string[] = [];
    for (const raw of raws) {
      for (const note of raw.notes) {
        if (!voiceOrder.includes(note.voice)) voiceOrder.push(note.voice);
      }
    }
    if (voiceOrder.length === 0) voiceOrder.push('1');

    for (const voice of voiceOrder) {
      const tied: (NoteEvent & { tieStart: boolean; tieStop: boolean })[] = [];
      const staves = new Set<string>();

      for (const [index, step] of steps.entries()) {
        const raw = raws[step.writtenIndex];
        if (raw === undefined) continue;
        const start = measures[index].startBeats;

        for (const note of raw.notes) {
          if (note.voice !== voice) continue;
          staves.add(note.staff);
          tied.push({
            onsetBeats: start + note.offsetBeats,
            durationBeats: note.durationBeats,
            midiPitch: note.midiPitch,
            measureNumber: raw.number,
            tieStart: note.tieStart,
            tieStop: note.tieStop,
          });
        }
      }

      // Ties are matched within a voice, and only after unrolling, so a note
      // tied across a repeat seam is handled the same as any other.
      const events = mergeTies(tied).sort((a, b) => a.onsetBeats - b.onsetBeats);

      let range: Part['range'] = null;
      for (const ev of events) {
        if (range === null) range = { minMidi: ev.midiPitch, maxMidi: ev.midiPitch };
        else {
          range.minMidi = Math.min(range.minMidi, ev.midiPitch);
          range.maxMidi = Math.max(range.maxMidi, ev.midiPitch);
        }
      }

      const staff = staves.size === 1 ? [...staves][0] : '1';
      const clef = state.clefs.get(staff) ?? state.clefs.get('1') ?? 'G';

      parts.push({
        id: `${partId}-v${voice}`,
        label: voiceOrder.length > 1 ? `${label} ${voiceOrder.indexOf(voice) + 1}` : label,
        events,
        clef,
        keyFifths: state.keyFifths,
        range,
        source: { partId, voice },
      });
    }

    if (voiceOrder.length > 1) {
      warnings.push(
        `"${label}" contains ${voiceOrder.length} voices on one staff; it was split into ${voiceOrder.length} parts.`,
      );
    }
  });

  const silent = parts.filter((p) => p.events.length === 0);
  if (silent.length > 0 && silent.length === parts.length) {
    throw new Error('This score parsed successfully but contains no notes.');
  }

  return {
    title: readTitle(root, fallbackTitle),
    parts,
    measures,
    durationBeats,
    tempoBpm: readTempo(root, stateByPart[structuralIndex].beatType),
    lyrics: collectLyrics(rawByPart, steps, measures),
    warnings,
  };
}
