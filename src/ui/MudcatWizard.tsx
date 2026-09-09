import { useCallback, useRef, useState } from 'react';

/**
 * Mudcat wizard — find an arrangement on the forum and bring it in.
 *
 * Three steps, one screen each: describe the tune, pick from what came back,
 * check the ABC before it is converted. The check step matters more than it
 * looks: forum ABC is written by hand and is frequently a little wrong, so
 * the user gets to see and fix the source rather than being handed a silent
 * mis-transcription.
 *
 * The result is a File, handed to exactly the same import path as a dropped
 * score. The wizard has no privileged route into the app.
 */

interface ThreadRef {
  id: string;
  title: string;
  url: string;
  tuneCount?: number;
  hadAbc?: boolean;
  error?: string;
}

/** Live counts while a sweep is running. */
interface Progress {
  read: number;
  total: number;
  withAbc: number;
}

interface FoundTune {
  text: string;
  title: string;
  key: string;
  metre: string;
  voices: number;
  author: string;
  score: number;
  reasons: string[];
  /** Requirements this tune fails; non-empty means it is a last resort. */
  missing: string[];
  /** 0-100, how well this tune answers the query. */
  match: number;
  thread: ThreadRef;
}

interface Keyword {
  /** Stable identity, so editing one row does not remount the others. */
  id: number;
  text: string;
  required: boolean;
}

interface Warning {
  message: string;
  line?: number;
}

type Step = 'query' | 'results' | 'review';

/**
 * What to call a tune whose ABC carries no `T:` field.
 *
 * Posters leave `T:` blank all the time, but the thread they posted it in is
 * almost always named after the song — so the thread subject is a far better
 * answer than "Untitled". Forum routing prefixes ("RE:", "Lyr/Tune Add:") are
 * conversation bookkeeping rather than part of the name, so they come off.
 */
function tuneName(tune: FoundTune): string {
  if (tune.title !== '') return tune.title;

  const subject = tune.thread.title
    .replace(/^\s*(?:RE|Re):\s*/, '')
    .replace(/^\s*(?:Lyr|Tune|Chord|Origin|ADD|Add)(?:[/ ](?:Lyr|Tune|Chord|Req|Add))*\s*(?:Req|Add)?:\s*/i, '')
    .trim();

  return subject === '' ? 'Untitled tune' : subject;
}

interface Props {
  onImport: (file: File) => void;
  onClose: () => void;
}

