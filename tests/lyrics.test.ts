import { describe, it, expect } from 'vitest';
import { fixturePath, loadScore } from './helpers';
import { fitLayout, layOut } from '../src/ui/Lyrics';
import type { LyricSyllable } from '../src/core/types';

/**
 * Lyric extraction and fitting.
 *
 * The fixture's ground truth is known exactly (see its header comment), so
 * these assertions are exact rather than approximate.
 */

const LYRICS = fixturePath('lyrics-fixture.musicxml');
const SIMPLE = fixturePath('wellerman-fixture-simple.musicxml');

describe('lyric extraction', () => {
  it('reads the sung text in performance order', () => {
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    expect(lyrics.map((l) => l.text)).toEqual([
      'On', 'shore-', 'line',
      'On', 'shore-', 'line',
      'won', 'der‿at',
    ]);
  });

  it('takes lyrics from whichever part carries them, not the first part', () => {
    // The fixture puts every word under P2. A reader that assumed part one
    // would find nothing at all, which is the common real-world failure.
    expect(loadScore(LYRICS).lyrics ?? []).not.toHaveLength(0);
  });

  it('repeats the words when the music repeats', () => {
    // Bars 1-2 sit inside a repeat, so "On shore- line" sounds twice, the
    // second time four beats later.
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    expect(lyrics.filter((l) => l.text === 'On').map((l) => l.onsetBeats)).toEqual([0, 4]);
  });

  it('places each syllable at the onset of the note it is sung on', () => {
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    expect(lyrics.map((l) => l.onsetBeats)).toEqual([0, 1, 2, 4, 5, 6, 8, 9]);
  });

  it('keeps a hyphen the exporter wrote, and adds none of its own', () => {
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    const texts = lyrics.map((l) => l.text);
    // "shore-" is written with its hyphen; "won"/"der" are marked begin/end
    // with no hyphen written, and real exports use that same markup for
    // ordinary separate words, so neither gains one.
    expect(texts).toContain('shore-');
    expect(texts).toContain('won');
    expect(texts.filter((t) => t.endsWith('-'))).toEqual(['shore-', 'shore-']);
  });

  it('joins an elision rather than dropping half of it', () => {
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    expect(lyrics.at(-1)?.text).toBe('der‿at');
  });

  it('ignores an empty <text/> and a second verse line', () => {
    const texts = (loadScore(LYRICS).lyrics ?? []).map((l) => l.text);
    expect(texts).not.toContain('');
    expect(texts).not.toContain('IGNORED');
  });

  it('reports no lyrics for a score that has none', () => {
    expect(loadScore(SIMPLE).lyrics).toEqual([]);
  });

  it('tags each syllable with the measure it falls in', () => {
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    expect(lyrics.map((l) => l.measureNumber)).toEqual([
      '1', '1', '2', '1', '1', '2', '3', '3',
    ]);
  });
});

/** Build syllables at the given beats, for the fitting tests. */
function at(beats: number[], text = 'la'): LyricSyllable[] {
  return beats.map((onsetBeats) => ({ onsetBeats, text, measureNumber: '1' }));
}

/** A stand-in for canvas text measurement: 8px per character at size 13. */
const measure = (text: string): number => text.length * 8;
const measureAt = (text: string, fontSize: number): number =>
  text.length * 8 * (fontSize / 13);

describe('lyric fitting', () => {
  it('leaves syllables at their true onset when they fit', () => {
    const { placements, overflowed } = layOut(at([0, 4, 8]), 20, measure);
    expect(placements.map((p) => p.x)).toEqual([0, 80, 160]);
    expect(overflowed).toBe(0);
  });

  it('keeps every syllable in reading order, left to right', () => {
    // Words are read left to right, so this is the property the whole layout
    // serves. An earlier version stacked crowded syllables onto extra rows,
    // which never overlapped and was still unreadable.
    const beats = Array.from({ length: 24 }, (_, i) => i * 0.2);
    const { placements } = layOut(at(beats, 'word'), 5, measure, 900);
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i].x).toBeGreaterThanOrEqual(placements[i - 1].x);
    }
  });

  it('never overlaps two syllables', () => {
    const beats = Array.from({ length: 20 }, (_, i) => i * 0.3);
    const { placements } = layOut(at(beats, 'sing'), 5, measure, 2000);
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i].x).toBeGreaterThanOrEqual(
        placements[i - 1].x + placements[i - 1].width,
      );
    }
  });

  it('never pushes a syllable past the right edge, where it would be clipped', () => {
    const beats = Array.from({ length: 30 }, (_, i) => i * 0.2);
    const width = 300;
    for (const p of layOut(at(beats, 'longish'), 6, measure, width).placements) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + p.width).toBeLessThanOrEqual(width + 0.001);
    }
  });

  it('counts the syllables pushed far from their own note', () => {
    const beats = Array.from({ length: 20 }, (_, i) => i * 0.1);
    // Every syllable after the first is crowded off its note at this density.
    expect(layOut(at(beats, 'crowded'), 5, measure, 2000).overflowed).toBeGreaterThan(10);
    // And none are when there is room.
    expect(layOut(at([0, 8, 16], 'crowded'), 20, measure, 2000).overflowed).toBe(0);
  });

  it('keeps the anchor at the true onset even when the text is moved', () => {
    const { placements } = layOut(at([0, 0.1], 'stretch'), 20, measure);
    expect(placements[1].anchorX).toBeCloseTo(2);
  });

  it('handles an empty lyric list', () => {
    expect(layOut([], 20, measure).placements).toEqual([]);
  });
});

