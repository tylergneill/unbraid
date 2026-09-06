/**
 * Dev-server routes for the mudcat wizard.
 *
 * The browser cannot fetch mudcat.org directly — no CORS headers — so the
 * fetching happens here, in the Vite dev server's Node process, and the app
 * talks to same-origin `/api/mudcat/*` routes.
 *
 * This is a *dev-only* plugin (`apply: 'serve'`). A production build has no
 * server to host these routes, so the wizard is hidden there rather than
 * offered and broken; see `Landing.tsx`.
 */

import type { Connect, Plugin } from 'vite';
import type { ServerResponse } from 'node:http';
import { parseSearchResults, parseThreadPosts } from './thread';
import { extractTunes, scoreTunes, type TuneQuery } from './abc';
import { abcToMusicXml } from './abcToMusicXml';

const ORIGIN = 'https://mudcat.org';

/** A browser-ish UA. Mudcat serves a stripped page to unrecognised clients. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** Politeness gap between requests to the forum, in milliseconds. */
const THROTTLE_MS = 900;

/** How many threads deep to look before giving up on a query. */
const MAX_THREADS = 5;

let lastFetch = 0;

/**
 * Fetch one page, never faster than the throttle allows.
 *
 * Mudcat is a small volunteer-run forum; the wizard reads at most a handful of
 * pages per search and waits between them rather than fanning out in parallel.
 */
async function politeFetch(
  url: string,
  options: { method?: string; body?: URLSearchParams } = {},
): Promise<string> {
  const wait = Math.max(0, THROTTLE_MS - (Date.now() - lastFetch));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    body: options.body,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      ...(options.body !== undefined
        ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`mudcat.org returned ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

async function readJsonBody(req: Connect.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

/**
 * Run the forum's search.
 *
 * Mudcat's search is a POST to `@NewSSResults.cfm` with a `query` field, as
 * the form on the front page does it; there is no documented GET equivalent.
 * `ForumSearch` keeps the results to forum threads, which are the only pages
 * that carry ABC.
 */
async function runSearch(query: TuneQuery): Promise<string> {
  // Search on the title alone.
  //
  // Mudcat's search ANDs its terms, and every extra word collapses the result
  // set hard: "wellerman" returns nine threads, "wellerman abc" returns one.
  // So artist and parts are deliberately *not* sent — they are ranking signals
  // applied to the posts we retrieve, not filters applied to the search.
  const terms = [query.title, query.artist, query.parts]
    .filter((t): t is string => t !== undefined && t.trim() !== '')[0] ?? '';

  const body = new URLSearchParams({
    query: terms,
    DTSearch: '1',
    ForumSearch: '1',
    TheURL: ORIGIN,
  });

  return politeFetch(`${ORIGIN}/@NewSSResults.cfm`, { method: 'POST', body });
}

export function mudcatPlugin(): Plugin {
  return {
    name: 'unbraid-mudcat',
    apply: 'serve',

    configureServer(server) {
      /** Search, then walk the top threads collecting and ranking tunes. */
      server.middlewares.use('/api/mudcat/search', (req, res) => {
        void (async () => {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

          let query: TuneQuery;
          try {
            query = (await readJsonBody(req)) as TuneQuery;
          } catch {
            return json(res, 400, { error: 'Malformed request body' });
          }

          const asked = [query.title, query.artist, query.parts].some(
            (v) => v !== undefined && v.trim() !== '',
          );
          if (!asked) return json(res, 400, { error: 'Give at least a title, artist or part.' });

          try {
            const searchHtml = await runSearch(query);
            const threads = parseSearchResults(searchHtml).slice(0, MAX_THREADS);

            if (threads.length === 0) {
              return json(res, 200, { threads: [], tunes: [], note: 'No threads matched.' });
            }

            const tunes = [];
            const visited = [];

            for (const thread of threads) {
              let posts;
              try {
                posts = parseThreadPosts(await politeFetch(thread.url));
              } catch (e) {
                visited.push({ ...thread, error: e instanceof Error ? e.message : 'failed' });
                continue;
              }

              const texts = posts.map((p) => p.text);
              const found = posts.flatMap((post, i) => extractTunes(post.text, i, post.author));
              const ranked = scoreTunes(found, query, texts);

              visited.push({ ...thread, tuneCount: ranked.length });
              for (const tune of ranked) tunes.push({ ...tune, thread });
            }

            tunes.sort((a, b) => b.score - a.score);
            json(res, 200, { threads: visited, tunes: tunes.slice(0, 25) });
          } catch (e) {
            json(res, 502, {
              error: e instanceof Error ? e.message : 'Could not reach mudcat.org',
            });
          }
        })();
      });

      /** Convert one chosen ABC block. Kept separate so the user can edit first. */
      server.middlewares.use('/api/mudcat/convert', (req, res) => {
        void (async () => {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

          try {
            const body = (await readJsonBody(req)) as { abc?: string };
            if (typeof body.abc !== 'string' || body.abc.trim() === '') {
              return json(res, 400, { error: 'No ABC supplied' });
            }
            json(res, 200, abcToMusicXml(body.abc));
          } catch (e) {
            json(res, 400, {
              error: e instanceof Error ? e.message : 'That ABC could not be converted.',
            });
          }
        })();
      });
    },
  };
}
