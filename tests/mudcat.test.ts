import { describe, it, expect } from 'vitest';
import { extractTunes, scoreTunes, sanitizeAbc } from '../src/mudcat/abc';
import { parseSearchResults, parseThreadPosts } from '../src/mudcat/thread';
import { abcToMusicXml, parseKey } from '../src/mudcat/abcToMusicXml';
import { parseXml } from '../src/core/xmlParse';
import { parseMusicXml } from '../src/core/musicxml';

const SIMPLE = `X:1
T:Test Tune
M:4/4
L:1/4
K:C
CDEF|GABc|`;

describe('sanitizeAbc', () => {
  it('turns forum markup back into plain ABC', () => {
    const raw = 'X:1<br>T:Song &amp; Dance<br>K:D<br>DEF|';
    expect(sanitizeAbc(raw)).toBe('X:1\nT:Song & Dance\nK:D\nDEF|');
  });
});

describe('extractTunes', () => {
  it('finds a tune and reads its header', () => {
    const [tune] = extractTunes(SIMPLE, 0, 'someone');
    expect(tune.title).toBe('Test Tune');
    expect(tune.key).toBe('C');
    expect(tune.metre).toBe('4/4');
  });

  it('separates two tunes in one post', () => {
    const tunes = extractTunes(`${SIMPLE}\n\nX:2\nT:Second\nK:G\nGABc|`, 0, 'x');
    expect(tunes).toHaveLength(2);
    expect(tunes[1].title).toBe('Second');
  });

  it('stops at prose following the tune', () => {
    const tunes = extractTunes(`${SIMPLE}\n\nI learnt this from my grandmother in 1962.`, 0, 'x');
    expect(tunes[0].text).not.toContain('grandmother');
  });

  it('reads an empty T: as empty rather than taking the next line', () => {
    const [tune] = extractTunes('X:1\nT:\nM:4/4\nK:C\nCDEF|', 0, 'x');
    expect(tune.title).toBe('');
    expect(tune.metre).toBe('4/4');
  });

  it('counts voices', () => {
    const abc = 'X:1\nT:Four Part\nK:C\nV:1\nCDEF|\nV:2\nGABc|';
    expect(extractTunes(abc, 0, 'x')[0].voices).toBe(2);
  });
});

describe('scoreTunes', () => {
  it('ranks a title match above a non-match', () => {
    const tunes = [
      ...extractTunes('X:1\nT:Wellerman\nK:D\nDEF|', 0, 'a'),
      ...extractTunes('X:1\nT:Something Else\nK:D\nDEF|', 1, 'b'),
    ];
    const ranked = scoreTunes(tunes, { title: 'Wellerman' });
    expect(ranked[0].title).toBe('Wellerman');
    expect(ranked[0].reasons.join()).toContain('title matches');
  });

  it('prefers multi-voice arrangements', () => {
    const tunes = [
      ...extractTunes('X:1\nT:A\nK:C\nCDEF|', 0, 'a'),
      ...extractTunes('X:1\nT:A\nK:C\nV:1\nCDEF|\nV:2\nGABc|', 1, 'b'),
    ];
    expect(scoreTunes(tunes, {})[0].voices).toBe(2);
  });
});

describe('parseKey', () => {
  it('reads majors, minors and modes', () => {
    expect(parseKey('C').fifths).toBe(0);
    expect(parseKey('D').fifths).toBe(2);
    expect(parseKey('Bb').fifths).toBe(-2);
    expect(parseKey('Am').fifths).toBe(0);
    expect(parseKey('Dm').fifths).toBe(-1);
    expect(parseKey('Ddor').fifths).toBe(0);
  });

  it('applies key accidentals to the right steps', () => {
    expect(parseKey('D').alters.get('F')).toBe(1);
    expect(parseKey('D').alters.get('C')).toBe(1);
    expect(parseKey('F').alters.get('B')).toBe(-1);
  });
});

