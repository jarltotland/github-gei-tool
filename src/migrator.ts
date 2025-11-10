import { Config } from './config';
import { fetchRepositories, runGh, extractMigrationId, getMigrationStatus, needsMigration } from './github';
import * as state from './state';
import { MigrationStatus } from './state';

// Helper to check if a status represents an unsynced state
export function isUnsynced(status: MigrationStatus): boolean {
  return status === 'needs_migration' || status === 'unsynced';
}

// Discover repositories from source and add new ones to state
export async function discoverRepositories(config: Config, onUpdate?: () => void): Promise<void> {
  console.log(`[${new Date().toISOString()}] Discovering repositories from ${config.source.org}...`);
  
  const repos = await fetchRepositories(config.source);
  console.log(`[${new Date().toISOString()}] Found ${repos.length} repositories`);

  let newRepoCount = 0;
  
  // Update state with discovered repos (only add new ones)
  for (const repo of repos) {
    const existing = state.getRepo(repo.name);
    if (!existing) {
      state.upsertRepo(repo.name, {
        name: repo.name,
        visibility: repo.visibility,
        status: 'unknown'
      });
      newRepoCount++;
    }
  }

  if (newRepoCount > 0) {
    console.log(`[${new Date().toISOString()}] Added ${newRepoCount} new repositories to state`);
  } else {
    console.log(`[${new Date().toISOString()}] No new repositories found`);
  }

  await state.saveState();
  if (onUpdate) {
    onUpdate();
  }
}

export async function queueSingleRepo(config: Config, repoName: string, visibility: state.RepoVisibility): Promise<void> {
  try {
    const args = [
      'gei', 'migrate-repo',
      '--github-source-org', config.source.org,
      '--source-repo', repoName,
      '--github-target-org', config.target.org,
      '--target-repo', repoName,
      '--queue-only',
      '--github-source-pat', config.source.token,
      '--github-target-pat', config.target.token
    ];

    // Add URL parameters if not github.com
    if (config.source.hostLabel !== 'github.com') {
      args.push('--github-source-url', config.source.restBase);
    }

    if (config.target.hostLabel !== 'github.com') {
      args.push('--github-target-url', config.target.restBase);
    }

    // Try to set target visibility
    args.push('--target-repo-visibility', visibility);

    console.log(`[${new Date().toISOString()}] Queueing ${repoName}...`);
    const result = await runGh(args);

    if (result.code !== 0) {
      console.error(`[${new Date().toISOString()}] Failed to queue ${repoName}: ${result.stderr}`);
      state.setStatus(repoName, 'failed', result.stderr);
      return;
    }

    const migrationId = extractMigrationId(result.stdout);
    
    if (!migrationId) {
      console.error(`[${new Date().toISOString()}] Could not extract migration ID for ${repoName}`);
      state.setStatus(repoName, 'failed', 'Could not extract migration ID from output');
      return;
    }

    const now = new Date().toISOString();
    state.upsertRepo(repoName, {
      migrationId,
      status: 'queued',
      queuedAt: now,
      startedAt: now
    });

  console.log(`[${new Date().toISOString()}] Queued ${repoName} with migration ID: ${migrationId}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error queueing ${repoName}:`, error);
    state.setStatus(repoName, 'failed', String(error));
  }
}

// Find and queue the next unsynced repository
export async function syncNextRepo(config: Config): Promise<string | null> {
  const allRepos = state.listAll();
  
  // Find first repo that needs migration
  const unsyncedRepo = allRepos.find(repo => isUnsynced(repo.status));
  
  if (!unsyncedRepo) {
    return null;
  }
  
  console.log(`[${new Date().toISOString()}] Sync worker: Queueing ${unsyncedRepo.name}...`);
  await queueSingleRepo(config, unsyncedRepo.name, unsyncedRepo.visibility);
  
  return unsyncedRepo.name;
}

