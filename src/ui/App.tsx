import { useCallback, useEffect, useState } from 'react';
import type { Project } from '../core/types';
import { parseScoreFile } from '../core/ingest';
import { parseXmlDom } from '../core/domXml';
import { scoreFromRecording } from '../core/transcription';
import { isSupportedAudioFile, transcribeRecording, type TranscribeStage } from '../audio/transcriber';
import {
  createProject,
  deleteProject,
  listProjects,
  loadProject,
  renameProject,
  saveProject,
} from '../storage/projects';
import { Landing, type RecordingProgress } from './Landing';
import { Logo } from './Logo';
import { ProjectView } from './ProjectView';

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [current, setCurrent] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState<RecordingProgress | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    setProjects(await listProjects());
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // Storage bounds its own open request, so this settles either way.
        await refresh();
      } catch {
        setError(
          'Could not open local storage, so saved pieces are unavailable. ' +
            'Another tab may have this app open; private browsing can also block it. ' +
            'You can still load a score for this session.',
        );
      } finally {
        setReady(true);
      }
    })();
  }, [refresh]);

  /**
   * Save a freshly imported project and open it.
   *
   * The piece parsed, so let the user practise it even if it cannot be
   * stored. Failing to save is worth saying, but it is not a reason to throw
   * away a piece they just loaded.
   */
  const openNewProject = useCallback(
    async (project: Project) => {
      try {
        await saveProject(project);
        await refresh();
      } catch {
        setError('This piece is loaded but could not be saved, so it will be gone on reload.');
      }
      setCurrent(project);
    },
    [refresh],
  );

  const handleUpload = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      let project: Project;
      try {
        const bytes = await file.arrayBuffer();
        const score = parseScoreFile(file.name, bytes, parseXmlDom);
        project = createProject(score, { name: file.name, bytes });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That file could not be read.');
        setBusy(false);
        return;
      }
      await openNewProject(project);
      setBusy(false);
    },
    [openNewProject],
  );

  const handleRecordingUpload = useCallback(
    async (file: File, partCount: number | 'auto') => {
      setError(null);
      if (!isSupportedAudioFile(file.name)) {
        setError('Unbraid reads recordings as MP3 or M4A (WAV and AAC also work).');
        return;
      }

      const show = (s: TranscribeStage) => {
        switch (s.stage) {
          case 'decoding':
            return setRecordingProgress({ label: 'Decoding the recording…', fraction: null });
          case 'loading-model':
            return setRecordingProgress({ label: 'Loading the listening model…', fraction: null });
          case 'listening':
            return setRecordingProgress({
              label: `Listening for notes… ${Math.round(s.fraction * 100)}%`,
              fraction: s.fraction,
            });
          case 'splitting':
            return setRecordingProgress({ label: 'Separating the parts…', fraction: null });
        }
      };

      let project: Project;
      try {
        const bytes = await file.arrayBuffer();
        const heard = await transcribeRecording(bytes, show);
        show({ stage: 'splitting' });
        const title = file.name.replace(/\.[^.]+$/, '') || 'Untitled recording';
        const score = scoreFromRecording(heard, { title, partCount });
        project = createProject(score, { name: file.name, bytes });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'That recording could not be transcribed.');
        setRecordingProgress(null);
        return;
      }
      await openNewProject(project);
      setRecordingProgress(null);
    },
    [openNewProject],
  );

  const handleOpen = useCallback(async (id: string) => {
    const project = await loadProject(id);
    if (project === null) setError('That piece could not be found.');
    else setCurrent(project);
  }, []);

  /**
   * Persist edits as they happen; there is no explicit save in the app.
   *
   * Takes an updater rather than a finished project so that two edits racing
   * each other cannot clobber one another. The notes pane autosaves on a
   * timer, so a fader moved while that timer is pending would otherwise be
   * overwritten by a snapshot taken before the move.
   */
  const handleChange = useCallback(
    (update: (previous: Project) => Project) => {
      setCurrent((previous) => {
        if (previous === null) return previous;
        const next = update(previous);
        void saveProject(next).then(refresh);
        return next;
      });
    },
    [refresh],
  );

  if (!ready) return <div className="spinner">Loading…</div>;

  if (current !== null) {
    return (
      <ProjectView
        project={current}
        onChange={handleChange}
        onBack={() => {
          setCurrent(null);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1 className="brand">
          <Logo size={34} className="brand-mark" />
          <span className="wordmark">Unbraid</span>
          <span className="version" title={`Unbraid ${__APP_VERSION__}`}>
            v{__APP_VERSION__}
          </span>
        </h1>
        <span className="spacer" />
        <span className="band-range">Practise one part against the rest</span>
      </div>

      {error !== null && (
        <div className="banner error">
          <span>{error}</span>
          <button className="close" onClick={() => setError(null)} title="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="bands-scroll">
        <Landing
          projects={projects}
          busy={busy}
          recordingProgress={recordingProgress}
          onUpload={(file) => void handleUpload(file)}
          onUploadRecording={(file, parts) => void handleRecordingUpload(file, parts)}
          onOpen={(id) => void handleOpen(id)}
          onDelete={(id) => void deleteProject(id).then(refresh)}
          onRename={(id, title) => void renameProject(id, title).then(refresh)}
        />
      </div>
    </div>
  );
}
