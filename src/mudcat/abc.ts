/**
 * ABC notation extraction and ranking.
 *
 * Mudcat threads are prose with tunes embedded in them. A post may hold no
 * ABC, one tune, or a whole set; the tune may be fenced in <pre>, indented,
 * or simply typed inline mid-sentence. So extraction is deliberately lenient
 * about surroundings and strict only about the one thing ABC guarantees: a
 * tune starts at an `X:` reference field on its own line.
 *
 * Nothing here touches the network or the DOM, so it is testable against
 * saved thread HTML and is the part of the pipeline worth trusting.
 */

/** Fields we lift out of a tune header for display and ranking. */
export interface AbcTune {
  /** The tune body, from `X:` to its terminator, with forum artefacts gone. */
  text: string;
  /** `X:` reference number, as written. */
  reference: string;
  /** `T:` title, first one only. Empty when the tune has no title field. */
  title: string;
  /** `M:` metre, e.g. "4/4". Empty when absent. */
  metre: string;
  /** `K:` key, e.g. "Dm". Empty when absent — though ABC requires it. */
  key: string;
  /** `L:` default note length. Empty when absent (a common forum mistake). */
  unitLength: string;
  /** Number of `V:` voice declarations; >1 suggests a real arrangement. */
  voices: number;
  /** Index of the post this came from, 0-based. */
  postIndex: number;
  /** Author of the post, where the thread markup gave us one. */
  author: string;
}

/** A tune plus why the ranker put it where it did. */
export interface ScoredTune extends AbcTune {
  score: number;
  /** Human-readable reasons, shown in the wizard so the pick is not a mystery. */
  reasons: string[];
  /**
   * Requirements this tune fails, e.g. "only one voice".
   *
   * Non-empty means the tune is filtered out of the results; the wizard
   * reports how many were removed so an empty list is explicable.
   */
  missing: string[];
  /**
   * `score` as a 0-100 percentage of what this query could award.
   *
   * The raw score is unbounded and its scale shifts with the query — a search
   * with three keywords can earn far more than one with none — so the raw
   * number means nothing to a reader. This divides by the best a tune could
   * have done *for this particular query*, which is comparable across
   * searches and is what the UI shows.
   */
  match: number;
}

/** One free-text term to look for, and whether it is a hard requirement. */
export interface Keyword {
  /** e.g. "harmony", "SATB", "Seekers" — matched against the tune and its post. */
  text: string;
  /** When true, a tune that does not match is excluded rather than demoted. */
  required: boolean;
}

/**
 * What the user is looking for.
 *
 * `multiPart` is separate from the keywords because it is structural rather
 * than textual: it asks whether the ABC actually declares more than one voice,
 * which is the thing that decides whether a tune is usable in this app at all.
 * A post saying the word "harmony" is much weaker evidence than a tune that
 * contains two `V:` blocks.
 */
export interface TuneQuery {
  title?: string;
  keywords?: Keyword[];
  /** Require more than one voice. Defaults to true; the app is for harmony. */
  multiPart?: boolean;
  /** False (the default) counts matching threads only; true reads them. */
  read?: boolean;
}

/**
 * Strip the forum's own markup out of a candidate block.
 *
 * Mudcat posts are HTML, and ABC pasted into them picks up `<br>` line breaks
 * and HTML entities. Those must go before the text is valid ABC, and they are
 * the single most common reason a copied tune fails to compile.
 */
export function sanitizeAbc(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|pre|code|span|font|b|i|em|strong)\b[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    // &amp; last, so "&amp;lt;" does not become a tag.
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n')
    // Strip leading and trailing whitespace from every line.
    //
    // ABC anchors its fields to the start of a line, so `  V:1` is not a voice
    // declaration — it is a line of notation-shaped prose. Posts arrive with
    // ragged indentation all the time, both because writers indent tunes and
    // because the surrounding HTML was pretty-printed, and the raggedness is
    // per-line rather than a shared block indent. ABC itself attaches no
    // meaning to leading whitespace, so removing it costs nothing.
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}


