import type { LinkMode, MixState, Score } from '../core/types';
import { beatsToSeconds, formatTime } from '../core/timeline';
import { MAX_TRANSPOSE, formatTranspose } from '../core/transpose';

/**
 * Transport, link-mode selector, tempo, and transposition (execution doc §6.2).
 */

interface Props {
  score: Score;
  mix: MixState;
  isPlaying: boolean;
  positionBeats: number;
  onPlayPause: () => void;
  onStop: () => void;
  onLinkMode: (mode: LinkMode) => void;
  onClearLoop: () => void;
  onSolo: () => void;
  onTempoScale: (scale: number) => void;
  onTranspose: (semitones: number) => void;
  onZoom: (delta: number) => void;
}

const LINK_MODES: { value: LinkMode; label: string; title: string }[] = [
  { value: 'independent', label: 'Independent', title: 'Each fader moves alone' },
  { value: 'all', label: 'All', title: 'Moving one fader moves them all' },
  {
    value: 'all-except-focus',
    label: 'All but mine',
    title: 'Move everyone except the focus part — turn the others down',
  },
];

export function Transport({
  score,
  mix,
  isPlaying,
  positionBeats,
  onPlayPause,
  onStop,
  onLinkMode,
  onClearLoop,
  onSolo,
  onTempoScale,
  onTranspose,
  onZoom,
}: Props) {
  const transpose = mix.transposeSemitones ?? 0;
  const focusLabel = score.parts.find((p) => p.id === mix.focusPartId)?.label ?? 'your part';
  const tempo = score.tempoBpm * mix.tempoScale;
  const position = beatsToSeconds(positionBeats, tempo);
  const total = beatsToSeconds(
    mix.loopRegion === null ? score.durationBeats : mix.loopRegion.endBeats - mix.loopRegion.startBeats,
    tempo,
  );

  return (
    <div className="transport">
      <button className="primary" onClick={onPlayPause}>
        {isPlaying ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button onClick={onStop}>■ Stop</button>

      <span className="clock">
        {formatTime(position)} / {formatTime(total)}
      </span>

      <div className="group">
        <label>Faders</label>
        <div className="seg">
          {LINK_MODES.map((mode) => {
            // "All except focus" has no referent until a part is claimed.
            const needsFocus = mode.value === 'all-except-focus' && mix.focusPartId === null;
            return (
              <button
                key={mode.value}
                className={mix.linkMode === mode.value ? 'on' : ''}
                disabled={needsFocus}
                title={
                  needsFocus
                    ? 'Mark a part as yours first — use "set as mine" beside its name'
                    : mode.value === 'all-except-focus'
                      ? `Move every fader except ${focusLabel}`
                      : mode.title
                }
                onClick={() => onLinkMode(mode.value)}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={onSolo}
        disabled={mix.focusPartId === null}
        title={
          mix.focusPartId === null
            ? 'Mark a part as yours first — use "set as mine" beside its name'
            : `Silence everything except ${focusLabel}`
        }
      >
        Just my part
      </button>

      <button onClick={onClearLoop} disabled={mix.loopRegion === null}>
        {mix.loopRegion === null ? 'Looping whole song' : 'Clear loop'}
      </button>

      <div className="group">
        <label htmlFor="tempo">Tempo</label>
        <input
          id="tempo"
          className="tempo"
          type="range"
          min={40}
          max={130}
          value={Math.round(mix.tempoScale * 100)}
          onChange={(e) => onTempoScale(Number(e.target.value) / 100)}
        />
        <span className="clock" style={{ minWidth: 62 }}>
          {Math.round(tempo)} bpm
        </span>
      </div>

      <div className="group" title="Transpose: move every part up or down by semitones ( [ and ] )">
        <label>Key</label>
        <button
          className="ghost"
          onClick={() => onTranspose(transpose - 1)}
          disabled={transpose <= -MAX_TRANSPOSE}
          aria-label="Transpose down a semitone"
        >
          ♭
        </button>
        <button
          className={transpose === 0 ? 'ghost transpose' : 'ghost transpose on'}
          onClick={() => onTranspose(0)}
          disabled={transpose === 0}
          title={transpose === 0 ? 'As written' : 'Back to the written key'}
        >
          {formatTranspose(transpose)}
        </button>
        <button
          className="ghost"
          onClick={() => onTranspose(transpose + 1)}
          disabled={transpose >= MAX_TRANSPOSE}
          aria-label="Transpose up a semitone"
        >
          ♯
        </button>
      </div>

      <span className="spacer" style={{ flex: 1 }} />

      <div className="group">
        <button className="ghost" onClick={() => onZoom(-1)} title="Zoom out">
          −
        </button>
        <button className="ghost" onClick={() => onZoom(1)} title="Zoom in">
          +
        </button>
      </div>
    </div>
  );
}
