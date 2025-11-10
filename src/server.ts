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
let statusWorkerRunning = false;
let statusWorkerCurrentRepo: string | null = null;
let migrationWorkerRunning = false;
let progressWorkerRunning = false;
let progressWorkerCurrentRepo: string | null = null;
const MAX_CONCURRENT_MIGRATIONS = 10;

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
    const inProgress = state.listAll().filter(r => 
      ['queued', 'exporting', 'exported', 'importing'].includes(r.status)
    );
    res.json({
      running: migrationWorkerRunning,
      inProgress: inProgress.length,
      maxConcurrent: MAX_CONCURRENT_MIGRATIONS
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
  
  // Check every hour for repos older than 5 minutes
  const statusWorkerIntervalSeconds = 3600; // 1 hour
  
  statusWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Status worker started (checking every ${statusWorkerIntervalSeconds}s)`);
  
  // Run immediately on startup
  statusWorkerCheck();
  
  // Then run on interval
  statusWorkerInterval = setInterval(statusWorkerCheck, statusWorkerIntervalSeconds * 1000);
  
  broadcastStateUpdate();
}

function stopStatusWorker() {
  if (!statusWorkerRunning) {
    return;
  }
  
  statusWorkerRunning = false;
  statusWorkerCurrentRepo = null;
  
  if (statusWorkerInterval) {
    clearInterval(statusWorkerInterval);
    statusWorkerInterval = null;
  }
  
  console.log(`[${new Date().toISOString()}] Status worker stopped`);
  broadcastStateUpdate();
}

async function statusWorkerCheck() {
  try {
    await checkOldestRepos(
      config, 
      broadcastStateUpdate, 
      5, 
      5,
      (repoName) => {
        statusWorkerCurrentRepo = repoName;
        broadcastStateUpdate();
      },
      () => {
        statusWorkerCurrentRepo = null;
        broadcastStateUpdate();
      }
    );
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in status worker:`, error);
  }
}

function startMigrationWorker() {
  if (migrationWorkerRunning) {
    return;
  }
  
  migrationWorkerRunning = true;
  console.log(`[${new Date().toISOString()}] Migration worker started (max ${MAX_CONCURRENT_MIGRATIONS} concurrent)`);
  
  broadcastStateUpdate();
  
  // Start the worker loop
  runMigrationWorkerTick();
}

function stopMigrationWorker() {
  if (!migrationWorkerRunning) {
    return;
  }
  
  migrationWorkerRunning = false;
  
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
    // Count current in-progress migrations
    const allRepos = state.listAll();
    const inProgress = allRepos.filter(r => 
      ['queued', 'exporting', 'exported', 'importing'].includes(r.status)
    );
    
    const slotsAvailable = MAX_CONCURRENT_MIGRATIONS - inProgress.length;
    
    if (slotsAvailable > 0) {
      // Try to queue up to available slots
      let queued = 0;
      for (let i = 0; i < slotsAvailable; i++) {
        const repoName = await queueNextRepo(config);
        if (repoName) {
          console.log(`[${new Date().toISOString()}] Migration worker: Queued ${repoName} (${inProgress.length + queued + 1}/${MAX_CONCURRENT_MIGRATIONS})`);
          queued++;
          broadcastStateUpdate();
        } else {
          break; // No more repos to queue
        }
      }
      
      if (queued > 0) {
        // Check again soon for more slots
        migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 5000);
      } else {
        // No repos to queue, wait longer
        migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 30000);
      }
    } else {
      // At capacity, check again soon
      migrationWorkerInterval = setTimeout(runMigrationWorkerTick, 10000);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error in migration worker:`, error);
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
      }
    );
    
    // Check again in a few seconds
    progressWorkerInterval = setTimeout(runProgressWorkerTick, 5000);
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

  // Save state
  await state.saveState();

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

// Start the application
main().catch(error => {
  console.error(`[${new Date().toISOString()}] Fatal error:`, error);
  process.exit(1);
});
