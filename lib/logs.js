/**
 * Logs Command for MasterClaw CLI
 *
 * View and stream logs from MasterClaw services.
 * Supports filtering by service, level, time range, and search queries.
 *
 * Features:
 * - View historical logs with filtering
 * - Stream logs in real-time (tail -f style)
 * - Filter by service, log level, time range
 * - Search within logs
 * - Export logs to file
 * - JSON output for parsing
 *
 * @example
 * mc logs                          # View recent logs
 * mc logs --follow                 # Stream logs in real-time
 * mc logs --service core           # Core service logs only
 * mc logs --level ERROR            # Error logs only
 * mc logs --since 1h               # Logs from last hour
 * mc logs --search "error"         # Search for "error"
 * mc logs --export logs.txt        # Export to file
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const fs = require('fs-extra');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const logs = new Command('logs');

/**
 * Get Core API URL
 */
async function getCoreUrl() {
  return await config.get('core.url', 'http://localhost:8000');
}

/**
 * Fetch logs from API
 */
async function fetchLogs(coreUrl, options) {
  const params = new URLSearchParams();

  if (options.service) params.append('service', options.service);
  if (options.level) params.append('level', options.level);
  if (options.since) params.append('since', options.since);
  if (options.limit) params.append('limit', options.limit.toString());
  if (options.search) params.append('search', options.search);

  try {
    const response = await axios.get(
      `${coreUrl}/v1/logs?${params.toString()}`,
      { timeout: 15000 }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message
    };
  }
}

/**
 * Stream logs from API (SSE)
 */
async function streamLogs(coreUrl, options, onLog) {
  const params = new URLSearchParams();

  if (options.service) params.append('service', options.service);
  if (options.level) params.append('level', options.level);
  if (options.search) params.append('search', options.search);

  try {
    const response = await axios.post(
      `${coreUrl}/v1/logs/stream`,
      {
        service: options.service,
        level: options.level,
        search: options.search,
        follow: true
      },
      {
        responseType: 'stream',
        timeout: 0 // No timeout for streaming
      }
    );

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const log = JSON.parse(line.replace(/^data: /, ''));
            onLog(log);
          } catch (e) {
            // Not JSON, might be SSE comment or empty
          }
        }
      });
    });

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Get color for log level
 */
