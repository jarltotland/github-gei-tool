# GitHub Migration Dashboard

A TypeScript-based web dashboard for managing GitHub Enterprise Importer (GEI) migrations with real-time status updates.

## Features

- **Real-time Dashboard**: Web interface showing all repositories under migration
- **Smart Sync Detection**: Automatically checks if repositories need migration by comparing source and target
- **Live Status Updates**: Real-time updates via Server-Sent Events as repositories are checked
- **Multi-select Filters**: Toggle status filters to show only the repositories you care about
- **Sortable Columns**: Click column headers to sort by name, status, last checked, or last change
- **Time Tracking**: Shows elapsed time for active migrations and timestamps for checks and changes
- **Persistent State**: Progress saved in local JSON file - resume anytime
- **Migration Logs**: Click any repository to view detailed migration logs
- **Statistics**: Overview of unsynced, queued, in-progress, synced, and failed repositories

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
- `GH_SOURCE_ORG`: Source organization name
- `GH_SOURCE_TOKEN`: GitHub PAT with repo, admin:org, admin:repo_hook, and workflow scopes
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

# Skip queueing migrations on startup (resume only)
npm start -- --no-queue

# Show help
npm start -- --help
```

## How It Works

1. **Startup**: 
   - Web server starts immediately at `http://localhost:3000`
   - Loads existing state from `data/migrations-state.json` (if exists)
   - Fetches all repositories from source organization in background
   - Checks each repository against target to determine sync status
   - **Does NOT automatically queue migrations** - manual action required
   
2. **Sync Detection**: 
   - Compares `pushed_at` timestamps between source and target repositories
   - Marks repos as **UNSYNCED** if target is missing or has older commits
   - Marks repos as **SYNCED** if target is up to date
   
3. **Real-time Updates**: 
   - Updates broadcast via Server-Sent Events as each repo is checked
   - Dashboard updates automatically without page refresh
   - Poll migrations every 60 seconds (configurable) for active migrations
   
4. **Status Tracking**:
   - **UNSYNCED**: Repository needs migration (target missing or out of date)
   - **QUEUED**: Migration queued but not started
   - **IN PROGRESS**: Exporting, exported, or importing
   - **SYNCED**: Repository up to date in target
   - **FAILED**: Migration failed ❌
   - **UNKNOWN**: Status cannot be determined

5. **Persistence**: 
   - State saved to `data/migrations-state.json` after every update
   - Stop and restart anytime - progress is preserved

## Dashboard

Access the dashboard at `http://localhost:3000` (or your custom port).

### Summary Statistics
- Total repositories
- Unsynced (need migration)
- Queued for migration
- In Progress (exporting/importing)
- Synced (up to date)
- Failed

### Interactive Filters
Toggle status filters to show/hide repositories:
- Click any status pill to toggle it on/off
- Multiple filters can be active simultaneously
- Filter by: UNSYNCED, QUEUED, IN PROGRESS, SYNCED, FAILED, UNKNOWN

### Repository Table
Sortable columns (click headers):
- **Repository**: Name of the repository
- **Status**: Current sync/migration status (color-coded pills)
- **Visibility**: PUBLIC, PRIVATE, or INTERNAL (color-coded pills)
- **Last Checked**: When the sync status was last verified
- **Last Change**: When repository was last pushed to (yyyy-mm-dd format)
- **Elapsed Time**: Time spent on migration (for active migrations)
- **Migration ID**: GitHub migration identifier
- **Actions**: View detailed migration logs

Click "View Logs" to see detailed migration logs for any repository.

## API Endpoints

- `GET /`: Dashboard HTML
- `GET /api/state`: Current migration state (JSON)
- `GET /api/logs/:repo`: Migration logs for a specific repository
- `GET /events`: Server-Sent Events stream for real-time updates

## Files and Directories

- `src/`: TypeScript source code
- `dist/`: Compiled JavaScript (generated)
- `data/migrations-state.json`: Persistent migration state
- `logs/`: Cached migration logs
- `tmp/`: Temporary files

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

## Migrating from gei.sh

The new TypeScript version replaces `gei.sh` with these improvements:

✅ **Added**:
- Web dashboard with real-time updates
- Persistent state across restarts
- Live elapsed time tracking
- Statistics overview
- Log viewing in browser

✅ **Kept**:
- All environment variables same as before
- Same migration queueing logic
- Compatible with existing `.env` files

## License

ISC
