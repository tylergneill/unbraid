import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  cleanNotes,
  estimateBeatGrid,
  estimatePartCount,
  groupChords,
  isLikelyOvertone,
  scoreFromRecording,
  scoreFromStems,
  splitIntoVoices,
  type HeardNote,
} from '../src/core/transcription';
import { fixturePath, loadScore } from './helpers';

/**
 * Recording → Score, everything downstream of the neural network.
 *
 * The fixtures in fixtures/audio/ are what Basic Pitch heard when given a
 * synthesised performance of a committed MusicXML fixture (see the README
 * there). The score that was synthesised is therefore exact ground truth for
 * which voice sang every note, and for the tempo.
 */

function note(startSec: number, durationSec: number, midiPitch: number, amplitude = 0.8): HeardNote {
  return { startSec, durationSec, midiPitch, amplitude };
}

function heard(name: string): HeardNote[] {
  return JSON.parse(readFileSync(fixturePath(`audio/${name}.notes.json`), 'utf8')) as HeardNote[];
}

/**
 * Fraction of heard notes placed in the voice that actually sang them.
 *
 * A heard note is matched to a score note of the same pitch starting within
 * 80 ms. Unmatched notes (transcription errors) are not counted either way;
 * this measures the splitter, not the transcriber.
 */
function voiceAccuracy(fixture: string, audio: string, bpm: number): { accuracy: number; matched: number } {
  const truth = loadScore(fixturePath(fixture));
  const secPerBeat = 60 / bpm;
  const ref = truth.parts.flatMap((p, v) =>
    p.events.map((e) => ({ t: e.onsetBeats * secPerBeat, p: e.midiPitch, v })),
  );
  const { voices } = splitIntoVoices(heard(audio), truth.parts.length);
  let matched = 0;
  let right = 0;
  voices.forEach((line, v) => {
    for (const n of line) {
      const candidates = ref.filter((r) => r.p === n.midiPitch && Math.abs(r.t - n.startSec) < 0.08);
      if (candidates.length === 0) continue;
      matched++;
      if (candidates.some((r) => r.v === v)) right++;
    }
  });
  return { accuracy: right / matched, matched };
}

describe('cleanNotes', () => {
  it('sorts by onset and drops zero-length notes', () => {
    const out = cleanNotes([note(1, 0.5, 60), note(0, 0, 62), note(0.5, 0.5, 64)]);
    expect(out.map((n) => n.startSec)).toEqual([0.5, 1]);
  });

  it('fuses overlapping detections of one pitch into their union', () => {
    const out = cleanNotes([note(0, 1, 60, 0.4), note(0.5, 1, 60, 0.9)]);
    expect(out).toHaveLength(1);
    expect(out[0].durationSec).toBeCloseTo(1.5);
    expect(out[0].amplitude).toBe(0.9);
  });

  it('keeps a re-struck note at the same pitch as a separate note', () => {
    expect(cleanNotes([note(0, 0.5, 60), note(0.5, 0.5, 60)])).toHaveLength(2);
  });
});

describe('groupChords', () => {
  it('groups near-simultaneous onsets, each chord high to low', () => {
    const chords = groupChords(cleanNotes([note(0, 1, 48), note(0.03, 1, 67), note(1, 1, 60)]));
    expect(chords.map((c) => c.map((n) => n.midiPitch))).toEqual([[67, 48], [60]]);
  });
});

describe('isLikelyOvertone', () => {
  const fundamental = note(0, 1, 48, 0.9);

  it('flags a much fainter octave or twelfth that starts and stops with a note', () => {
    expect(isLikelyOvertone(note(0.02, 0.95, 60, 0.4), [fundamental])).toBe(true);
    expect(isLikelyOvertone(note(0.02, 0.95, 67, 0.4), [fundamental])).toBe(true);
  });

  it('keeps a quiet harmony a third or a sixth away', () => {
    expect(isLikelyOvertone(note(0, 1, 52, 0.3), [fundamental])).toBe(false);
    expect(isLikelyOvertone(note(0, 1, 57, 0.3), [fundamental])).toBe(false);
  });

  it('keeps an octave heard about as confidently as the note below it', () => {
    expect(isLikelyOvertone(note(0, 1, 60, 0.8), [fundamental])).toBe(false);
  });

  it('keeps an octave that moves on its own', () => {
    expect(isLikelyOvertone(note(0.5, 1, 60, 0.4), [fundamental])).toBe(false);
  });
});