describe('shrink to fit', () => {
  it('keeps the full font size when the text already fits', () => {
    const { fontSize, dotted } = fitLayout(at([0, 4, 8], 'room'), 40, measureAt, 2000);
    expect(fontSize).toBe(13);
    expect(dotted).toBe(false);
  });

  it('shrinks the font rather than letting words drift off their notes', () => {
    // Sized so the text does not fit at 13px but does a little smaller.
    const beats = Array.from({ length: 12 }, (_, i) => i * 2);
    const { fontSize, dotted } = fitLayout(at(beats, 'medium'), 20, measureAt, 900);
    expect(fontSize).toBeLessThan(13);
    expect(dotted).toBe(false);
  });

  it('keeps every word within a short distance of its note whenever it shows words', () => {
    // The bug this guards against: unbounded push let drift accumulate across
    // the piece, putting words bars away from the note they belong to.
    const beats = Array.from({ length: 12 }, (_, i) => i * 2);
    const { placements, dotted } = fitLayout(at(beats, 'medium'), 20, measureAt, 900);
    expect(dotted).toBe(false);
    for (const p of placements) {
      expect(p.x - p.anchorX).toBeLessThanOrEqual(26);
    }
  });

  it('does not let one very tight pair cost the whole piece its words', () => {
    // Real scores contain the odd pair too close for any zoom — in the
    // Wellerman a "when the" an eighth before "tong-". Demanding perfection
    // from every syllable let that single pair force dots everywhere.
    const roomy = Array.from({ length: 40 }, (_, i) => i * 4);
    const tight = [...roomy, 156.1];
    const { dotted } = fitLayout(at(tight, 'word'), 20, measureAt, 3400);
    expect(dotted).toBe(false);
  });

  it('falls back to one dot per note when no readable size fits', () => {
    const beats = Array.from({ length: 200 }, (_, i) => i * 0.1);
    const syllables = at(beats, 'incompressible');
    const { placements, dotted } = fitLayout(syllables, 1, measureAt, 200);

    expect(dotted).toBe(true);
    // One mark per syllable: nothing is lost, it just stops being words.
    expect(placements).toHaveLength(syllables.length);
    expect(placements.every((p) => p.text === '\u00b7')).toBe(true);
  });

  it('puts every dot exactly on its own note', () => {
    // The point of the fallback: it is no longer readable, but it is honest.
    const beats = Array.from({ length: 200 }, (_, i) => i * 0.1);
    const scale = 1;
    const { placements } = fitLayout(at(beats, 'incompressible'), scale, measureAt, 200);
    for (const [i, p] of placements.entries()) {
      expect(p.x).toBeCloseTo(beats[i] * scale);
      expect(p.x).toBeCloseTo(p.anchorX);
    }
  });

  it('fits a real lyric at every zoom level, in order and on its note', () => {
    // Real syllable timings — uneven, with hyphenated pairs an eighth apart —
    // rather than the evenly spaced synthetic runs above.
    const lyrics = loadScore(LYRICS).lyrics ?? [];
    const beats = 10;
    for (const zoom of [4, 6, 9, 13, 18, 26, 38, 54]) {
      const width = Math.max(320, beats * zoom);
      const { placements, dotted } = fitLayout(lyrics, width / beats, measureAt, width);

      // Nothing is ever lost, whichever mode the strip is in.
      expect(placements).toHaveLength(lyrics.length);

      for (let i = 1; i < placements.length; i++) {
        expect(placements[i].x).toBeGreaterThanOrEqual(placements[i - 1].x);
      }
      for (const p of placements) {
        expect(p.x - p.anchorX).toBeLessThanOrEqual(26);
        if (!dotted) expect(p.x + p.width).toBeLessThanOrEqual(width + 0.001);
      }
    }
  });
});