describe('abcToMusicXml', () => {
  it('produces MusicXML the app can parse', () => {
    const { musicXml } = abcToMusicXml(SIMPLE);
    const score = parseMusicXml(parseXml(musicXml));
    expect(score.parts).toHaveLength(1);
    expect(score.parts[0].events).toHaveLength(8);
  });

  it('gets pitches and octaves right', () => {
    const { musicXml } = abcToMusicXml(SIMPLE);
    const score = parseMusicXml(parseXml(musicXml));
    // C4=60 D E F G A B c5=72
    expect(score.parts[0].events.map((e) => e.midiPitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
  });

  it('applies the key signature to unmarked notes', () => {
    const { musicXml } = abcToMusicXml('X:1\nT:D\nM:4/4\nL:1/4\nK:D\nFGAB|');
    const score = parseMusicXml(parseXml(musicXml));
    // F is sharp in D major: 66 not 65.
    expect(score.parts[0].events[0].midiPitch).toBe(66);
  });

  it('honours explicit accidentals over the key', () => {
    const { musicXml } = abcToMusicXml('X:1\nT:D\nM:4/4\nL:1/4\nK:D\n=FGAB|');
    const score = parseMusicXml(parseXml(musicXml));
    expect(score.parts[0].events[0].midiPitch).toBe(65);
  });

  it('reads note durations', () => {
    const { musicXml } = abcToMusicXml('X:1\nM:4/4\nL:1/8\nK:C\nC2D4E|');
    const score = parseMusicXml(parseXml(musicXml));
    const [a, b, c] = score.parts[0].events;
    expect(a.durationBeats).toBeCloseTo(1);
    expect(b.durationBeats).toBeCloseTo(2);
    expect(c.durationBeats).toBeCloseTo(0.5);
  });

  it('splits V: voices into separate parts', () => {
    const abc = 'X:1\nT:Duet\nM:4/4\nL:1/4\nK:C\nV:1\nCDEF|\nV:2\nGABc|';
    const { musicXml, voiceIds } = abcToMusicXml(abc);
    expect(voiceIds).toEqual(['1', '2']);
    const score = parseMusicXml(parseXml(musicXml));
    expect(score.parts).toHaveLength(2);
  });

  it('stacks chord members on one onset', () => {
    const { musicXml } = abcToMusicXml('X:1\nM:4/4\nL:1/4\nK:C\n[CEG]D|');
    const score = parseMusicXml(parseXml(musicXml));
    const onsets = score.parts[0].events.map((e) => e.onsetBeats);
    expect(onsets[0]).toBe(0);
    expect(onsets[1]).toBe(0);
    expect(onsets[2]).toBe(0);
    expect(onsets[3]).toBe(1);
  });

  it('keeps consecutive chords on separate onsets', () => {
    const { musicXml } = abcToMusicXml('X:1\nM:4/4\nL:1/4\nK:C\n[CEG][DFA]|');
    const score = parseMusicXml(parseXml(musicXml));
    expect(score.parts[0].events.map((e) => e.onsetBeats)).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('warns when L: is missing rather than failing', () => {
    const { warnings } = abcToMusicXml('X:1\nM:4/4\nK:C\nCDEF|');
    expect(warnings.some((w) => w.message.includes('L:'))).toBe(true);
  });

  it('survives a tune with no header fields at all', () => {
    const { musicXml, warnings } = abcToMusicXml('X:1\nCDEF|');
    expect(warnings.length).toBeGreaterThan(0);
    expect(() => parseMusicXml(parseXml(musicXml))).not.toThrow();
  });
});

describe('parseSearchResults', () => {
  // Shaped after a real @NewSSResults.cfm page: the anchor text is the bare
  // word "Thread" and the subject follows it as plain text before the date.
  it('reads the subject that follows the link, not the anchor text', () => {
    const html =
      `<FONT SIZE="-1"><B>2.757</B> - \n` +
      `<A HREF="thread.cfm?threadid=13706#4230361">Thread</A> - ` +
      `RE: Origin: Soon May the Wellerman Come - Oct 19 2025 10:45PM -   &nbsp;  \n` +
      `<FONT COLOR="Gray">NonMember</FONT>`;
    const results = parseSearchResults(html);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: '13706',
      title: 'RE: Origin: Soon May the Wellerman Come',
      url: 'https://mudcat.org/thread.cfm?threadid=13706',
    });
  });

  it('falls back to the anchor text when no subject follows', () => {
    const html = `<a href="thread.cfm?threadid=12345&amp;messages=40">ABC: Sea shanties</a>`;
    expect(parseSearchResults(html)[0].title).toBe('ABC: Sea shanties');
  });

  it('does not repeat a thread linked twice', () => {
    const html = `<a href="/thread.cfm?threadid=1">One</a><a href="/thread.cfm?threadid=1">One again</a>`;
    expect(parseSearchResults(html)).toHaveLength(1);
  });
});

describe('parseThreadPosts', () => {
  it('splits a thread on its From: headers', () => {
    const html = `
      <p>Subject: ABC please<br>From: Alice - 12 Mar 04<br>Here is the tune:<br>X:1<br>K:D<br>DEF|</p>
      <p>From: Bob - 13 Mar 04<br>Thanks Alice!</p>`;
    const posts = parseThreadPosts(html);
    expect(posts).toHaveLength(2);
    expect(posts[0].author).toBe('Alice');
    expect(posts[0].text).toContain('X:1');
    expect(posts[1].author).toBe('Bob');
  });

  it('breaks lines on opening <P>, which the forum uses as a separator', () => {
    // Real threads write "ABC format:<P>  X:1<BR>..." with <P> unclosed, so an
    // opening-tag break is what puts `X:` at the start of its line.
    const posts = parseThreadPosts('<p>From: A - 1 Jan 20<br>ABC format:<P>  X:1<BR>T:Tune<BR>K:C<BR>CDEF|</p>');
    const tunes = extractTunes(posts[0].text, 0, posts[0].author);
    expect(tunes).toHaveLength(1);
    expect(tunes[0].title).toBe('Tune');
  });

  it('falls back to one post when no headers are recognisable', () => {
    const posts = parseThreadPosts('<p>X:1<br>K:C<br>CDEF|</p>');
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toContain('K:C');
  });
});

describe('end to end', () => {
  it('goes from thread HTML to a parseable score', () => {
    const html = `
      <p>From: Singer - 1 Jan 20<br>
      Here is the SATB version we do:<br>
      X:1<br>T:Wellerman<br>M:4/4<br>L:1/4<br>K:Dm<br>
      V:1<br>DEFG|ABcd|<br>
      V:2<br>ABcd|DEFG|<br></p>`;
    const posts = parseThreadPosts(html);
    const tunes = posts.flatMap((p, i) => extractTunes(p.text, i, p.author));
    const ranked = scoreTunes(tunes, { title: 'Wellerman', parts: 'SATB' }, posts.map((p) => p.text));

    expect(ranked[0].title).toBe('Wellerman');
    expect(ranked[0].voices).toBe(2);

    const score = parseMusicXml(parseXml(abcToMusicXml(ranked[0].text).musicXml));
    expect(score.parts).toHaveLength(2);
    expect(score.parts[0].events.length).toBeGreaterThan(0);
  });
});
