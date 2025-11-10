import { Config } from '../config';
import * as state from '../state';
import { runGh, extractMigrationId } from '../github';

// Helper to check if a status represents an unsynced state
export function isUnsynced(status: state.MigrationStatus): boolean {
  return status === 'needs_migration' || status === 'unsynced';
}

// Find and queue the next unsynced repository
export async function queueNextRepo(config: Config): Promise<string | null> {
  const allRepos = state.listAll();
  
  // Find first repo that needs migration
  const unsyncedRepo = allRepos.find(repo => isUnsynced(repo.status));
  
  if (!unsyncedRepo) {
    return null;
  }
  
  console.log(`[${new Date().toISOString()}] Migration worker: Queueing ${unsyncedRepo.name}...`);
  await queueSingleRepo(config, unsyncedRepo.name, unsyncedRepo.visibility);
  
  return unsyncedRepo.name;
}

async function queueSingleRepo(config: Config, repoName: string, visibility: state.RepoVisibility): Promise<void> {
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
