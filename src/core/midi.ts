import { Midi } from '@tonejs/midi';
import type { Part, Score } from './types';
import { transposeScore } from './transpose';

/**
 * Standard MIDI File export, for opening a piece in MuseScore (or any other
 * notation program or DAW).
 *
 * MIDI rather than MusicXML because it is the honest format for what Unbraid
 * knows. A score import already has its MusicXML (and the app offers the
 * original file for download); a recording import has only notes with exact
 * timings, no note values, beams or ties. MusicXML would force Unbraid to
 * guess the notation itself. MIDI hands MuseScore the timings and lets its
 * import dialog do the quantising, which it does well and lets the user tune.
 *
 * One track per part, named after the part, so MuseScore makes one staff per
 * part with the right name. The tempo and bar lines are Unbraid's, so bar 5
 * in MuseScore is bar 5 here. Any transposition is applied: what you export
 * is what you have been hearing.
 *
 * No key signature is written. @tonejs/midi 2.0.28 encodes it wrongly (it
 * offsets the key by +7 where it should be -7), and a recording has no known
 * key anyway; MuseScore's MIDI import works the key out from the notes.
 *
 * Pure (no DOM), so it is tested by parsing the output back.
 */

/** Ticks per quarter note. 480 is the common default and divides into triplets. */
export const PPQ = 480;

/** General MIDI programs, chosen so a quick playback in MuseScore sounds plausible. */
const PROGRAM = {
  voice: 52, // Choir Aahs
  bass: 33, // Electric Bass (finger)
  other: 0, // Acoustic Grand Piano
};

function programFor(part: Part): number {
  if (part.source.partId === 'recording' && part.id === 'bass') return PROGRAM.bass;
  if (part.source.partId === 'recording' && part.id === 'other') return PROGRAM.other;
  return PROGRAM.voice;
}

/** MIDI channel for the i-th part, skipping 10 (index 9), which General MIDI reserves for drums. */
function channelFor(index: number): number {
  const c = index % 15;
  return c >= 9 ? c + 1 : c;
}

/**
 * A bar's length as a time signature.
 *
 * Unbraid stores bar lengths in quarter notes, so 4 → 4/4 and 3 → 3/4; a
 * half-quarter length becomes eighths (1.5 → 3/8, 3 is still 3/4 — compound
 * metre cannot be recovered from length alone, and MuseScore lets you change
 * it after import).
 */
export function timeSignatureFor(quarters: number): [number, number] {
  if (Number.isInteger(quarters)) return [quarters, 4];
  if (Number.isInteger(quarters * 2)) return [quarters * 2, 8];
  return [Math.round(quarters * 4), 16];
}

export interface MidiExportOptions {
  transposeSemitones?: number;
}

/** Build a .mid file for the score. */
export function scoreToMidi(score: Score, options: MidiExportOptions = {}): Uint8Array<ArrayBuffer> {
  const shown = transposeScore(score, options.transposeSemitones ?? 0);
  const midi = new Midi();
  // The header's PPQ is read-only in @tonejs/midi and already 480; assert it,
  // since every tick below assumes it.
  if (midi.header.ppq !== PPQ) throw new Error(`Unexpected MIDI resolution ${midi.header.ppq}`);

  midi.header.name = score.title;
  midi.header.setTempo(score.tempoBpm);

  let previous: [number, number] | null = null;
  for (const measure of score.measures) {
    const signature = timeSignatureFor(measure.durationBeats);
    if (previous === null || signature[0] !== previous[0] || signature[1] !== previous[1]) {
      midi.header.timeSignatures.push({
        ticks: Math.round(measure.startBeats * PPQ),
        timeSignature: signature,
        measures: measure.index,
      });
      previous = signature;
    }
  }
  midi.header.update();

  shown.parts.forEach((part, i) => {
    const track = midi.addTrack();
    track.name = part.label;
    track.channel = channelFor(i);
    track.instrument.number = programFor(part);
    for (const event of part.events) {
      const ticks = Math.round(event.onsetBeats * PPQ);
      const durationTicks = Math.max(1, Math.round(event.durationBeats * PPQ));
      track.addNote({ midi: event.midiPitch, ticks, durationTicks, velocity: 0.8 });
    }
  });

  return new Uint8Array(midi.toArray());
}

/** A filename for the export, noting any transposition so versions do not get mixed up. */
export function midiFileName(title: string, transposeSemitones = 0): string {
  const safe = title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'unbraid';
  if (transposeSemitones === 0) return `${safe}.mid`;
  const sign = transposeSemitones > 0 ? '+' : '-';
  return `${safe} (transposed ${sign}${Math.abs(transposeSemitones)}).mid`;
}
