import { useLayoutEffect, useRef, useState } from 'react';
import type { LyricSyllable } from '../core/types';

/**
 * The lyric strip.
 *
 * The words sit on the same horizontal time axis as the bands, so a syllable
 * is directly above the note it is sung on and the playhead reaches both at
 * the same moment. That alignment is the whole point: it is what lets someone
 * read ahead to the next phrase while watching their own line.
 *
 * Placing text on a musical time axis means the spacing is decided by the
 * music, not by the words — quick syllables crowd, held ones leave gaps — so
 * fitting is the hard part. `layOut` places the words; `fitLayout` picks the
 * size they are placed at.
 */

/** Font size for the syllables at full size, in CSS pixels. */
const FONT_SIZE = 13;
/** Never shrink the text below this, or it stops being readable at all. */
const MIN_FONT_SIZE = 8;
/** Minimum blank space between two syllables before they count as colliding. */
const GAP_PX = 4;
/**
 * How far right of its own note a syllable may be drawn.
 *
 * Roughly a short word's width. Within it the text still reads as belonging to
 * the note beneath it; past it the strip would be asserting something false
 * about when the word is sung.
 */
const MAX_DRIFT_PX = 26;
/**
 * Stand-in drawn at each note when the words themselves cannot fit.
 *
 * A middle dot rather than a full stop: it sits on the text's centre line, so
 * a run of them reads as evenly spaced marks rather than as punctuation.
 */
const DOT = '\u00b7';
/**
 * Share of syllables allowed past `MAX_DRIFT_PX` before the strip gives up on
 * words and shows dots.
 *
 * Not zero, because real scores contain the occasional very tight pair that no
 * available zoom can separate, and one such pair should not cost the reader
 * the words for the whole piece.
 */
const OVERFLOW_TOLERANCE = 0.05;

export interface LyricPlacement {
  text: string;
  /** Left edge in pixels, after fitting. */
  x: number;
  width: number;
  /** True onset in pixels, for comparing against where the text ended up. */
  anchorX: number;
}

export interface LyricLayout {
  placements: LyricPlacement[];
  /** Font size the strip should render at, after any shrink-to-fit. */
  fontSize: number;
  /**
   * True when the words did not fit at any readable size and the strip is
   * showing one dot per note instead.
   */
  dotted: boolean;
}

/**
 * Fit syllables onto one line.
 *
 * One line, always. Words are read left to right, and a layout that wraps or
 * stacks them breaks that: an early version placed crowded syllables on the
 * nearest free row, which passed every "nothing overlaps, nothing is clipped"
 * check and still came out as "There / once was a / that put to / sea." —
 * tidy columns the eye cannot follow.
 *
 * So a syllable is drawn at its own note's position when there is room, and
 * pushed just clear of its predecessor when there is not. The push is capped
 * at `MAX_DRIFT_PX`, because it otherwise compounds: each displaced syllable
 * displaces the next, and unbounded that reached eighteen bars of drift in the
 * Wellerman at default zoom — words nowhere near the note they belong to,
 * which is not a cramped layout but a wrong one.
 *
 * Syllables that would exceed that cap are counted in `overflowed` rather than
 * treated as fatal here. The caller decides what an acceptable number is; this
 * function never invents or omits an entry, so its output always lines up
 * one-to-one with the syllables it was given.
 *
 * Nothing is ever drawn past the right edge either, since the strip clips.
 */
export function layOut(
  syllables: LyricSyllable[],
  scale: number,
  measure: (text: string) => number,
  width = Infinity,
): { placements: LyricPlacement[]; overflowed: number } {
  const placements: LyricPlacement[] = [];
  let cursor = -Infinity;
  let overflowed = 0;

  for (const syllable of syllables) {
    const textWidth = measure(syllable.text);
    const anchorX = syllable.onsetBeats * scale;

    // At its own note when free, otherwise just clear of the previous word.
    let x = Math.max(anchorX, cursor);
    // Never past the right edge: the strip clips, so that would lose the word.
    if (Number.isFinite(width)) x = Math.min(x, Math.max(0, width - textWidth));

    if (x - anchorX > MAX_DRIFT_PX) overflowed++;

    placements.push({ text: syllable.text, x, width: textWidth, anchorX });
    cursor = x + textWidth + GAP_PX;
  }

  return { placements, overflowed };
}

