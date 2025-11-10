import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadConfig, Config } from './config';
import * as state from './state';
import { checkGhCli, checkGeiExtension } from './github';
import { queueMigrations, pollMigrationStatuses } from './migrator';
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
let heartbeatInterval: NodeJS.Timeout | null = null;

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
  state.initState(config.source.org, config.target.org, config.source.hostLabel, config.target.hostLabel);

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

  // Queue migrations in background if not skipped
  if (!argv.noQueue) {
    // Run queueing in the background without blocking
    queueMigrationsAsync(config);
  }

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function startServer() {
  const app = express();

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

async function queueMigrationsAsync(config: Config) {
  try {
    await queueMigrations(config, broadcastStateUpdate);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error queueing migrations:`, error);
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
