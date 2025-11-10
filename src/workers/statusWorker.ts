import { Config } from '../config';
import * as state from '../state';
import { needsMigration } from '../github';

export async function checkOldestRepos(
  config: Config, 
  onUpdate?: () => void, 
  minAgeMinutes: number = 5, 
  batchSize: number = 5, 
  onRepoStart?: (repoName: string) => void, 
  onRepoEnd?: () => void
): Promise<void> {
  const allRepos = state.listAll();
  
  if (allRepos.length === 0) {
    return;
  }

  // Find repos that need status check
  const now = Date.now();
  const minAgeMs = minAgeMinutes * 60 * 1000;
  
  // First, get all unknown repos (priority)
  const unknownRepos = allRepos.filter(repo => repo.status === 'unknown');
  
  // Then get other repos that need checking (oldest or stale)
  const otherReposNeedingCheck = allRepos
    .filter(repo => {
      // Skip unknown (already in unknownRepos)
      if (repo.status === 'unknown') {
        return false;
      }
      
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
      // Sort by oldest first
      const aTime = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
      const bTime = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
      return aTime - bTime;
    })
    .slice(0, batchSize); // Only check N oldest repos
  
  // Prioritize unknown repos, then add other repos if there's room
  let reposNeedingCheck: state.RepoState[];
  if (unknownRepos.length > 0) {
    reposNeedingCheck = unknownRepos;
    console.log(`[${new Date().toISOString()}] Status worker: Checking all ${unknownRepos.length} unknown repositories...`);
  } else {
    reposNeedingCheck = otherReposNeedingCheck;
    if (reposNeedingCheck.length === 0) {
      return;
    }
    console.log(`[${new Date().toISOString()}] Status worker: Checking ${reposNeedingCheck.length} oldest repositories...`);
  }

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