export function MudcatWizard({ onImport, onClose }: Props) {
  const [step, setStep] = useState<Step>('query');
  const [title, setTitle] = useState('');
  const [multiPart, setMultiPart] = useState(true);
  /** True once the count has come back but the threads are not yet read. */
  const [counted, setCounted] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [keywords, setKeywords] = useState<Keyword[]>([{ id: 1, text: '', required: false }]);
  const nextId = useRef(2);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [tunes, setTunes] = useState<FoundTune[]>([]);
  const [threads, setThreads] = useState<ThreadRef[]>([]);
  const [matched, setMatched] = useState(0);
  const [chosen, setChosen] = useState<FoundTune | null>(null);
  const [draft, setDraft] = useState('');
  const [warnings, setWarnings] = useState<Warning[]>([]);

  /**
   * Run a search, or continue one.
   *
   * `from` is where in the result list to read, so "search more" picks up
   * after the threads already read rather than starting over. Continuing a
   * search adds to what is on screen; a fresh one replaces it.
   */
  const search = useCallback(
    async (read = false) => {
      setBusy(true);
      setError(null);
      setNote(null);
      if (read) {
        setTunes([]);
        setThreads([]);
        setProgress(null);
      }

      const body = JSON.stringify({
        title,
        multiPart,
        read,
        keywords: keywords
          .filter((k) => k.text.trim() !== '')
          .map(({ text, required }) => ({ text: text.trim(), required })),
      });

      try {
        const response = await fetch('/api/mudcat/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        // The counting step is a plain JSON reply; the sweep is a stream.
        if (!read) {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error ?? 'Search failed.');
          setMatched(data.matched ?? 0);
          setCounted(true);
          setBusy(false);
          return;
        }

        if (!response.ok || response.body === null) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error ?? 'Search failed.');
        }

        setStep('results');

        // NDJSON: one event per line, so results appear as threads are read
        // rather than after the whole sweep finishes.
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        let readCount = 0;
        let withAbc = 0;
        let total = 0;
        let suppressed = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;

          // The last line may be a partial JSON object; keep it for next time.
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.trim() === '') continue;
            const event = JSON.parse(line);

            if (event.type === 'start') {
              total = event.reading;
              setMatched(event.matched);
              setProgress({ read: 0, total, withAbc: 0 });
            } else if (event.type === 'thread') {
              readCount += 1;
              if (event.thread.hadAbc === true) withAbc += 1;
              setProgress({ read: readCount, total, withAbc });
              setThreads((prev) => [...prev, event.thread]);
              if (event.tunes.length > 0) {
                setTunes((prev) =>
                  [...prev, ...event.tunes].sort((a, b) => b.score - a.score),
                );
              }
            } else if (event.type === 'done') {
              suppressed = event.suppressed ?? 0;
            }
          }
        }

        setProgress(null);
        setTunes((current) => {
          if (current.length === 0) {
            setNote(
              suppressed > 0
                ? `Found ${suppressed} tune${suppressed === 1 ? '' : 's'}, but none met your ` +
                    'filters. Try unticking “Multi-part only”, or drop a required keyword.'
                : 'None of those threads had ABC in them. Try different words.',
            );
          }
          return current;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Search failed.');
        setProgress(null);
      } finally {
        setBusy(false);
      }
    },
    [title, multiPart, keywords],
  );

  const choose = useCallback((tune: FoundTune) => {
    setChosen(tune);
    setDraft(tune.text);
    setWarnings([]);
    setError(null);
    setStep('review');
  }, []);

  const convert = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/mudcat/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ abc: draft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Conversion failed.');

      setWarnings(data.warnings ?? []);

      // Name the file the way the row was labelled, so a tune with no `T:`
      // does not land in the library as "tune.musicxml".
      const label =
        data.title !== undefined && data.title !== '' && data.title !== 'Untitled'
          ? data.title
          : chosen === null
            ? 'tune'
            : tuneName(chosen);
      const name = `${label.replace(/[^\w\- ]+/g, '').trim() || 'tune'}.musicxml`;
      const file = new File([data.musicXml], name, { type: 'application/vnd.recordare.musicxml+xml' });
      onImport(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Conversion failed.');
    } finally {
      setBusy(false);
    }
  }, [draft, chosen, onImport]);

  return (
    <div className="wizard-backdrop" onClick={onClose}>
      <div
        className="wizard"
        role="dialog"
        aria-modal="true"
        aria-label="Find an arrangement on Mudcat"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wizard-head">
          <h3>Find an arrangement on Mudcat</h3>
          <button className="ghost" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {error !== null && <div className="wizard-error">{error}</div>}

        {step === 'query' && (
          <div className="wizard-body">
            <p className="lede">
              Mudcat Café is a folk music forum where people post tunes as ABC notation.
              This searches it and converts what it finds.
            </p>

            <label className="field">
              <span>Title</span>
              <input
                type="text"
                value={title}
                autoFocus
                onChange={(e) => {
                  setTitle(e.target.value);
                  setCounted(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void search();
                }}
              />
            </label>

            <label className="check">
              <input
                type="checkbox"
                checked={multiPart}
                onChange={(e) => setMultiPart(e.target.checked)}
              />
              <span>
                Multi-part only
                {!multiPart && (
                  <span className="sub">Single-voice tunes are included.</span>
                )}
              </span>
            </label>

            <div className="keywords">
              <span className="keywords-label">Keywords</span>
              {keywords.map((keyword, i) => (
                <div className="keyword-row" key={keyword.id}>
                  <input
                    type="text"
                    value={keyword.text}
                    placeholder={i === 0 ? 'harmony, SATB, Seekers…' : ''}
                    onChange={(e) =>
                      setKeywords((prev) =>
                        prev.map((k) => (k.id === keyword.id ? { ...k, text: e.target.value } : k)),
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) void search();
                    }}
                  />
                  <label className="check inline" title="Exclude tunes that do not match">
                    <input
                      type="checkbox"
                      checked={keyword.required}
                      onChange={(e) =>
                        setKeywords((prev) =>
                          prev.map((k) =>
                            k.id === keyword.id ? { ...k, required: e.target.checked } : k,
                          ),
                        )
                      }
                    />
                    <span>required</span>
                  </label>
                  <button
                    className="ghost"
                    title="Remove"
                    disabled={keywords.length === 1}
                    onClick={() => setKeywords((prev) => prev.filter((k) => k.id !== keyword.id))}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="ghost add-keyword"
                onClick={() =>
                  setKeywords((prev) => [
                    ...prev,
                    { id: (nextId.current += 1), text: '', required: false },
                  ])
                }
              >
                + Add keyword
              </button>
            </div>

            {counted && (
              <div className="count-prompt">
                {matched === 0 ? (
                  <span>Nothing matched that search.</span>
                ) : (
                  <>
                    <span>
                      <strong>{matched}</strong> thread{matched === 1 ? '' : 's'} matched. Reading
                      them all takes about {Math.max(1, Math.round(matched * 0.5))}s — most forum
                      posts have no notation in them, so it is worth a look.
                    </span>
                    <button className="primary" disabled={busy} onClick={() => void search(true)}>
                      {busy ? 'Reading…' : 'Read them'}
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="wizard-actions">
              <button
                className="primary"
                disabled={
                  busy || (title.trim() === '' && keywords.every((k) => k.text.trim() === ''))
                }
                onClick={() => void search()}
              >
                {busy ? 'Searching…' : 'Search'}
              </button>
            </div>
          </div>
        )}

        {step === 'results' && (
          <div className="wizard-body">
            {progress !== null && (
              <div className="progress">
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${(progress.read / Math.max(1, progress.total)) * 100}%` }}
                  />
                </div>
                <span className="progress-text">
                  Read {progress.read} of {progress.total} ·{' '}
                  <strong>{progress.withAbc}</strong> with notation ·{' '}
                  {progress.read - progress.withAbc} without
                </span>
              </div>
            )}

            {note !== null && <p className="empty">{note}</p>}

            {tunes.length > 0 && (
              <ul className="tune-list">
                {tunes.map((tune, i) => (
                  <li key={`${tune.thread.id}-${i}`}>
                    <button className="tune-row" onClick={() => choose(tune)}>
                      <span className="title">
                        {tuneName(tune)}
                        <span className="match" title="How well this answers your search">
                          {tune.match}%
                        </span>
                      </span>
                      <span className="meta">
                        {[
                          tune.voices > 1 ? `${tune.voices} voices` : '1 voice',
                          tune.key !== '' ? `key ${tune.key}` : 'no key',
                          tune.metre !== '' ? tune.metre : null,
                          tune.author !== '' ? `posted by ${tune.author}` : null,
                        ]
                          .filter((x) => x !== null)
                          .join(' · ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {threads.length > 0 && (
              <details className="threads">
                <summary>
                  {matched > threads.length
                    ? `${threads.length} of ${matched} threads read`
                    : `${threads.length} threads searched`}
                </summary>
                <ul>
                  {threads.map((t) => (
                    <li key={t.id}>
                      <a href={t.url} target="_blank" rel="noreferrer noopener">
                        {t.title}
                      </a>
                      <span className="meta">
                        {t.error !== undefined
                          ? ` — ${t.error}`
                          : ` — ${t.tuneCount ?? 0} tune${t.tuneCount === 1 ? '' : 's'}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="wizard-actions">
              <button className="ghost" onClick={() => setStep('query')}>
                ← Back
              </button>
            </div>
          </div>
        )}

        {step === 'review' && chosen !== null && (
          <div className="wizard-body">
            <p className="lede">
              Check the notation before it is converted. Forum ABC is typed by hand, so a
              missing <code>L:</code> or <code>K:</code> line is common — and fixable here.
            </p>

            <textarea
              className="abc-source"
              value={draft}
              spellCheck={false}
              rows={14}
              onChange={(e) => setDraft(e.target.value)}
            />

            {warnings.length > 0 && (
              <ul className="wizard-warnings">
                {warnings.map((w, i) => (
                  <li key={i}>
                    {w.message}
                    {w.line !== undefined && <span className="meta"> (line {w.line})</span>}
                  </li>
                ))}
              </ul>
            )}

            <div className="wizard-actions">
              <button className="ghost" onClick={() => setStep('results')}>
                ← Back
              </button>
              <a
                className="source-link"
                href={chosen.thread.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                View the thread
              </a>
              <button className="primary" disabled={busy} onClick={() => void convert()}>
                {busy ? 'Converting…' : 'Convert and add'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
