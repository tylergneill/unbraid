/**
 * Regenerate a fixtures/audio/*.notes.json file from a recording.
 *
 *   npx tsx scripts/transcribe-fixture.ts in.mp3 fixtures/audio/out.notes.json [high]
 *
 * The optional last argument is the sensitivity ("normal", the default, or
 * "high"), as chosen on the app's recording tab.
 *
 * Runs the same Basic Pitch model, with the same TRANSCRIBER_SETTINGS, as the
 * app does in the browser, but on TensorFlow.js's plain-JS CPU backend, so it
 * is slow (a minute or two per minute of audio). Decoding goes through ffmpeg,
 * which must be on PATH, since Node has no Web Audio.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SENSITIVITY_THRESHOLDS, TRANSCRIBER_SETTINGS, type Sensitivity } from '../src/core/transcription';

const require = createRequire(import.meta.url);
const tf = require('@tensorflow/tfjs');
const { BasicPitch, outputToNotesPoly, noteFramesToTime } = require('@spotify/basic-pitch');

const [input, output, sensitivityArg = 'normal'] = process.argv.slice(2);
const sensitivity = sensitivityArg as Sensitivity;
if (!input || !output) {
  console.error('usage: npx tsx scripts/transcribe-fixture.ts <recording> <out.notes.json>');
  process.exit(1);
}

// Mono, 22.05 kHz, 32-bit float: Basic Pitch's input format.
const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', input, '-ac', '1', '-ar', '22050', '-f', 'f32le', '-'], {
  maxBuffer: 1 << 30,
});
const audio = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

const modelDir = require.resolve('@spotify/basic-pitch/model/model.json').replace(/model\.json$/, '');
const json = JSON.parse(readFileSync(modelDir + 'model.json', 'utf8'));
const weights = readFileSync(modelDir + 'group1-shard1of1.bin');
const model = tf.loadGraphModel(
  tf.io.fromMemory({
    modelTopology: json.modelTopology,
    weightSpecs: json.weightsManifest[0].weights,
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
    format: json.format,
    generatedBy: json.generatedBy,
    convertedBy: json.convertedBy,
    signature: json.signature,
  }),
);

const frames: number[][] = [];
const onsets: number[][] = [];
await new BasicPitch(model).evaluateModel(
  audio,
  (f: number[][], o: number[][]) => {
    frames.push(...f);
    onsets.push(...o);
  },
  () => {},
);

const s = TRANSCRIBER_SETTINGS;
const t = SENSITIVITY_THRESHOLDS[sensitivity];
const round = (x: number) => Math.round(x * 1000) / 1000;
const notes = noteFramesToTime(
  outputToNotesPoly(frames, onsets, t.onsetThreshold, t.frameThreshold, s.minNoteFrames, s.inferOnsets, s.maxFreqHz, s.minFreqHz, s.melodiaTrick),
).map((n: { startTimeSeconds: number; durationSeconds: number; pitchMidi: number; amplitude: number }) => ({
  startSec: round(n.startTimeSeconds),
  durationSec: round(n.durationSeconds),
  midiPitch: n.pitchMidi,
  amplitude: round(n.amplitude),
}));
notes.sort((a: { startSec: number }, b: { startSec: number }) => a.startSec - b.startSec);

writeFileSync(output, JSON.stringify(notes) + '\n');
console.log(`${notes.length} notes → ${output}`);
