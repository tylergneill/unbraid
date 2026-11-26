import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LinkMode, MixState, Project } from '../core/types';
import { PlaybackEngine } from '../audio/engine';
import {
  applyVolumeChange,
  resetVolumes,
  setFocusPart,
  setLinkMode,
  soloFocus,
} from '../core/mixer';
import { effectiveLoop, normalizeLoopRegion, snapToMeasure } from '../core/timeline';
import { clampTranspose, transposeScore } from '../core/transpose';
import { midiFileName, scoreToMidi } from '../core/midi';
import { Bands } from './Bands';
import { Transport } from './Transport';
import { NotesPane } from './NotesPane';

/**
 * The project view: bands, mixer, transport, notes (execution doc §6.2).
 *
 * Mix state is the single source of truth; the engine is told about changes
 * rather than being asked for them, so the UI never waits on audio.
 */

interface Props {
  project: Project;
  /** Applies an update to the stored project and persists it. */
  onChange: (update: (previous: Project) => Project) => void;
  onBack: () => void;
}

const ZOOM_LEVELS = [4, 6, 9, 13, 18, 26, 38, 54];
const DEFAULT_ZOOM = 3;

export function ProjectView({ project, onChange, onBack }: Props) {
  const { score } = project;
  const [mix, setMix] = useState<MixState>(project.mixState);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionBeats, setPositionBeats] = useState(0);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [warningsOpen, setWarningsOpen] = useState(score.warnings.length > 0);

  const engineRef = useRef<PlaybackEngine | null>(null);
  const partIds = useMemo(() => score.parts.map((p) => p.id), [score]);

  // One engine per loaded score. Rebuilding it on every mix change would
  // reschedule every note, so mix updates are pushed into the live engine.
  useEffect(() => {
    const engine = new PlaybackEngine(score);
    engineRef.current = engine;

    for (const part of score.parts) {
      engine.setVolume(part.id, project.mixState.volumes[part.id] ?? 80);
    }
    engine.setLoop(project.mixState.loopRegion);
    engine.setTempoScale(project.mixState.tempoScale);
    engine.setTranspose(project.mixState.transposeSemitones ?? 0);

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // Deliberately keyed on the score alone: the initial mix is read once,
    // and every later change is applied through the handlers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  // Drive the playhead from the audio clock, not from a timer of our own, so
  // the line on screen matches what is actually sounding.
  useEffect(() => {
    const sync = () => {
      const engine = engineRef.current;
      if (engine === null) return;
      setPositionBeats(engine.positionBeats);
      setIsPlaying(engine.isPlaying);
    };

    let frame = requestAnimationFrame(function tick() {
      sync();
      frame = requestAnimationFrame(tick);
    });

    // requestAnimationFrame is throttled to a stop while the tab is in the
    // background, which would leave the playhead frozen wherever it was and
    // out of step with the audio on return. A slow timer keeps the displayed
    // position honest; it costs nothing while the rAF loop is running.
    const backstop = setInterval(sync, 250);

    return () => {
      cancelAnimationFrame(frame);
      clearInterval(backstop);
    };
  }, []);

  /** Update mix state and persist it, in one place. */
  const commit = useCallback(
    (next: MixState) => {
      setMix(next);
      onChange((previous) => ({ ...previous, mixState: next }));
    },
    [onChange],
  );

  const handleVolume = useCallback(
    (partId: string, volume: number) => {
      const next = applyVolumeChange(mix, partId, volume, partIds);
      commit(next);
      // Push every changed fader, since linked modes move more than one.
      for (const id of partIds) {
        engineRef.current?.setVolume(id, next.volumes[id] ?? 0);
      }
    },
    [mix, partIds, commit],
  );

  const handleFocus = useCallback(
    (partId: string) => {
      commit(setFocusPart(mix, mix.focusPartId === partId ? null : partId));
    },
    [mix, commit],
  );

  const handleSolo = useCallback(() => {
    if (mix.focusPartId === null) return;
    const next = soloFocus(mix, partIds);
    commit(next);
    for (const id of partIds) engineRef.current?.setVolume(id, next.volumes[id] ?? 0);
  }, [mix, partIds, commit]);

  const handleReset = useCallback(() => {
    const next = resetVolumes(mix, partIds);
    commit(next);
    for (const id of partIds) engineRef.current?.setVolume(id, next.volumes[id] ?? 0);
  }, [mix, partIds, commit]);

  const handleLoopRegion = useCallback(
    (a: number, b: number) => {
      // Snap to bar lines: a chorus starts where a bar starts, and a hand-drag
      // will never land exactly there.
      const region = normalizeLoopRegion(score, snapToMeasure(score, a), snapToMeasure(score, b));
      const next = { ...mix, loopRegion: region };
      commit(next);
      engineRef.current?.setLoop(region);
    },
    [score, mix, commit],
  );

  const handleClearLoop = useCallback(() => {
    const next = { ...mix, loopRegion: null };
    commit(next);
    engineRef.current?.setLoop(null);
  }, [mix, commit]);

  const handlePlayPause = useCallback(() => {
    const engine = engineRef.current;
    if (engine === null) return;
    if (engine.isPlaying) engine.pause();
    else void engine.play();
  }, []);

  const handleStop = useCallback(() => {
    engineRef.current?.stop();
  }, []);

  const handleSeek = useCallback((beats: number) => {
    engineRef.current?.seekBeats(beats);
  }, []);

  const handleTempoScale = useCallback(
    (scale: number) => {
      const next = { ...mix, tempoScale: scale };
      commit(next);
      engineRef.current?.setTempoScale(scale);
    },
    [mix, commit],
  );

  const transpose = mix.transposeSemitones ?? 0;

  const handleTranspose = useCallback(
    (semitones: number) => {
      const value = clampTranspose(semitones);
      commit({ ...mix, transposeSemitones: value });
      engineRef.current?.setTranspose(value);
    },
    [mix, commit],
  );

  /** What the bands draw: the score as it currently sounds. */
  const shownScore = useMemo(() => transposeScore(score, transpose), [score, transpose]);

  const handleExportMidi = useCallback(() => {
    const bytes = scoreToMidi(score, { transposeSemitones: transpose });
    download(new Blob([bytes], { type: 'audio/midi' }), midiFileName(project.title, transpose));
  }, [score, transpose, project.title]);

  const sourceIsScore = project.sourceFile !== null && !score.parts.some((p) => p.source.partId === 'recording');

  const handleExportOriginal = useCallback(() => {
    if (project.sourceFile === null) return;
    download(new Blob([project.sourceFile.bytes]), project.sourceFile.name);
  }, [project.sourceFile]);

  const handleLinkMode = useCallback(
    (mode: LinkMode) => commit(setLinkMode(mix, mode)),
    [mix, commit],
  );

  // Keyboard shortcuts, kept to the few a practising singer actually reaches
  // for without taking their eyes off the bands.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'Escape') {
        handleStop();
      } else if (e.key === 'l' || e.key === 'L') {
        handleClearLoop();
      } else if (e.key === 's' || e.key === 'S') {
        handleSolo();
      } else if (e.key === '0') {
        handleReset();
      } else if (e.key === '[') {
        handleTranspose(transpose - 1);
      } else if (e.key === ']') {
        handleTranspose(transpose + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePlayPause, handleStop, handleClearLoop, handleSolo, handleReset, handleTranspose, transpose]);

  const loop = effectiveLoop(score, mix.loopRegion);
  const relativePosition = Math.max(0, positionBeats - loop.startBeats);

  return (
    <div className="app">
      <div className="topbar">
        <button className="ghost" onClick={onBack}>
          ← Pieces
        </button>
        <h1>{project.title}</h1>
        <span className="spacer" />
        <span className="band-range">
          {score.parts.length} parts · {score.measures.length} bars
        </span>
        <button
          className="ghost"
          onClick={handleExportMidi}
          title={
            'Download a MIDI file, one track per part, to open in MuseScore' +
            (transpose === 0 ? '' : ` (transposed ${transpose > 0 ? 'up' : 'down'} ${Math.abs(transpose)})`)
          }
        >
          Export MIDI
        </button>
        {sourceIsScore && (
          <button
            className="ghost"
            onClick={handleExportOriginal}
            title="Download the score file you imported, untouched (best for MuseScore: keeps the notation)"
          >
            Original score
          </button>
        )}
      </div>

      {warningsOpen && score.warnings.length > 0 && (
        <div className="banner warn">
          <ul>
            {score.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button className="close" onClick={() => setWarningsOpen(false)} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      <Bands
        score={shownScore}
        mix={mix}
        positionBeats={positionBeats}
        pixelsPerBeat={ZOOM_LEVELS[zoom]}
        onVolumeChange={handleVolume}
        onFocusPart={handleFocus}
        onLoopRegion={handleLoopRegion}
        onSeek={handleSeek}
      />

      <Transport
        score={score}
        mix={mix}
        isPlaying={isPlaying}
        positionBeats={relativePosition}
        onPlayPause={handlePlayPause}
        onStop={handleStop}
        onLinkMode={handleLinkMode}
        onClearLoop={handleClearLoop}
        onSolo={handleSolo}
        onTempoScale={handleTempoScale}
        onTranspose={handleTranspose}
        onZoom={(delta) =>
          setZoom((z) => Math.max(0, Math.min(ZOOM_LEVELS.length - 1, z + delta)))
        }
      />

      <NotesPane
        value={project.notes}
        onChange={(notes) => onChange((previous) => ({ ...previous, notes }))}
      />

      <div className="hint-bar">
        Click the bar ruler to jump, drag across it to loop a span · mark your line with{' '}
        <em>set as mine</em> to unlock "Just my part" and "All but mine" ·{' '}
        <kbd>space</kbd> play · <kbd>S</kbd> just my part · <kbd>L</kbd> clear loop ·{' '}
        <kbd>0</kbd> reset faders · <kbd>[</kbd> <kbd>]</kbd> key down / up
      </div>
    </div>
  );
}

/** Save a blob through the browser's download prompt. */
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
