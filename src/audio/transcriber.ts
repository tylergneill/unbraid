import modelJsonUrl from '@spotify/basic-pitch/model/model.json?url';
import modelWeightsUrl from '@spotify/basic-pitch/model/group1-shard1of1.bin?url';
import { TRANSCRIBER_SETTINGS, type HeardNote } from '../core/transcription';

/**
 * Listen to a recording and report the notes in it, entirely in the browser.
 *
 * Uses Spotify's Basic Pitch: a small (~900 KB) polyphonic pitch model that
 * runs on TensorFlow.js, on the GPU via WebGL where available. Like the rest
 * of Unbraid, nothing is uploaded anywhere; the recording is decoded, heard,
 * and stored on this machine.
 *
 * Basic Pitch answers "which pitches are sounding, when" but not "who is
 * singing them". Splitting its notes into parts is src/core/transcription.ts.
 *
 * TensorFlow.js is large, so it and the model are loaded on first use only;
 * opening a MusicXML score never pays for them.
 */

/** Basic Pitch's fixed input format: mono, 22.05 kHz. */
const MODEL_SAMPLE_RATE = 22050;

export type TranscribeStage =
  | { stage: 'decoding' }
  | { stage: 'loading-model' }
  | { stage: 'listening'; fraction: number }
  | { stage: 'splitting' };

/** Whether the app is willing to attempt this filename as a recording. */
export function isSupportedAudioFile(name: string): boolean {
  return /\.(mp3|m4a|mp4|aac|wav)$/i.test(name);
}

/**
 * Decode any format the browser understands, downmixed and resampled for the model.
 *
 * Decoding through an OfflineAudioContext at 22.05 kHz makes the browser do
 * the resampling; averaging the channels does the downmix.
 */
async function decodeForModel(bytes: ArrayBuffer): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, MODEL_SAMPLE_RATE);
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

  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels;
  }
  return mono;
}

/**
 * Load the bundled model.
 *
 * Vite gives each model file its own hashed URL, so the relative weight path
 * inside model.json no longer resolves. Fetching both files and handing them
 * to TensorFlow.js from memory sidesteps that.
 */
async function loadModel() {
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

/** Decode and transcribe a recording into individual heard notes. */
export async function transcribeRecording(
  bytes: ArrayBuffer,
  onProgress: (stage: TranscribeStage) => void,
): Promise<HeardNote[]> {
  onProgress({ stage: 'decoding' });
  const audio = await decodeForModel(bytes);
  if (audio.length < MODEL_SAMPLE_RATE / 2) throw new Error('That recording is too short to transcribe.');

  onProgress({ stage: 'loading-model' });
  const { BasicPitch, outputToNotesPoly, noteFramesToTime } = await import('@spotify/basic-pitch');
  const basicPitch = new BasicPitch(loadModel());

  const frames: number[][] = [];
  const onsets: number[][] = [];
  onProgress({ stage: 'listening', fraction: 0 });
  await basicPitch.evaluateModel(
    audio,
    (f, o) => {
      frames.push(...f);
      onsets.push(...o);
    },
    (fraction) => onProgress({ stage: 'listening', fraction }),
  );

  const s = TRANSCRIBER_SETTINGS;
  const notes = noteFramesToTime(
    outputToNotesPoly(
      frames,
      onsets,
      s.onsetThreshold,
      s.frameThreshold,
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
