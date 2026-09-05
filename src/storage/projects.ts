import { deleteDB, openDB, type IDBPDatabase } from 'idb';
import type { MixState, Project, Score } from '../core/types';
import { initialMixState } from '../core/mixer';

/**
 * Local-first project storage (execution doc §7).
 *
 * Everything lives in the browser. No server means no deployment story and no
 * question about uploaded sheet music sitting on someone else's disk.
 */

const DB_NAME = 'unbraid';
const DB_VERSION = 1;
const STORE = 'projects';

/**
 * The pre-rebrand database name.
 *
 * Nothing reads it any more, but a browser that ran the old build still has it
 * on disk holding scores the user can no longer see. Dropping it on first open
 * keeps the rename from leaving orphaned data behind; it is fire-and-forget
 * because failing to delete a database nobody reads must never block startup.
 */
const LEGACY_DB_NAME = 'harmoneeze';

/** Set once the delete has been attempted, so it runs at most once per page. */
let legacyDropped = false;

function dropLegacyDB(): void {
  if (legacyDropped) return;
  legacyDropped = true;

  void deleteDB(LEGACY_DB_NAME, {
    // Another tab from the old build still holds it open. The request stays
    // pending indefinitely rather than failing, so nothing here can force it;
    // the delete simply lands whenever that tab goes away, or on a later load.
    blocked() {},
  }).catch(() => {
    // Storage unavailable, or the delete was refused. The live database is
    // unaffected either way, and a database nobody reads is not worth an error.
  });
}

/** What actually goes to disk: the source file plus everything derived. */
interface StoredProject {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  sourceFileName: string | null;
  sourceBytes: ArrayBuffer | null;
  score: Score;
  mixState: MixState;
  notes: string;
}

/**
 * How long to wait for the database before giving up.
 *
 * IndexedDB open requests do not fail when they are blocked — they wait
 * indefinitely for whatever holds the old connection to let go. Without a
 * bound, one stale connection leaves every call pending forever and the UI
 * hangs with no error to report.
 */
const OPEN_TIMEOUT_MS = 4000;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (dbPromise === null) {
    dropLegacyDB();

    const opening = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      },
      // Another tab is holding an old version open, or the database was
      // deleted from under us. Drop the handle so the next call reconnects
      // instead of reusing a connection that will never open.
      blocked() {
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    });

    dbPromise = Promise.race([
      opening,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Local storage is unavailable (the database did not open).')),
          OPEN_TIMEOUT_MS,
        ),
      ),
    ]).catch((error: unknown) => {
      // Never cache a rejected promise: one transient failure would otherwise
      // poison every later call for the lifetime of the page.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function toProject(stored: StoredProject): Project {
  return {
    id: stored.id,
    title: stored.title,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    sourceFile:
      stored.sourceBytes === null
        ? null
        : { name: stored.sourceFileName ?? 'score', bytes: stored.sourceBytes },
    score: stored.score,
    mixState: stored.mixState,
    notes: stored.notes,
  };
}

function toStored(project: Project): StoredProject {
  return {
    id: project.id,
    title: project.title,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sourceFileName: project.sourceFile?.name ?? null,
    sourceBytes: project.sourceFile?.bytes ?? null,
    score: project.score,
    mixState: project.mixState,
    notes: project.notes,
  };
}

export function createProject(
  score: Score,
  sourceFile: { name: string; bytes: ArrayBuffer } | null,
): Project {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: score.title,
    createdAt: now,
    updatedAt: now,
    sourceFile,
    score,
    mixState: initialMixState(score),
    notes: '',
  };
}

/** Projects, most recently opened first (§6.1). */
export async function listProjects(): Promise<Project[]> {
  const all = (await (await db()).getAll(STORE)) as StoredProject[];
  return all.map(toProject).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<Project | null> {
  const stored = (await (await db()).get(STORE, id)) as StoredProject | undefined;
  return stored === undefined ? null : toProject(stored);
}

export async function saveProject(project: Project): Promise<void> {
  await (await db()).put(STORE, toStored({ ...project, updatedAt: Date.now() }));
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}

export async function renameProject(id: string, title: string): Promise<void> {
  const project = await loadProject(id);
  if (project === null) return;
  await saveProject({ ...project, title });
}
