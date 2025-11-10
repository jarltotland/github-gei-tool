let state = null;
let eventSource = null;
let sortColumn = 'name';
let sortDirection = 'asc';
let activeFilters = new Set(['needs_migration', 'queued', 'exporting', 'exported', 'importing', 'synced', 'imported', 'failed', 'unknown']);

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    loadState();
    connectSSE();
    startElapsedTimer();
    setupSorting();
    setupFilters();
});

async function loadState() {
    try {
        const response = await fetch('/api/state');
        state = await response.json();
        renderState();
    } catch (error) {
        console.error('Failed to load state:', error);
    }
}

function connectSSE() {
    eventSource = new EventSource('/events');

    eventSource.addEventListener('state', (event) => {
        state = JSON.parse(event.data);
        renderState();
    });

    eventSource.addEventListener('heartbeat', () => {
        // Keep connection alive
    });

    eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        // Reconnect after 5 seconds
        setTimeout(() => {
            if (eventSource) {
                eventSource.close();
            }
            connectSSE();
        }, 5000);
    };
}

function renderState() {
    if (!state) return;

    // Update header info
    document.getElementById('info').textContent = 
        `Migrating from enterprise/${state.sourceOrg} (${state.sourceHost}) to enterprise/${state.targetOrg} (${state.targetHost})`;

    // Calculate stats
    const repos = Object.values(state.repos);
    const stats = {
        total: repos.length,
        unsynced: repos.filter(r => r.status === 'needs_migration').length,
        queued: repos.filter(r => r.status === 'queued').length,
        progress: repos.filter(r => ['exporting', 'exported', 'importing'].includes(r.status)).length,
        synced: repos.filter(r => r.status === 'synced' || r.status === 'imported').length,
        failed: repos.filter(r => r.status === 'failed').length
    };

    // Update stats
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-unsynced').textContent = stats.unsynced;
    document.getElementById('stat-queued').textContent = stats.queued;
    document.getElementById('stat-progress').textContent = stats.progress;
    document.getElementById('stat-synced').textContent = stats.synced;
    document.getElementById('stat-failed').textContent = stats.failed;

    // Render table
    renderTable(repos);
}

function renderTable(repos) {
    const tbody = document.getElementById('migrations-tbody');
    
    // Apply filter - show repos that match any active filter
    repos = repos.filter(r => activeFilters.has(r.status));
    
    if (repos.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">No repositories found</td></tr>';
        return;
    }

    // Apply sorting
    repos = sortRepos(repos);

    tbody.innerHTML = repos.map(repo => {
        const elapsed = formatElapsedTime(repo);
        const statusClass = `status-${repo.status}`;
        const visibilityClass = `visibility-${repo.visibility}`;
        const lastChecked = repo.lastChecked ? formatTimestamp(repo.lastChecked) : '-';
        const lastPushed = repo.lastPushed ? formatTimestamp(repo.lastPushed, true) : '-';
        
        return `
            <tr>
                <td><strong>${escapeHtml(repo.name)}</strong></td>
                <td><span class="status-badge ${statusClass}">${getStatusLabel(repo.status)}</span></td>
                <td><span class="visibility-badge ${visibilityClass}">${repo.visibility.toUpperCase()}</span></td>
                <td class="timestamp">${lastChecked}</td>
                <td class="timestamp">${lastPushed}</td>
                <td class="elapsed-time" data-repo="${escapeHtml(repo.name)}">${elapsed}</td>
                <td><code>${repo.migrationId || '-'}</code></td>
                <td>
                    <button onclick="showLogs('${escapeHtml(repo.name)}')" 
                            ${!repo.migrationId ? 'disabled' : ''}>
                        View Logs
                    </button>
                    ${repo.errorMessage ? `<br><small style="color: #d73a49;">${escapeHtml(repo.errorMessage.substring(0, 50))}...</small>` : ''}
                </td>
            </tr>
        `;
    }).join('');
}

function formatElapsedTime(repo) {
    if (repo.endedAt && repo.elapsedSeconds !== undefined) {
        return formatSeconds(repo.elapsedSeconds);
    }

    if (repo.startedAt) {
        const start = new Date(repo.startedAt).getTime();
        const now = Date.now();
        const seconds = Math.floor((now - start) / 1000);
        return formatSeconds(seconds);
    }

    return '-';
}

