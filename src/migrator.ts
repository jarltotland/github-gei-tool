import { Config } from './config';
import { fetchRepositories, runGh, extractMigrationId, getMigrationStatus, needsMigration } from './github';
import * as state from './state';
import { MigrationStatus } from './state';

export async function queueMigrations(config: Config, onUpdate?: () => void): Promise<void> {
  console.log(`[${new Date().toISOString()}] Fetching repositories from ${config.source.org}...`);
  
  const repos = await fetchRepositories(config.source);
  console.log(`[${new Date().toISOString()}] Found ${repos.length} repositories`);

  // Update state with discovered repos
  for (const repo of repos) {
    const existing = state.getRepo(repo.name);
    if (!existing) {
      state.upsertRepo(repo.name, {
        name: repo.name,
        visibility: repo.visibility,
        status: 'unknown'
      });
    }
  }

  // Filter repos that need queueing
  const reposToCheck = repos.filter(repo => {
    const existing = state.getRepo(repo.name);
    return !existing || !existing.migrationId;
  });

  if (reposToCheck.length === 0) {
    console.log(`[${new Date().toISOString()}] All repositories already queued`);
    await state.saveState();
    return;
  }

  console.log(`[${new Date().toISOString()}] Checking ${reposToCheck.length} repositories for migration need...`);

  // Check which repos need migration and mark status accordingly
  let needsMigrationCount = 0;
  let syncedCount = 0;
  
  for (const repo of reposToCheck) {
    const result = await needsMigration(config.source, config.target, repo.name);
    const now = new Date().toISOString();
    
    if (result.needs) {
      // Mark as needing migration but don't queue yet
      state.upsertRepo(repo.name, {
        name: repo.name,
        visibility: repo.visibility,
        status: 'needs_migration',
        lastChecked: now,
        lastPushed: result.lastPushed
      });
      needsMigrationCount++;
    } else {
      // Mark as synced
      state.upsertRepo(repo.name, {
        name: repo.name,
        visibility: repo.visibility,
        status: 'synced',
        lastChecked: now,
        lastPushed: result.lastPushed
      });
      syncedCount++;
    }
    
    // Broadcast update after each repo is checked
    await state.saveState();
    if (onUpdate) {
      onUpdate();
    }
  }

  console.log(`[${new Date().toISOString()}] Summary: ${needsMigrationCount} need migration, ${syncedCount} synced`);

  await state.saveState();
  console.log(`[${new Date().toISOString()}] Queueing complete`);
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

export async function pollMigrationStatuses(config: Config, onUpdate?: () => void): Promise<void> {
  const incomplete = state.listIncomplete();
  
  if (incomplete.length === 0) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Polling status for ${incomplete.length} repositories...`);

  // Poll with concurrency limit
  const concurrency = 10;
  for (let i = 0; i < incomplete.length; i += concurrency) {
    const batch = incomplete.slice(i, i + concurrency);
    await Promise.all(batch.map(repo => pollSingleRepo(config, repo, onUpdate)));
  }

  await state.saveState();
}

async function pollSingleRepo(config: Config, repo: state.RepoState, onUpdate?: () => void): Promise<void> {
  if (!repo.migrationId) {
    return;
  }

  try {
    const status = await getMigrationStatus(config.target, repo.migrationId);

    if (!status) {
      return;
    }

    const now = new Date().toISOString();
    repo.lastPolledAt = now;
    repo.lastChecked = now;

    const newStatus = mapGitHubStatus(status.state);
    
    if (newStatus !== repo.status) {
      console.log(`[${new Date().toISOString()}] ${repo.name}: ${repo.status} -> ${newStatus}`);
      state.setStatus(repo.name, newStatus, status.failureReason);
      
      if (onUpdate) {
        onUpdate();
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error polling ${repo.name}:`, error);
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
