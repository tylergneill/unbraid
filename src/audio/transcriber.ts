import modelJsonUrl from '@spotify/basic-pitch/model/model.json?url';
import modelWeightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url';
import {
  SENSITIVITY_THRESHOLDS,
  TRANSCRIBER_SETTINGS,
  type HeardNote,
  type HeardStem,
  type Sensitivity,
} from '../core/transcription';

/**
 * Listen to a recording and report the notes in it, entirely in the browser.
 *
 * Two stages, the first optional:
 *
 * 1. **Separate** (recordings with instruments): Demucs splits the mix into
 *    vocals, bass, other instruments, and drums, by timbre. See stems.ts.
 * 2. **Hear notes**: Spotify's Basic Pitch, a small (~900 KB) polyphonic
 *    pitch model on TensorFlow.js (GPU via WebGL where available), runs once
 *    per stem, or once on the whole mix for a voices-only recording.
 *
 * Basic Pitch answers "which pitches are sounding, when" but not "who is
 * singing them". Splitting its notes into parts is src/core/transcription.ts.
 *
 * Nothing is uploaded anywhere: the recording is decoded, separated, heard,
 * and stored on this machine. Both models, and the libraries that run them,
 * load on first use only, so opening a MusicXML score never pays for them.
 */

/** Basic Pitch's fixed input format: mono, 22.05 kHz. */
const PITCH_SAMPLE_RATE = 22050;

/** Demucs's fixed input format: stereo, 44.1 kHz. Mirrors stems.ts, which loads lazily. */
const STEM_SAMPLE_RATE = 44100;

/** A stem quieter than this (RMS) holds only separation bleed; it is not transcribed. */
const SILENT_STEM_RMS = 0.005;

export interface TranscribeOptions {
  /** Separate vocals from instruments first. Off for unaccompanied singing. */
  separateInstruments: boolean;
  sensitivity: Sensitivity;
}

export type TranscribeStage =
  | { stage: 'decoding' }
  | { stage: 'loading-separator'; fraction: number | null }
  | { stage: 'separating'; fraction: number | null }
  | { stage: 'loading-model' }
  | { stage: 'listening'; stem: HeardStem['kind']; fraction: number }
  | { stage: 'splitting' };

/** Whether the app is willing to attempt this filename as a recording. */
export function isSupportedAudioFile(name: string): boolean {
  return /\.(mp3|m4a|mp4|aac|wav)$/i.test(name);
}

/**
 * Decode any format the browser understands, at the given sample rate.
 *
 * Decoding through an OfflineAudioContext makes the browser do the resampling.
 */