function formatSeconds(seconds) {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    
    if (minutes < 60) {
        return `${minutes}m ${secs}s`;
    }
    
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m ${secs}s`;
}

function startElapsedTimer() {
    setInterval(() => {
        if (!state) return;
        
        // Update elapsed times for active repos
        const repos = Object.values(state.repos);
        repos.forEach(repo => {
            if (!repo.endedAt && repo.startedAt) {
                const cell = document.querySelector(`td.elapsed-time[data-repo="${repo.name}"]`);
                if (cell) {
                    const start = new Date(repo.startedAt).getTime();
                    const now = Date.now();
                    const seconds = Math.floor((now - start) / 1000);
                    cell.textContent = formatSeconds(seconds);
                }
            }
        });
    }, 1000);
}

async function showLogs(repoName) {
    const modal = document.getElementById('logs-modal');
    const title = document.getElementById('modal-title');
    const content = document.getElementById('logs-content');

    title.textContent = `Migration Logs - ${repoName}`;
    content.textContent = 'Loading...';
    modal.classList.add('show');

    try {
        const response = await fetch(`/api/logs/${encodeURIComponent(repoName)}`);
        const logs = await response.text();
        content.textContent = logs;
    } catch (error) {
        content.textContent = `Error loading logs: ${error.message}`;
    }
}

function closeLogsModal() {
    const modal = document.getElementById('logs-modal');
    modal.classList.remove('show');
}

// Close modal on backdrop click
document.getElementById('logs-modal').addEventListener('click', (e) => {
    if (e.target.id === 'logs-modal') {
        closeLogsModal();
    }
});

// Close modal on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeLogsModal();
    }
});

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function setupSorting() {
    document.querySelectorAll('th.sortable').forEach(header => {
        header.addEventListener('click', () => {
            const column = header.getAttribute('data-sort');
            
            if (sortColumn === column) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = column;
                sortDirection = 'asc';
            }
            
            // Update header classes
            document.querySelectorAll('th.sortable').forEach(h => {
                h.classList.remove('sort-asc', 'sort-desc');
            });
            header.classList.add(`sort-${sortDirection}`);
            
            // Re-render table
            if (state) {
                renderState();
            }
        });
    });
    
    // Set initial sort indicator
    const initialHeader = document.querySelector(`th[data-sort="${sortColumn}"]`);
    if (initialHeader) {
        initialHeader.classList.add('sort-asc');
    }
}

function sortRepos(repos) {
    return repos.sort((a, b) => {
        let aVal, bVal;
        
        if (sortColumn === 'name') {
            aVal = a.name.toLowerCase();
            bVal = b.name.toLowerCase();
        } else if (sortColumn === 'status') {
            aVal = a.status;
            bVal = b.status;
        } else if (sortColumn === 'lastChecked') {
            aVal = a.lastChecked ? new Date(a.lastChecked).getTime() : 0;
            bVal = b.lastChecked ? new Date(b.lastChecked).getTime() : 0;
        } else if (sortColumn === 'lastPushed') {
            aVal = a.lastPushed ? new Date(a.lastPushed).getTime() : 0;
            bVal = b.lastPushed ? new Date(b.lastPushed).getTime() : 0;
        }
        
        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
}

function formatTimestamp(isoString, useShortDate = false) {
    const date = new Date(isoString);
    const now = new Date();
    const diffSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (diffSeconds < 60) {
        return 'Just now';
    } else if (diffSeconds < 3600) {
        const minutes = Math.floor(diffSeconds / 60);
        return `${minutes}m ago`;
    } else if (diffSeconds < 86400) {
        const hours = Math.floor(diffSeconds / 3600);
        return `${hours}h ago`;
    } else {
        if (useShortDate) {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        return date.toLocaleString();
    }
}

function setupFilters() {
    const filterPills = document.querySelectorAll('.filter-pill');
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const status = pill.getAttribute('data-status');
            
            // Toggle this filter
            if (activeFilters.has(status)) {
                activeFilters.delete(status);
                pill.classList.remove('active');
            } else {
                activeFilters.add(status);
                pill.classList.add('active');
            }
            
            // Re-render
            if (state) {
                renderState();
            }
        });
    });
}

function getStatusLabel(status) {
    const labels = {
        'needs_migration': 'UNSYNCED',
        'queued': 'QUEUED',
        'exporting': 'IN PROGRESS',
        'exported': 'IN PROGRESS',
        'importing': 'IN PROGRESS',
        'synced': 'SYNCED',
        'imported': 'SYNCED',
        'failed': 'FAILED',
        'unknown': 'UNKNOWN'
    };
    return labels[status] || status.toUpperCase();
}
