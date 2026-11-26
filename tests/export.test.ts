import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Midi } from '@tonejs/midi';
import { midiFileName, PPQ, scoreToMidi, timeSignatureFor } from '../src/core/midi';
import {
  clampTranspose,
  formatTranspose,
  MAX_TRANSPOSE,
  transposeFifths,
  transposeScore,
} from '../src/core/transpose';
import { scoreFromStems, type HeardNote } from '../src/core/transcription';
import { initialMixState } from '../src/core/mixer';
import { fixturePath, loadScore, partByLabel } from './helpers';

/**
 * Transposition, and MIDI export for MuseScore.
 *
 * Exports are checked by parsing the file back with the same library a
 * notation program's importer would see it through, and comparing to the
 * score: every note, in every part, at the right time and pitch.
 */

describe('transposeFifths', () => {
  it('moves the key signature by seven fifths per semitone', () => {
    expect(transposeFifths(0, 2)).toBe(2); // C → D
    expect(transposeFifths(-1, -2)).toBe(-3); // F → E♭
    expect(transposeFifths(0, 7)).toBe(1); // C → G
  });

  it('spells the enharmonic keys the way choirs usually see them', () => {
    expect(transposeFifths(0, 1)).toBe(-5); // C → D♭, not C♯
    expect(transposeFifths(0, 6)).toBe(-6); // C → G♭, not F♯
    expect(transposeFifths(0, 12)).toBe(0);
  });
});

describe('transposeScore', () => {
  const score = loadScore(fixturePath('bach-bwv269.musicxml'));

  it('leaves the score itself alone at 0', () => {
    expect(transposeScore(score, 0)).toBe(score);
  });

  it('moves every note, range, and key, without touching the original', () => {
    const before = score.parts[0].events[0].midiPitch;
    const up = transposeScore(score, 3);
    up.parts.forEach((part, i) => {
      const original = score.parts[i];
      expect(part.events.map((e) => e.midiPitch)).toEqual(original.events.map((e) => e.midiPitch + 3));
      expect(part.range!.minMidi).toBe(original.range!.minMidi + 3);
      expect(part.keyFifths).toBe(transposeFifths(original.keyFifths, 3));
      // Timing is untouched.
      expect(part.events.map((e) => e.onsetBeats)).toEqual(original.events.map((e) => e.onsetBeats));
    });
    expect(score.parts[0].events[0].midiPitch).toBe(before);
    expect(up.measures).toBe(score.measures);
  });

  it('is undone exactly by the opposite transposition', () => {
    const roundTrip = transposeScore(transposeScore(score, 5), -5);
    expect(roundTrip.parts.map((p) => p.events)).toEqual(score.parts.map((p) => p.events));
  });
});

describe('transposition settings', () => {
  it('limits the range to an octave each way, in whole semitones', () => {
    expect(clampTranspose(15)).toBe(MAX_TRANSPOSE);
    expect(clampTranspose(-40)).toBe(-MAX_TRANSPOSE);
    expect(clampTranspose(2.4)).toBe(2);
  });

  it('shows the transposition with a sign', () => {
    expect(formatTranspose(0)).toBe('0');
    expect(formatTranspose(2)).toBe('+2');
    expect(formatTranspose(-3)).toBe('−3');
  });

  it('starts every new project in the written key', () => {
    expect(initialMixState(loadScore(fixturePath('bach-bwv269.musicxml'))).transposeSemitones).toBe(0);
  });
});

describe('timeSignatureFor', () => {
  it('turns bar lengths in quarter notes into time signatures', () => {
    expect(timeSignatureFor(4)).toEqual([4, 4]);
    expect(timeSignatureFor(3)).toEqual([3, 4]);
    expect(timeSignatureFor(1)).toEqual([1, 4]); // a pickup bar
    expect(timeSignatureFor(1.5)).toEqual([3, 8]);
  });
});

