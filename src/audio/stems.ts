import * as ort from 'onnxruntime-web';
import modelUrl from 'demucs/htdemucs.onnx?url';
import { separateTracks } from '../vendor/demucs/apply.js';
import { ONNXHTDemucs } from 'demucs/dist/onnx-htdemucs.js';

/**
 * Split a mixed recording into drums, bass, other, and vocals, in the browser.
 *
 * Uses Meta's HTDemucs v4 via Kevin Gibbons's JavaScript port (the `demucs`
 * npm package, MIT code). The model weights (~170 MB) ship inside that npm
 * package, so `npm install` puts them on disk and the app serves them to
 * itself: separating a song never touches the network. Inference runs on
 * ONNX Runtime Web, on the GPU through WebGPU where the browser has it
 * (Chrome, Edge, Safari 26) and on the CPU through WebAssembly otherwise,
 * which is several times slower.
 *
 * This is the step that brings *timbre* into Unbraid. The pitch model hears
 * only pitches; Demucs separates by what things sound like, so a bass guitar
 * and a bass singer end up in different stems even when they share notes.
 *
 * The `demucs` package imports `onnxruntime-node`. package.json overrides
 * that dependency with onnxruntime-web, and vite.config.ts aliases the import
 * to it, so the package and this file share one ONNX Runtime instance.
 *
 * The chunked overlap-add is vendored (src/vendor/demucs/apply.js) to fix
 * a NaN that otherwise punches 56 ms holes into the vocals every 5.85 s.
 *
 * Licence note: the weights are derived from Meta's, which the port's author
 * describes as for personal and research use only. Unbraid is non-commercial.
 */

/** Demucs's fixed input format: stereo, 44.1 kHz. */
export const DEMUCS_SAMPLE_RATE = 44100;

export type StemName = 'drums' | 'bass' | 'other' | 'vocals';

let modelPromise: Promise<ONNXHTDemucs> | null = null;

/**
 * Load the separation model once per page.
 *
 * Reported in bytes as it streams in, since it is large enough that a silent
 * wait would look like a hang.
 */
function loadModel(onDownload: (fraction: number | null) => void): Promise<ONNXHTDemucs> {
  if (modelPromise === null) {
    modelPromise = (async () => {
      // The demucs package sets wasmPaths to './' when imported, for its own
      // demo page. Under Vite that points at files that do not exist; unset,
      // ONNX Runtime finds its .wasm next to its own module, where Vite puts it.
      ort.env.wasm.wasmPaths = undefined;
      // The ONNX Runtime threading backend needs SharedArrayBuffer, which a
      // page only gets when served cross-origin isolated. Unbraid is not, so
      // the CPU fallback runs single-threaded rather than failing.
      if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

      const response = await fetch(modelUrl);
      if (!response.ok || response.body === null) {
        throw new Error('The instrument-separation model could not be loaded. Try `npm install` again.');
      }
      const total = Number(response.headers.get('content-length')) || 0;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onDownload(total > 0 ? loaded / total : null);
      }
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return ONNXHTDemucs.init(bytes.buffer);
    })().catch((error: unknown) => {
      // Let the next attempt retry rather than reuse a failure.
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

/**
 * Separate a stereo 44.1 kHz recording into its four stems.
 *
 * `channels` may be mono (one array); it is duplicated, since the model
 * expects two.
 */
export async function separateStems(
  channels: Float32Array[],
  onProgress: (stage: 'loading' | 'separating', fraction: number | null) => void,
): Promise<Record<StemName, Float32Array[]>> {
  onProgress('loading', null);
  const model = await loadModel((fraction) => onProgress('loading', fraction));

  const stereo = channels.length >= 2 ? channels.slice(0, 2) : [channels[0], channels[0]];
  onProgress('separating', 0);
  const tracks = await separateTracks(
    model,
    { channelData: stereo, sampleRate: DEMUCS_SAMPLE_RATE },
    (step, total) => onProgress('separating', total > 0 ? step / total : null),
  );

  // Any sample still non-finite (only possible at the very end) becomes silence.
  for (const track of Object.values(tracks)) {
    for (const channel of track.channelData) {
      for (let i = 0; i < channel.length; i++) if (!Number.isFinite(channel[i])) channel[i] = 0;
    }
  }

  return {
    drums: tracks.drums.channelData,
    bass: tracks.bass.channelData,
    other: tracks.other.channelData,
    vocals: tracks.vocals.channelData,
  };
}
