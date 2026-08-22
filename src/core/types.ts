/**
 * Core domain model (execution doc §4).
 *
 * Time is expressed in *quarter notes* throughout, never in MusicXML divisions
 * and never in seconds. Divisions are a per-part, per-measure encoding detail;
 * seconds depend on tempo, which the user can change. Quarters are the one
 * stable unit, so the parser converts into it immediately and nothing
 * downstream ever sees a <divisions> value.
 */

/** A single sung note on the unrolled timeline. */
export interface NoteEvent {
  /** Onset in quarter notes from the start of the unrolled piece. */
  onsetBeats: number;
  /** Sounding length in quarter notes. Tied notes are merged into one event. */
  durationBeats: number;
  /** MIDI pitch number; 60 = middle C. */
  midiPitch: number;
  /** Measure number (as written in the score) this note sounded in. */
  measureNumber: string;
}

/** One independently mixable voice line. */
export interface Part {
  id: string;
  /** Display name: from the score where possible, else derived (§11.3). */
  label: string;
  events: NoteEvent[];
  /** Clef sign of the staff this part was engraved on, e.g. "G" / "F". */
  clef: string;
  /** Key signature in fifths (-1 = one flat), taken from the first measure. */
  keyFifths: number;
  /** Sounding range, for laying out the band's pitch scale. Null if silent. */
  range: { minMidi: number; maxMidi: number } | null;
  /** MusicXML part id + voice this came from, for debugging bad splits. */
  source: { partId: string; voice: string };
}

/**
 * One sung syllable, placed on the unrolled timeline.
 *
 * Lyrics are a property of the *song*, not of a part: a typical choral export
 * writes the words under one staff only (the Wellerman TTBB fixture puts all
 * 122 syllables under Tenor 1) even though every part sings them. So syllables
 * are collected once, at score level, and displayed against whichever band the
 * user has claimed.
 */
export interface LyricSyllable {
  /** Onset in quarter notes from the start of the unrolled piece. */
  onsetBeats: number;
  /** The syllable exactly as the score wrote it, including any hyphen. */
  text: string;
  /** Measure number (as written) this syllable falls in. */
  measureNumber: string;
}

/** A measure on the unrolled timeline. */
export interface TimelineMeasure {
  /** Number as written in the score. Not unique — repeats reuse it. */
  number: string;
  /** Index in the unrolled sequence. Unique and monotonic. */
  index: number;
  startBeats: number;
  durationBeats: number;
  /** How many times this written measure has been played before this pass. */
  pass: number;
}

/** The fully parsed, repeat-unrolled score. */
export interface Score {
  title: string;
  parts: Part[];
  measures: TimelineMeasure[];
  /** Total length in quarter notes. */
  durationBeats: number;
  /** Tempo in quarter-notes per minute, from <sound tempo> or a default. */
  tempoBpm: number;
  /**
   * Sung text in performance order, or empty when the score carries none.
   * Optional so that projects stored before lyrics existed still load.
   */
  lyrics?: LyricSyllable[];
  /** Non-fatal parse problems worth surfacing to the user (§5.2). */
  warnings: string[];
}

export type LinkMode = 'all' | 'all-except-focus' | 'independent';

/** Per-project mixer + loop state (§4 `mix_state`). */
export interface MixState {
  /** Part id -> volume, 0..100. 0 is fully silent. */
  volumes: Record<string, number>;
  linkMode: LinkMode;
  /** Part id designated as the focus for 'all-except-focus'. */
  focusPartId: string | null;
  /** Loop region in quarter notes, or null for whole-song. */
  loopRegion: { startBeats: number; endBeats: number } | null;
  /** Playback tempo, as a multiplier of the score's notated tempo. */
  tempoScale: number;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Original upload, kept so the score can always be re-derived (§5.3). */
  sourceFile: { name: string; bytes: ArrayBuffer } | null;
  score: Score;
  mixState: MixState;
  notes: string;
}
