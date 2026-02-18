/**
 * top.js - Real-time container resource monitor for MasterClaw CLI
 * 
 * Like 'htop' but for MasterClaw services. Shows:
 * - CPU usage per container
 * - Memory usage (current and limit)
 * - Network I/O
 * - Container status and health
 * - Auto-refreshing display
 * 
 * Commands:
 * - mc top              Start interactive resource monitor
 * - mc top --once       Single snapshot, no refresh
 * - mc top --json       Output as JSON for scripting
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync } = require('child_process');
const { setInterval, clearInterval } = require('timers');

const { wrapCommand, ExitCode } = require('./error-handler');
const rateLimiter = require('./rate-limiter');
const logger = require('./logger');

// MasterClaw service definitions
const SERVICES = [
  { name: 'mc-traefik', display: 'traefik', category: 'infra' },
  { name: 'mc-interface', display: 'interface', category: 'app' },
  { name: 'mc-backend', display: 'backend', category: 'app' },
  { name: 'mc-core', display: 'core', category: 'app' },
  { name: 'mc-gateway', display: 'gateway', category: 'app' },
  { name: 'mc-chroma', display: 'chroma', category: 'data' },
  { name: 'mc-watchtower', display: 'watchtower', category: 'infra' },
  { name: 'mc-grafana', display: 'grafana', category: 'monitor' },
  { name: 'mc-prometheus', display: 'prometheus', category: 'monitor' },
  { name: 'mc-loki', display: 'loki', category: 'monitor' },
];

// Color scheme for categories
const CATEGORY_COLORS = {
  infra: chalk.cyan,
  app: chalk.green,
  data: chalk.yellow,
  monitor: chalk.magenta,
};

/**
 * Parse memory string (e.g., "1.5GiB", "500MiB", "100kB") to bytes
 */
function parseMemory(memStr) {
  if (!memStr || memStr === 'N/A') return 0;
  
  const units = {
    'B': 1,
    'kB': 1024,
    'KB': 1024,
    'MiB': 1024 * 1024,
    'MB': 1024 * 1024,
    'GiB': 1024 * 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
  };
  
  const match = memStr.match(/^([\d.]+)\s*([a-zA-Z]+)$/);
  if (!match) return 0;
  
  const [, num, unit] = match;
  const multiplier = units[unit] || 1;
  return parseFloat(num) * multiplier;
}

/**
 * Format bytes to human-readable
 */
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Format percentage with color coding
 */
function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || isNaN(value)) {
    return chalk.gray('N/A');
  }
  
  let color = chalk.green;
  if (value > 50) color = chalk.yellow;
  if (value > 80) color = chalk.red;
  
  return color(`${value.toFixed(decimals)}%`);
}

/**
 * Get container stats using docker stats
 */