/**
 * Header field lookup: first `LETTER:` line, value trimmed.
 *
 * `(.*)` rather than `(.+)`: an empty field is common — posters routinely
 * leave `T:` blank — and must read as empty, not fall through to match a
 * later line and report the *next* field's value as the title.
 */
function field(abc: string, letter: string): string {
  const m = new RegExp(`^${letter}:[ \\t]*(.*)$`, 'm').exec(abc);
  return m === null ? '' : m[1].trim();
}

/**
 * True when a line plausibly belongs to a tune.
 *
 * Used to decide where a tune ends. ABC has no terminator, so a tune runs
 * until something that is clearly prose again. An information field
 * (`K:`, `w:` …) or a line of notation continues it; a sentence ends it.
 */
function looksLikeAbcLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  // An information field: single letter, colon. `w:` carries lyrics.
  if (/^[A-Za-z]:/.test(t)) return true;
  // An inline field opening the line, `[V:1] B2B2 ...`. Multi-voice scores are
  // routinely written this way — one line per voice, per system — so missing
  // it truncates precisely the arrangements this app most wants.
  if (/^\[[A-Za-z]:/.test(t)) return true;
  // A comment or directive.
  if (t.startsWith('%')) return true;
  // Notation: made of note letters, accidentals, bars, durations, groupings.
  // Prose fails this because of its lowercase runs and punctuation.
  return /^[A-Ga-gxzZ0-9\s|\][:_^='",()<>/\\.\-~{}*+!$&]+$/.test(t);
}

/**
 * Pull every ABC tune out of one post's text.
 *
 * The anchor is `X:` at the start of a line, per the ABC standard. From there
 * the tune extends while lines still look like ABC, tolerating single blank
 * lines inside a tune (common between the header and the body) but stopping
 * at a blank line followed by prose.
 */
export function extractTunes(postText: string, postIndex: number, author: string): AbcTune[] {
  const text = sanitizeAbc(postText);
  const lines = text.split('\n');
  const tunes: AbcTune[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!/^X:\s*\S/.test(lines[i].trim())) continue;

    const body: string[] = [lines[i]];
    let j = i + 1;
    let pendingBlank = 0;

    while (j < lines.length) {
      const line = lines[j];

      // A second X: starts the next tune in a set; stop before it.
      if (/^X:\s*\S/.test(line.trim())) break;

      if (line.trim() === '') {
        pendingBlank += 1;
        // Two blank lines end a tune outright.
        if (pendingBlank >= 2) break;
        j += 1;
        continue;
      }

      if (!looksLikeAbcLine(line)) break;

      // A single blank line inside the tune is kept as a separator.
      if (pendingBlank === 1) body.push('');
      pendingBlank = 0;
      body.push(line);
      j += 1;
    }

    const abc = body.join('\n').trim();
    // A bare `X:` with no key and no notation is a false positive.
    if (!/^[A-Za-z]:/m.test(abc.split('\n').slice(1).join('\n')) && body.length < 3) {
      i = j - 1;
      continue;
    }

    tunes.push({
      text: abc,
      reference: field(abc, 'X'),
      title: field(abc, 'T'),
      metre: field(abc, 'M'),
      key: field(abc, 'K'),
      unitLength: field(abc, 'L'),
      voices: countVoices(abc),
      postIndex,
      author,
    });

    i = j - 1;
  }

  return tunes;
}

/**
 * Count the distinct voices a tune declares.
 *
 * Both spellings count: a `V:1` header line, and the inline `[V:1]` that opens
 * a line of notation. They are usually both present — the header declares the
 * voice and names it, the inline form marks which voice a line belongs to —
 * so the ids are deduplicated rather than added up.
 */
function countVoices(abc: string): number {
  const ids = new Set<string>();
  for (const m of abc.matchAll(/^V:\s*(\S+)/gm)) ids.add(m[1]);
  for (const m of abc.matchAll(/\[V:\s*([^\]\s]+)/g)) ids.add(m[1]);
  return ids.size;
}

/** Case- and punctuation-insensitive containment. */
function loosely(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const h = norm(haystack);
  const n = norm(needle);
  return n !== '' && h.includes(n);
}

