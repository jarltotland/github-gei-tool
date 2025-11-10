import * as fs from 'fs';
import * as path from 'path';

export type MigrationStatus = 'queued' | 'exporting' | 'exported' | 'importing' | 'imported' | 'failed' | 'unknown' | 'synced' | 'needs_migration';
export type RepoVisibility = 'public' | 'private' | 'internal';

export interface RepoState {
  name: string;
  visibility: RepoVisibility;
  migrationId?: string;
  status: MigrationStatus;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  elapsedSeconds?: number;
  lastUpdate?: string;
  lastPolledAt?: string;
  lastChecked?: string;
  lastPushed?: string;
  errorMessage?: string;
  logs?: {
    cached: boolean;
    cacheDir?: string;
    lastFetchedAt?: string;
  };
}

export interface MigrationState {
  version: number;
  sourceEnt: string;
  sourceOrg: string;
  targetEnt: string;
  targetOrg: string;
  sourceHost: string;
  targetHost: string;
  repos: Record<string, RepoState>;
}

const STATE_FILE = path.join(process.cwd(), 'data', 'migrations-state.json');
let writeMutex = Promise.resolve();

let currentState: MigrationState = {
  version: 1,
  sourceEnt: '',
  sourceOrg: '',
  targetEnt: '',
  targetOrg: '',
  sourceHost: '',
  targetHost: '',
  repos: {}
};

export function initState(sourceEnt: string, sourceOrg: string, targetEnt: string, targetOrg: string, sourceHost: string, targetHost: string): void {
  loadState();
  
  // Update org and host info
  currentState.sourceEnt = sourceEnt;
  currentState.sourceOrg = sourceOrg;
  currentState.targetEnt = targetEnt;
  currentState.targetOrg = targetOrg;
  currentState.sourceHost = sourceHost;
  currentState.targetHost = targetHost;
  
  saveState();
}

export function loadState(): MigrationState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      currentState = JSON.parse(data);
      console.log(`[${new Date().toISOString()}] Loaded state with ${Object.keys(currentState.repos).length} repositories`);
    } else {
      console.log(`[${new Date().toISOString()}] No existing state file found, starting fresh`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error loading state:`, error);
  }
  return currentState;
}

export function getState(): MigrationState {
  return currentState;
}

export function getRepo(repoName: string): RepoState | undefined {
  return currentState.repos[repoName];
}

export function upsertRepo(repoName: string, updates: Partial<RepoState>): void {
  if (!currentState.repos[repoName]) {
    currentState.repos[repoName] = {
      name: repoName,
      visibility: 'private',
      status: 'unknown',
      ...updates
    } as RepoState;
  } else {
    currentState.repos[repoName] = {
      ...currentState.repos[repoName],
      ...updates,
      lastUpdate: new Date().toISOString()
    };
  }
}

export function setStatus(repoName: string, status: MigrationStatus, errorMessage?: string): void {
  const now = new Date().toISOString();
  const repo = currentState.repos[repoName];
  
  if (!repo) return;
  
  repo.status = status;
  repo.lastUpdate = now;
  
  if (errorMessage) {
    repo.errorMessage = errorMessage;
  }
  
  // Track timing
  if (status !== 'queued' && !repo.startedAt) {
    repo.startedAt = now;
  }
  
  if (status === 'imported' || status === 'failed') {
    if (!repo.endedAt) {
      repo.endedAt = now;
      if (repo.startedAt) {
        const start = new Date(repo.startedAt).getTime();
        const end = new Date(repo.endedAt).getTime();
        repo.elapsedSeconds = Math.round((end - start) / 1000);
      }
    }
  }
}

export function listIncomplete(): RepoState[] {
  return Object.values(currentState.repos).filter(
    repo => ['queued', 'exporting', 'exported', 'importing'].includes(repo.status)
  );
}

export function listAll(): RepoState[] {
  return Object.values(currentState.repos);
}

export function saveState(): Promise<void> {
  // Use a mutex to prevent concurrent writes
  writeMutex = writeMutex.then(() => doSaveState());
  return writeMutex;
}

async function doSaveState(): Promise<void> {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Atomic write: write to temp file then rename
    const tempFile = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(currentState, null, 2), 'utf8');
    fs.renameSync(tempFile, STATE_FILE);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error saving state:`, error);
    throw error;
  }
}

export function getElapsedSeconds(repo: RepoState): number {
  if (repo.endedAt && repo.elapsedSeconds !== undefined) {
    return repo.elapsedSeconds;
  }
  
  if (repo.startedAt) {
    const start = new Date(repo.startedAt).getTime();
    const now = new Date().getTime();
    return Math.round((now - start) / 1000);
  }
  
  return 0;
}
