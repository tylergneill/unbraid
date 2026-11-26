import type { LinkMode, MixState, Score } from './types';

/**
 * Fader link modes (execution doc §6.2).
 *
 * The three modes exist to serve one gesture: "turn everyone else down so I
 * can hear my line". `all-except-focus` is that gesture, and the doc expects
 * it to be the most used mode.
 */

export const DEFAULT_VOLUME = 80;

export function initialMixState(score: Score): MixState {
  const volumes: Record<string, number> = {};
  for (const part of score.parts) volumes[part.id] = DEFAULT_VOLUME;
  return {
    volumes,
    linkMode: 'independent',
    // No part is claimed until the user says so. Defaulting to the first part
    // would silently make the soprano "theirs" and quietly change what the
    // link modes act on.
    focusPartId: null,
    loopRegion: null,
    tempoScale: 1,
    transposeSemitones: 0,
  };
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/**
 * Apply a fader move, honouring the current link mode.
 *
 * Linked modes move the other faders by the same *delta*, not to the same
 * value, so the mix's balance survives the gesture. Faders that hit an end
 * stop simply clamp; the moved fader always lands exactly where the user put
 * it.
 */
export function applyVolumeChange(
  state: MixState,
  partId: string,
  nextVolume: number,
  allPartIds: string[],
): MixState {
  const target = clamp(nextVolume);
  const delta = target - (state.volumes[partId] ?? DEFAULT_VOLUME);
  const volumes = { ...state.volumes, [partId]: target };

  if (delta !== 0 && state.linkMode !== 'independent') {
    for (const id of allPartIds) {
      if (id === partId) continue;
      // In 'all-except-focus' the focus part holds still — that is the whole
      // point of the mode: the user's own line stays put while the rest move.
      if (state.linkMode === 'all-except-focus' && id === state.focusPartId) continue;
      volumes[id] = clamp((state.volumes[id] ?? DEFAULT_VOLUME) + delta);
    }
  }

  return { ...state, volumes };
}

export function setLinkMode(state: MixState, linkMode: LinkMode): MixState {
  return { ...state, linkMode };
}

export function setFocusPart(state: MixState, focusPartId: string | null): MixState {
  return { ...state, focusPartId };
}

/** Silence everything except the focus part — the one-click "just me" gesture. */
export function soloFocus(state: MixState, allPartIds: string[]): MixState {
  const volumes: Record<string, number> = {};
  for (const id of allPartIds) {
    volumes[id] = id === state.focusPartId ? 100 : 0;
  }
  return { ...state, volumes };
}

/** Restore every fader to the default level. */
export function resetVolumes(state: MixState, allPartIds: string[]): MixState {
  const volumes: Record<string, number> = {};
  for (const id of allPartIds) volumes[id] = DEFAULT_VOLUME;
  return { ...state, volumes };
}

/**
 * Convert a 0-100 fader position to linear gain.
 *
 * Perceived loudness is not linear in fader position, so a raw mapping makes
 * the bottom of the travel useless. A squared curve gives usable resolution
 * where the user actually works. 0 must be true silence, not merely quiet,
 * so the user can strip the mix back to their own line.
 */
export function volumeToGain(volume: number): number {
  if (volume <= 0) return 0;
  const v = Math.min(100, volume) / 100;
  return v * v;
}