describe('scoreToMidi', () => {
  const score = loadScore(fixturePath('wellerman-fixture-simple.musicxml'));
  const read = (bytes: Uint8Array) => new Midi(bytes);

  it('writes one named track per part with every note in place', () => {
    const midi = read(scoreToMidi(score));
    expect(midi.header.ppq).toBe(PPQ);
    expect(midi.tracks.map((t) => t.name)).toEqual(score.parts.map((p) => p.label));

    score.parts.forEach((part, i) => {
      const notes = midi.tracks[i].notes;
      expect(notes).toHaveLength(part.events.length);
      part.events.forEach((e, j) => {
        expect(notes[j].midi).toBe(e.midiPitch);
        expect(notes[j].ticks).toBe(Math.round(e.onsetBeats * PPQ));
        expect(notes[j].durationTicks).toBe(Math.round(e.durationBeats * PPQ));
      });
    });
  });

  it('keeps the unrolled bar count, so bar numbers match the app', () => {
    // 22 bars of 4/4 after unrolling repeats.
    const midi = read(scoreToMidi(score));
    const lastTick = Math.max(...midi.tracks.flatMap((t) => t.notes.map((n) => n.ticks + n.durationTicks)));
    expect(Math.ceil(lastTick / (4 * PPQ))).toBe(22);
    expect(midi.header.timeSignatures.map((t) => t.timeSignature)).toEqual([[4, 4]]);
  });

  it('carries the tempo', () => {
    expect(read(scoreToMidi(score)).header.tempos[0].bpm).toBeCloseTo(score.tempoBpm, 3);
  });

  it('writes the metre of the piece', () => {
    const bach = loadScore(fixturePath('bach-bwv269.musicxml'));
    expect(read(scoreToMidi(bach)).header.timeSignatures.map((t) => t.timeSignature)).toEqual([[3, 4]]);
  });

  it('marks a pickup bar with a time signature of its own', () => {
    const measures = [1, 4, 4].map((durationBeats, index) => ({
      number: String(index + 1),
      index,
      startBeats: index === 0 ? 0 : 1 + (index - 1) * 4,
      durationBeats,
      pass: 0,
    }));
    const sigs = read(scoreToMidi({ ...score, measures })).header.timeSignatures;
    expect(sigs.map((t) => [t.ticks, t.timeSignature])).toEqual([
      [0, [1, 4]],
      [PPQ, [4, 4]],
    ]);
  });

  it('exports what you hear: the transposition is applied', () => {
    const midi = read(scoreToMidi(score, { transposeSemitones: -2 }));
    const bass = partByLabel(score, 'Bass');
    const index = score.parts.indexOf(bass);
    expect(midi.tracks[index].notes.map((n) => n.midi)).toEqual(bass.events.map((e) => e.midiPitch - 2));
  });

  it('never puts a part on the drum channel', () => {
    const many = { ...score, parts: Array.from({ length: 12 }, (_, i) => ({ ...score.parts[0], id: `p${i}` })) };
    const midi = read(scoreToMidi(many));
    expect(midi.tracks.every((t) => t.channel !== 9)).toBe(true);
  });

  it('gives recording parts sensible instruments', () => {
    const heard: HeardNote[] = JSON.parse(readFileSync(fixturePath('audio/wellerman-simple-synth.notes.json'), 'utf8'));
    const bassNotes = heard.filter((n) => n.midiPitch < 55).map((n) => ({ ...n, midiPitch: n.midiPitch - 12 }));
    const recording = scoreFromStems(
      [
        { kind: 'vocals', notes: heard.filter((n) => n.midiPitch >= 55) },
        { kind: 'bass', notes: bassNotes },
      ],
      { title: 'x' },
    );
    const midi = read(scoreToMidi(recording));
    const byName = new Map(midi.tracks.map((t) => [t.name, t.instrument.number]));
    expect(byName.get('Bass')).toBe(33);
    expect(byName.get('Vocals 1 (top)')).toBe(52);
  });
});

describe('midiFileName', () => {
  it('names the file after the piece, noting any transposition', () => {
    expect(midiFileName('The Wellerman')).toBe('The Wellerman.mid');
    expect(midiFileName('The Wellerman', 2)).toBe('The Wellerman (transposed +2).mid');
    expect(midiFileName('a/b: c', -1)).toBe('a-b- c (transposed -1).mid');
  });
});
