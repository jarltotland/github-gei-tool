import { spawn } from 'child_process';
import { HostConfig } from './config';
import { RepoVisibility } from './state';

export interface Repository {
  name: string;
  visibility: RepoVisibility;
}

interface GraphQLResponse {
  data: {
    organization: {
      repositories: {
        nodes: Array<{
          name: string;
          visibility: string;
          isArchived: boolean;
          isDisabled: boolean;
          isFork: boolean;
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
}

export async function fetchRepositories(hostConfig: HostConfig): Promise<Repository[]> {
  const repos: Repository[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const query = `
      query($org: String!, $cursor: String) {
        organization(login: $org) {
          repositories(first: 100, after: $cursor, orderBy: { field: NAME, direction: ASC }) {
            nodes {
              name
              visibility
              isArchived
              isDisabled
              isFork
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    `;

    const variables = {
      org: hostConfig.org,
      cursor
    };

    try {
      const args = ['api', 'graphql'];
      
      // Add hostname if not github.com
      if (hostConfig.hostLabel !== 'github.com') {
        args.push('--hostname', hostConfig.hostLabel);
      }
      
      args.push('-f', `query=${query}`, '-F', `org=${hostConfig.org}`);
      
      if (cursor) {
        args.push('-F', `cursor=${cursor}`);
      }

      const result = await runGh(args, { GH_TOKEN: hostConfig.token });
      
      if (result.code !== 0) {
        throw new Error(`Failed to fetch repositories: ${result.stderr}`);
      }

      const response: GraphQLResponse = JSON.parse(result.stdout);
      const nodes = response.data.organization.repositories.nodes;

      for (const node of nodes) {
        if (!node.isDisabled) {
          repos.push({
            name: node.name,
            visibility: node.visibility.toLowerCase() as RepoVisibility
          });
        }
      }

      hasNextPage = response.data.organization.repositories.pageInfo.hasNextPage;
      cursor = response.data.organization.repositories.pageInfo.endCursor;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Error fetching repositories:`, error);
      throw error;
    }
  }

  return repos;
}

export async function runGh(args: string[], envExtra?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envExtra };
    const child = spawn('gh', args, { env });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ stdout, stderr, code: code || 0 });
    });

    child.on('error', (error) => {
      stderr += error.message;
      resolve({ stdout, stderr, code: 1 });
    });
  });
}

export async function checkGhCli(): Promise<boolean> {
  try {
    const result = await runGh(['--version']);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function checkGeiExtension(): Promise<boolean> {
  try {
    const result = await runGh(['gei', '--help']);
    return result.code === 0;
  } catch {
    return false;
  }
}

export function extractMigrationId(output: string): string | null {
  const patterns = [
    /migration\s+id[:\s]+([0-9]+)/i,
    /queued\s+migration(?:s)?(?:\s+with)?\s+id[:\s]+([0-9]+)/i,
    /\(ID:\s*([RM_0-9A-Za-z]+)\)/i,
    /id[:\s]+([0-9]+)/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

export async function getMigrationStatus(
  hostConfig: HostConfig,
  migrationId: string
): Promise<{ state: string; createdAt?: string; updatedAt?: string; failureReason?: string } | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/orgs/${hostConfig.org}/migrations/${migrationId}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });

    if (result.code !== 0) {
      console.error(`[${new Date().toISOString()}] Failed to get migration status for ${migrationId}: ${result.stderr}`);
      return null;
    }

    const response = JSON.parse(result.stdout);
    return {
      state: response.state,
      createdAt: response.created_at,
      updatedAt: response.updated_at,
      failureReason: response.failure_reason
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error getting migration status:`, error);
    return null;
  }
}

export async function checkRepoExists(hostConfig: HostConfig, repoName: string): Promise<boolean> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/repos/${hostConfig.org}/${repoName}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    return result.code === 0;
  } catch (error) {
    return false;
  }
}

export async function getRepoLastUpdated(hostConfig: HostConfig, repoName: string): Promise<string | null> {
  try {
    const args = ['api'];
    
    if (hostConfig.hostLabel !== 'github.com') {
      args.push('--hostname', hostConfig.hostLabel);
    }
    
    args.push(`/repos/${hostConfig.org}/${repoName}`);

    const result = await runGh(args, { GH_TOKEN: hostConfig.token });
    
    if (result.code !== 0) {
      return null;
    }

    const response = JSON.parse(result.stdout);
    return response.pushed_at || response.updated_at;
  } catch (error) {
    return null;
  }
}

export async function needsMigration(sourceConfig: HostConfig, targetConfig: HostConfig, repoName: string): Promise<{ needs: boolean; lastPushed?: string }> {
  // Check if repo exists in target
  const existsInTarget = await checkRepoExists(targetConfig, repoName);
  
  // Get source last updated time
  const sourceLastUpdated = await getRepoLastUpdated(sourceConfig, repoName);
  
  if (!existsInTarget) {
    console.log(`[${new Date().toISOString()}] ${repoName}: Not in target, needs migration`);
    return { needs: true, lastPushed: sourceLastUpdated || undefined };
  }

  // Get target last updated time
  const targetLastUpdated = await getRepoLastUpdated(targetConfig, repoName);

  if (!sourceLastUpdated || !targetLastUpdated) {
    console.log(`[${new Date().toISOString()}] ${repoName}: Could not determine update times, assuming needs migration`);
    return { needs: true, lastPushed: sourceLastUpdated || undefined };
  }

  const sourceDate = new Date(sourceLastUpdated).getTime();
  const targetDate = new Date(targetLastUpdated).getTime();

  if (sourceDate > targetDate) {
    console.log(`[${new Date().toISOString()}] ${repoName}: Source has newer changes (${sourceLastUpdated} > ${targetLastUpdated})`);
    return { needs: true, lastPushed: sourceLastUpdated };
  }

  console.log(`[${new Date().toISOString()}] ${repoName}: Target is up to date, skipping migration`);
  return { needs: false, lastPushed: sourceLastUpdated };
}