async function decode(bytes: ArrayBuffer, sampleRate: number): Promise<Float32Array[]> {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  let buffer: AudioBuffer;
  try {
    // decodeAudioData detaches its argument, so hand it a copy and keep the original.
    buffer = await context.decodeAudioData(bytes.slice(0));
  } catch {
    throw new Error(
      'That recording could not be decoded. MP3 and M4A work in every current browser; ' +
        'if this is one, it may be damaged or DRM-protected.',
    );
  }
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

/** Average channels into one. */
function downmix(channels: Float32Array[]): Float32Array {
  const mono = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

/** Resample one channel with the browser's own resampler. */
async function resample(samples: Float32Array, from: number, to: number): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, Math.ceil((samples.length * to) / from), to);
  const buffer = context.createBuffer(1, samples.length, from);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return (await context.startRendering()).getChannelData(0);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/**
 * The bundled pitch model.
 *
 * Vite gives each model file its own hashed URL, so the relative weight path
 * inside model.json no longer resolves. Fetching both files and handing them
 * to TensorFlow.js from memory sidesteps that.
 */
let pitchModel: ReturnType<typeof loadPitchModelOnce> | null = null;

/** The pitch model, loaded once per page and shared by every stem. */
function loadPitchModel() {
  if (pitchModel === null) {
    pitchModel = loadPitchModelOnce().catch((error: unknown) => {
      pitchModel = null;
      throw error;
    });
  }
  return pitchModel;
}

async function loadPitchModelOnce() {
  const tf = await import('@tensorflow/tfjs');
  await tf.ready();
  const [json, weights] = await Promise.all([
    fetch(modelJsonUrl).then((r) => r.json()),
    fetch(modelWeightsUrl).then((r) => r.arrayBuffer()),
  ]);
  const handler = tf.io.fromMemory({
    modelTopology: json.modelTopology,
    weightSpecs: json.weightsManifest[0].weights,
    weightData: weights,
    format: json.format,
    generatedBy: json.generatedBy,
    convertedBy: json.convertedBy,
    signature: json.signature,
  });
  return tf.loadGraphModel(handler);
}

/** Run Basic Pitch over mono 22.05 kHz audio. */
async function hearNotes(
  audio: Float32Array,
  sensitivity: Sensitivity,
  onFraction: (fraction: number) => void,
): Promise<HeardNote[]> {
  const { BasicPitch, outputToNotesPoly, noteFramesToTime } = await import('@spotify/basic-pitch');
  const basicPitch = new BasicPitch(loadPitchModel());

  const frames: number[][] = [];
  const onsets: number[][] = [];
  await basicPitch.evaluateModel(
    audio,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    onFraction,
  );

  const s = TRANSCRIBER_SETTINGS;
  const t = SENSITIVITY_THRESHOLDS[sensitivity];
  const notes = noteFramesToTime(
    outputToNotesPoly(
      frames,
      onsets,
      t.onsetThreshold,
      t.frameThreshold,
      s.minNoteFrames,
      s.inferOnsets,
      s.maxFreqHz,
      s.minFreqHz,
      s.melodiaTrick,
    ),
  );

  return notes.map((n) => ({
    startSec: n.startTimeSeconds,
    durationSec: n.durationSeconds,
    midiPitch: n.pitchMidi,
    amplitude: n.amplitude,
  }));
}

/** Decode, optionally separate, and transcribe a recording, one note list per stem. */
export async function transcribeRecording(
  bytes: ArrayBuffer,
  options: TranscribeOptions,
  onProgress: (stage: TranscribeStage) => void,
): Promise<HeardStem[]> {
  onProgress({ stage: 'decoding' });

  if (!options.separateInstruments) {
    const audio = downmix(await decode(bytes, PITCH_SAMPLE_RATE));
    if (audio.length < PITCH_SAMPLE_RATE / 2) throw new Error('That recording is too short to transcribe.');
    onProgress({ stage: 'loading-model' });
    const notes = await hearNotes(audio, options.sensitivity, (fraction) =>
      onProgress({ stage: 'listening', stem: 'mix', fraction }),
    );
    return [{ kind: 'mix', notes }];
  }

  const channels = await decode(bytes, STEM_SAMPLE_RATE);
  if (channels[0].length < STEM_SAMPLE_RATE / 2) throw new Error('That recording is too short to transcribe.');

  const { separateStems } = await import('./stems');
  const stems = await separateStems(channels, (stage, fraction) =>
    onProgress(stage === 'loading' ? { stage: 'loading-separator', fraction } : { stage: 'separating', fraction }),
  );

  onProgress({ stage: 'loading-model' });
  const out: HeardStem[] = [];
  // Vocals first: they are what the user came for.
  for (const kind of ['vocals', 'bass', 'other'] as const) {
    const mono = downmix(stems[kind]);
    if (rms(mono) < SILENT_STEM_RMS) continue;
    const audio = await resample(mono, STEM_SAMPLE_RATE, PITCH_SAMPLE_RATE);
    const notes = await hearNotes(audio, options.sensitivity, (fraction) =>
      onProgress({ stage: 'listening', stem: kind, fraction }),
    );
    out.push({ kind, notes });
  }
  return out;
}