// Poll a single repo until it reaches a terminal state
export async function pollRepoUntilSettled(
  config: Config,
  repoName: string,
  onUpdate?: () => void,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<'synced' | 'failed' | 'timeout'> {
  const intervalMs = options.intervalMs || 5000;
  const timeoutMs = options.timeoutMs || 30 * 60 * 1000; // 30 minutes default
  const startTime = Date.now();
  
  while (true) {
    const repo = state.getRepo(repoName);
    
    if (!repo) {
      console.error(`[${new Date().toISOString()}] Sync worker: Repo ${repoName} not found in state`);
      return 'failed';
    }
    
    // Check for terminal states
    if (repo.status === 'synced' || repo.status === 'imported') {
      console.log(`[${new Date().toISOString()}] Sync worker: ${repoName} completed successfully`);
      return 'synced';
    }
    
    if (repo.status === 'failed') {
      console.log(`[${new Date().toISOString()}] Sync worker: ${repoName} failed`);
      return 'failed';
    }
    
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[${new Date().toISOString()}] Sync worker: ${repoName} timed out after ${timeoutMs}ms`);
      return 'timeout';
    }
    
    // Poll status if repo has a migration ID
    if (repo.migrationId) {
      try {
        const status = await getMigrationStatus(config.target, repo.migrationId);
        
        if (status) {
          const now = new Date().toISOString();
          repo.lastPolledAt = now;
          repo.lastChecked = now;
          
          const newStatus = mapGitHubStatus(status.state);
          
          if (newStatus !== repo.status) {
            console.log(`[${new Date().toISOString()}] Sync worker: ${repoName}: ${repo.status} -> ${newStatus}`);
            state.setStatus(repoName, newStatus, status.failureReason);
            
            if (onUpdate) {
              onUpdate();
            }
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Sync worker: Error polling ${repoName}:`, error);
      }
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export async function pollMigrationStatuses(
  config: Config, 
  onUpdate?: () => void,
  onRepoStart?: (repoName: string) => void,
  onRepoEnd?: () => void
): Promise<void> {
  const incomplete = state.listIncomplete();
  
  if (incomplete.length === 0) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Progress worker: Polling ${incomplete.length} repositories...`);

  // Poll with concurrency limit
  const concurrency = 10;
  for (let i = 0; i < incomplete.length; i += concurrency) {
    const batch = incomplete.slice(i, i + concurrency);
    
    for (const repo of batch) {
      if (onRepoStart) {
        onRepoStart(repo.name);
      }
      
      await pollSingleRepo(config, repo, onUpdate);
      
      if (onRepoEnd) {
        onRepoEnd();
      }
    }
  }

  await state.saveState();
}

export async function checkOldestRepos(config: Config, onUpdate?: () => void, minAgeMinutes: number = 5, batchSize: number = 5, onRepoStart?: (repoName: string) => void, onRepoEnd?: () => void): Promise<void> {
  const allRepos = state.listAll();
  
  if (allRepos.length === 0) {
    return;
  }

  // Find repos that need status check (oldest or not checked in the last minAgeMinutes)
  const now = Date.now();
  const minAgeMs = minAgeMinutes * 60 * 1000;
  
  const reposNeedingCheck = allRepos
    .filter(repo => {
      // Skip repos that are in an active migration state
      if (repo.status === 'queued' || repo.status === 'exporting' || 
          repo.status === 'exported' || repo.status === 'importing') {
        return false;
      }
      
      // If never checked, needs check
      if (!repo.lastChecked) {
        return true;
      }
      
      // Check if older than minAgeMinutes
      const lastChecked = new Date(repo.lastChecked).getTime();
      return (now - lastChecked) > minAgeMs;
    })
    .sort((a, b) => {
      // First priority: repos with no lastChecked (never been checked)
      const aNoLastChecked = !a.lastChecked;
      const bNoLastChecked = !b.lastChecked;
      if (aNoLastChecked && !bNoLastChecked) return -1;
      if (!aNoLastChecked && bNoLastChecked) return 1;
      
      // Both have no lastChecked - prioritize unknown status
      if (aNoLastChecked && bNoLastChecked) {
        const aIsUnknown = a.status === 'unknown';
        const bIsUnknown = b.status === 'unknown';
        if (aIsUnknown && !bIsUnknown) return -1;
        if (!aIsUnknown && bIsUnknown) return 1;
        return 0; // Both same, keep original order
      }
      
      // Both have lastChecked - sort by oldest first
      return new Date(a.lastChecked!).getTime() - new Date(b.lastChecked!).getTime();
    })
    .slice(0, batchSize); // Only check the oldest N repos

  if (reposNeedingCheck.length === 0) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Status worker: Checking ${reposNeedingCheck.length} oldest repositories...`);
  console.log(`[${new Date().toISOString()}] Status worker: Selected repos: ${reposNeedingCheck.map(r => `${r.name} (status: ${r.status}, lastChecked: ${r.lastChecked || 'NEVER'})`).join(', ')}`);

  // Check repos sequentially to avoid overwhelming the API
  for (const repo of reposNeedingCheck) {
    if (onRepoStart) {
      onRepoStart(repo.name);
    }
    await recheckRepoStatus(config, repo, onUpdate);
    if (onRepoEnd) {
      onRepoEnd();
    }
  }

  await state.saveState();
}

