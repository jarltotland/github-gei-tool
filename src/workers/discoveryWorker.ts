import { Config } from '../config';
import * as state from '../state';
import { fetchRepositories } from '../github';

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
