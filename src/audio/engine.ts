import * as Tone from 'tone';
import type { Part, Score } from '../core/types';
import { volumeToGain } from '../core/mixer';

/**
 * Playback engine (execution doc §5.4).
 *
 * One synth voice per part, so per-part gain is a single node away and the
 * mixer never has to reschedule anything. Notes are scheduled once into
 * Tone's Transport, which owns the loop points; the loop seam is therefore
 * sample-accurate rather than driven from JavaScript timers. The doc calls a
 * clicky loop the thing that would make the app unusable, so the seam is
 * handled by the audio clock and never by a callback.
 */

/** A part the engine can play. §8 keeps this narrower than `Part` on purpose. */
export interface AudioSource {
  readonly id: string;
  setVolume(volume: number): void;
  dispose(): void;
}

class SynthPart implements AudioSource {
  readonly id: string;
  private readonly synth: Tone.PolySynth;
  private readonly gain: Tone.Gain;

  /** Reads the engine's current transposition at the moment a note sounds. */
  private readonly transpose: () => number;

  constructor(part: Part, destination: Tone.InputNode, transpose: () => number) {
    this.id = part.id;
    this.transpose = transpose;
    this.gain = new Tone.Gain(volumeToGain(80)).connect(destination);

    // A soft triangle with a gentle envelope reads as voice-like enough to
    // sing against, which the doc asks for, without shipping a sample library.
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: {
        attack: 0.03,
        decay: 0.12,
        sustain: 0.75,
        // A short release keeps a held note from bleeding across the loop seam.
        release: 0.12,
      },
    }).connect(this.gain);

    this.synth.maxPolyphony = 12;
  }

  /** Schedule this part's notes onto the transport, in seconds. */
  schedule(part: Part, tempoBpm: number): number[] {
    const ids: number[] = [];
    for (const event of part.events) {
      const start = (event.onsetBeats / tempoBpm) * 60;
      // Trim a hair off so consecutive notes at the same pitch re-articulate
      // rather than the synth treating them as one continuous voice.
      const duration = Math.max(0.05, ((event.durationBeats / tempoBpm) * 60) - 0.01);
      const id = Tone.getTransport().schedule((time) => {
        this.synth.triggerAttackRelease(
          // Transposed when it sounds, not when it was scheduled, so changing
          // key never needs a reschedule and takes effect from the next note.
          Tone.Frequency(event.midiPitch + this.transpose(), 'midi').toFrequency(),
          duration,
          time,
        );
      }, start);
      ids.push(id);
    }
    return ids;
  }

  setVolume(volume: number): void {
    // Ramp rather than jump, so dragging a fader does not produce zipper noise.
    this.gain.gain.rampTo(volumeToGain(volume), 0.05);
  }

  /** Cut all sound immediately, for stop and for loop repositioning. */
  silence(): void {
    this.synth.releaseAll();
  }

  dispose(): void {
    this.synth.dispose();
    this.gain.dispose();
  }
}

export interface EngineState {
  isPlaying: boolean;
  positionBeats: number;
}

/**
 * Owns the Tone transport for one loaded score.
 *
 * Construct with a parsed score, call `setVolume` as faders move and
 * `setLoop` as the region changes, and dispose when the score is unloaded.
 */
export class PlaybackEngine {
  private readonly parts = new Map<string, SynthPart>();
  private readonly scheduledIds: number[] = [];
  private readonly limiter: Tone.Limiter;
  private readonly master: Tone.Gain;
  private readonly score: Score;
  private disposed = false;

  constructor(score: Score) {
    this.score = score;

    // Four or five synth voices at full tilt will clip the master bus; a
    // limiter keeps the mix safe without the user having to ride the faders.
    this.limiter = new Tone.Limiter(-6).toDestination();
    this.master = new Tone.Gain(0.9).connect(this.limiter);

    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.bpm.value = score.tempoBpm;
    transport.loop = true;
    this.setLoop(null);

    for (const part of score.parts) {
      const synth = new SynthPart(part, this.master, () => this.transposeSemitones);
      this.parts.set(part.id, synth);
      this.scheduledIds.push(...synth.schedule(part, score.tempoBpm));
    }
  }