describe('estimatePartCount', () => {
  it('reads a single line as one part', () => {
    const line = [60, 62, 64, 65, 67].map((p, i) => note(i * 0.5, 0.5, p));
    expect(estimatePartCount(line)).toBe(1);
  });

  it('finds four parts in the four-voice fixtures', () => {
    expect(estimatePartCount(heard('bach-bwv269-synth'))).toBe(4);
    // Half of the shanty is a solo verse; the chorus must still win.
    expect(estimatePartCount(heard('wellerman-simple-synth'))).toBe(4);
  });

  it('counts a brief four-part harmony in an otherwise two-part song', () => {
    // 100 s of melody over bass, with six seconds of four-part harmony at 40 s.
    const notes: HeardNote[] = [];
    for (let t = 0; t < 100; t += 1) {
      notes.push(note(t, 1, 67 + (t % 3)), note(t, 1, 43 + (t % 2)));
      if (t >= 40 && t < 46) notes.push(note(t, 1, 64, 0.4), note(t, 1, 59, 0.4));
    }
    expect(estimatePartCount(notes)).toBe(4);
  });

  it('ignores a fuller texture that never holds for long', () => {
    const notes: HeardNote[] = [];
    for (let t = 0; t < 60; t += 1) notes.push(note(t, 1, 67), note(t, 1, 43));
    // Four separate 0.2 s flickers of a third note: none lasts long enough to count.
    for (const t of [5, 15, 25, 35]) notes.push(note(t, 0.2, 60));
    expect(estimatePartCount(notes)).toBe(2);
  });

  it('does not count overtones as parts', () => {
    const notes: HeardNote[] = [];
    for (let t = 0; t < 30; t += 1) {
      notes.push(note(t, 1, 64), note(t, 1, 48));
      notes.push(note(t, 1, 60, 0.3)); // the bass's octave, heard faintly
    }
    expect(estimatePartCount(notes)).toBe(2);
  });

  it('is not fooled by a single stray extra note', () => {
    const chords = Array.from({ length: 20 }, (_, i) => [
      note(i, 1, 72),
      note(i, 1, 65),
      note(i, 1, 57),
    ]).flat();
    chords.push(note(5, 0.1, 84, 0.2));
    expect(estimatePartCount(chords)).toBe(3);
  });
});

