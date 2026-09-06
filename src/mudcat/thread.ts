/**
 * Mudcat HTML → posts.
 *
 * Kept separate from the network layer so it can be tested against saved
 * pages, and separate from `abc.ts` so that when the forum's markup changes
 * — it is a hand-built site of long standing — only this file has to move.
 *
 * The site's HTML is old-fashioned: uppercase tags, unclosed elements, tables
 * for layout. So this leans on shape (a post is preceded by a "Subject:" line
 * and an author) rather than on classes or ids, which it largely lacks.
 */

export interface ForumPost {
  author: string;
  /** Plain text of the post, with markup reduced to newlines. */
  text: string;
}

export interface ThreadRef {
  id: string;
  title: string;
  url: string;
}

/** Strip tags to plain text while keeping the line structure ABC depends on. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // <P> on this forum is used as a *separator*, often unclosed, so the
    // opening tag is the line break — not just the closing one. A tune
    // introduced as "ABC format:<P>X:1" depends on this: without it the `X:`
    // does not start a line and no tune is found at all.
    .replace(/<p\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h\d|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\r\n?/g, '\n');
}

/**
 * Pull thread links out of a search results page.
 *
 * Mudcat thread URLs carry a `threadid` query parameter, which is the one
 * stable handle on the page; the surrounding table markup is not.
 */
export function parseSearchResults(html: string): ThreadRef[] {
  const found = new Map<string, ThreadRef>();
  const anchor = /<a\b[^>]*href=["']?([^"'\s>]*thread\.cfm\?[^"'\s>]*)["']?[^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/gi, '&');
    const id = /threadid=(\d+)/i.exec(href)?.[1];
    if (id === undefined || found.has(id)) continue;

    // The anchor's own text is the bare word "Thread" on the results page; the
    // subject line follows it as plain text, as
    // `<A ...>Thread</A> - RE: Origin: Soon May the Wellerman Come - Oct 19 …`.
    // So read forward from the link and take the segment between the first
    // " - " and the trailing date, falling back to the anchor text elsewhere
    // (a thread linked from inside a post, say, where it is the real title).
    const anchorText = htmlToText(m[2]).trim().replace(/\s+/g, ' ');
    const following = htmlToText(html.slice(m.index + m[0].length, m.index + m[0].length + 300));
    const subject = /^\s*-\s*(.+?)\s+-\s+\w{3}\s+\d/.exec(following)?.[1];

    const title = (subject ?? anchorText).trim().replace(/\s+/g, ' ');
    if (title === '') continue;

    found.set(id, {
      id,
      title,
      url: `https://mudcat.org/thread.cfm?threadid=${id}`,
    });
  }

  return [...found.values()];
}

/**
 * Split a thread page into its individual posts.
 *
 * Posts on mudcat are separated by a header line naming the poster and date,
 * of the general form "Subject: … From: NAME - DATE". Where that pattern is
 * not found the whole page is returned as a single post, which still lets ABC
 * extraction work — it just costs the per-post author attribution.
 */
export function parseThreadPosts(html: string): ForumPost[] {
  const text = htmlToText(html);

  // "From: Someone - 12 Mar 04" begins each post's body.
  const header = /^\s*From:\s*(.+?)\s*(?:-\s*(?:PM\s*)?\d.*)?$/gim;
  const marks: { author: string; start: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = header.exec(text)) !== null) {
    marks.push({ author: m[1].trim(), start: m.index + m[0].length });
  }

  if (marks.length === 0) {
    const body = text.trim();
    return body === '' ? [] : [{ author: '', text: body }];
  }

  return marks.map((mark, i) => ({
    author: mark.author,
    text: text.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : undefined).trim(),
  }));
}
