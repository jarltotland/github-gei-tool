import * as fs from 'fs';
import * as path from 'path';
import { Config } from './config';
import { runGh } from './github';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const TMP_DIR = path.join(process.cwd(), 'tmp');

export async function getRepoLogs(config: Config, repoName: string): Promise<string> {
  const logFile = path.join(LOGS_DIR, `${repoName}.log`);

  // Check if we have cached logs
  if (fs.existsSync(logFile)) {
    return fs.readFileSync(logFile, 'utf8');
  }

  // Download fresh logs
  try {
    console.log(`[${new Date().toISOString()}] Downloading logs for ${repoName}...`);
    
    // Ensure directories exist
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }

    const args = [
      'gei', 'download-logs',
      '--github-target-org', config.target.org,
      '--target-repo', repoName,
      '--github-target-pat', config.target.token
    ];

    if (config.target.hostLabel !== 'github.com') {
      args.push('--target-api-url', config.target.restBase);
    }

    const result = await runGh(args);

    if (result.code !== 0) {
      const errorMsg = `Failed to download logs: ${result.stderr}`;
      console.error(`[${new Date().toISOString()}] ${errorMsg}`);
      return errorMsg;
    }

    // The output should contain the log content or tell us where it was saved
    let logContent = result.stdout;

    // If logs were downloaded to a file, read it
    const downloadedLog = findDownloadedLog(repoName);
    if (downloadedLog) {
      logContent = fs.readFileSync(downloadedLog, 'utf8');
      // Clean up the downloaded file
      fs.unlinkSync(downloadedLog);
    }

    // Cache the logs
    fs.writeFileSync(logFile, logContent, 'utf8');

    console.log(`[${new Date().toISOString()}] Logs for ${repoName} downloaded and cached`);
    return logContent;
  } catch (error) {
    const errorMsg = `Error downloading logs: ${String(error)}`;
    console.error(`[${new Date().toISOString()}] ${errorMsg}`);
    return errorMsg;
  }
}

function findDownloadedLog(repoName: string): string | null {
  // gh gei download-logs typically creates a file like migration-log-ORG-REPO-ID.log
  const cwd = process.cwd();
  const files = fs.readdirSync(cwd);

  for (const file of files) {
    if (file.startsWith('migration-log-') && file.includes(repoName) && file.endsWith('.log')) {
      return path.join(cwd, file);
    }
  }

  return null;
}