  /** The audio clock must be started from a user gesture. */
  static async unlock(): Promise<void> {
    await Tone.start();
  }

  async play(): Promise<void> {
    if (this.disposed) return;
    await Tone.start();
    Tone.getTransport().start();
  }

  pause(): void {
    Tone.getTransport().pause();
    this.silenceAll();
  }

  stop(): void {
    const transport = Tone.getTransport();
    transport.stop();
    transport.seconds = this.loopStartSeconds;
    this.silenceAll();
  }

  private loopStartSeconds = 0;

  /**
   * Set the looped span, in quarter notes.
   *
   * Passing null loops the whole song, which is the default state the doc
   * asks for when no region is selected.
   */
  setLoop(region: { startBeats: number; endBeats: number } | null): void {
    const transport = Tone.getTransport();
    const start = region === null ? 0 : region.startBeats;
    const end = region === null ? this.score.durationBeats : region.endBeats;

    // Loop points are given to the transport in seconds at the notated tempo.
    // Tone scales them with the playback rate, so slowing down for practice
    // does not move the seam.
    const startSeconds = (start / this.score.tempoBpm) * 60;
    const endSeconds = (end / this.score.tempoBpm) * 60;

    transport.loopStart = startSeconds;
    transport.loopEnd = endSeconds;
    this.loopStartSeconds = startSeconds;

    // If the playhead is outside the new region, bring it inside rather than
    // leaving it to run to the end of the piece before looping back.
    if (transport.seconds < startSeconds || transport.seconds > endSeconds) {
      transport.seconds = startSeconds;
      this.silenceAll();
    }
  }

  /** Move the playhead, in quarter notes. */
  seekBeats(beats: number): void {
    const transport = Tone.getTransport();
    transport.seconds = (beats / this.score.tempoBpm) * 60;
    this.silenceAll();
  }

  /**
   * Current playhead position in quarter notes.
   *
   * `transport.seconds` reports where the *scheduler* has reached, which runs
   * ahead of the audible output by the context's lookAhead so that notes are
   * queued before they must sound. Drawing that value puts the playhead
   * slightly ahead of what the ear hears, so the lookahead is subtracted to
   * report the sounding position instead.
   *
   * Only while playing: when stopped or paused the transport is not running
   * ahead of anything, and the correction would misreport a seek.
   */
  get positionBeats(): number {
    const transport = Tone.getTransport();
    let seconds = transport.seconds;

    if (transport.state === 'started') {
      // Scale by the playback rate, since lookAhead is wall-clock time while
      // transport.seconds advances at the current tempo.
      const rate = this.score.tempoBpm > 0 ? transport.bpm.value / this.score.tempoBpm : 1;
      seconds = Math.max(0, seconds - Tone.getContext().lookAhead * rate);
    }

    return (seconds / 60) * this.score.tempoBpm;
  }

  get isPlaying(): boolean {
    return Tone.getTransport().state === 'started';
  }

  setVolume(partId: string, volume: number): void {
    this.parts.get(partId)?.setVolume(volume);
  }

  /**
   * Practice tempo, as a multiplier of the notated tempo.
   *
   * Slow practice is standard for by-ear work (§6.2). Driving it through the
   * transport's playback rate keeps every scheduled note and both loop points
   * correct with no rescheduling.
   */
  setTempoScale(scale: number): void {
    Tone.getTransport().bpm.value = this.score.tempoBpm * scale;
  }

  private transposeSemitones = 0;

  /**
   * Transpose playback by semitones. Notes already sounding are cut, so the
   * old key does not hang over the new one.
   */
  setTranspose(semitones: number): void {
    if (semitones === this.transposeSemitones) return;
    this.transposeSemitones = semitones;
    this.silenceAll();
  }

  private silenceAll(): void {
    for (const part of this.parts.values()) part.silence();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const transport = Tone.getTransport();
    transport.stop();
    for (const id of this.scheduledIds) transport.clear(id);
    transport.cancel();

    for (const part of this.parts.values()) part.dispose();
    this.parts.clear();
    this.master.dispose();
    this.limiter.dispose();
  }
}
