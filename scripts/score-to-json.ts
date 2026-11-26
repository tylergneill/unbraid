/**
 * Dump a MusicXML fixture's parts as JSON, for scripts/synth-choir.py.
 *
 *   npx tsx scripts/score-to-json.ts fixtures/bach-bwv269.musicxml > /tmp/bach.json
 *
 * Uses the app's own parser, so the synthesised performance is of exactly the
 * notes the tests treat as ground truth (repeats unrolled, ties merged).
 */
import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { parseScoreFile } from '../src/core/ingest';
import { parseXml } from '../src/core/xmlParse';

const path = process.argv[2];
const buf = readFileSync(path);
const score = parseScoreFile(basename(path), buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), parseXml);
console.log(JSON.stringify({ parts: score.parts.map((p) => ({ label: p.label, events: p.events })) }));
