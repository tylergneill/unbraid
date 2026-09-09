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
import { extractTunes, scoreAndPartition, type TuneQuery } from './abc';
import { abcToMusicXml } from './abcToMusicXml';

const ORIGIN = 'https://mudcat.org';

/** A browser-ish UA. Mudcat serves a stripped page to unrecognised clients. */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Politeness gap between requests to the forum, in milliseconds.
 *
 * Measured: thread pages come back in ~30-300ms (mean ~96ms over a sample),
 * so this gap, not the server, is what paces a search. 400ms keeps us well
 * under the rate a person clicking through results would generate while
 * making a deeper search practical.
 */
const THROTTLE_MS = 400;

/**
 * Hard ceiling on threads read in one sweep.
 *
 * Reading a thread costs ~100ms plus the politeness gap, so a typical 40-hit
 * search is ~20s. This cap stops a pathologically broad query from turning
 * into a very long run of requests against a small volunteer-run forum.
 */
const MAX_THREADS = 60;

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
  // So keywords are deliberately *not* sent — they filter and rank the posts
  // we retrieve, which is a far better use of them than shrinking the search.
  const terms =
    query.title !== undefined && query.title.trim() !== ''
      ? query.title.trim()
      : (query.keywords ?? []).map((k) => k.text).find((t) => t.trim() !== '') ?? '';

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

          const asked =
            (query.title !== undefined && query.title.trim() !== '') ||
            (query.keywords ?? []).some((k) => k.text.trim() !== '');
          if (!asked) return json(res, 400, { error: 'Give at least a title or a keyword.' });

          try {
            const searchHtml = await runSearch(query);
            const all = parseSearchResults(searchHtml);

            if (all.length === 0) {
              return json(res, 200, { threads: [], tunes: [], matched: 0, note: 'No threads matched.' });
            }

            // Two-step by default: report how many threads matched and stop,
            // so the user can decide whether the wait is worth it. Mudcat's
            // ranking is about discussion, not notation, so there is no
            // sensible "best few" to read on their behalf.
            if (query.read !== true) {
              return json(res, 200, { threads: [], tunes: [], matched: all.length, counted: true });
            }

            const threads = all.slice(0, MAX_THREADS);

            // Stream one JSON object per line (NDJSON) as each thread is read.
            // A sweep of 40 threads is ~16s, which is far too long to stare at
            // a spinner, and the interesting part — whether threads are turning
            // up notation at all — is knowable long before the end.
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            const send = (event: unknown) => res.write(`${JSON.stringify(event)}\n`);

            send({ type: 'start', matched: all.length, reading: threads.length });

            let withAbc = 0;
            let suppressed = 0;

            for (const thread of threads) {
              let posts;
              try {
                posts = parseThreadPosts(await politeFetch(thread.url));
              } catch (e) {
                send({
                  type: 'thread',
                  thread: { ...thread, error: e instanceof Error ? e.message : 'failed' },
                  tunes: [],
                });
                continue;
              }

              const texts = posts.map((p) => p.text);
              const found = posts.flatMap((post, i) => extractTunes(post.text, i, post.author));
              const ranked = scoreAndPartition(found, query, texts);
              suppressed += ranked.suppressed.length;
              if (found.length > 0) withAbc += 1;

              send({
                type: 'thread',
                thread: { ...thread, tuneCount: ranked.tunes.length, hadAbc: found.length > 0 },
                tunes: ranked.tunes.map((tune) => ({ ...tune, thread })),
              });
            }

            send({ type: 'done', withAbc, suppressed });
            res.end();
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
