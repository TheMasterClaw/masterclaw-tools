// events.js - Event tracking and notification history for MasterClaw
// Tracks system events: backups, deployments, alerts, and custom events

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const events = new Command('events');

// Event storage path
const EVENTS_DIR = path.join(os.homedir(), '.masterclaw', 'events');
const EVENTS_FILE = path.join(EVENTS_DIR, 'events.json');
const MAX_EVENTS = 1000; // Keep last 1000 events

// Event types with icons
const EVENT_TYPES = {
  backup: { icon: '💾', color: chalk.cyan },
  deploy: { icon: '🚀', color: chalk.green },
  alert: { icon: '🔔', color: chalk.yellow },
  error: { icon: '❌', color: chalk.red },
  warning: { icon: '⚠️', color: chalk.yellow },
  info: { icon: 'ℹ️', color: chalk.blue },
  security: { icon: '🔒', color: chalk.magenta },
  maintenance: { icon: '🔧', color: chalk.gray },
  restore: { icon: '📦', color: chalk.cyan },
  update: { icon: '⬆️', color: chalk.green },
};

// Severity levels
const SEVERITY = {
  critical: { priority: 0, color: chalk.bgRed.white },
  high: { priority: 1, color: chalk.red },
  medium: { priority: 2, color: chalk.yellow },
  low: { priority: 3, color: chalk.gray },
  info: { priority: 4, color: chalk.blue },
};

/**
 * Initialize events storage
 */
async function initStorage() {
  await fs.ensureDir(EVENTS_DIR);
  if (!await fs.pathExists(EVENTS_FILE)) {
    await fs.writeJson(EVENTS_FILE, { events: [], version: 1 }, { spaces: 2 });
  }
}

/**
 * Load events from storage
 */
async function loadEvents() {
  await initStorage();
  try {
    const data = await fs.readJson(EVENTS_FILE);
    return data.events || [];
  } catch (err) {
    return [];
  }
}

/**
 * Save events to storage
 */
async function saveEvents(eventList) {
  await fs.writeJson(EVENTS_FILE, { events: eventList, version: 1 }, { spaces: 2 });
}

/**
 * Add a new event
 */
async function addEvent(type, title, message, options = {}) {
  const event = {
    id: generateEventId(),
    type: type || 'info',
    title,
    message,
    severity: options.severity || 'info',
    source: options.source || 'cli',
    metadata: options.metadata || {},
    timestamp: new Date().toISOString(),
    acknowledged: false,
    acknowledgedAt: null,
  };

  const eventList = await loadEvents();
  eventList.unshift(event); // Add to beginning

  // Trim to max events
  if (eventList.length > MAX_EVENTS) {
    eventList.splice(MAX_EVENTS);
  }

  await saveEvents(eventList);
  return event;
}

/**
 * Generate unique event ID
 */