describe('splitIntoVoices', () => {
  it('splits block chords top to bottom', () => {
    const notes = [
      [72, 64, 55, 48],
      [74, 65, 57, 50],
      [76, 67, 59, 52],
    ].flatMap((chord, i) => chord.map((p) => note(i, 1, p)));
    const { voices, dropped } = splitIntoVoices(notes, 4);
    expect(dropped).toBe(0);
    expect(voices.map((line) => line.map((n) => n.midiPitch))).toEqual([
      [72, 74, 76],
      [64, 65, 67],
      [55, 57, 59],
      [48, 50, 52],
    ]);
  });

  it('follows a moving voice against a held one by smallest step', () => {
    // Top voice holds C5 for two beats; the lower voice moves G4 → A4.
    const notes = [note(0, 2, 72), note(0, 1, 67), note(1, 1, 69)];
    const { voices } = splitIntoVoices(notes, 2);
    expect(voices[0].map((n) => n.midiPitch)).toEqual([72]);
    expect(voices[1].map((n) => n.midiPitch)).toEqual([67, 69]);
  });

  it('gives a solo to the voice that carries it on when the others enter', () => {
    // A two-bar solo around A4, then a two-part chord whose top note
    // continues the melody. Midway between the voices' homes, the solo
    // could go either way locally; the join decides it.
    const solo = [69, 67, 65, 64].map((p, i) => note(i * 0.5, 0.5, p));
    const duet = [0, 1, 2, 3].flatMap((i) => [note(2 + i, 1, 65 - i), note(2 + i, 1, 53 - i)]);
    const { voices } = splitIntoVoices([...solo, ...duet], 2);
    expect(voices[0].slice(0, 4).map((n) => n.midiPitch)).toEqual([69, 67, 65, 64]);
    expect(voices[1].every((n) => n.midiPitch <= 53)).toBe(true);
  });

  it('drops the least confident pitch when a chord has more than there are voices', () => {
    const notes = [note(0, 1, 72), note(0, 1, 79, 0.1), note(0, 1, 60)];
    const { voices, dropped } = splitIntoVoices(notes, 2);
    expect(dropped).toBe(1);
    expect(voices.map((line) => line.map((n) => n.midiPitch))).toEqual([[72], [60]]);
  });

  it('skips a faint overtone rather than shifting every voice down for it', () => {
    // Four bars of SATB establish where each voice is. Then the bass is
    // missed and an overtone an octave above the alto appears: placing it
    // would push soprano, alto and tenor each one voice down.
    const satb = [0, 1, 2, 3].flatMap((i) => [69, 65, 60, 48].map((p) => note(i, 1, p)));
    const chord = [note(4, 1, 69), note(4, 1, 65), note(4, 1, 60), note(4, 1, 77, 0.4)];
    const { voices, dropped } = splitIntoVoices([...satb, ...chord], 4);
    expect(dropped).toBe(1);
    expect(voices.map((line) => line[line.length - 1].midiPitch)).toEqual([69, 65, 60, 48]);
    expect(voices[3]).toHaveLength(4);
  });

  it('places a quiet harmony in a part that has rested all along', () => {
    // Melody and bass for 20 s; then two quiet inner parts enter well away
    // from where the splitter expects them. They are harmonies, not
    // overtones, so they must be kept.
    const notes: HeardNote[] = [];
    for (let t = 0; t < 24; t += 1) {
      notes.push(note(t, 1, 72), note(t, 1, 41));
      if (t >= 20) notes.push(note(t, 1, 64, 0.3), note(t, 1, 57, 0.3));
    }
    const { voices, dropped } = splitIntoVoices(notes, 4);
    expect(dropped).toBe(0);
    expect(voices.map((line) => new Set(line.map((n) => n.midiPitch)))).toEqual([
      new Set([72]),
      new Set([64]),
      new Set([57]),
      new Set([41]),
    ]);
  });

  it('never lets one voice sing two notes at once', () => {
    const { voices } = splitIntoVoices(heard('bach-bwv269-synth'), 4);
    for (const line of voices) {
      for (let i = 1; i < line.length; i++) {
        expect(line[i].startSec).toBeGreaterThanOrEqual(line[i - 1].startSec + line[i - 1].durationSec - 1e-9);
      }
    }
  });

  it('puts Bach BWV 269 back into its four voices', () => {
    const { accuracy, matched } = voiceAccuracy('bach-bwv269.musicxml', 'bach-bwv269-synth', 80);
    expect(matched).toBeGreaterThan(280);
    expect(accuracy).toBeGreaterThan(0.95);
  });

  it('keeps the shanty verse solo in the top voice', () => {
    const { accuracy, matched } = voiceAccuracy(
      'wellerman-fixture-simple.musicxml',
      'wellerman-simple-synth',
      110,
    );
    expect(matched).toBeGreaterThan(100);
    expect(accuracy).toBeGreaterThan(0.95);
  });
});

describe('estimateBeatGrid', () => {
  it('recovers a steady pulse', () => {
    const notes = Array.from({ length: 32 }, (_, i) => note(0.25 + i * (60 / 90), 0.5, 60 + (i % 5)));
    const grid = estimateBeatGrid(notes);
    expect(grid.tempoBpm).toBeGreaterThan(88.5);
    expect(grid.tempoBpm).toBeLessThan(91.5);
  });

  it('recovers the fixtures’ tempi', () => {
    expect(Math.abs(estimateBeatGrid(heard('bach-bwv269-synth')).tempoBpm - 80)).toBeLessThan(0.5);
    expect(Math.abs(estimateBeatGrid(heard('wellerman-simple-synth')).tempoBpm - 110)).toBeLessThan(0.5);
  });

  it('finds the shanty’s real downbeat', () => {
    // The fixture's first note is beat 1 of bar 1, so the grid should start there.
    expect(Math.abs(estimateBeatGrid(heard('wellerman-simple-synth')).originSec)).toBeLessThan(0.05);
  });

  it('puts the first bar line at or just before the first note', () => {
    const notes = cleanNotes(heard('wellerman-simple-synth'));
    const grid = estimateBeatGrid(notes);
    expect(grid.originSec).toBeLessThanOrEqual(notes[0].startSec + 0.05);
    expect(notes[0].startSec - grid.originSec).toBeLessThan((60 / grid.tempoBpm) * grid.beatsPerBar);
  });

  it('falls back to 60 bpm when there is too little to go on', () => {
    expect(estimateBeatGrid([note(0, 1, 60)]).tempoBpm).toBe(60);
  });
});

