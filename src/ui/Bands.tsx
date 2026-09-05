import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import type { MixState, Score } from '../core/types';
import { midiToName } from '../core/pitch';
import { bandColor, paintBand, paintRuler } from './bandPainter';
import { Lyrics } from './Lyrics';

/**
 * The multi-band piano roll (execution doc §6.2).
 *
 * All bands share one horizontal time axis and one playhead. Dragging on the
 * ruler defines the loop region; clicking without dragging clears it back to
 * whole-song.
 *
 * The lyric strip shares that axis too. It sits above every band until the
 * user claims a part, then moves to just below the claimed one: the words a
 * singer reads should be next to the line they are singing, not across the
 * screen from it.
 */

const LABEL_WIDTH = 168;
const BAND_HEIGHT = 96;
const RULER_HEIGHT = 34;

/** Travel past which a press on the ruler is a loop drag, not a scrub. */
const DRAG_THRESHOLD_PX = 5;

interface Props {
  score: Score;
  mix: MixState;
  positionBeats: number;
  pixelsPerBeat: number;
  onVolumeChange: (partId: string, volume: number) => void;
  onFocusPart: (partId: string) => void;
  onLoopRegion: (a: number, b: number) => void;
  onSeek: (beats: number) => void;
}

export function Bands({
  score,
  mix,
  positionBeats,
  pixelsPerBeat,
  onVolumeChange,
  onFocusPart,
  onLoopRegion,
  onSeek,
}: Props) {
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const canvasRefs = useRef(new Map<string, HTMLCanvasElement>());
  const [drag, setDrag] = useState<{ from: number; to: number; isDrag: boolean } | null>(null);
  /** The in-flight gesture. A ref, so listeners always see the current value. */
  const gestureRef = useRef<{ from: number; isDrag: boolean } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Stretch a short score to fill the viewport rather than stranding the bands
  // in a narrow column. Measured once per layout, since every coordinate in
  // this component derives from it.
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => setAvailable(el.clientWidth - LABEL_WIDTH));
    observer.observe(el);
    setAvailable(el.clientWidth - LABEL_WIDTH);
    return () => observer.disconnect();
  }, []);

  const naturalWidth = score.durationBeats * pixelsPerBeat;
  const contentWidth = Math.max(320, naturalWidth, available);
  // Beats-to-pixels must follow the stretched width, or clicks map wrongly.
  const scale = score.durationBeats > 0 ? contentWidth / score.durationBeats : pixelsPerBeat;

  // Repaint whenever the layout or the mix changes. Not per frame: the
  // playhead is a DOM overlay, so animation never touches the canvases.
  useLayoutEffect(() => {
    const dpr = window.devicePixelRatio || 1;

    for (const [index, part] of score.parts.entries()) {
      const canvas = canvasRefs.current.get(part.id);
      if (canvas === undefined) continue;
      paintBand(canvas, {
        part,
        score,
        color: bandColor(index),
        pixelsPerBeat: scale,
        width: contentWidth,
        height: BAND_HEIGHT,
        dpr,
        muted: (mix.volumes[part.id] ?? 0) === 0,
      });
    }

    if (rulerRef.current !== null) {
      paintRuler(rulerRef.current, score, scale, contentWidth, RULER_HEIGHT, dpr);
    }
  }, [score, scale, contentWidth, mix.volumes]);

  /**
   * Convert a pointer event to a beat position.
   *
   * Measured against the ruler element itself rather than the scroll
   * container: its rect already accounts for both the label gutter and the
   * current scroll offset, so neither has to be corrected for by hand.
   */
  const beatsFromEvent = (clientX: number): number => {
    const ruler = rulerRef.current;
    if (ruler === null) return 0;
    const rect = ruler.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(score.durationBeats, x / scale));
  };

  /**
   * Begin a ruler gesture.
   *
   * A press that stays put is a scrub: the playhead follows the pointer, which
   * is what a progress bar is expected to do. A press that travels far enough
   * to be a deliberate drag becomes a loop selection instead. Distinguishing
   * them by distance means the user does not have to learn two controls, and a
   * mis-aimed click never silently redefines the loop.
   *
   * The live gesture is tracked in a ref rather than state, and the window
   * listeners are attached here rather than in an effect. State updates are
   * batched, so an effect keyed on the gesture would not have subscribed yet
   * when a fast click's `pointerup` arrives, and the click would be lost. The
   * `drag` state exists only to drive the selection preview.
   */
  const beginGesture = (clientX: number) => {
    const from = beatsFromEvent(clientX);
    gestureRef.current = { from, isDrag: false };
    setDrag({ from, to: from, isDrag: false });
    onSeek(from);

    const move = (e: PointerEvent) => {
      const gesture = gestureRef.current;
      if (gesture === null) return;

      const to = beatsFromEvent(e.clientX);
      if (!gesture.isDrag && Math.abs(to - gesture.from) * scale > DRAG_THRESHOLD_PX) {
        gesture.isDrag = true;
      }
      // While it is still a scrub, keep the playhead under the pointer.
      if (!gesture.isDrag) onSeek(to);
      setDrag({ from: gesture.from, to, isDrag: gesture.isDrag });
    };

    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);

      const gesture = gestureRef.current;
      gestureRef.current = null;
      setDrag(null);
      if (gesture === null) return;

      const to = beatsFromEvent(e.clientX);
      const isDrag =
        gesture.isDrag || Math.abs(to - gesture.from) * scale > DRAG_THRESHOLD_PX;
      if (isDrag) onLoopRegion(gesture.from, to);
      else onSeek(to);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const loop = mix.loopRegion;
  const playheadX = positionBeats * scale;

  // One strip, rendered in one of two places: above every band, or directly
  // below the claimed one. Building the element once here keeps its props in a
  // single spot rather than duplicating them at both sites.
  const syllables = score.lyrics ?? [];
  const focusIndex = score.parts.findIndex((p) => p.id === mix.focusPartId);
  const lyricStrip =
    syllables.length === 0 ? null : (
      <Lyrics
        syllables={syllables}
        scale={scale}
        width={contentWidth}
        gutterLabel="Lyrics"
        positionBeats={positionBeats}
      />
    );

  // Only a real loop drag previews; a scrub leaves the existing loop shading in
  // place so the user can see where they are seeking to within it.
  const previewing = drag !== null && drag.isDrag;
  const previewStart = drag === null ? 0 : Math.min(drag.from, drag.to) * scale;
  const previewWidth = drag === null ? 0 : Math.abs(drag.to - drag.from) * scale;

  return (
    <div className="bands-scroll" ref={scrollRef}>
      <div className="bands" style={{ width: LABEL_WIDTH + contentWidth }}>
        <div className="ruler-row">
          <div className="ruler-gutter">Bar</div>
          <div
            className="ruler"
            style={{ width: contentWidth }}
            onPointerDown={(e) => {
              e.preventDefault();
              beginGesture(e.clientX);
            }}
            title="Click or drag the playhead to scrub · drag across to set a loop region"
          >
            <canvas ref={rulerRef} />
          </div>
        </div>

        {focusIndex === -1 && lyricStrip}

        {score.parts.map((part, index) => {
          const volume = mix.volumes[part.id] ?? 0;
          const isFocus = mix.focusPartId === part.id;
          return (
            <Fragment key={part.id}>
              <div
                className={
                  [
                    'band-row',
                    volume === 0 ? 'band-muted' : '',
                    isFocus ? 'band-focus' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
              >
                <div className="band-label">
                  <button
                    className={isFocus ? 'band-name is-focus' : 'band-name'}
                    style={{ color: isFocus ? undefined : bandColor(index) }}
                    onClick={() => onFocusPart(part.id)}
                    title={
                      isFocus
                        ? `${part.label} is your part — click to unset`
                        : `Click to make ${part.label} your part`
                    }
                    aria-pressed={isFocus}
                  >
                    <span className="dot" />
                    {part.label}
                  </button>

                  <span className="band-range">
                    {/* The focus part is what "All but mine" and "Just my part"
                        act on, so it needs to say so in words rather than only
                        through a colour change. */}
                    {isFocus ? (
                      <span className="my-part">★ my part</span>
                    ) : (
                      <button className="claim-part" onClick={() => onFocusPart(part.id)}>
                        set as mine
                      </button>
                    )}
                    {part.range !== null && (
                      <span className="range-text">
                        {midiToName(part.range.minMidi)}–{midiToName(part.range.maxMidi)}
                      </span>
                    )}
                  </span>

                  <div className="fader">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={volume}
                      aria-label={`${part.label} volume`}
                      onChange={(e) => onVolumeChange(part.id, Number(e.target.value))}
                    />
                    <span className="value">{volume}</span>
                  </div>
                </div>

                <div className="band-canvas-wrap" style={{ width: contentWidth }}>
                  <canvas
                    ref={(el) => {
                      if (el === null) canvasRefs.current.delete(part.id);
                      else canvasRefs.current.set(part.id, el);
                    }}
                  />
                </div>
              </div>
              {isFocus && lyricStrip}
            </Fragment>
          );
        })}

        <div className="overlay" style={{ width: contentWidth }}>
          {/* Everything outside the loop is shaded, so the practised span
              reads as the lit part of the timeline. */}
          {loop !== null && !previewing && (
            <>
              <div
                className="loop-shade"
                style={{ left: 0, width: loop.startBeats * scale }}
              />
              <div
                className="loop-shade"
                style={{
                  left: loop.endBeats * scale,
                  width: Math.max(0, contentWidth - loop.endBeats * scale),
                }}
              />
              <div className="loop-edge" style={{ left: loop.startBeats * scale }} />
              <div className="loop-edge" style={{ left: loop.endBeats * scale }} />
            </>
          )}

          {previewing && (
            <div
              className="loop-edge"
              style={{ left: previewStart, width: previewWidth, opacity: 0.25, background: 'var(--focus)' }}
            />
          )}

          <div className="playhead" style={{ left: playheadX }} />
        </div>
      </div>
    </div>
  );
}
