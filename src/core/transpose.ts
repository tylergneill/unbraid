import type { Part, Score } from './types';

/**
 * Transposition: move the whole piece up or down by semitones.
 *
 * Choral parts are often written a little high or low for a given group of
 * singers, and a by-ear learner who cannot reach a line will learn it wrong.
 * Transposition lives in the mix state (per project, like the tempo) and is
 * applied in two places: live in the playback engine, at the moment each note
 * sounds, and here, to produce the score the bands draw. The stored score is
 * never changed, so going back to 0 is exact.
 */

/** A fifth either way covers every practical choir key change; an octave is generous. */
export const MAX_TRANSPOSE = 12;

export function clampTranspose(semitones: number): number {
  return Math.max(-MAX_TRANSPOSE, Math.min(MAX_TRANSPOSE, Math.round(semitones)));
}

/**
 * The key signature after transposing, in fifths (-1 = one flat).
 *
 * Each semitone up adds seven fifths (C → C♯ is seven sharps). Twelve keys
 * have two spellings; the result is kept within six flats to five sharps,
 * which picks D♭ over C♯ and G♭ over F♯ — the spellings choirs usually see.
 */
export function transposeFifths(fifths: number, semitones: number): number {
  const raw = fifths + 7 * semitones;
  return ((((raw + 6) % 12) + 12) % 12) - 6;
}

/** "+2", "−3", or "0": how the transport shows a transposition. */
export function formatTranspose(semitones: number): string {
  if (semitones === 0) return '0';
  return semitones > 0 ? `+${semitones}` : `−${-semitones}`;
}

/**
 * The score as it sounds after transposing.
 *
 * Returns the very same object at 0, so components memoised on the score do
 * not redraw for nothing.
 */
export function transposeScore(score: Score, semitones: number): Score {
  if (semitones === 0) return score;
  const parts: Part[] = score.parts.map((part) => ({
    ...part,
    events: part.events.map((e) => ({ ...e, midiPitch: e.midiPitch + semitones })),
    keyFifths: transposeFifths(part.keyFifths, semitones),
    range:
      part.range === null
        ? null
        : { minMidi: part.range.minMidi + semitones, maxMidi: part.range.maxMidi + semitones },
  }));
  return { ...score, parts };
}