describe('scoreFromRecording', () => {
  it('builds a Score the rest of the app can play', () => {
    const score = scoreFromRecording(heard('wellerman-simple-synth'), { title: 'Shanty' });
    expect(score.title).toBe('Shanty');
    expect(score.parts.map((p) => p.label)).toEqual([
      'Part 1 (top)',
      'Part 2',
      'Part 3',
      'Part 4 (bottom)',
    ]);
    expect(score.lyrics).toEqual([]);

    // Bars tile the timeline with no gaps.
    score.measures.forEach((m, i) => {
      expect(m.index).toBe(i);
      expect(m.startBeats).toBe(i * 4);
    });
    expect(score.durationBeats).toBe(score.measures.length * 4);

    for (const part of score.parts) {
      expect(part.range).not.toBeNull();
      for (const e of part.events) {
        expect(e.onsetBeats).toBeGreaterThanOrEqual(0);
        expect(e.onsetBeats + e.durationBeats).toBeLessThanOrEqual(score.durationBeats);
        expect(e.measureNumber).toBe(String(Math.floor(e.onsetBeats / 4) + 1));
      }
    }
  });

  it('keeps the recording’s own timing rather than snapping to the grid', () => {
    const notes = cleanNotes(heard('bach-bwv269-synth'));
    const score = scoreFromRecording(notes, { title: 'x' });
    const { originSec } = estimateBeatGrid(notes);
    const secPerBeat = 60 / score.tempoBpm;
    const toBeats = (sec: number) => Math.max(0, (sec - originSec) / secPerBeat);
    // Every event sits exactly where a heard note began, converted to beats.
    for (const part of score.parts) {
      for (const e of part.events) {
        const source = notes.some(
          (n) => n.midiPitch === e.midiPitch && Math.abs(toBeats(n.startSec) - e.onsetBeats) < 1e-9,
        );
        expect(source).toBe(true);
      }
    }
  });

  it('honours a forced part count and drops voices that end up silent', () => {
    const line = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => note(i * 0.5, 0.5, p));
    const score = scoreFromRecording(line, { title: 'x', partCount: 3 });
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0].label).toBe('Part 1');
    expect(score.parts[0].events).toHaveLength(8);
  });

  it('says how the parts and bar lines were arrived at', () => {
    const score = scoreFromRecording(heard('bach-bwv269-synth'), { title: 'x' });
    expect(score.warnings[0]).toMatch(/4 parts \(estimated\)/);
    expect(score.warnings[0]).toMatch(/bpm/);
  });

  it('refuses a recording with no notes in it', () => {
    expect(() => scoreFromRecording([], { title: 'x' })).toThrow(/No notes/);
  });
});

describe('scoreFromStems', () => {
  const vocals = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((t) => [note(t, 1, 69 + (t % 2)), note(t, 1, 64)]);
  const bass = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((t) => [
    note(t, 1, 40),
    note(t, 1, 52, 0.3), // its octave overtone
  ]);
  const piano = Array.from({ length: 12 }, (_, i) => [note(i * 0.66, 0.6, 60), note(i * 0.66, 0.6, 55)]).flat();

  it('names each stem’s parts by where they came from', () => {
    const score = scoreFromStems(
      [
        { kind: 'vocals', notes: vocals },
        { kind: 'bass', notes: bass },
        { kind: 'other', notes: piano },
      ],
      { title: 'x' },
    );
    expect(score.parts.map((p) => p.label)).toEqual([
      'Vocals 1 (top)',
      'Vocals 2 (bottom)',
      'Bass',
      'Other instruments',
    ]);
    expect(new Set(score.parts.map((p) => p.id)).size).toBe(4);
    expect(score.warnings[0]).toMatch(/separating vocals from instruments/);
  });

  it('keeps the bass to one line, without its overtones', () => {
    const score = scoreFromStems([{ kind: 'bass', notes: bass }], { title: 'x' });
    expect(score.parts).toHaveLength(1);
    expect(new Set(score.parts[0].events.map((e) => e.midiPitch))).toEqual(new Set([40]));
  });

  it('keeps chords in the accompaniment band', () => {
    const score = scoreFromStems([{ kind: 'other', notes: piano }], { title: 'x' });
    expect(score.parts[0].events).toHaveLength(24);
  });

  it('leaves out an accompaniment stem that is only bleed', () => {
    const score = scoreFromStems(
      [
        { kind: 'vocals', notes: vocals },
        { kind: 'other', notes: piano.slice(0, 3) },
      ],
      { title: 'x' },
    );
    expect(score.parts.map((p) => p.label)).toEqual(['Vocals 1 (top)', 'Vocals 2 (bottom)']);
  });

  it('applies a forced part count to the vocals only', () => {
    const score = scoreFromStems(
      [
        { kind: 'vocals', notes: vocals },
        { kind: 'bass', notes: bass },
      ],
      { title: 'x', partCount: 1 },
    );
    expect(score.parts.map((p) => p.label)).toEqual(['Vocals', 'Bass']);
  });
});