async function recheckRepoStatus(config: Config, repo: state.RepoState, onUpdate?: () => void): Promise<void> {
  try {
    const result = await needsMigration(config.source, config.target, repo.name);
    const now = new Date().toISOString();
    const oldStatus = repo.status;
    
    if (result.needs) {
      state.upsertRepo(repo.name, {
        status: 'needs_migration',
        lastChecked: now,
        lastPushed: result.lastPushed
      });
    } else {
      state.upsertRepo(repo.name, {
        status: 'synced',
        lastChecked: now,
        lastPushed: result.lastPushed
      });
    }
    
    const newStatus = result.needs ? 'needs_migration' : 'synced';
    if (oldStatus !== newStatus) {
      console.log(`[${new Date().toISOString()}] Status worker: ${repo.name}: ${oldStatus} -> ${newStatus}`);
    }
    
    if (onUpdate) {
      onUpdate();
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error rechecking ${repo.name}:`, error);
  }
}

async function pollSingleRepo(config: Config, repo: state.RepoState, onUpdate?: () => void): Promise<void> {
  if (!repo.migrationId) {
    // Check if this repo has been in-progress for over 1 minute without a migration ID
    if (repo.startedAt && !repo.endedAt) {
      const startTime = new Date(repo.startedAt).getTime();
      const now = Date.now();
      const elapsedMs = now - startTime;
      
      if (elapsedMs > 60000) { // 1 minute
        console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} has been in-progress for ${Math.round(elapsedMs / 1000)}s without migration ID, marking as unknown`);
        state.setStatus(repo.name, 'unknown', 'Migration status lost - may have completed or failed');
        
        if (onUpdate) {
          onUpdate();
        }
      }
    }
    return;
  }

  try {
    const status = await getMigrationStatus(config.target, repo.migrationId);

    if (!status) {
      // Migration status not found - might have completed or failed without us noticing
      if (repo.startedAt) {
        const startTime = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const elapsedMs = now - startTime;
        
        if (elapsedMs > 60000) { // 1 minute
          console.warn(`[${new Date().toISOString()}] Progress worker: ${repo.name} migration not found after ${Math.round(elapsedMs / 1000)}s, marking as unknown`);
          state.setStatus(repo.name, 'unknown', 'Migration status not found - may have completed or failed');
          
          if (onUpdate) {
            onUpdate();
          }
        }
      }
      return;
    }

    const now = new Date().toISOString();
    repo.lastPolledAt = now;
    repo.lastChecked = now;

    const newStatus = mapGitHubStatus(status.state);
    
    if (newStatus !== repo.status) {
      console.log(`[${new Date().toISOString()}] Progress worker: ${repo.name}: ${repo.status} -> ${newStatus}`);
      state.setStatus(repo.name, newStatus, status.failureReason);
      
      if (onUpdate) {
        onUpdate();
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Progress worker: Error polling ${repo.name}:`, error);
  }
}

function mapGitHubStatus(githubState: string): MigrationStatus {
  const state = githubState.toLowerCase();
  
  switch (state) {
    case 'pending':
    case 'queued':
      return 'queued';
    case 'exporting':
      return 'exporting';
    case 'exported':
      return 'exported';
    case 'importing':
      return 'importing';
    case 'imported':
      return 'imported';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}
