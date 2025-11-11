# GitHub Migration Dashboard

A TypeScript-based web dashboard for managing GitHub Enterprise Importer (GEI) migrations with real-time status updates. Uses `gh gei` CLI or GitHub APIs for all migration operations.

![screenshot](screenshot.png)

## Features

- **Real-time Dashboard**: Web interface showing all repositories under migration
- **Three Background Workers**: Independent Status, Migration, and Progress Workers with UI controls
- **Smart Sync Detection**: Automatically checks if repositories need migration by comparing source and target
- **Live Status Updates**: Real-time updates via Server-Sent Events as repositories are checked
- **Multi-select Filters**: Toggle status filters to show only the repositories you care about
- **Sortable Columns**: Click column headers to sort by name, status, last checked, or last change
- **Time Tracking**: Shows elapsed time for active migrations and timestamps for checks and changes
- **Persistent State**: Progress saved in local JSON file - resume anytime
- **Migration Logs**: View detailed migration logs with automatic log discovery for synced repos
- **Error Handling**: Retry failed migrations with automatic target repository deletion
- **Statistics**: Overview of unsynced, queued, syncing, synced, and failed repositories
- **Enhanced UI**: Error tooltips, log/error buttons, and improved status indicators

## Prerequisites

1. **Node.js** (v16 or later)
2. **GitHub CLI** (`gh`): [Install here](https://cli.github.com/)
3. **GEI Extension**: Install with `gh extension install github/gh-gei`

## Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Configuration

Copy `template.env` to `.env` and fill in your values:

```bash
cp template.env .env
```

Required environment variables:
- `GH_SOURCE_ENT`: Source enterprise name
- `GH_SOURCE_ORG`: Source organization name
- `GH_SOURCE_TOKEN`: GitHub PAT with repo, admin:org, admin:repo_hook, and workflow scopes
- `GH_TARGET_ENT`: Target enterprise name
- `GH_TARGET_ORG`: Target organization name  
- `GH_TARGET_TOKEN`: GitHub PAT with repo, admin:org, admin:repo_hook, and workflow scopes

Optional (for GitHub Enterprise Server):
- `GH_SOURCE_URL`: Source API URL (e.g., `https://ghe.example.com/api/v3`)
- `GH_TARGET_URL`: Target API URL (e.g., `https://ghe.example.com/api/v3`)

## Usage

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm run build
npm start
```

### Command Line Options

```bash
# Custom port
npm start -- --port 4000

# Custom polling interval (in seconds)
npm start -- --poll-seconds 30

# Show help
npm start -- --help
```

## How It Works

### Architecture

The application uses four independent components:

1. **Main Thread (Discovery)**: 
   - Web server starts immediately at `http://localhost:3000`
   - Loads existing state from `data/migrations-state.json` (if exists)
   - Performs one-time repository discovery from source organization
   - Adds any new repositories with `unknown` status
   - Does NOT check sync status or queue migrations
   
2. **Status Worker** (Background Thread):
   - Periodically checks repositories to update their sync status
   - **Prioritizes all `unknown` repos first** (checks all of them in one run)
   - After unknowns are checked, switches to checking 5 oldest repos per run
   - Compares `pushed_at` timestamps between source and target repositories
   - Marks repos as **UNSYNCED** if target is missing or has older commits
   - Marks repos as **SYNCED** if target is up to date
   - Runs every hour
   - Can be started/stopped via the dashboard UI
   - Shows currently checking repository in real-time
   
3. **Migration Worker** (Background Thread):
   - Queues migrations for unsynced repositories using `gh gei migrate-repo --queue-only`
   - Enforces max 10 concurrent queued repos to prevent overwhelming GitHub API
   - Automatically pauses queueing when limit reached, resumes after 30 seconds
   - Queues all available unsynced repos in each run (subject to concurrency limit)
   - Checks every 30 seconds for new unsynced repos
   - Automatically deletes target repository if "already contains" error occurs
   - Can be started/stopped via the dashboard UI
   - Shows currently queueing repository in real-time
   
4. **Progress Worker** (Background Thread):
   - Monitors in-progress migrations (queued and syncing)
   - Polls GitHub API every 60 seconds to check migration progress
   - Updates repository status as migrations complete
   - Automatically downloads migration logs when completed (success or failure)
   - Shows currently checking repository in real-time
   - Detects stale migrations (running >1 minute with status not found)
   - Marks stale migrations as `unknown` with error message
   - Does not check repos with `unknown`, `synced`, or `failed` status
   - Runs automatically on startup
   - Can be started/stopped via the dashboard UI

### Status Tracking

The dashboard uses a simplified 6-status system with color-coding:

- **UNKNOWN** (Yellow): Status not yet checked
- **UNSYNCED** (Yellow): Repository needs migration (target missing or out of date)
- **QUEUED** (Blue): Migration queued with GitHub but not started
- **SYNCING** (Blue): Migration in progress (exporting, importing, etc.)
- **SYNCED** (Green): Repository successfully synced and up to date
- **FAILED** (Red): Migration failed ❌

All GitHub migration API statuses are automatically mapped to these 6 states for a consistent, easy-to-understand view.

### Worker Control

All three workers can be independently controlled from the dashboard:
- **Status Worker**: Determines which repositories need syncing
- **Migration Worker**: Queues up to 10 migrations concurrently
- **Progress Worker**: Monitors in-progress migrations (auto-starts on startup)
- Start/stop any worker at any time
- Workers run concurrently without interference
- Live status shown for each worker

### Real-time Updates

- Updates broadcast via Server-Sent Events
- Dashboard updates automatically without page refresh
- Shows live progress of both workers
- Active migration polling configurable (default: 60 seconds)

### Persistence

- State saved to `data/migrations-state.json` after every update
- Stop and restart anytime - progress is preserved
- Workers remember their state across restarts

## Dashboard

Access the dashboard at `http://localhost:3000` (or your custom port).

### Worker Controls

Three independent workers in the header:

**Status Worker**:
- Shows current repository being checked (or "Running (idle)" or "Stopped")
- Start/Stop button to control the worker
- Runs every hour
- Checks ALL unknown repos first, then 5 oldest repos per run

**Migration Worker**:
- Shows currently queueing repository (or "Running (idle)" or "Stopped")
- Start/Stop button to control the worker
- Queues all available unsynced repos

**Progress Worker**:
- Shows current repository being checked (or "Running (idle)" or "Stopped")
- Start/Stop button to control the worker
- Monitors all in-progress migrations (auto-starts on startup)
- Polls every 60 seconds
- Automatically downloads logs when migrations complete
- Detects and marks stale migrations as unknown

### Summary Statistics
- Total repositories
- Unsynced (need migration)
- Queued for migration
- Syncing (migration in progress)
- Synced (up to date)
- Failed
- Unknown

### Interactive Filters

**Status Filters:**
- Click any status pill to toggle it on/off
- Click stat boxes (Total, Unsynced, etc.) to instantly filter by that status
- Multiple filters can be active simultaneously
- Filter by: UNSYNCED, QUEUED, SYNCING, SYNCED, FAILED, UNKNOWN

**Repository Name Filter:**
- Text input on the right side of filters
- Case-insensitive search
- Matches partial repository names
- Works in combination with status filters

### Repository Table
Sortable columns (click headers):
- **Repository**: Name of the repository
- **Status**: Current sync/migration status (color-coded pills)
- **Last Status Change**: When the status last changed (default sort, newest first)
- **Last Checked**: When the sync status was last verified
- **Last Commit**: When repository was last pushed to (yyyy-mm-dd format)
- **Duration**: Time spent on migration (starts when queued, stops when completed)
- **Actions**: Buttons for managing repository migrations

**Action Buttons**:
- **Retry** (Failed repos): Retry a failed migration. Automatically deletes the target repository if it was partially created.
- **Errors** (Failed repos): View detailed error message for a failed migration
- **Logs** (Synced/Failed repos): View detailed migration logs. For synced repos, shows cached logs or attempts to find them. For failed repos, shows available error logs.

## API Endpoints

### General
- `GET /`: Dashboard HTML
- `GET /api/state`: Current migration state (JSON)
- `GET /api/logs/:repo`: Migration logs for a specific repository
- `POST /api/repos/:repo/retry`: Retry a failed migration (deletes target repo if needed)
- `POST /api/logs/:repo/download`: Attempt to download and find logs for a synced repository
- `GET /events`: Server-Sent Events stream for real-time updates

### Status Worker
- `GET /api/status-worker`: Get worker status `{ running: boolean, currentRepo: string | null }`
- `POST /api/status-worker/start`: Start the Status Worker
- `POST /api/status-worker/stop`: Stop the Status Worker

### Migration Worker
- `GET /api/migration-worker`: Get worker status `{ running: boolean, currentRepo: string | null }`
- `POST /api/migration-worker/start`: Start the Migration Worker
- `POST /api/migration-worker/stop`: Stop the Migration Worker

### Progress Worker
- `GET /api/progress-worker`: Get worker status `{ running: boolean, currentRepo: string | null }`
- `POST /api/progress-worker/start`: Start the Progress Worker
- `POST /api/progress-worker/stop`: Stop the Progress Worker

## Code Structure

```
src/
├── workers/              # Independent worker modules
│   ├── discoveryWorker.ts   # Repository discovery
│   ├── statusWorker.ts      # Status checking
│   ├── migrationWorker.ts   # Migration queueing
│   └── progressWorker.ts    # Progress monitoring
├── ui/                   # Frontend files
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.ts            # Main server and worker coordination
├── config.ts            # Configuration management
├── state.ts             # State management
├── github.ts            # GitHub API interactions
└── logs.ts              # Log retrieval

data/
├── migrations-state.json  # Persistent state (git-ignored)
└── *.log                  # Downloaded migration logs

tmp/                     # Temporary files
```

## Graceful Shutdown

Press `Ctrl+C` to stop the server. It will:
1. Stop polling
2. Save current state
3. Close all client connections
4. Exit cleanly

## Troubleshooting

### "gh CLI not found"
Install GitHub CLI: https://cli.github.com/

### "gh gei extension not found"
Install the extension: `gh extension install github/gh-gei`

### "Failed to fetch repositories"
- Verify your tokens have correct scopes
- Check that tokens are SSO-authorized for the organization
- Ensure `GH_SOURCE_ORG` matches the actual organization name

### Migrations stuck in "queued"
- GitHub may be rate-limiting or processing other migrations
- Check the logs for specific errors
- Verify network connectivity to GitHub API