/**
 * Lay the text out at the largest size that keeps every word on its own note.
 *
 * Shrinking is the whole strategy for crowding: smaller text buys room in the
 * dense bars, which is what keeps each word aligned. Sizes are tried largest
 * first and the first that fits without drift wins, so a roomy score is never
 * shrunk needlessly.
 *
 * A handful of syllables may still sit past the drift cap without condemning
 * the whole strip. Real scores contain the odd very tight pair — in the
 * Wellerman a single "when the" an eighth before "tong-" needs more pixels per
 * beat than the widest zoom provides — and demanding perfection from every
 * syllable let that one pair force dots across the entire piece at every zoom.
 * `OVERFLOW_TOLERANCE` is the share allowed to be crowded before words stop
 * being worth showing at all.
 *
 * Below `MIN_FONT_SIZE` the text stops being readable, and there is no size at
 * which these words both fit and stay on their notes. Rather than show a lyric
 * that is either unreadable or broadly misaligned, the strip then falls back
 * to a single dot per note: no longer readable as words, but still an honest
 * picture of where the syllables fall — the rhythm of the text against the
 * bands, and a visible cue that zooming in will bring the words back.
 */
export function fitLayout(
  syllables: LyricSyllable[],
  scale: number,
  measureAt: (text: string, fontSize: number) => number,
  width: number,
): LyricLayout {
  const allowed = Math.floor(syllables.length * OVERFLOW_TOLERANCE);

  for (let fontSize = FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize--) {
    const measure = (t: string) => measureAt(t, fontSize);
    const { placements, overflowed } = layOut(syllables, scale, measure, width);
    if (overflowed <= allowed) return { placements, fontSize, dotted: false };
  }

  // No readable size fits: one dot per note, each exactly on its onset.
  const dots = syllables.map((syllable) => ({
    text: DOT,
    x: syllable.onsetBeats * scale,
    width: 0,
    anchorX: syllable.onsetBeats * scale,
  }));
  return { placements: dots, fontSize: MIN_FONT_SIZE, dotted: true };
}

interface Props {
  syllables: LyricSyllable[];
  /** Pixels per quarter note — the same scale the bands are drawn at. */
  scale: number;
  width: number;
  /** Label shown in the sticky gutter, e.g. "Lyrics" or the claimed part. */
  gutterLabel: string;
  /** Highlight up to this beat, so sung text reads as already past. */
  positionBeats: number;
}

export function Lyrics({ syllables, scale, width, gutterLabel, positionBeats }: Props) {
  const [layout, setLayout] = useState<LyricLayout>({
    placements: [],
    fontSize: FONT_SIZE,
    dotted: false,
  });

  // Text has to be measured in the font it will actually render in: "a" and
  // "through" differ by enough that an average-character-width guess would
  // overlap badly, and the fitting shrinks the font, so the measurement has to
  // follow it. One offscreen canvas does the job without touching the DOM.
  const measureRef = useRef<CanvasRenderingContext2D | null>(null);
  useLayoutEffect(() => {
    if (measureRef.current === null) {
      measureRef.current = document.createElement('canvas').getContext('2d');
    }
    const ctx = measureRef.current;
    if (ctx === null) return;

    // Measuring is the inner loop of a search over font sizes, so results are
    // memoised per size-and-text; a lyric reuses the same words constantly.
    const cache = new Map<string, number>();
    const measureAt = (text: string, fontSize: number): number => {
      const key = `${fontSize}:${text}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
      const w = ctx.measureText(text).width;
      cache.set(key, w);
      return w;
    };

    setLayout(fitLayout(syllables, scale, measureAt, width));
  }, [syllables, scale, width]);

  if (syllables.length === 0) return null;

  const playheadX = positionBeats * scale;

  return (
    <div className="lyric-row">
      <div className="lyric-gutter">
        {gutterLabel}
        {/* Name what the dots are, so a row of marks is not mistaken for the
            lyric being broken or missing. */}
        {layout.dotted && <span className="lyric-hint">zoom in for words</span>}
      </div>
      <div
        className={layout.dotted ? 'lyric-strip is-dotted' : 'lyric-strip'}
        style={{ width, fontSize: layout.fontSize }}
        title={layout.dotted ? 'One dot per syllable — zoom in to read the words' : undefined}
      >
        {layout.placements.map((p, index) => (
          <span
            key={index}
            className={p.anchorX <= playheadX ? 'syllable is-sung' : 'syllable'}
            style={{ left: p.x }}
          >
            {p.text}
          </span>
        ))}
      </div>
    </div>
  );
}
