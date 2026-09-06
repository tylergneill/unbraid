import { useCallback, useRef, useState } from 'react';
import type { Project } from '../core/types';
import { MudcatWizard } from './MudcatWizard';

/**
 * Landing page — the project organizer (execution doc §6.1).
 *
 * "Minimal. It is a launcher, not a dashboard."
 */

interface Props {
  projects: Project[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onUpload: (file: File) => void;
  busy: boolean;
}

function describe(project: Project): string {
  const parts = project.score.parts.length;
  const when = new Date(project.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${parts} part${parts === 1 ? '' : 's'} · ${project.score.measures.length} bars · ${when}`;
}

export function Landing({ projects, onOpen, onDelete, onRename, onUpload, busy }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file !== undefined) onUpload(file);
    },
    [onUpload],
  );

  const commitRename = (id: string) => {
    const title = draft.trim();
    if (title !== '') onRename(id, title);
    setRenaming(null);
  };

  return (
    <div className="landing">
      <h2>Your pieces</h2>
      <p className="lede">
        Upload a score, mute everything but your line, and loop it until it sticks.
      </p>

      <div
        className={dragOver ? 'dropzone over' : 'dropzone'}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
      >
        <strong>{busy ? 'Reading score…' : 'Drop a score here, or click to choose'}</strong>
        <span className="hint">MusicXML (.musicxml, .xml) or compressed MusicXML (.mxl)</span>
      </div>

      {import.meta.env.DEV && (
        <p className="or-mudcat">
          or <button onClick={() => setWizardOpen(true)}>find an arrangement on Mudcat</button>
        </p>
      )}

      {wizardOpen && (
        <MudcatWizard
          onClose={() => setWizardOpen(false)}
          onImport={(file) => {
            setWizardOpen(false);
            onUpload(file);
          }}
        />
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".musicxml,.xml,.mxl"
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          // Clear so re-picking the same file fires a change event again.
          e.target.value = '';
        }}
      />

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