/**
 * Score every tune, keeping those that fail a requirement.
 *
 * The weights encode a simple belief: a title match is strong evidence, a
 * multi-voice tune is what someone practising harmony actually wants, and a
 * tune missing `K:` is likely to be a fragment quoted mid-discussion.
 * Reasons are surfaced in the UI so a wrong pick is visibly wrong.
 */
function scoreAll(tunes: AbcTune[], query: TuneQuery, postText: string[] = []): ScoredTune[] {
  // Harmony is the point of the app, so multi-part is required unless the user
  // deliberately turns it off.
  const wantsMultiPart = query.multiPart !== false;
  const keywords = (query.keywords ?? []).filter((k) => k.text.trim() !== '');

  const scored = tunes.map((tune) => {
    let score = 0;
    const reasons: string[] = [];
    const missing: string[] = [];
    const context = postText[tune.postIndex] ?? '';

    if (query.title !== undefined && query.title.trim() !== '') {
      if (loosely(tune.title, query.title)) {
        score += 50;
        reasons.push(`title matches “${query.title}”`);
      } else if (loosely(context, query.title)) {
        score += 15;
        reasons.push('title appears in the post');
      }
    }

    for (const keyword of keywords) {
      const hit = loosely(context, keyword.text) || loosely(tune.text, keyword.text);
      if (hit) {
        score += keyword.required ? 30 : 20;
        reasons.push(`mentions “${keyword.text}”`);
      } else if (keyword.required) {
        missing.push(`no “${keyword.text}”`);
      }
    }

    if (tune.voices > 1) {
      score += 25;
      reasons.push(`${tune.voices} voices`);
    } else if (wantsMultiPart) {
      // A single-voice tune cannot give the user parts to practise against, so
      // it fails the requirement outright rather than merely scoring low.
      missing.push('only one voice');
    }

    // Completeness. K: is required by the standard; L: is routinely forgotten
    // and its absence means the converter has to guess note lengths.
    if (tune.key !== '') {
      score += 10;
    } else {
      score -= 15;
      reasons.push('no key field');
    }
    if (tune.unitLength === '') reasons.push('no L: field (lengths inferred)');

    // Prefer substance over a two-bar fragment quoted in passing.
    const noteLines = tune.text.split('\n').filter((l) => !/^[A-Za-z]:/.test(l.trim())).length;
    score += Math.min(noteLines, 12);

    if (/^w:/m.test(tune.text)) {
      score += 8;
      reasons.push('has lyrics');
    }

    return { ...tune, score, reasons, missing };
  });

  // The ceiling for this query: every keyword hit, a title match, multiple
  // voices, a key, a full-length tune and lyrics.
  const ceiling =
    (query.title !== undefined && query.title.trim() !== '' ? 50 : 0) +
    keywords.reduce((total, k) => total + (k.required ? 30 : 20), 0) +
    25 + // more than one voice
    10 + // has a key field
    12 + // a substantial tune body
    8; // has lyrics

  return scored.map((tune) => ({
    ...tune,
    match: Math.max(0, Math.min(100, Math.round((tune.score / ceiling) * 100))),
  }));
}

/**
 * Rank tunes, dropping any that fail a requirement.
 */
export function scoreTunes(tunes: AbcTune[], query: TuneQuery, postText: string[] = []): ScoredTune[] {
  return scoreAndPartition(tunes, query, postText).tunes;
}

/**
 * Rank tunes, and report what the requirements removed.
 *
 * Separate from `scoreTunes` so the caller can tell "no ABC in these threads"
 * apart from "ABC found, but none of it multi-part" — two results that look
 * identical in the UI but mean very different things to the user.
 */
export function scoreAndPartition(
  tunes: AbcTune[],
  query: TuneQuery,
  postText: string[] = [],
): { tunes: ScoredTune[]; suppressed: ScoredTune[] } {
  const all = scoreAll(tunes, query, postText);
  return {
    tunes: all.filter((t) => t.missing.length === 0).sort((a, b) => b.score - a.score),
    suppressed: all.filter((t) => t.missing.length > 0).sort((a, b) => b.score - a.score),
  };
}
