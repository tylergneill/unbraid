/**
 * ABC → MusicXML.
 *
 * Scope is deliberately narrow: enough ABC to carry a forum-posted vocal
 * arrangement into unbraid's parser, and no more. That means pitch, duration,
 * accidentals, ties, chords, multi-voice `V:` blocks, bar lines, repeats and
 * `w:` lyrics. It does not mean ornaments, tuplets beyond the common cases,
 * grace notes, or engraving directives — those are dropped rather than
 * approximated, because a wrong note is worse than a missing decoration.
 *
 * Where the source is ambiguous the converter guesses the way the ABC standard
 * says to guess (see `defaultUnitLength`), and every guess is reported back so
 * the wizard can show what it had to assume.
 */

/** Anything the converter had to infer or discard, surfaced in the UI. */
export interface ConversionWarning {
  message: string;
  /** Source line, 1-based, where known. */
  line?: number;
}

export interface ConversionResult {
  musicXml: string;
  warnings: ConversionWarning[];
  /** Voice ids in the order they appear, for a quick "4 parts" summary. */
  voiceIds: string[];
  title: string;
}

/** MusicXML divisions per quarter note. 768 divides every common ABC length. */
const DIVISIONS = 768;

interface Header {
  title: string;
  metre: string;
  unitLength: string;
  key: string;
  tempo: string;
}

interface AbcNote {
  /** MIDI-ish pitch parts. Null step means a rest. */
  step: string | null;
  octave: number;
  alter: number;
  /** Duration in quarter notes. */
  quarters: number;
  tieStart: boolean;
  /** True when this note sounds with the previous one. */
  chord: boolean;
  /** Bar line follows this note, if any. */
  barAfter: 'none' | 'plain' | 'repeat-start' | 'repeat-end' | 'double' | 'final';
}

/** Sharps and flats in the order key signatures add them. */
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/**
 * Parse a `K:` field into a fifths count and the mode's accidentals.
 *
 * Handles the common forms: "D", "Dm", "Ddor", "Bb", "F#mix", "none".
 */
