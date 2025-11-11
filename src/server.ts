import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig, Config } from './config';
import * as state from './state';
import { checkGhCli, checkGeiExtension } from './github';
import { discoverRepositories } from './workers/discoveryWorker';
import { pollMigrationStatuses } from './workers/progressWorker';
import { checkOldestRepos } from './workers/statusWorker';
import { queueNextRepo } from './workers/migrationWorker';
import { getRepoLogs } from './logs';

const argv = yargs(hideBin(process.argv))
  .option('port', {
    type: 'number',
    default: 3000,
    description: 'Port for the web server'
  })
  .option('poll-seconds', {
    type: 'number',
    default: 60,
    description: 'Interval in seconds for polling migration status'
  })
  .option('no-queue', {
    type: 'boolean',
    default: false,
    description: 'Skip queueing migrations on startup'
  })
  .help()
  .parseSync();

let config: Config;
let sseClients: Response[] = [];
let pollInterval: NodeJS.Timeout | null = null;
let statusWorkerInterval: NodeJS.Timeout | null = null;
let migrationWorkerInterval: NodeJS.Timeout | null = null;
let progressWorkerInterval: NodeJS.Timeout | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
let backupInterval: NodeJS.Timeout | null = null;
let statusWorkerRunning = false;
let statusWorkerCurrentRepo: string | null = null;
let migrationWorkerRunning = false;
let migrationWorkerCurrentRepo: string | null = null;
let progressWorkerRunning = false;
let progressWorkerCurrentRepo: string | null = null;

