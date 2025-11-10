import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

export interface HostConfig {
  hostLabel: string;
  restBase: string;
  graphqlUrl: string;
  token: string;
  enterprise: string;
  org: string;
}

export interface Config {
  source: HostConfig;
  target: HostConfig;
  port: number;
  pollSeconds: number;
  sseHeartbeatSeconds: number;
}

function deriveEndpoints(url: string | undefined, isSource: boolean): { restBase: string; graphqlUrl: string; hostLabel: string } {
  if (!url || url.trim() === '') {
    // Default to github.com
    return {
      restBase: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
      hostLabel: 'github.com'
    };
  }

  // Parse the URL to extract host
  const urlObj = new URL(url);
  const host = urlObj.hostname;
  
  // For GHES, the URL is typically https://hostname/api/v3
  return {
    restBase: url,
    graphqlUrl: `${urlObj.protocol}//${host}/api/graphql`,
    hostLabel: host
  };
}

export function loadConfig(cliPort?: number, cliPollSeconds?: number): Config {
  const sourceToken = process.env.GH_SOURCE_TOKEN;
  const targetToken = process.env.GH_TARGET_TOKEN;
  const sourceEnt = process.env.GH_SOURCE_ENT;
  const targetEnt = process.env.GH_TARGET_ENT;
  const sourceOrg = process.env.GH_SOURCE_ORG;
  const targetOrg = process.env.GH_TARGET_ORG;

  if (!sourceToken) {
    console.error('Error: GH_SOURCE_TOKEN environment variable must be set');
    process.exit(1);
  }

  if (!targetToken) {
    console.error('Error: GH_TARGET_TOKEN environment variable must be set');
    process.exit(1);
  }

  if (!sourceEnt) {
    console.error('Error: GH_SOURCE_ENT environment variable must be set');
    process.exit(1);
  }

  if (!targetEnt) {
    console.error('Error: GH_TARGET_ENT environment variable must be set');
    process.exit(1);
  }

  if (!sourceOrg) {
    console.error('Error: GH_SOURCE_ORG environment variable must be set');
    process.exit(1);
  }

  if (!targetOrg) {
    console.error('Error: GH_TARGET_ORG environment variable must be set');
    process.exit(1);
  }

  const sourceUrl = process.env.GH_SOURCE_URL;
  const targetUrl = process.env.GH_TARGET_URL;

  const sourceEndpoints = deriveEndpoints(sourceUrl, true);
  const targetEndpoints = deriveEndpoints(targetUrl, false);

  return {
    source: {
      ...sourceEndpoints,
      token: sourceToken,
      enterprise: sourceEnt,
      org: sourceOrg
    },
    target: {
      ...targetEndpoints,
      token: targetToken,
      enterprise: targetEnt,
      org: targetOrg
    },
    port: cliPort || 3000,
    pollSeconds: cliPollSeconds || 60,
    sseHeartbeatSeconds: 15
  };
}