function getContainerStats() {
  const stats = [];
  
  for (const service of SERVICES) {
    try {
      // Check if container exists and is running
      const format = '{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}';
      const inspectCmd = `docker inspect --format='${format}' ${service.name} 2>/dev/null || echo 'not_found'`;
      
      let status, health, image;
      try {
        const inspect = execSync(inspectCmd, { encoding: 'utf8', timeout: 5000 }).trim();
        if (inspect === 'not_found') {
          stats.push({
            ...service,
            state: 'not_found',
            health: 'unknown',
            cpu: null,
            memory: null,
            memoryLimit: null,
            memoryPercent: null,
            netIn: null,
            netOut: null,
            pids: null,
            uptime: '-',
          });
          continue;
        }
        [status, health, image] = inspect.split('|');
      } catch (e) {
        stats.push({
          ...service,
          state: 'error',
          health: 'unknown',
          cpu: null,
          memory: null,
          memoryLimit: null,
          memoryPercent: null,
          netIn: null,
          netOut: null,
          pids: null,
          uptime: '-',
        });
        continue;
      }
      
      // Get resource stats if running
      let cpu = null, memory = null, memoryLimit = null, memoryPercent = null;
      let netIn = null, netOut = null, pids = null, uptime = '-';
      
      if (status === 'running') {
        try {
          // Use docker stats with no-stream for single snapshot
          const format = '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}|{{.PIDs}}';
          const statsCmd = `docker stats --no-stream --format '${format}' ${service.name} 2>/dev/null`;
          const statsOutput = execSync(statsCmd, { encoding: 'utf8', timeout: 10000 }).trim();
          
          if (statsOutput) {
            const [cpuPerc, memUsage, netIO, pidsStr] = statsOutput.split('|');
            
            // Parse CPU percentage
            if (cpuPerc) {
              cpu = parseFloat(cpuPerc.replace('%', '')) || 0;
            }
            
            // Parse memory (format: "500MiB / 1GiB")
            if (memUsage && memUsage.includes('/')) {
              const [used, limit] = memUsage.split('/').map(s => s.trim());
              memory = parseMemory(used);
              memoryLimit = parseMemory(limit);
              if (memoryLimit > 0) {
                memoryPercent = (memory / memoryLimit) * 100;
              }
            }
            
            // Parse network I/O (format: "1.2MB / 500kB")
            if (netIO && netIO.includes('/')) {
              const [inStr, outStr] = netIO.split('/').map(s => s.trim());
              netIn = parseMemory(inStr);
              netOut = parseMemory(outStr);
            }
            
            // Parse PIDs
            if (pidsStr) {
              pids = parseInt(pidsStr.trim(), 10) || 0;
            }
          }
          
          // Get uptime
          const startedAtFormat = '{{.State.StartedAt}}';
          const uptimeCmd = `docker inspect --format='${startedAtFormat}' ${service.name} 2>/dev/null`;
          const startedAt = execSync(uptimeCmd, { encoding: 'utf8', timeout: 5000 }).trim();
          if (startedAt) {
            const startTime = new Date(startedAt);
            const now = new Date();
            const diff = Math.floor((now - startTime) / 1000);
            
            if (diff < 60) uptime = `${diff}s`;
            else if (diff < 3600) uptime = `${Math.floor(diff / 60)}m`;
            else if (diff < 86400) uptime = `${Math.floor(diff / 3600)}h`;
            else uptime = `${Math.floor(diff / 86400)}d`;
          }
        } catch (e) {
          logger.debug(`Failed to get stats for ${service.name}: ${e.message}`);
        }
      }
      
      stats.push({
        ...service,
        state: status,
        health: health || 'unknown',
        cpu,
        memory,
        memoryLimit,
        memoryPercent,
        netIn,
        netOut,
        pids,
        uptime,
      });
    } catch (error) {
      logger.debug(`Error checking ${service.name}: ${error.message}`);
      stats.push({
        ...service,
        state: 'error',
        health: 'unknown',
        cpu: null,
        memory: null,
        memoryLimit: null,
        memoryPercent: null,
        netIn: null,
        netOut: null,
        pids: null,
        uptime: '-',
      });
    }
  }
  
  return stats;
}

/**
 * Get system-wide stats
 */