function getLevelColor(level) {
  switch (level?.toUpperCase()) {
    case 'ERROR':
    case 'CRITICAL':
      return chalk.red;
    case 'WARNING':
    case 'WARN':
      return chalk.yellow;
    case 'INFO':
      return chalk.blue;
    case 'DEBUG':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Format log entry for display
 */
function formatLogEntry(log, options) {
  const timestamp = new Date(log.timestamp).toLocaleTimeString();
  const level = log.level?.toUpperCase().padEnd(8) || 'UNKNOWN ';
  const service = log.service?.padEnd(10) || '';
  const message = log.message;

  if (options.json) {
    return JSON.stringify(log);
  }

  const levelColor = getLevelColor(log.level);

  if (options.compact) {
    return `${chalk.gray(timestamp)} ${levelColor(level)} ${message}`;
  }

  return `${chalk.gray(timestamp)} ${levelColor(level)} ${chalk.cyan(service)} ${message}`;
}

/**
 * Main logs command
 */
logs
  .description('View and stream logs from MasterClaw services')
  .option('-f, --follow', 'Stream logs in real-time (tail -f style)')
  .option('-s, --service <name>', 'Filter by service (core, gateway, etc.)')
  .option('-l, --level <level>', 'Filter by log level (DEBUG, INFO, WARNING, ERROR, CRITICAL)')
  .option('--since <duration>', 'Show logs since duration (e.g., 5m, 1h, 24h)', '1h')
  .option('-n, --limit <number>', 'Maximum number of log entries', '100')
  .option('--search <query>', 'Search for text in logs')
  .option('-c, --compact', 'Compact output (timestamp level message only)')
  .option('--export <path>', 'Export logs to file')
  .option('-j, --json', 'Output as JSON')
  .option('--no-color', 'Disable colored output')
  .action(wrapCommand(async (options) => {
    const coreUrl = await getCoreUrl();

    // Validate level if provided
    const validLevels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
    if (options.level && !validLevels.includes(options.level.toUpperCase())) {
      console.log(chalk.red(`Invalid log level: ${options.level}`));
      console.log(chalk.gray(`Valid levels: ${validLevels.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    // Streaming mode
    if (options.follow) {
      console.log(chalk.blue('🔍 Streaming logs (Press Ctrl+C to stop)\n'));

      const result = await streamLogs(coreUrl, options, (log) => {
        console.log(formatLogEntry(log, options));
      });

      if (!result.success) {
        console.log(chalk.red('❌ Failed to stream logs'));
        console.log(chalk.gray(`  Error: ${result.error}`));
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      }

      // Keep process alive for streaming
      await new Promise(() => {});
      return;
    }

    // Historical logs mode
    const spinner = ora('Fetching logs...').start();
    const result = await fetchLogs(coreUrl, options);
    spinner.stop();

    if (!result.success) {
      console.log(chalk.red('❌ Failed to fetch logs'));
      console.log(chalk.gray(`  Error: ${result.error}`));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }

    const logs = result.data.logs || [];

    if (logs.length === 0) {
      console.log(chalk.yellow('No logs found matching the criteria'));
      return;
    }

    // Export to file if requested
    if (options.export) {
      const exportData = options.json
        ? logs.map(l => JSON.stringify(l)).join('\n')
        : logs.map(l => formatLogEntry(l, options)).join('\n');

      await fs.writeFile(options.export, exportData);
      console.log(chalk.green(`✓ Exported ${logs.length} log entries to ${options.export}`));
      return;
    }

    // Display logs
    if (!options.json) {
      console.log(chalk.blue(`📋 Log Entries (${logs.length})\n`));
    }

    logs.forEach(log => {
      console.log(formatLogEntry(log, options));
    });

    if (!options.json) {
      console.log(chalk.gray(`\nShowing ${logs.length} entries`));
      console.log(chalk.gray('Use --follow to stream logs in real-time'));
    }
  }, 'logs'));

/**
 * Services subcommand - List available log sources
 */
logs
  .command('services')
  .description('List available log services/sources')
  .option('-j, --json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    const coreUrl = await getCoreUrl();

    const spinner = ora('Fetching services...').start();

    try {
      const response = await axios.get(`${coreUrl}/v1/logs/services`, {
        timeout: 10000
      });

      spinner.stop();

      const services = response.data.services || [];

      if (options.json) {
        console.log(JSON.stringify(services, null, 2));
        return;
      }

      console.log(chalk.blue('📡 Available Log Services\n'));

      services.forEach(service => {
        console.log(`  ${chalk.cyan(service.name)}`);
        if (service.description) {
          console.log(`    ${chalk.gray(service.description)}`);
        }
      });

      console.log(chalk.gray(`\n${services.length} service(s) available`));

    } catch (err) {
      spinner.stop();
      console.log(chalk.red('❌ Failed to fetch services'));
      console.log(chalk.gray(`  Error: ${err.message}`));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }
  }, 'logs-services'));

/**
 * Levels subcommand - Show log levels
 */
logs
  .command('levels')
  .description('Show available log levels')
  .action(() => {
    console.log(chalk.blue('📊 Log Levels\n'));

    const levels = [
      { level: 'DEBUG', color: chalk.gray, desc: 'Detailed debugging information' },
      { level: 'INFO', color: chalk.blue, desc: 'General informational messages' },
      { level: 'WARNING', color: chalk.yellow, desc: 'Warning messages' },
      { level: 'ERROR', color: chalk.red, desc: 'Error messages' },
      { level: 'CRITICAL', color: chalk.red.bold, desc: 'Critical errors' }
    ];

    levels.forEach(({ level, color, desc }) => {
      console.log(`  ${color(level.padEnd(10))} ${chalk.gray(desc)}`);
    });

    console.log(chalk.gray('\nUsage: mc logs --level ERROR'));
  });

module.exports = logs;