function generateEventId() {
  return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Format event for display
 */
function formatEvent(event, options = {}) {
  const typeConfig = EVENT_TYPES[event.type] || EVENT_TYPES.info;
  const severityConfig = SEVERITY[event.severity] || SEVERITY.info;
  const date = new Date(event.timestamp);
  const timeStr = date.toLocaleString();
  const relativeTime = getRelativeTime(date);

  if (options.compact) {
    const ackMarker = event.acknowledged ? '✓' : '○';
    return `${ackMarker} ${typeConfig.icon} [${event.severity.toUpperCase()}] ${event.title} (${relativeTime})`;
  }

  const lines = [
    `${typeConfig.icon} ${chalk.bold(event.title)}`,
    `   ${chalk.gray('ID:')} ${event.id}`,
    `   ${chalk.gray('Type:')} ${typeConfig.color(event.type)} ${chalk.gray('|')} ${chalk.gray('Severity:')} ${severityConfig.color(event.severity)}`,
    `   ${chalk.gray('Time:')} ${timeStr} ${chalk.gray(`(${relativeTime})`)}`,
    `   ${chalk.gray('Source:')} ${event.source}`,
  ];

  if (event.message) {
    lines.push(`   ${chalk.gray('Message:')} ${event.message}`);
  }

  if (event.acknowledged) {
    lines.push(`   ${chalk.green('✓ Acknowledged')}`);
  } else if (event.severity === 'critical' || event.severity === 'high') {
    lines.push(`   ${chalk.red('○ Unacknowledged')}`);
  }

  // Show metadata if present and verbose
  if (options.verbose && Object.keys(event.metadata).length > 0) {
    lines.push(`   ${chalk.gray('Metadata:')}`);
    for (const [key, value] of Object.entries(event.metadata)) {
      lines.push(`     ${chalk.gray(`${key}:`)} ${value}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get relative time string
 */
function getRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

/**
 * Filter events based on criteria
 */
function filterEvents(eventList, filters = {}) {
  return eventList.filter(event => {
    if (filters.type && event.type !== filters.type) return false;
    if (filters.severity && event.severity !== filters.severity) return false;
    if (filters.source && event.source !== filters.source) return false;
    if (filters.acknowledged !== undefined && event.acknowledged !== filters.acknowledged) return false;
    if (filters.since) {
      const sinceDate = new Date(filters.since);
      if (new Date(event.timestamp) < sinceDate) return false;
    }
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      const matches =
        event.title.toLowerCase().includes(searchLower) ||
        (event.message && event.message.toLowerCase().includes(searchLower)) ||
        event.type.toLowerCase().includes(searchLower);
      if (!matches) return false;
    }
    return true;
  });
}

// =============================================================================
// CLI Commands
// =============================================================================

// List events command
events
  .command('list')
  .description('List system events with filtering options')
  .option('-t, --type <type>', 'Filter by event type (backup, deploy, alert, error, warning, info, security, maintenance, restore, update)')
  .option('-s, --severity <severity>', 'Filter by severity (critical, high, medium, low, info)')
  .option('--source <source>', 'Filter by source')
  .option('-a, --acknowledged', 'Show only acknowledged events')
  .option('-u, --unacknowledged', 'Show only unacknowledged events')
  .option('--since <duration>', 'Show events since duration (e.g., 1h, 1d, 7d)')
  .option('--search <query>', 'Search in event titles and messages')
  .option('-l, --limit <n>', 'Limit number of events', '50')
  .option('--compact', 'Compact output format')
  .option('-v, --verbose', 'Show detailed information including metadata')
  .action(async (options) => {
    const eventList = await loadEvents();

    // Build filters
    const filters = {};
    if (options.type) filters.type = options.type;
    if (options.severity) filters.severity = options.severity;
    if (options.source) filters.source = options.source;
    if (options.acknowledged) filters.acknowledged = true;
    if (options.unacknowledged) filters.acknowledged = false;
    if (options.search) filters.search = options.search;

    // Parse since duration
    if (options.since) {
      const match = options.since.match(/^(\d+)([hdwmy])$/);
      if (match) {
        const [, num, unit] = match;
        const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
        const sinceMs = Date.now() - (parseInt(num) * multipliers[unit]);
        filters.since = new Date(sinceMs).toISOString();
      }
    }

    let filtered = filterEvents(eventList, filters);
    const total = filtered.length;

    // Apply limit
    const limit = parseInt(options.limit, 10);
    filtered = filtered.slice(0, limit);

    if (filtered.length === 0) {
      console.log(chalk.gray('No events found matching the criteria.'));
      return;
    }

    console.log(chalk.blue('🐾 MasterClaw Events'));
    console.log(chalk.gray(`Showing ${filtered.length} of ${total} events\n`));

    for (const event of filtered) {
      console.log(formatEvent(event, options));
      if (!options.compact) console.log();
    }

    // Show summary
    const unackCritical = eventList.filter(e =>
      !e.acknowledged && (e.severity === 'critical' || e.severity === 'high')
    ).length;

    if (unackCritical > 0) {
      console.log(chalk.yellow(`⚠️  ${unackCritical} unacknowledged critical/high severity events`));
      console.log(chalk.gray('   Run "mc events ack-all" to acknowledge all'));
    }
  });

// Show single event command
events
  .command('show <id>')
  .description('Show detailed information about a specific event')
  .action(async (id) => {
    const eventList = await loadEvents();
    const event = eventList.find(e => e.id === id || e.id.startsWith(id));

    if (!event) {
      console.log(chalk.red(`❌ Event not found: ${id}`));
      console.log(chalk.gray('   Use "mc events list" to see available events'));
      process.exit(1);
    }

    console.log(formatEvent(event, { verbose: true }));
  });

// Acknowledge event command
events
  .command('ack <id>')
  .description('Acknowledge an event by ID')
  .action(async (id) => {
    const eventList = await loadEvents();
    const event = eventList.find(e => e.id === id || e.id.startsWith(id));

    if (!event) {
      console.log(chalk.red(`❌ Event not found: ${id}`));
      process.exit(1);
    }

    if (event.acknowledged) {
      console.log(chalk.yellow('⚠️  Event is already acknowledged'));
      return;
    }

    event.acknowledged = true;
    event.acknowledgedAt = new Date().toISOString();
    await saveEvents(eventList);

    console.log(chalk.green(`✅ Acknowledged event: ${event.title}`));
  });

// Acknowledge all events command
events
  .command('ack-all')
  .description('Acknowledge all unacknowledged events')
  .option('-s, --severity <severity>', 'Only acknowledge events of specific severity')
  .action(async (options) => {
    const eventList = await loadEvents();
    let toAcknowledge = eventList.filter(e => !e.acknowledged);

    if (options.severity) {
      toAcknowledge = toAcknowledge.filter(e => e.severity === options.severity);
    }

    if (toAcknowledge.length === 0) {
      console.log(chalk.gray('No unacknowledged events to acknowledge.'));
      return;
    }

    const now = new Date().toISOString();
    for (const event of toAcknowledge) {
      event.acknowledged = true;
      event.acknowledgedAt = now;
    }

    await saveEvents(eventList);
    console.log(chalk.green(`✅ Acknowledged ${toAcknowledge.length} events`));
  });

// Add custom event command
events
  .command('add <title>')
  .description('Add a custom event to the log')
  .option('-t, --type <type>', 'Event type', 'info')
  .option('-s, --severity <severity>', 'Event severity', 'info')
  .option('-m, --message <message>', 'Event message/details')
  .option('--source <source>', 'Event source', 'user')
  .action(async (title, options) => {
    const event = await addEvent(options.type, title, options.message, {
      severity: options.severity,
      source: options.source,
    });

    const typeConfig = EVENT_TYPES[event.type] || EVENT_TYPES.info;
    console.log(chalk.green(`✅ Event added: ${typeConfig.icon} ${event.title}`));
    console.log(chalk.gray(`   ID: ${event.id}`));
  });

// Get event statistics
events
  .command('stats')
  .description('Show event statistics and summaries')
  .option('--since <duration>', 'Stats since duration (e.g., 24h, 7d)', '7d')
  .action(async (options) => {
    const eventList = await loadEvents();

    // Parse since duration
    let sinceDate = new Date(0);
    if (options.since) {
      const match = options.since.match(/^(\d+)([hdwmy])$/);
      if (match) {
        const [, num, unit] = match;
        const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
        sinceDate = new Date(Date.now() - (parseInt(num) * multipliers[unit]));
      }
    }

    const filtered = eventList.filter(e => new Date(e.timestamp) >= sinceDate);

    // Calculate stats
    const stats = {
      total: filtered.length,
      byType: {},
      bySeverity: {},
      acknowledged: 0,
      unacknowledged: 0,
      criticalUnacknowledged: 0,
    };

    for (const event of filtered) {
      stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;
      stats.bySeverity[event.severity] = (stats.bySeverity[event.severity] || 0) + 1;
      if (event.acknowledged) {
        stats.acknowledged++;
      } else {
        stats.unacknowledged++;
        if (event.severity === 'critical') {
          stats.criticalUnacknowledged++;
        }
      }
    }

    console.log(chalk.blue('🐾 Event Statistics'));
    console.log(chalk.gray(`Period: ${options.since}\n`));

    console.log(chalk.cyan('Overview:'));
    console.log(`  Total events: ${stats.total}`);
    console.log(`  Acknowledged: ${chalk.green(stats.acknowledged)}`);
    console.log(`  Unacknowledged: ${stats.unacknowledged > 0 ? chalk.yellow(stats.unacknowledged) : chalk.gray(stats.unacknowledged)}`);
    if (stats.criticalUnacknowledged > 0) {
      console.log(`  ${chalk.red(`⚠️  Critical unacknowledged: ${stats.criticalUnacknowledged}`)}`);
    }

    console.log(chalk.cyan('\nBy Type:'));
    for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
      const typeConfig = EVENT_TYPES[type] || EVENT_TYPES.info;
      console.log(`  ${typeConfig.icon} ${type}: ${count}`);
    }

    console.log(chalk.cyan('\nBy Severity:'));
    for (const [sev, count] of Object.entries(stats.bySeverity).sort((a, b) => (SEVERITY[a[0]]?.priority || 99) - (SEVERITY[b[0]]?.priority || 99))) {
      const sevConfig = SEVERITY[sev] || SEVERITY.info;
      console.log(`  ${sevConfig.color(sev)}: ${count}`);
    }
  });

// Clear old events
events
  .command('clear')
  .description('Clear old events from the log')
  .option('--older-than <duration>', 'Clear events older than duration (e.g., 30d)', '30d')
  .option('--force', 'Skip confirmation prompt')
  .action(async (options) => {
    const eventList = await loadEvents();

    // Parse duration
    let cutoffDate = new Date(0);
    if (options.olderThan) {
      const match = options.olderThan.match(/^(\d+)([hdwmy])$/);
      if (match) {
        const [, num, unit] = match;
        const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
        cutoffDate = new Date(Date.now() - (parseInt(num) * multipliers[unit]));
      }
    }

    const toKeep = eventList.filter(e => new Date(e.timestamp) >= cutoffDate);
    const toRemove = eventList.length - toKeep.length;

    if (toRemove === 0) {
      console.log(chalk.gray('No events to clear.'));
      return;
    }

    if (!options.force) {
      console.log(chalk.yellow(`⚠️  This will remove ${toRemove} events older than ${options.olderThan}`));
      console.log(chalk.gray('   Run with --force to skip this confirmation'));
      return;
    }

    await saveEvents(toKeep);
    console.log(chalk.green(`✅ Cleared ${toRemove} old events`));
    console.log(chalk.gray(`   Kept ${toKeep.length} events`));
  });

// Export events
events
  .command('export')
  .description('Export events to a file')
  .option('-f, --format <format>', 'Export format (json, csv)', 'json')
  .option('-o, --output <path>', 'Output file path')
  .option('--since <duration>', 'Export events since duration')
  .action(async (options) => {
    const eventList = await loadEvents();
    let filtered = eventList;

    // Apply since filter if specified
    if (options.since) {
      const match = options.since.match(/^(\d+)([hdwmy])$/);
      if (match) {
        const [, num, unit] = match;
        const multipliers = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000, y: 31536000000 };
        const sinceMs = Date.now() - (parseInt(num) * multipliers[unit]);
        filtered = eventList.filter(e => new Date(e.timestamp) >= new Date(sinceMs));
      }
    }

    // Determine output path
    let outputPath = options.output;
    if (!outputPath) {
      const date = new Date().toISOString().split('T')[0];
      outputPath = `masterclaw-events-${date}.${options.format}`;
    }

    if (options.format === 'csv') {
      // CSV export
      const headers = ['id', 'timestamp', 'type', 'severity', 'title', 'message', 'source', 'acknowledged'];
      const rows = filtered.map(e => [
        e.id,
        e.timestamp,
        e.type,
        e.severity,
        `"${(e.title || '').replace(/"/g, '""')}"`,
        `"${(e.message || '').replace(/"/g, '""')}"`,
        e.source,
        e.acknowledged ? 'yes' : 'no',
      ]);
      const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
      await fs.writeFile(outputPath, csv);
    } else {
      // JSON export
      await fs.writeJson(outputPath, { events: filtered, exportedAt: new Date().toISOString() }, { spaces: 2 });
    }

    console.log(chalk.green(`✅ Exported ${filtered.length} events to ${outputPath}`));
  });