async function main() {
  console.log(`[${new Date().toISOString()}] GitHub Migration Dashboard starting...`);

  // Load configuration
  config = loadConfig(argv.port, argv.pollSeconds);

  // Check prerequisites
  const hasGh = await checkGhCli();
  if (!hasGh) {
    console.error('Error: gh CLI not found. Please install it: https://cli.github.com/');
    process.exit(1);
  }

  const hasGei = await checkGeiExtension();
  if (!hasGei) {
    console.error('Error: gh gei extension not found. Please install it: gh extension install github/gh-gei');
    process.exit(1);
  }

  // Initialize state
  state.initState(config.source.enterprise, config.source.org, config.target.enterprise, config.target.org, config.source.hostLabel, config.target.hostLabel);

  // Print banner
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║        GitHub Migration Dashboard                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Source:  ${config.source.org} (${config.source.hostLabel})`);
  console.log(`  Target:  ${config.target.org} (${config.target.hostLabel})`);
  console.log(`  Port:    ${config.port}`);
  console.log(`  Poll:    Every ${config.pollSeconds} seconds`);
  console.log('');
  console.log(`  Dashboard: http://localhost:${config.port}`);
  console.log(`  API:       http://localhost:${config.port}/api/state`);
  console.log('');

  // Start web server immediately
  startServer();

  // Start polling
  startPolling();

  // Start status worker
  startStatusWorker();

  // Start progress worker (monitors in-progress migrations)
  startProgressWorker();

  // Start hourly backup scheduler
  startBackupScheduler();

  // Discover repositories in background (one-time)
  discoverRepositoriesAsync(config);

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startServer() {
  const app = express();
  
  // Parse JSON bodies
  app.use(express.json());

  // Serve static files
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'ui', 'index.html'));
  });

  app.get('/app.js', (req, res) => {
    res.type('application/javascript');
    res.sendFile(path.join(__dirname, 'ui', 'app.js'));
  });

  app.get('/styles.css', (req, res) => {
    res.type('text/css');
    res.sendFile(path.join(__dirname, 'ui', 'styles.css'));
  });

  // API endpoints
  app.get('/api/state', (req, res) => {
    res.json(state.getState());
  });

  app.get('/api/status-worker', (req, res) => {
    res.json({
      running: statusWorkerRunning,
      currentRepo: statusWorkerCurrentRepo
    });
  });

  app.post('/api/status-worker/start', (req, res) => {
    if (!statusWorkerRunning) {
      startStatusWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/status-worker/stop', (req, res) => {
    if (statusWorkerRunning) {
      stopStatusWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  app.get('/api/migration-worker', (req, res) => {
    res.json({
      running: migrationWorkerRunning,
      currentRepo: migrationWorkerCurrentRepo
    });
  });

  app.post('/api/migration-worker/start', (req, res) => {
    if (!migrationWorkerRunning) {
      startMigrationWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/migration-worker/stop', (req, res) => {
    if (migrationWorkerRunning) {
      stopMigrationWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  app.get('/api/progress-worker', (req, res) => {
    res.json({
      running: progressWorkerRunning,
      currentRepo: progressWorkerCurrentRepo
    });
  });

  app.post('/api/progress-worker/start', (req, res) => {
    if (!progressWorkerRunning) {
      startProgressWorker();
      res.json({ success: true, running: true });
    } else {
      res.json({ success: false, message: 'Already running' });
    }
  });

  app.post('/api/progress-worker/stop', (req, res) => {
    if (progressWorkerRunning) {
      stopProgressWorker();
      res.json({ success: true, running: false });
    } else {
      res.json({ success: false, message: 'Not running' });
    }
  });

  app.get('/api/logs/:repo', async (req, res) => {
    const repoName = req.params.repo;
    try {
      const logs = await getRepoLogs(config, repoName);
      res.type('text/plain');
      res.send(logs);
    } catch (error) {
      res.status(500).send(`Error retrieving logs: ${String(error)}`);
    }
  });

  app.post('/api/logs/:repo/download', async (req, res) => {
    const repoName = req.params.repo;
    try {
      const { downloadLogs } = await import('./logs');
      await downloadLogs(config, repoName);
      res.json({ success: true, message: `Logs downloaded for ${repoName}` });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  app.post('/api/repos/:repo/retry', async (req, res) => {
    const repoName = req.params.repo;
    try {
      const repo = state.getRepo(repoName);
      if (!repo) {
        return res.status(404).json({ success: false, error: `Repository ${repoName} not found` });
      }
      
      // Immediately set status to unsynced
      state.setStatus(repoName, 'unsynced');
      broadcastStateUpdate();
      
      // Queue the specific repo directly
      const { queueSingleRepo } = await import('./workers/migrationWorker');
      console.log(`[${new Date().toISOString()}] Retry: Queueing ${repoName}...`);
      await queueSingleRepo(config, repoName, repo.visibility);
      
      broadcastStateUpdate();
      res.json({ success: true, message: `Retry queued for ${repoName}` });
    } catch (error) {
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // Server-Sent Events endpoint
  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Add client to list
    sseClients.push(res);

    // Send initial state
    res.write(`event: state\n`);
    res.write(`data: ${JSON.stringify(state.getState())}\n\n`);

    // Remove client on disconnect
    req.on('close', () => {
      sseClients = sseClients.filter(client => client !== res);
    });
  });

  app.listen(config.port, () => {
    console.log(`[${new Date().toISOString()}] Server started on port ${config.port}`);
  });

  // Start heartbeat
  heartbeatInterval = setInterval(() => {
    broadcastSSE('heartbeat', '');
  }, config.sseHeartbeatSeconds * 1000);
}

function broadcastSSE(event: string, data: string) {
  const message = `event: ${event}\ndata: ${data}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      // Client disconnected
    }
  });
}

function broadcastStateUpdate() {
  broadcastSSE('state', JSON.stringify(state.getState()));
}

function startPolling() {
  // Poll immediately
  poll();

  // Then poll at interval
  pollInterval = setInterval(poll, config.pollSeconds * 1000);
}

function startStatusWorker() {
  if (statusWorkerRunning) {
    return;
  }
  
  statusWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Status worker started (continuous mode)`);
  
  broadcastStateUpdate();
  
  // Start the worker loop
  runStatusWorkerTick();
}

function stopStatusWorker() {
  if (!statusWorkerRunning) {
    return;
  }
  
  statusWorkerRunning = false;
  statusWorkerCurrentRepo = null;
  
  if (statusWorkerInterval) {
    clearTimeout(statusWorkerInterval);
    statusWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Status worker stopped`);
  broadcastStateUpdate();
}

async function runStatusWorkerTick() {
  // Exit if worker was stopped
  if (!statusWorkerRunning) {
    return;
  }
  
  try {
    // Check repos older than 1 hour, or all repos if some have never been checked
    const checkedCount = await checkOldestRepos(
      config, 
      broadcastStateUpdate, 
      60, // Check repos older than 60 minutes
      1,  // Check 1 repo at a time
      (repoName) => {
        statusWorkerCurrentRepo = repoName;
        broadcastStateUpdate();
      },
      () => {
        statusWorkerCurrentRepo = null;
        broadcastStateUpdate();
      },
      () => !statusWorkerRunning
    );
    
    // If we checked repos, immediately check for more
    if (checkedCount > 0) {
      // Schedule next tick immediately
      statusWorkerInterval = setTimeout(runStatusWorkerTick, 100);
    } else {
      // All repos checked within last hour, idle for 1 minute before checking again
      statusWorkerInterval = setTimeout(runStatusWorkerTick, 60 * 1000);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in status worker:`, error);
    // Retry after 1 minute on error
    statusWorkerInterval = setTimeout(runStatusWorkerTick, 60 * 1000);
  }
}

function startMigrationWorker() {
  if (migrationWorkerRunning) {
    return;
  }
  
  migrationWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Migration worker started`);
  
  broadcastStateUpdate();
  
  // Start the worker loop
  runMigrationWorkerTick();
}

function stopMigrationWorker() {
  if (!migrationWorkerRunning) {
    return;
  }
  
  migrationWorkerRunning = false;
  migrationWorkerCurrentRepo = null;
  
  if (migrationWorkerInterval) {
    clearTimeout(migrationWorkerInterval);
    migrationWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Migration worker stopped`);
  broadcastStateUpdate();
}

async function runMigrationWorkerTick() {
  // Exit if worker was stopped
  if (!migrationWorkerRunning) {
    return;
  }
  
  try {
    // Queue all unsynced repos
    let queued = 0;
    while (true) {
      // Check if worker was stopped
      if (!migrationWorkerRunning) {
        console.log(`[${new Date().toISOString()}] Migration worker: Stopping (worker disabled)`);
        migrationWorkerCurrentRepo = null;
        broadcastStateUpdate();
        return;
      }
      
      const repoName = await queueNextRepo(config, (name) => {
        migrationWorkerCurrentRepo = name;
        broadcastStateUpdate();
      });
      
      if (repoName) {
        console.log(`[${new Date().toISOString()}] Migration worker: Queued ${repoName}`);
        queued++;
        migrationWorkerCurrentRepo = null;
        broadcastStateUpdate();
      } else {
        migrationWorkerCurrentRepo = null;
        break; // No more repos to queue
      }
    }
    
    if (queued > 0) {
      console.log(`[${new Date().toISOString()}] Migration worker: Queued ${queued} repo${queued > 1 ? 's' : ''}`);
    }
    
    // Check again later for new repos
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 30000);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in migration worker:`, error);
    migrationWorkerCurrentRepo = null;
    broadcastStateUpdate();
    
    // Retry after a delay
    migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 10000);
  }
}

function startProgressWorker() {
  if (progressWorkerRunning) {
    return;
  }
  
  progressWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Progress worker started`);
  
  broadcastStateUpdate();
  
  // Start the worker loop
  runProgressWorkerTick();
}

function stopProgressWorker() {
  if (!progressWorkerRunning) {
    return;
  }
  
  progressWorkerRunning = false;
  progressWorkerCurrentRepo = null;
  
  if (progressWorkerInterval) {
    clearTimeout(progressWorkerInterval);
    progressWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Progress worker stopped`);
  broadcastStateUpdate();
}

async function runProgressWorkerTick() {
  // Exit if worker was stopped
  if (!progressWorkerRunning) {
    return;
  }
  
  try {
    // Poll all in-progress migrations
    await pollMigrationStatuses(
      config, 
      broadcastStateUpdate,
      (repoName) => {
        progressWorkerCurrentRepo = repoName;
        broadcastStateUpdate();
      },
      () => {
        progressWorkerCurrentRepo = null;
        broadcastStateUpdate();
      },
      () => !progressWorkerRunning
    );
    
    // Check again in 1 minute
    progressWorkerInterval = setTimeout(runProgressWorkerTick, 60000);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in progress worker:`, error);
    progressWorkerCurrentRepo = null;
    broadcastStateUpdate();
    
    // Retry after a delay
    progressWorkerInterval = setTimeout(runProgressWorkerTick, 10000);
  }
}

async function discoverRepositoriesAsync(config: Config) {
  try {
    await discoverRepositories(config, broadcastStateUpdate);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error discovering repositories:`, error);
  }
}

async function poll() {
  try {
    await pollMigrationStatuses(config, broadcastStateUpdate);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error polling migrations:`, error);
  }
}

async function shutdown() {
  console.log(`\n[${new Date().toISOString()}] Shutting down gracefully...`);

  // Stop polling
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  if (statusWorkerInterval) {
    clearInterval(statusWorkerInterval);
  }

  if (migrationWorkerInterval) {
    clearTimeout(migrationWorkerInterval);
  }

  if (progressWorkerInterval) {
    clearTimeout(progressWorkerInterval);
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  if (backupInterval) {
    clearTimeout(backupInterval);
  }

  // Flush any pending debounced saves
  console.log(`[${new Date().toISOString()}] Flushing pending state changes...`);
  await state.flushPendingSaves();

  // Close SSE connections
  sseClients.forEach(client => {
    try {
      client.end();
    } catch (error) {
      // Ignore
    }
  });

  console.log(`[${new Date().toISOString()}] Shutdown complete`);
  process.exit(0);
}

function startBackupScheduler() {
  const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
  const STATE_FILE = path.join(process.cwd(), 'data', 'migrations-state.json');
  const MAX_BACKUPS = 24;

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const performBackup = async () => {
    try {
      // Check if state file exists
      if (!fs.existsSync(STATE_FILE)) {
        console.log(`[${new Date().toISOString()}] Backup: State file not found, skipping`);
        return;
      }

      // Create backup filename with timestamp
      const now = new Date();
      const timestamp = now.toISOString()
        .replace(/T/, '-')
        .replace(/:/g, '-')
        .replace(/\..*/, '')
        .substring(0, 16); // YYYY-MM-DD-HH-mm
      const backupFile = path.join(BACKUP_DIR, `migrations-state-${timestamp}.json`);

      // Copy state file to backup
      await fs.promises.copyFile(STATE_FILE, backupFile);
      console.log(`[${new Date().toISOString()}] Backup: Created ${path.basename(backupFile)}`);

      // Rotate old backups
      const files = await fs.promises.readdir(BACKUP_DIR);
      const backupFiles = files
        .filter(f => f.startsWith('migrations-state-') && f.endsWith('.json'))
        .sort()
        .reverse(); // Newest first

      // Delete oldest backups if we have more than MAX_BACKUPS
      if (backupFiles.length > MAX_BACKUPS) {
        const toDelete = backupFiles.slice(MAX_BACKUPS);
        for (const file of toDelete) {
          await fs.promises.unlink(path.join(BACKUP_DIR, file));
          console.log(`[${new Date().toISOString()}] Backup: Deleted old backup ${file}`);
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Backup: Error creating backup:`, error);
    }
  };

  // Calculate time until next hour
  const now = new Date();
  const msUntilNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();

  console.log(`[${new Date().toISOString()}] Backup scheduler: First backup in ${Math.round(msUntilNextHour / 1000 / 60)} minutes`);

  // Schedule first backup at the next hour
  backupInterval = setTimeout(() => {
    performBackup();
    // Then run every hour
    backupInterval = setInterval(performBackup, 60 * 60 * 1000);
  }, msUntilNextHour);
}

// Start the application
main().catch(error => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, error);
  process.exit(1);
});
