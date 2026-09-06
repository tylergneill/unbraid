import { useCallback, useState } from 'react';

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
  error?: string;
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
  thread: ThreadRef;
}

interface Warning {
  message: string;
  line?: number;
}

type Step = 'query' | 'results' | 'review';

interface Props {
  onImport: (file: File) => void;
  onClose: () => void;
}

export function MudcatWizard({ onImport, onClose }: Props) {
  const [step, setStep] = useState<Step>('query');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [parts, setParts] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [tunes, setTunes] = useState<FoundTune[]>([]);
  const [threads, setThreads] = useState<ThreadRef[]>([]);
  const [chosen, setChosen] = useState<FoundTune | null>(null);
  const [draft, setDraft] = useState('');
  const [warnings, setWarnings] = useState<Warning[]>([]);

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const response = await fetch('/api/mudcat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, artist, parts }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Search failed.');

      setTunes(data.tunes ?? []);
      setThreads(data.threads ?? []);
      if (data.note !== undefined) setNote(data.note);
      else if ((data.tunes ?? []).length === 0) {
        setNote('Those threads had no ABC in them. Try different words.');
      }
      setStep('results');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  }, [title, artist, parts]);

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

      const name = `${(data.title ?? 'tune').replace(/[^\w\- ]+/g, '').trim() || 'tune'}.musicxml`;
      const file = new File([data.musicXml], name, { type: 'application/vnd.recordare.musicxml+xml' });
      onImport(file);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Conversion failed.');
    } finally {
      setBusy(false);
    }
  }, [draft, onImport]);

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
                placeholder="Wellerman"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void search();
                }}
              />
            </label>

            <label className="field">
              <span>Artist or source</span>
              <input
                type="text"
                value={artist}
                placeholder="optional"
                onChange={(e) => setArtist(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void search();
                }}
              />
            </label>

            <label className="field">
              <span>Parts</span>
              <input
                type="text"
                value={parts}
                placeholder="harmony, SATB, tenor…"
                onChange={(e) => setParts(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void search();
                }}
              />
            </label>

            <div className="wizard-actions">
              <span className="hint">Searches at most five threads, slowly.</span>
              <button
                className="primary"
                disabled={busy || (title.trim() === '' && artist.trim() === '' && parts.trim() === '')}
                onClick={() => void search()}
              >
                {busy ? 'Searching…' : 'Search'}
              </button>
            </div>
          </div>
        )}

        {step === 'results' && (
          <div className="wizard-body">
            {note !== null && <p className="empty">{note}</p>}

            {tunes.length > 0 && (
              <ul className="tune-list">
                {tunes.map((tune, i) => (
                  <li key={`${tune.thread.id}-${i}`}>
                    <button className="tune-row" onClick={() => choose(tune)}>
                      <span className="title">{tune.title === '' ? 'Untitled tune' : tune.title}</span>
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
                      {tune.reasons.length > 0 && (
                        <span className="why">{tune.reasons.join(' · ')}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {threads.length > 0 && (
              <details className="threads">
                <summary>{threads.length} threads searched</summary>
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