// Watch events in real-time
events
  .command('watch')
  .description('Watch for new events in real-time')
  .option('--severity <severity>', 'Only show events of specific severity or higher')
  .action(async (options) => {
    console.log(chalk.blue('👁️  Watching for new events...'));
    console.log(chalk.gray('Press Ctrl+C to stop\n'));

    let lastCount = (await loadEvents()).length;

    const checkInterval = setInterval(async () => {
      const eventList = await loadEvents();
      if (eventList.length > lastCount) {
        const newEvents = eventList.slice(0, eventList.length - lastCount);
        for (const event of newEvents.reverse()) {
          // Filter by severity if specified
          if (options.severity) {
            const severityLevels = ['critical', 'high', 'medium', 'low', 'info'];
            const minLevel = severityLevels.indexOf(options.severity);
            const eventLevel = severityLevels.indexOf(event.severity);
            if (eventLevel > minLevel) continue;
          }
          console.log(formatEvent(event, { compact: true }));
        }
        lastCount = eventList.length;
      }
    }, 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(checkInterval);
      console.log(chalk.gray('\nStopped watching events.'));
      process.exit(0);
    });
  });

// Default action - show help
events
  .action(async () => {
    console.log(chalk.blue('🐾 MasterClaw Event Tracking\n'));
    console.log('Track and manage system events including:');
    console.log('  • Backups, deployments, and restores');
    console.log('  • Alerts, warnings, and errors');
    console.log('  • Security incidents and maintenance');
    console.log('');
    console.log(chalk.cyan('Quick start:'));
    console.log('  mc events list              # List recent events');
    console.log('  mc events list -u           # Show unacknowledged events');
    console.log('  mc events stats             # View event statistics');
    console.log('  mc events ack <id>          # Acknowledge an event');
    console.log('  mc events add "Custom note"  # Add a custom event');
    console.log('');
    events.outputHelp();
  });

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  events,
  addEvent,
  loadEvents,
  EVENT_TYPES,
  SEVERITY,
};
