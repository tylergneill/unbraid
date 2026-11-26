import { useRef, useState, type ReactNode } from 'react';
import type { Project } from '../core/types';
import { MAX_PARTS } from '../core/transcription';

/**
 * Landing page — the project organizer (execution doc §6.1).
 *
 * "Minimal. It is a launcher, not a dashboard."
 *
 * Two ways in, on two tabs: a written score (MusicXML), or a recording that
 * is transcribed and split into parts. They are separate tabs, not one
 * dropzone that sniffs the file, because they promise different things: a
 * score is read exactly, a recording is a best guess the user should expect
 * to check.
 */

export type ImportMode = 'score' | 'recording';

/** What a recording import is doing right now, for the dropzone to show. */
export interface RecordingProgress {
  label: string;
  /** 0..1 when the stage has measurable progress, else null. */
  fraction: number | null;
}

interface Props {
  projects: Project[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onUpload: (file: File) => void;
  onUploadRecording: (file: File, partCount: number | 'auto') => void;
  busy: boolean;
  recordingProgress: RecordingProgress | null;
}

function describe(project: Project): string {
  const parts = project.score.parts.length;
  const when = new Date(project.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const fromRecording = project.score.parts.some((p) => p.source.partId === 'recording');
  return (
    (fromRecording ? 'From a recording · ' : '') +
    `${parts} part${parts === 1 ? '' : 's'} · ${project.score.measures.length} bars · ${when}`
  );
}

interface DropzoneProps {
  accept: string;
  disabled: boolean;
  onFile: (file: File) => void;
  children: ReactNode;
}

/** A click-or-drop target for one file. */
function Dropzone({ accept, disabled, onFile, children }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = () => {
    if (!disabled) inputRef.current?.click();
  };

  return (
    <>
      <div
        className={['dropzone', dragOver ? 'over' : '', disabled ? 'busy' : ''].join(' ').trim()}
        onClick={pick}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (!disabled && file !== undefined) onFile(file);
        }}
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        }}
      >
        {children}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file !== undefined) onFile(file);
          // Clear so re-picking the same file fires a change event again.
          e.target.value = '';
        }}
      />
    </>
  );
}

export function Landing({
  projects,
  onOpen,
  onDelete,
  onRename,
  onUpload,
  onUploadRecording,
  busy,
  recordingProgress,
}: Props) {
  const [mode, setMode] = useState<ImportMode>('score');
  const [partCount, setPartCount] = useState<number | 'auto'>('auto');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title !== '') onRename(id, title);
    setRenaming(null);
  };

  const working = busy || recordingProgress !== null;

  return (
    <div className="landing">
      <h2>Your pieces</h2>
      <p className="lede">
        Upload a score or a recording, mute everything but your line, and loop it until it sticks.
      </p>

      <div className="import-tabs" role="tablist">
        {(['score', 'recording'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? 'import-tab active' : 'import-tab'}
            disabled={working && mode !== m}
            onClick={() => setMode(m)}
          >
            {m === 'score' ? 'From a score' : 'From a recording'}
          </button>
        ))}
      </div>

      {mode === 'score' ? (
        <Dropzone accept=".musicxml,.xml,.mxl" disabled={working} onFile={onUpload}>
          <strong>{busy ? 'Reading score…' : 'Drop a score here, or click to choose'}</strong>
          <span className="hint">MusicXML (.musicxml, .xml) or compressed MusicXML (.mxl)</span>
        </Dropzone>
      ) : (
        <>
          <Dropzone
            accept=".mp3,.m4a,.mp4,.aac,.wav,audio/*"
            disabled={working}
            onFile={(file) => onUploadRecording(file, partCount)}
          >
            {recordingProgress === null ? (
              <>
                <strong>Drop a recording here, or click to choose</strong>
                <span className="hint">
                  MP3 or M4A. Works best when each part is clearly audible on its own.
                </span>
              </>
            ) : (
              <>
                <strong>{recordingProgress.label}</strong>
                <div className="progress" aria-hidden={recordingProgress.fraction === null}>
                  <div
                    className={recordingProgress.fraction === null ? 'progress-fill indeterminate' : 'progress-fill'}
                    style={
                      recordingProgress.fraction === null
                        ? undefined
                        : { width: `${Math.round(recordingProgress.fraction * 100)}%` }
                    }
                  />
                </div>
                <span className="hint">Everything runs on this computer; nothing is uploaded.</span>
              </>
            )}
          </Dropzone>
          <div className="import-options">
            <label>
              Parts
              <select
                value={String(partCount)}
                disabled={working}
                onChange={(e) =>
                  setPartCount(e.target.value === 'auto' ? 'auto' : Number(e.target.value))
                }
              >
                <option value="auto">Work it out</option>
                {Array.from({ length: MAX_PARTS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">
              Notes are heard automatically, so expect some to be missing or in the wrong part.
            </span>
          </div>
        </>
      )}

      {projects.length === 0 ? (
        <p className="empty">Nothing here yet.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-row">
              {renaming === project.id ? (
                <input
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(project.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(project.id);
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <button className="open" onClick={() => onOpen(project.id)}>
                  <span className="title">{project.title}</span>
                  <span className="meta">{describe(project)}</span>
                </button>
              )}

              <button
                className="ghost"
                title="Rename"
                onClick={() => {
                  setRenaming(project.id);
                  setDraft(project.title);
                }}
              >
                Rename
              </button>
              <button
                className="ghost danger"
                title="Delete"
                onClick={() => {
                  if (confirm(`Delete "${project.title}"? This cannot be undone.`)) {
                    onDelete(project.id);
                  }
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
