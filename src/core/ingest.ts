import { unzipSync, strFromU8 } from 'fflate';
import type { Score } from './types';
import { parseMusicXml } from './musicxml';
import { childText, type XmlElement } from './xml';

/**
 * File ingest (execution doc §5.1).
 *
 * Recognises plain MusicXML and compressed `.mxl`. The doc calls out `.mxl`
 * specifically as the first thing a user will hand the app, because it is what
 * MuseScore and Sibelius export by default.
 */

/** A `.mxl` is a zip; every zip begins with this local file header signature. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Locate the score inside a compressed MusicXML container.
 *
 * The container declares its root file in `META-INF/container.xml`. That is
 * the path to trust, since an `.mxl` may legitimately hold several files
 * (cover images, linked parts). Where the container is missing or unreadable,
 * fall back to the first plausible score at the archive root.
 */
function extractFromMxl(bytes: Uint8Array, parseXml: (s: string) => XmlElement): string {
  const files = unzipSync(bytes);

  const containerRaw = files['META-INF/container.xml'];
  if (containerRaw !== undefined) {
    try {
      const container = parseXml(strFromU8(containerRaw));
      const rootfiles = container.child('rootfiles');
      const first = rootfiles?.child('rootfile') ?? null;
      const path = first?.attr('full-path') ?? null;
      if (path !== null && files[path] !== undefined) return strFromU8(files[path]);
    } catch {
      // Fall through to the heuristic below.
    }
  }

  // No usable container: take the first .xml/.musicxml that is not metadata.
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('META-INF/')) continue;
    if (/\.(musicxml|xml)$/i.test(name)) return strFromU8(data);
  }

  throw new Error('This .mxl file does not contain a MusicXML score.');
}

/** Strip a UTF-8 BOM, which trips strict XML parsers. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse an uploaded file into a `Score`.
 *
 * `parseXml` is injected so this works in both the browser (DOMParser) and
 * Node (the bundled reader) without either pulling in the other.
 */
export function parseScoreFile(
  fileName: string,
  bytes: ArrayBuffer,
  parseXml: (source: string) => XmlElement,
): Score {
  const view = new Uint8Array(bytes);
  if (view.length === 0) throw new Error('That file is empty.');

  const text = isZip(view)
    ? extractFromMxl(view, parseXml)
    : stripBom(new TextDecoder('utf-8').decode(view));

  if (text.trim() === '') throw new Error('That file contains no readable text.');
  if (!text.includes('<score-partwise') && !text.includes('<score-timewise')) {
    if (text.includes('<')) {
      throw new Error('That file is XML, but not a MusicXML score.');
    }
    throw new Error(
      'Unbraid reads MusicXML (.musicxml, .xml) and compressed MusicXML (.mxl).',
    );
  }

  const fallbackTitle = fileName.replace(/\.(musicxml|xml|mxl)$/i, '') || 'Untitled';
  const score = parseMusicXml(parseXml(text), fallbackTitle);

  // A score's own <movement-title> is sometimes just the export filename; the
  // uploaded name is no worse and usually better.
  if (/\.(mxl|musicxml|xml)$/i.test(score.title)) {
    score.title = fallbackTitle;
  }
  return score;
}

/** Whether the app is willing to attempt this filename. */
export function isSupportedScoreFile(name: string): boolean {
  return /\.(musicxml|xml|mxl)$/i.test(name);
}

/** Read `<credit-words>`-style metadata for display. Unused by the parser. */
export function scoreSubtitle(root: XmlElement): string | null {
  const id = root.child('identification');
  if (id === null) return null;
  for (const creator of id.children('creator')) {
    if (creator.attr('type') === 'composer') {
      const t = creator.text().trim();
      if (t !== '') return t;
    }
  }
  return childText(id, 'creator');
}