function getSystemStats() {
  try {
    // Get Docker system info
    const systemFormat = '{{.Type}}|{{.TotalCount}}|{{.Size}}';
    const systemCmd = `docker system df --format '${systemFormat}' 2>/dev/null`;
    const systemOutput = execSync(systemCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    
    const systemInfo = {
      containers: { count: 0, size: 0 },
      images: { count: 0, size: 0 },
      volumes: { count: 0, size: 0 },
    };
    
    for (const line of systemOutput.split('\n')) {
      const [type, count, size] = line.split('|');
      if (type === 'Images') {
        systemInfo.images.count = parseInt(count, 10) || 0;
        systemInfo.images.size = size;
      } else if (type === 'Containers') {
        systemInfo.containers.count = parseInt(count, 10) || 0;
        systemInfo.containers.size = size;
      } else if (type === 'Local Volumes') {
        systemInfo.volumes.count = parseInt(count, 10) || 0;
        systemInfo.volumes.size = size;
      }
    }
    
    return systemInfo;
  } catch (e) {
    return null;
  }
}

/**
 * Clear the terminal screen
 */
function clearScreen() {
  process.stdout.write('\x1Bc');
}

/**
 * Display the header
 */
function displayHeader() {
  console.log(chalk.blue.bold('🐾 MasterClaw Resource Monitor'));
  console.log(chalk.gray(`   ${new Date().toLocaleString()}`));
  console.log('');
}

/**
 * Display stats table
 */
function displayStats(stats, previousStats = null) {
  // Header row
  const header = [
    chalk.bold('Container'.padEnd(12)),
    chalk.bold('Status'.padEnd(10)),
    chalk.bold('CPU'.padEnd(8)),
    chalk.bold('Memory'.padEnd(10)),
    chalk.bold('Mem%'.padEnd(7)),
    chalk.bold('Net In'.padEnd(10)),
    chalk.bold('Net Out'.padEnd(10)),
    chalk.bold('PIDs'.padEnd(6)),
    chalk.bold('Uptime'.padEnd(8)),
  ].join('');
  
  console.log(header);
  console.log(chalk.gray('─'.repeat(85)));
  
  // Group by category
  const categories = ['app', 'data', 'infra', 'monitor'];
  const categoryNames = { app: '📱 App Services', data: '💾 Data', infra: '🔧 Infrastructure', monitor: '📊 Monitoring' };
  
  for (const category of categories) {
    const categoryStats = stats.filter(s => s.category === category);
    if (categoryStats.length === 0) continue;
    
    // Check if any in category are running
    const hasRunning = categoryStats.some(s => s.state === 'running');
    if (!hasRunning && category !== 'app') continue; // Skip empty categories except app
    
    console.log(chalk.bold(CATEGORY_COLORS[category](categoryNames[category])));
    
    for (const stat of categoryStats) {
      const color = CATEGORY_COLORS[category];
      
      // Status indicator
      let statusIcon, statusText;
      if (stat.state === 'running') {
        if (stat.health === 'healthy') {
          statusIcon = chalk.green('●');
          statusText = chalk.green('healthy');
        } else if (stat.health === 'unhealthy') {
          statusIcon = chalk.red('●');
          statusText = chalk.red('unhealthy');
        } else {
          statusIcon = chalk.yellow('●');
          statusText = chalk.yellow('running');
        }
      } else if (stat.state === 'not_found') {
        statusIcon = chalk.gray('○');
        statusText = chalk.gray('down');
      } else {
        statusIcon = chalk.red('○');
        statusText = chalk.red(stat.state);
      }
      
      // Format values
      const cpuStr = stat.cpu !== null ? formatPercent(stat.cpu, 1).padEnd(8) : chalk.gray('-').padEnd(8);
      const memStr = stat.memory !== null ? formatBytes(stat.memory, 1).padEnd(10) : chalk.gray('-').padEnd(10);
      const memPctStr = stat.memoryPercent !== null ? formatPercent(stat.memoryPercent, 0).padEnd(7) : chalk.gray('-').padEnd(7);
      const netInStr = stat.netIn !== null ? formatBytes(stat.netIn, 1).padEnd(10) : chalk.gray('-').padEnd(10);
      const netOutStr = stat.netOut !== null ? formatBytes(stat.netOut, 1).padEnd(10) : chalk.gray('-').padEnd(10);
      const pidsStr = stat.pids !== null ? stat.pids.toString().padEnd(6) : chalk.gray('-').padEnd(6);
      
      // Trend indicator for CPU
      let trend = '';
      if (previousStats && stat.cpu !== null) {
        const prev = previousStats.find(p => p.name === stat.name);
        if (prev && prev.cpu !== null) {
          const diff = stat.cpu - prev.cpu;
          if (Math.abs(diff) > 5) {
            trend = diff > 0 ? chalk.red('▲') : chalk.green('▼');
          }
        }
      }
      
      const row = [
        color(stat.display.padEnd(12)),
        statusText.padEnd(10),
        cpuStr,
        memStr,
        memPctStr,
        netInStr,
        netOutStr,
        pidsStr,
        chalk.gray(stat.uptime.padEnd(8)),
        trend,
      ].join('');
      
      console.log(row);
    }
    
    console.log('');
  }
}

/**
 * Display system summary
 */
function displaySystemSummary(systemStats) {
  if (!systemStats) return;
  
  console.log(chalk.bold('📦 Docker System'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  Containers: ${systemStats.containers.count} (${systemStats.containers.size})`);
  console.log(`  Images:     ${systemStats.images.count} (${systemStats.images.size})`);
  console.log(`  Volumes:    ${systemStats.volumes.count} (${systemStats.volumes.size})`);
  console.log('');
}

/**
 * Display footer/help
 */
function displayFooter(isWatchMode) {
  if (isWatchMode) {
    console.log(chalk.gray('Press Ctrl+C to exit | Refreshing every 3s'));
  } else {
    console.log(chalk.gray('Run with --watch for live updates'));
  }
}

/**
 * Export stats as JSON
 */
async function exportStats(options) {
  const stats = getContainerStats();
  const systemStats = getSystemStats();
  
  const output = {
    timestamp: new Date().toISOString(),
    services: stats,
    system: systemStats,
  };
  
  if (options.output) {
    const fs = require('fs-extra');
    await fs.writeJson(options.output, output, { spaces: 2 });
    console.log(chalk.green(`✅ Stats exported to ${options.output}`));
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

/**
 * Run single snapshot display
 */
async function runSnapshot() {
  const stats = getContainerStats();
  const systemStats = getSystemStats();
  
  displayHeader();
  displayStats(stats);
  displaySystemSummary(systemStats);
  displayFooter(false);
}

/**
 * Validates the interval parameter for watch mode
 * Prevents DoS attacks via resource exhaustion from extremely low intervals
 * 
 * @param {string|number} interval - User-provided interval value
 * @returns {Object} - Validation result { valid: boolean, value: number, error?: string }
 */
function validateInterval(interval) {
  // Security bounds for interval to prevent resource exhaustion
  const MIN_INTERVAL_SECONDS = 1;      // Minimum: 1 second (prevent API spam)
  const MAX_INTERVAL_SECONDS = 300;    // Maximum: 5 minutes (prevent useless config)
  const DEFAULT_INTERVAL_SECONDS = 3;  // Default: 3 seconds

  // Parse the interval value
  const parsed = parseFloat(interval);

  // Check if it's a valid number
  if (isNaN(parsed)) {
    return {
      valid: false,
      value: DEFAULT_INTERVAL_SECONDS * 1000,
      error: `Invalid interval '${interval}'. Please provide a valid number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`
    };
  }

  // Check for non-finite values (Infinity, -Infinity)
  if (!isFinite(parsed)) {
    return {
      valid: false,
      value: DEFAULT_INTERVAL_SECONDS * 1000,
      error: `Interval must be a finite number between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS} seconds.`
    };
  }

  // Check minimum bound (prevent DoS via rapid API calls)
  if (parsed < MIN_INTERVAL_SECONDS) {
    return {
      valid: false,
      value: DEFAULT_INTERVAL_SECONDS * 1000,
      error: `Interval too short (${parsed}s). Minimum allowed is ${MIN_INTERVAL_SECONDS} second(s) to prevent system overload.`
    };
  }

  // Check maximum bound (prevent useless configurations)
  if (parsed > MAX_INTERVAL_SECONDS) {
    return {
      valid: false,
      value: DEFAULT_INTERVAL_SECONDS * 1000,
      error: `Interval too long (${parsed}s). Maximum allowed is ${MAX_INTERVAL_SECONDS} seconds (5 minutes).`
    };
  }

  // Valid interval - convert to milliseconds
  return {
    valid: true,
    value: Math.round(parsed * 1000),
    seconds: parsed
  };
}

/**
 * Run watch mode with auto-refresh
 */
async function runWatch(options) {
  // Validate interval parameter (security hardening)
  const intervalValidation = validateInterval(options.interval);
  
  if (!intervalValidation.valid) {
    console.log(chalk.yellow(`⚠️  ${intervalValidation.error}`));
    console.log(chalk.gray(`   Using default interval of 3 seconds.`));
    logger.warn('Invalid interval provided, using default', { 
      provided: options.interval,
      error: intervalValidation.error 
    });
  }
  
  const intervalMs = intervalValidation.value;
  let previousStats = null;
  let isFirstRun = true;
  
  // Check rate limiting for watch mode
  const rateLimitResult = await rateLimiter.checkRateLimit('top-watch', {
    maxAttempts: 1,
    windowMs: 60000,
  });
  
  if (!rateLimitResult.allowed) {
    console.log(chalk.yellow('⚠️  Rate limit exceeded. Please wait before starting watch mode.'));
    process.exit(ExitCode.GENERAL_ERROR);
  }
  
  const update = () => {
    try {
      // Clear screen except first run
      if (!isFirstRun) {
        clearScreen();
      }
      isFirstRun = false;
      
      const stats = getContainerStats();
      const systemStats = getSystemStats();
      
      displayHeader();
      displayStats(stats, previousStats);
      displaySystemSummary(systemStats);
      displayFooter(true);
      
      previousStats = stats;
    } catch (error) {
      logger.error('Error updating display:', error);
    }
  };
  
  // Initial display
  update();
  
  // Set up interval
  const timer = setInterval(update, intervalMs);
  
  // Handle exit
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n');
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

// Create the top command
const topCmd = new Command('top')
  .description('Real-time container resource monitor (like htop for MasterClaw)')
  .option('-w, --watch', 'Watch mode - continuously update (default)')
  .option('-o, --once', 'Single snapshot, no refresh')
  .option('-i, --interval <seconds>', 'Update interval in seconds (default: 3)', '3')
  .option('-j, --json', 'Output as JSON')
  .option('-e, --export <file>', 'Export to file (implies --json)')
  .addHelpText('after', `
Examples:
  $ mc top                 # Start interactive monitor
  $ mc top --once          # Single snapshot
  $ mc top --json          # Output as JSON
  $ mc top --export stats.json   # Export to file

Keyboard Shortcuts (in watch mode):
  Ctrl+C    Exit

Columns:
  Container  Service name
  Status     Running state and health
  CPU        CPU usage percentage
  Memory     Memory usage
  Mem%       Memory usage percentage of limit
  Net In/Out Network I/O
  PIDs       Number of processes
  Uptime     How long container has been running
`)
  .action(wrapCommand(async (options) => {
    // Handle JSON export
    if (options.json || options.export) {
      await exportStats(options);
      return;
    }
    
    // Handle single snapshot
    if (options.once) {
      await runSnapshot();
      return;
    }
    
    // Default: watch mode
    await runWatch(options);
  }, 'top'));

module.exports = {
  topCmd,
  getContainerStats,
  getSystemStats,
  parseMemory,
  formatBytes,
  formatPercent,
  validateInterval,
  SERVICES,
};
