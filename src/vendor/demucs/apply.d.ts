/** Types for the vendored apply.js; see the header there. */
import type { RawAudio } from 'demucs/dist/wav-utils.js';
import type { ONNXHTDemucs } from 'demucs/dist/onnx-htdemucs.js';
export type ProgressCallback = (step: number, total: number) => void;
export declare function separateTracks(model: ONNXHTDemucs, rawAudio: RawAudio, progressCallback?: ProgressCallback, overlap?: number): Promise<Record<string, RawAudio>>;