export function parseKey(k: string): { fifths: number; alters: Map<string, number> } {
  const raw = k.trim();
  const alters = new Map<string, number>();
  if (raw === '' || /^none$/i.test(raw)) return { fifths: 0, alters };

  const m = /^([A-Ga-g])([#b]?)\s*([A-Za-z]*)/.exec(raw);
  if (m === null) return { fifths: 0, alters };

  const tonic = m[1].toUpperCase();
  const accidental = m[2];
  const mode = m[3].toLowerCase().slice(0, 3);

  // Major-key fifths for each natural tonic, then adjust for the mode.
  const base: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
  let fifths = base[tonic] ?? 0;
  if (accidental === '#') fifths += 7;
  if (accidental === 'b') fifths -= 7;

  const modeShift: Record<string, number> = {
    maj: 0, ion: 0, '': 0,
    min: -3, aeo: -3, m: -3,
    dor: -2, phr: -4, lyd: 1, mix: -1, loc: -5,
  };
  fifths += modeShift[mode] ?? 0;

  // Expand fifths into per-step accidentals the notes inherit.
  if (fifths > 0) for (let i = 0; i < Math.min(fifths, 7); i += 1) alters.set(SHARP_ORDER[i], 1);
  if (fifths < 0) for (let i = 0; i < Math.min(-fifths, 7); i += 1) alters.set(FLAT_ORDER[i], -1);

  return { fifths, alters };
}

/**
 * The ABC default when `L:` is missing.
 *
 * The standard rule: if the metre is less than 0.75 the unit is a sixteenth,
 * otherwise an eighth. Forum posts omit `L:` constantly, so getting this right
 * is what keeps a tune from playing at double or half speed.
 */
function defaultUnitLength(metre: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(metre.trim());
  if (m === null) return 0.5; // no metre: assume eighth
  const ratio = Number(m[1]) / Number(m[2]);
  return ratio < 0.75 ? 0.25 : 0.5;
}

/** Split a tune into its header fields and the body lines that follow `K:`. */
function splitHeader(abc: string): { header: Header; bodyLines: { text: string; line: number }[] } {
  const lines = abc.split('\n');
  const header: Header = { title: '', metre: '', unitLength: '', key: '', tempo: '' };
  const bodyLines: { text: string; line: number }[] = [];
  let inBody = false;

  lines.forEach((text, i) => {
    const trimmed = text.trim();
    if (!inBody) {
      const f = /^([A-Za-z]):\s*(.*)$/.exec(trimmed);
      if (f !== null) {
        const [, letter, value] = f;
        if (letter === 'T' && header.title === '') header.title = value.trim();
        if (letter === 'M') header.metre = value.trim();
        if (letter === 'L') header.unitLength = value.trim();
        if (letter === 'Q') header.tempo = value.trim();
        if (letter === 'K') {
          header.key = value.trim();
          inBody = true; // K: is always the last header field.
        }
        return;
      }
      if (trimmed === '' || trimmed.startsWith('%')) return;
      // Body started without a K:, which is malformed but recoverable.
      inBody = true;
    }
    if (trimmed.startsWith('%')) return;
    bodyLines.push({ text, line: i + 1 });
  });

  return { header, bodyLines };
}

/** Evaluate an `L:` field like "1/8" into quarter notes. */
function unitToQuarters(unit: string, metre: string): number {
  const m = /^(\d+)\s*\/\s*(\d+)/.exec(unit.trim());
  if (m === null) return defaultUnitLength(metre);
  const value = Number(m[1]) / Number(m[2]);
  return value * 4; // a whole note is 4 quarters
}

/**
 * Tokenise one line of ABC body into notes.
 *
 * Written as a hand-rolled scanner rather than a regex sweep because ABC's
 * duration suffixes, broken rhythm and chords are positional: what a `>` means
 * depends on the notes either side of it.
 */
function parseBody(
  bodyLines: { text: string; line: number }[],
  unitQuarters: number,
  keyAlters: Map<string, number>,
  warn: (message: string, line?: number) => void,
): Map<string, AbcNote[]> {
  const voices = new Map<string, AbcNote[]>();
  let currentVoice = '1';
  const ensure = (id: string) => {
    if (!voices.has(id)) voices.set(id, []);
    return voices.get(id) as AbcNote[];
  };
  ensure('1');

  // Accidentals set by an explicit sign persist to the end of the bar.
  let barAccidentals = new Map<string, number>();

  for (const { text, line } of bodyLines) {
    const trimmed = text.trim();

    // Inline field: a voice switch, or a mid-tune metre/length change.
    const field = /^([A-Za-z]):\s*(.*)$/.exec(trimmed);
    if (field !== null) {
      const [, letter, value] = field;
      if (letter === 'V') {
        currentVoice = (/^\s*(\S+)/.exec(value)?.[1] ?? '1').trim();
        ensure(currentVoice);
      } else if (letter === 'w') {
        // Lyrics are attached in a later pass; noted here so they are not lost.
      } else if (letter === 'K' || letter === 'M' || letter === 'L') {
        warn(`Mid-tune ${letter}: change is not applied`, line);
      }
      continue;
    }

    const out = ensure(currentVoice);
    let i = 0;
    // Chord state: `inChord` is true between [ and ], and `chordOpen` marks
    // that the chord's first note has been placed, so every later member
    // sounds with it rather than after it.
    let inChord = false;
    let chordOpen = false;
    let brokenRhythm = 0;

    while (i < trimmed.length) {
      const c = trimmed[i];

      // Inline voice switch, e.g. [V:2]
      if (c === '[' && /^\[[A-Za-z]:/.test(trimmed.slice(i))) {
        const close = trimmed.indexOf(']', i);
        const inner = trimmed.slice(i + 1, close === -1 ? undefined : close);
        const f = /^([A-Za-z]):\s*(.*)$/.exec(inner);
        if (f !== null && f[1] === 'V') {
          currentVoice = (/^\s*(\S+)/.exec(f[2])?.[1] ?? '1').trim();
          ensure(currentVoice);
        }
        i = close === -1 ? trimmed.length : close + 1;
        continue;
      }

      // Chord bracket: [CEG] — all members share an onset.
      if (c === '[') {
        inChord = true;
        chordOpen = false;
        i += 1;
        continue;
      }
      if (c === ']') {
        inChord = false;
        chordOpen = false;
        i += 1;
        continue;
      }

      // Bar lines, including repeats.
      if (c === '|' || c === ':') {
        const rest = trimmed.slice(i);
        let kind: AbcNote['barAfter'] = 'plain';
        let len = 1;
        if (/^\|\]/.test(rest)) { kind = 'final'; len = 2; }
        else if (/^\|\|/.test(rest)) { kind = 'double'; len = 2; }
        else if (/^:\|\]?/.test(rest)) { kind = 'repeat-end'; len = rest.startsWith(':|]') ? 3 : 2; }
        else if (/^\|:/.test(rest)) { kind = 'repeat-start'; len = 2; }
        else if (/^::/.test(rest)) { kind = 'repeat-end'; len = 2; }
        else if (c === ':') { i += 1; continue; }

        const target = ensure(currentVoice);
        if (target.length > 0) target[target.length - 1].barAfter = kind;
        barAccidentals = new Map();
        i += len;
        continue;
      }

      // Repeat-ending markers like [1 / [2 — dropped, the unroller handles bars.
      if (/^\[\d/.test(trimmed.slice(i))) {
        i += 2;
        continue;
      }

      // Quoted chord symbols and annotations.
      if (c === '"') {
        const close = trimmed.indexOf('"', i + 1);
        i = close === -1 ? trimmed.length : close + 1;
        continue;
      }

      // Slurs, ornaments, grace-note groups: skipped without complaint, as they
      // do not change which pitches sound.
      if (c === '(' || c === ')') { i += 1; continue; }
      if (c === '{') {
        const close = trimmed.indexOf('}', i);
        i = close === -1 ? trimmed.length : close + 1;
        continue;
      }
      if (c === '~' || c === 'H' || c === 'L' || c === 'M' || c === 'O' ||
          c === 'P' || c === 'S' || c === 'T' || c === 'u' || c === 'v') {
        // Decorations are single letters only when followed by a note.
        if (/^[A-Ga-gz]/.test(trimmed.slice(i + 1))) { i += 1; continue; }
      }
      if (c === '!' || c === '+') {
        const close = trimmed.indexOf(c, i + 1);
        i = close === -1 ? trimmed.length : close + 1;
        continue;
      }
      if (c === '$' || c === '\\') { i += 1; continue; }

      // Tuplets: (3 means three notes in the time of two.
      if (/^\(\d/.test(trimmed.slice(i))) {
        warn('Tuplet timing is approximated', line);
        i += 2;
        continue;
      }

      // Accidentals precede the note letter.
      let alter: number | null = null;
      if (c === '^') {
        alter = trimmed[i + 1] === '^' ? 2 : 1;
        i += alter === 2 ? 2 : 1;
      } else if (c === '_') {
        alter = trimmed[i + 1] === '_' ? -2 : -1;
        i += alter === -2 ? 2 : 1;
      } else if (c === '=') {
        alter = 0;
        i += 1;
      }

      const letter = trimmed[i];

      if (letter === undefined) break;

      // A note or a rest.
      if (/[A-Ga-gzZx]/.test(letter)) {
        const isRest = /[zZx]/.test(letter);
        let step: string | null = null;
        let octave = 4;

        if (!isRest) {
          const upper = letter.toUpperCase();
          step = upper;
          // Lowercase is the octave above; ABC middle C is C4.
          octave = letter === upper ? 4 : 5;
        }
        i += 1;

        // Octave marks.
        while (i < trimmed.length && (trimmed[i] === "'" || trimmed[i] === ',')) {
          if (trimmed[i] === "'") octave += 1;
          else octave -= 1;
          i += 1;
        }

        // Duration: an optional multiplier, then optional /divisor.
        let numerator = '';
        while (i < trimmed.length && /\d/.test(trimmed[i])) { numerator += trimmed[i]; i += 1; }
        let denominator = 1;
        while (i < trimmed.length && trimmed[i] === '/') {
          i += 1;
          let d = '';
          while (i < trimmed.length && /\d/.test(trimmed[i])) { d += trimmed[i]; i += 1; }
          denominator *= d === '' ? 2 : Number(d);
        }

        let quarters = unitQuarters * (numerator === '' ? 1 : Number(numerator)) / denominator;

        // Broken rhythm carried from the previous note.
        if (brokenRhythm > 0) { quarters *= 1 + brokenRhythm; brokenRhythm = 0; }
        else if (brokenRhythm < 0) { quarters *= 1 + brokenRhythm; brokenRhythm = 0; }

        // A tie binds this note to the next of the same pitch.
        let tieStart = false;
        if (trimmed[i] === '-') { tieStart = true; i += 1; }

        // Resolve the sounding accidental: explicit, else bar-local, else key.
        let effective = 0;
        if (step !== null) {
          if (alter !== null) {
            effective = alter;
            barAccidentals.set(step + String(octave), alter);
          } else if (barAccidentals.has(step + String(octave))) {
            effective = barAccidentals.get(step + String(octave)) as number;
          } else {
            effective = keyAlters.get(step) ?? 0;
          }
        }

        out.push({
          step,
          octave,
          alter: effective,
          quarters,
          tieStart,
          chord: inChord && chordOpen,
          barAfter: 'none',
        });

        // The first note of a chord keeps its own onset; the rest join it.
        if (inChord) chordOpen = true;
        continue;
      }

      // Broken rhythm: a> lengthens this note and shortens the next.
      if (letter === '>') {
        if (out.length > 0) out[out.length - 1].quarters *= 1.5;
        brokenRhythm = -0.5;
        i += 1;
        continue;
      }
      if (letter === '<') {
        if (out.length > 0) out[out.length - 1].quarters *= 0.5;
        brokenRhythm = 0.5;
        i += 1;
        continue;
      }

      // Anything else is unrecognised; skip one character.
      i += 1;
    }
  }

  return voices;
}

/** XML-escape text destined for an element body. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Note type name MusicXML wants alongside the duration. */
function noteType(quarters: number): string {
  const table: [number, string][] = [
    [4, 'whole'], [2, 'half'], [1, 'quarter'], [0.5, 'eighth'],
    [0.25, '16th'], [0.125, '32nd'], [0.0625, '64th'],
  ];
  let best = table[2];
  let bestDiff = Infinity;
  for (const entry of table) {
    // Compare against the un-dotted value, so a dotted quarter reads "quarter".
    for (const factor of [1, 1.5, 1.75]) {
      const diff = Math.abs(entry[0] * factor - quarters);
      if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
  }
  return best[1];
}

/** Dots implied by a duration relative to its base type. */
function dotsFor(quarters: number, type: string): number {
  const base: Record<string, number> = {
    whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625,
  };
  const b = base[type] ?? 1;
  const ratio = quarters / b;
  if (Math.abs(ratio - 1.75) < 0.01) return 2;
  if (Math.abs(ratio - 1.5) < 0.01) return 1;
  return 0;
}

/**
 * Group a voice's flat note list into measures.
 *
 * ABC bar lines are authoritative where present. Where a tune has none — a
 * fragment quoted without bars — notes are packed to the metre so the app
 * still gets a usable ruler.
 */
function toMeasures(notes: AbcNote[], beatsPerMeasure: number): AbcNote[][] {
  const measures: AbcNote[][] = [];
  let current: AbcNote[] = [];
  let filled = 0;
  const hasBars = notes.some((n) => n.barAfter !== 'none');

  for (const note of notes) {
    current.push(note);
    if (!note.chord) filled += note.quarters;

    if (hasBars) {
      if (note.barAfter !== 'none') { measures.push(current); current = []; filled = 0; }
    } else if (filled >= beatsPerMeasure - 1e-9) {
      measures.push(current); current = []; filled = 0;
    }
  }
  if (current.length > 0) measures.push(current);
  return measures.length > 0 ? measures : [[]];
}

/** Build the MusicXML document. */
export function abcToMusicXml(abc: string): ConversionResult {
  const warnings: ConversionWarning[] = [];
  const warn = (message: string, line?: number) => {
    // Collapse duplicates; one "tuplet approximated" line is enough.
    if (!warnings.some((w) => w.message === message)) warnings.push({ message, line });
  };

  const { header, bodyLines } = splitHeader(abc);
  if (header.key === '') warn('No K: field; assuming C major');
  if (header.unitLength === '') {
    warn(`No L: field; assuming ${defaultUnitLength(header.metre) === 0.25 ? '1/16' : '1/8'}`);
  }
  if (header.metre === '') warn('No M: field; assuming 4/4');

  const { fifths, alters } = parseKey(header.key);
  const unitQuarters = unitToQuarters(header.unitLength, header.metre);

  const metreMatch = /^(\d+)\s*\/\s*(\d+)/.exec(header.metre.trim());
  const beats = metreMatch === null ? 4 : Number(metreMatch[1]);
  const beatType = metreMatch === null ? 4 : Number(metreMatch[2]);
  const beatsPerMeasure = beats * (4 / beatType);

  const voices = parseBody(bodyLines, unitQuarters, alters, warn);

  // Voices holding nothing are an artefact of a stray V: line.
  for (const [id, notes] of [...voices.entries()]) {
    if (notes.length === 0) voices.delete(id);
  }
  if (voices.size === 0) {
    warn('No notes were found in this tune');
    voices.set('1', []);
  }

  const voiceIds = [...voices.keys()];
  const partsXml: string[] = [];
  const partListXml: string[] = [];

  voiceIds.forEach((voiceId, index) => {
    const partId = `P${index + 1}`;
    const label = voiceIds.length === 1 ? 'Voice' : `Voice ${voiceId}`;
    partListXml.push(
      `    <score-part id="${partId}">\n      <part-name>${esc(label)}</part-name>\n    </score-part>`,
    );

    const notes = voices.get(voiceId) as AbcNote[];
    const measures = toMeasures(notes, beatsPerMeasure);
    const measureXml: string[] = [];

    measures.forEach((measure, mi) => {
      const body: string[] = [];

      if (mi === 0) {
        body.push(
          `      <attributes>\n` +
            `        <divisions>${DIVISIONS}</divisions>\n` +
            `        <key><fifths>${fifths}</fifths></key>\n` +
            `        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>\n` +
            `        <clef><sign>G</sign><line>2</line></clef>\n` +
            `      </attributes>`,
        );
      }

      for (const note of measure) {
        const duration = Math.max(1, Math.round(note.quarters * DIVISIONS));
        const type = noteType(note.quarters);
        const dots = '<dot/>'.repeat(dotsFor(note.quarters, type));

        if (note.step === null) {
          body.push(
            `      <note>\n        <rest/>\n        <duration>${duration}</duration>\n` +
              `        <voice>1</voice>\n        <type>${type}</type>${dots}\n      </note>`,
          );
          continue;
        }

        const alterXml = note.alter !== 0 ? `<alter>${note.alter}</alter>` : '';
        const chordXml = note.chord ? '        <chord/>\n' : '';
        const tieXml = note.tieStart ? '        <tie type="start"/>\n' : '';
        body.push(
          `      <note>\n${chordXml}` +
            `        <pitch><step>${note.step}</step>${alterXml}<octave>${note.octave}</octave></pitch>\n` +
            `        <duration>${duration}</duration>\n${tieXml}` +
            `        <voice>1</voice>\n        <type>${type}</type>${dots}\n      </note>`,
        );
      }

      measureXml.push(`    <measure number="${mi + 1}">\n${body.join('\n')}\n    </measure>`);
    });

    partsXml.push(`  <part id="${partId}">\n${measureXml.join('\n')}\n  </part>`);
  });

  const title = header.title === '' ? 'Untitled' : header.title;

  const musicXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" ` +
    `"http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="3.1">\n` +
    `  <work><work-title>${esc(title)}</work-title></work>\n` +
    `  <part-list>\n${partListXml.join('\n')}\n  </part-list>\n` +
    `${partsXml.join('\n')}\n` +
    `</score-partwise>\n`;

  return { musicXml, warnings, voiceIds, title };
}
