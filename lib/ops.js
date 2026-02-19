/**
 * MasterClaw Ops - Unified Operational Dashboard
 *
 * Provides a "single pane of glass" view of MasterClaw operational health,
 * aggregating service status, recent errors, SSL certificates, backups,
 * costs, and security findings into one comprehensive dashboard.
 *
 * Usage:
 *   mc ops                    # Show full operational dashboard
 *   mc ops --compact          # Compact view for cron/terminals
 *   mc ops --watch            # Auto-refresh every 30 seconds
 *   mc ops --alerts-only      # Show only items needing attention
 *   mc ops --export json      # Export to JSON for automation
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const { logger, LogLevel } = require('./logger');
const { wrapCommand, ExitCode } = require('./error-handler');
const { getCurrentCorrelationId } = require('./correlation');

const ops = new Command('ops');

// Core API URL
const CORE_URL = process.env.CORE_URL || 'http://localhost:8000';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';

// Status emojis
const STATUS = {
  healthy: chalk.green('✅'),
  warning: chalk.yellow('⚠️'),
  critical: chalk.red('❌'),
  unknown: chalk.gray('❓'),
  info: chalk.blue('ℹ️'),
};

// Find infrastructure directory
async function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];

  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }
  return null;
}

// Check service health
async function getServiceHealth() {
  const services = [
    { name: 'Interface', url: 'http://localhost', path: '/' },
    { name: 'Backend API', url: 'http://localhost:3001', path: '/health' },
    { name: 'AI Core', url: 'http://localhost:8000', path: '/health' },
    { name: 'Gateway', url: 'http://localhost:3000', path: '/health' },
    { name: 'ChromaDB', url: 'http://localhost:8000', path: '/health', note: 'via Core' },
  ];

  const results = [];
  const correlationId = getCurrentCorrelationId();

  for (const svc of services) {
    try {
      const start = Date.now();
      const response = await axios.get(`${svc.url}${svc.path}`, {
        timeout: 5000,
        validateStatus: () => true,
      });
      const responseTime = Date.now() - start;

      const healthy = response.status === 200;
      const result = {
        name: svc.name,
        status: healthy ? 'healthy' : 'unhealthy',
        responseTime,
        statusCode: response.status,
        healthy,
      };

      logger.debug('Service health check completed', {
        service: svc.name,
        healthy,
        responseTime,
        statusCode: response.status,
        correlationId,
      });

      results.push(result);
    } catch (error) {
      logger.warn('Service health check failed', {
        service: svc.name,
        error: error.code || error.message,
        correlationId,
      });

      results.push({
        name: svc.name,
        status: 'down',
        error: error.code || error.message,
        healthy: false,
      });
    }
  }

  return results;
}

// Get recent errors from logs
async function getRecentErrors() {
  const correlationId = getCurrentCorrelationId();

  try {
    // Try to get errors from Loki first
    const lokiUrl = 'http://localhost:3100';
    const response = await axios.get(
      `${lokiUrl}/loki/api/v1/query_range?query=` +
      encodeURIComponent('{job="docker"} |= "error" or "ERROR" or "Error" or "CRITICAL"') +
      '&limit=10&start=' + (Date.now() - 3600000) + '000000', // Last hour
      { timeout: 5000, validateStatus: () => true }
    );

    if (response.data?.data?.result) {
      const errors = [];
      for (const stream of response.data.data.result) {
        for (const value of stream.values || []) {
          errors.push({
            timestamp: new Date(parseInt(value[0]) / 1000000).toISOString(),
            service: stream.stream.service || 'unknown',
            message: value[1].substring(0, 200), // Truncate long messages
          });
        }
      }

      logger.debug('Retrieved recent errors from Loki', {
        count: errors.length,
        correlationId,
      });

      return errors.slice(0, 5); // Return top 5
    }
  } catch (err) {
    logger.debug('Loki not available for error retrieval', {
      error: err.message,
      correlationId,
    });
    // Loki not available, try Docker logs fallback
  }

  // Fallback: check if containers are running
  try {
    const output = execSync('docker ps --filter "name=mc-" --format "{{.Names}}|{{.Status}}"', {
      encoding: 'utf8',
      timeout: 5000,
    });

    const containers = output.trim().split('\n').filter(Boolean);
    if (containers.length === 0) {
      logger.warn('No MasterClaw containers running', { correlationId });
      return [{ service: 'all', message: 'No MasterClaw containers running', critical: true }];
    }

    logger.debug('Docker containers check completed', {
      count: containers.length,
      correlationId,
    });

    return []; // Containers are running, no critical errors
  } catch (err) {
    logger.error('Failed to check container status', {
      error: err.message,
      correlationId,
    });
    return [{ service: 'docker', message: 'Unable to check container status: ' + err.message, critical: true }];
  }
}

// Check SSL certificate status
async function getSSLStatus() {
  const correlationId = getCurrentCorrelationId();
  const infraDir = await findInfraDir();

  if (!infraDir) {
    logger.debug('Infrastructure directory not found for SSL check', { correlationId });
    return { available: false, message: 'Infrastructure directory not found' };
  }

  const certPath = path.join(infraDir, 'data', 'letsencrypt', 'acme.json');
  if (!await fs.pathExists(certPath)) {
    logger.debug('No SSL certificates found', { certPath, correlationId });
    return { available: false, message: 'No SSL certificates found' };
  }

  try {
    // Check certificate expiration using openssl
    const domain = process.env.DOMAIN || 'localhost';
    const output = execSync(
      `echo | openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | ` +
      `openssl x509 -noout -dates -subject 2>/dev/null || echo "ERROR"`,
      { encoding: 'utf8', timeout: 10000 }
    );

    if (output.includes('ERROR')) {
      logger.warn('Could not retrieve certificate info', { domain, correlationId });
      return { available: true, status: 'unknown', message: 'Could not retrieve certificate info' };
    }

    const notAfter = output.match(/notAfter=(.+)/);
    if (notAfter) {
      const expiryDate = new Date(notAfter[1]);
      const daysUntilExpiry = Math.floor((expiryDate - Date.now()) / (1000 * 60 * 60 * 24));

      let status = 'healthy';
      if (daysUntilExpiry < 7) status = 'critical';
      else if (daysUntilExpiry < 30) status = 'warning';

      logger.debug('SSL certificate status checked', {
        domain,
        daysUntilExpiry,
        status,
        correlationId,
      });

      return {
        available: true,
        status,
        daysUntilExpiry,
        expiryDate: expiryDate.toISOString().split('T')[0],
      };
    }
  } catch (err) {
    logger.error('Failed to check SSL status', {
      error: err.message,
      correlationId,
    });
    return { available: true, status: 'error', message: err.message };
  }

  return { available: false, message: 'Unable to check SSL status' };
}

// Check backup status
async function getBackupStatus() {
  const correlationId = getCurrentCorrelationId();
  const infraDir = await findInfraDir();

  if (!infraDir) {
    logger.debug('Infrastructure directory not found for backup check', { correlationId });
    return { available: false, message: 'Infrastructure directory not found' };
  }

  const backupDir = path.join(infraDir, 'backups');
  if (!await fs.pathExists(backupDir)) {
    logger.debug('No backup directory found', { backupDir, correlationId });
    return { available: true, status: 'warning', message: 'No backup directory found' };
  }

  try {
    const files = await fs.readdir(backupDir);
    const backups = files
      .filter(f => f.startsWith('backup_') && f.endsWith('.tar.gz'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtime,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (backups.length === 0) {
      logger.warn('No backups found in backup directory', { backupDir, correlationId });
      return { available: true, status: 'warning', message: 'No backups found' };
    }

    const latest = backups[0];
    const hoursSinceBackup = (Date.now() - latest.mtime) / (1000 * 60 * 60);
    const daysSinceBackup = hoursSinceBackup / 24;

    let status = 'healthy';
    if (daysSinceBackup > 7) status = 'critical';
    else if (daysSinceBackup > 3) status = 'warning';

    logger.debug('Backup status checked', {
      totalBackups: backups.length,
      hoursSinceBackup: Math.round(hoursSinceBackup),
      status,
      correlationId,
    });

    return {
      available: true,
      status,
      lastBackup: latest.mtime.toISOString(),
      hoursSinceBackup: Math.round(hoursSinceBackup),
      totalBackups: backups.length,
    };
  } catch (err) {
    logger.error('Failed to check backup status', {
      error: err.message,
      correlationId,
    });
    return { available: true, status: 'error', message: err.message };
  }
}

// Get cost/budget status
async function getCostStatus() {
  const correlationId = getCurrentCorrelationId();

  try {
    const response = await axios.get(`${CORE_URL}/v1/costs`, {
      timeout: 5000,
      validateStatus: () => true,
    });

    if (response.status === 200 && response.data) {
      const { monthly_budget = 100, total_cost = 0, daily_estimate = 0 } = response.data;
      const percentUsed = (total_cost / monthly_budget) * 100;

      let status = 'healthy';
      if (percentUsed >= 100) status = 'critical';
      else if (percentUsed >= 80) status = 'warning';

      logger.debug('Cost status retrieved', {
        totalCost: total_cost,
        monthlyBudget: monthly_budget,
        percentUsed: Math.round(percentUsed * 10) / 10,
        status,
        correlationId,
      });

      return {
        available: true,
        status,
        monthlyBudget: monthly_budget,
        totalCost: total_cost,
        percentUsed: Math.round(percentUsed * 10) / 10,
        dailyEstimate: daily_estimate,
      };
    }
  } catch (err) {
    logger.debug('Cost API not available', {
      error: err.message,
      correlationId,
    });
    // Core API not available
  }

  // Fallback: read from environment
  const budget = parseFloat(process.env.LLM_MONTHLY_BUDGET) || 100;
  logger.debug('Using fallback cost data from environment', { budget, correlationId });

  return {
    available: true,
    status: 'unknown',
    monthlyBudget: budget,
    message: 'Cost data unavailable - Core API not responding',
  };
}

// Get security scan status
async function getSecurityStatus() {
  const correlationId = getCurrentCorrelationId();
  const infraDir = await findInfraDir();

  if (!infraDir) {
    logger.debug('Infrastructure directory not found for security check', { correlationId });
    return { available: false, message: 'Infrastructure directory not found' };
  }

  // Check for recent scan results
  const scanResultsPath = path.join(infraDir, '.security-scan-results.json');
  if (await fs.pathExists(scanResultsPath)) {
    try {
      const data = await fs.readJson(scanResultsPath);
      const hoursSinceScan = (Date.now() - new Date(data.timestamp)) / (1000 * 60 * 60);

      let status = 'healthy';
      if (data.critical > 0) status = 'critical';
      else if (data.high > 0) status = 'warning';

      logger.debug('Security scan status retrieved', {
        critical: data.critical || 0,
        high: data.high || 0,
        medium: data.medium || 0,
        hoursSinceScan: Math.round(hoursSinceScan),
        status,
        correlationId,
      });

      return {
        available: true,
        status,
        critical: data.critical || 0,
        high: data.high || 0,
        medium: data.medium || 0,
        lastScan: data.timestamp,
        hoursSinceScan: Math.round(hoursSinceScan),
      };
    } catch (err) {
      logger.error('Invalid scan results file', {
        path: scanResultsPath,
        error: err.message,
        correlationId,
      });
      return { available: true, status: 'error', message: 'Invalid scan results file' };
    }
  }

  logger.debug('No recent security scans found', { correlationId });
  return {
    available: true,
    status: 'unknown',
    message: 'No recent security scans found. Run: mc scan',
  };
}

// Get system resources
async function getSystemResources() {
  const correlationId = getCurrentCorrelationId();

  try {
    // Disk usage
    const diskOutput = execSync("df -h / | tail -1 | awk '{print $5, $4}'", {
      encoding: 'utf8',
      timeout: 5000,
    });
    const [diskUsed, diskAvail] = diskOutput.trim().split(' ');
    const diskPercent = parseInt(diskUsed.replace('%', ''));

    // Memory usage
    const memOutput = execSync("free | grep Mem | awk '{print $3/$2 * 100.0}'", {
      encoding: 'utf8',
      timeout: 5000,
    });
    const memPercent = Math.round(parseFloat(memOutput.trim()));

    // Load average
    const loadOutput = execSync("uptime | awk -F'load average:' '{print $2}' | awk '{print $1}' | tr -d ','", {
      encoding: 'utf8',
      timeout: 5000,
    });
    const loadAvg = parseFloat(loadOutput.trim());

    let status = 'healthy';
    if (diskPercent > 90 || memPercent > 90) status = 'critical';
    else if (diskPercent > 80 || memPercent > 80) status = 'warning';

    logger.debug('System resources checked', {
      diskPercent,
      memPercent,
      loadAvg,
      status,
      correlationId,
    });

    return {
      available: true,
      status,
      disk: { used: diskUsed, available: diskAvail, percent: diskPercent },
      memory: { percent: memPercent },
      loadAvg,
    };
  } catch (err) {
    logger.error('Failed to check system resources', {
      error: err.message,
      correlationId,
    });
    return { available: false, message: err.message };
  }
}

// Calculate overall health score
function calculateHealthScore(components) {
  let score = 100;
  
  for (const comp of components) {
    if (comp.status === 'critical') score -= 20;
    else if (comp.status === 'warning') score -= 10;
    else if (comp.status === 'down' || comp.status === 'error') score -= 15;
  }

  return Math.max(0, Math.min(100, score));
}

// Print dashboard
function printDashboard(data, options = {}) {
  const { compact = false, alertsOnly = false } = options;

  if (!compact) {
    console.log(chalk.bold('\n🐾 MasterClaw Operational Dashboard'));
    console.log(chalk.gray('   ' + new Date().toLocaleString()));
    console.log('');
  }

  // Overall score
  const components = [
    ...data.services,
    data.ssl,
    data.backup,
    data.cost,
    data.security,
    data.resources,
  ].filter(Boolean);

  const score = calculateHealthScore(components);
  let scoreEmoji = STATUS.healthy;
  let scoreColor = chalk.green;
  if (score < 50) {
    scoreEmoji = STATUS.critical;
    scoreColor = chalk.red;
  } else if (score < 80) {
    scoreEmoji = STATUS.warning;
    scoreColor = chalk.yellow;
  }

  if (!alertsOnly) {
    console.log(chalk.bold('Overall Health Score: ') + scoreColor(`${scoreEmoji} ${score}/100`));
    console.log('');
  }

  // Services
  const unhealthyServices = data.services.filter(s => !s.healthy);
  if (!alertsOnly || unhealthyServices.length > 0) {
    console.log(chalk.bold('📱 Services'));
    console.log(chalk.gray('─'.repeat(50)));
    for (const svc of data.services) {
      const icon = svc.healthy ? STATUS.healthy : STATUS.critical;
      const status = svc.healthy ? 'healthy' : (svc.status || 'down');
      const time = svc.responseTime ? ` (${svc.responseTime}ms)` : '';
      console.log(`  ${icon} ${svc.name.padEnd(15)} ${status}${time}`);
    }
    console.log('');
  }

  // Recent Errors
  if (data.errors && data.errors.length > 0) {
    console.log(chalk.bold(`🔥 Recent Errors (${data.errors.length} found)`));
    console.log(chalk.gray('─'.repeat(50)));
    for (const err of data.errors.slice(0, 3)) {
      const time = err.timestamp ? new Date(err.timestamp).toLocaleTimeString() : 'now';
      const msg = err.message.length > 60 ? err.message.substring(0, 57) + '...' : err.message;
      console.log(`  ${STATUS.critical} [${time}] ${err.service}: ${msg}`);
    }
    console.log('');
  }

  // SSL
  if (!alertsOnly || data.ssl?.status !== 'healthy') {
    console.log(chalk.bold('🔒 SSL Certificate'));
    console.log(chalk.gray('─'.repeat(50)));
    if (data.ssl?.available) {
      const icon = data.ssl.status === 'healthy' ? STATUS.healthy : 
                   data.ssl.status === 'warning' ? STATUS.warning : STATUS.critical;
      if (data.ssl.daysUntilExpiry !== undefined) {
        console.log(`  ${icon} Expires in ${data.ssl.daysUntilExpiry} days (${data.ssl.expiryDate})`);
      } else {
        console.log(`  ${STATUS.unknown} ${data.ssl.message}`);
      }
    } else {
      console.log(`  ${STATUS.unknown} ${data.ssl?.message || 'SSL status unavailable'}`);
    }
    console.log('');
  }

  // Backups
  if (!alertsOnly || data.backup?.status !== 'healthy') {
    console.log(chalk.bold('💾 Backups'));
    console.log(chalk.gray('─'.repeat(50)));
    if (data.backup?.available) {
      const icon = data.backup.status === 'healthy' ? STATUS.healthy :
                   data.backup.status === 'warning' ? STATUS.warning : STATUS.critical;
      if (data.backup.hoursSinceBackup !== undefined) {
        const hours = data.backup.hoursSinceBackup;
        const timeStr = hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
        console.log(`  ${icon} Last backup: ${timeStr} (${data.backup.totalBackups} total)`);
      } else {
        console.log(`  ${icon} ${data.backup.message}`);
      }
    } else {
      console.log(`  ${STATUS.unknown} ${data.backup?.message || 'Backup status unavailable'}`);
    }
    console.log('');
  }

  // Costs
  if (!alertsOnly || data.cost?.status !== 'healthy') {
    console.log(chalk.bold('💰 Costs'));
    console.log(chalk.gray('─'.repeat(50)));
    if (data.cost?.available) {
      const icon = data.cost.status === 'healthy' ? STATUS.healthy :
                   data.cost.status === 'warning' ? STATUS.warning : 
                   data.cost.status === 'critical' ? STATUS.critical : STATUS.unknown;
      if (data.cost.totalCost !== undefined) {
        console.log(`  ${icon} $${data.cost.totalCost.toFixed(2)} / $${data.cost.monthlyBudget} (${data.cost.percentUsed}%)`);
      } else {
        console.log(`  ${icon} ${data.cost.message}`);
      }
    } else {
      console.log(`  ${STATUS.unknown} Cost status unavailable`);
    }
    console.log('');
  }

  // Security
  if (!alertsOnly || (data.security?.critical > 0 || data.security?.high > 0)) {
    console.log(chalk.bold('🛡️  Security'));
    console.log(chalk.gray('─'.repeat(50)));
    if (data.security?.available) {
      const icon = data.security.status === 'healthy' ? STATUS.healthy :
                   data.security.status === 'warning' ? STATUS.warning :
                   data.security.status === 'critical' ? STATUS.critical : STATUS.unknown;
      if (data.security.critical !== undefined) {
        console.log(`  ${icon} ${data.security.critical} critical, ${data.security.high} high, ${data.security.medium} medium`);
        if (data.security.hoursSinceScan) {
          console.log(`     Last scan: ${data.security.hoursSinceScan}h ago`);
        }
      } else {
        console.log(`  ${icon} ${data.security.message}`);
      }
    } else {
      console.log(`  ${STATUS.unknown} Security status unavailable`);
    }
    console.log('');
  }

  // System Resources
  if (!alertsOnly || data.resources?.status !== 'healthy') {
    console.log(chalk.bold('🖥️  System Resources'));
    console.log(chalk.gray('─'.repeat(50)));
    if (data.resources?.available) {
      const icon = data.resources.status === 'healthy' ? STATUS.healthy :
                   data.resources.status === 'warning' ? STATUS.warning : STATUS.critical;
      console.log(`  ${icon} Disk: ${data.resources.disk.used} used (${data.resources.disk.available} free)`);
      console.log(`     Memory: ${data.resources.memory.percent}% used`);
      console.log(`     Load: ${data.resources.loadAvg}`);
    } else {
      console.log(`  ${STATUS.unknown} Resource data unavailable`);
    }
    console.log('');
  }

  // Summary for alerts-only mode
  if (alertsOnly) {
    const issues = components.filter(c => c.status && c.status !== 'healthy' && c.status !== 'unknown');
    if (issues.length === 0) {
      console.log(chalk.green('\n✅ All systems operational - no issues detected!'));
    } else {
      console.log(chalk.yellow(`\n⚠️  ${issues.length} component(s) need attention`));
    }
  }
}

// Export data as JSON
function exportJson(data) {
  const exportData = {
    timestamp: new Date().toISOString(),
    score: calculateHealthScore([
      ...data.services,
      data.ssl,
      data.backup,
      data.cost,
      data.security,
      data.resources,
    ].filter(Boolean)),
    services: data.services,
    errors: data.errors,
    ssl: data.ssl,
    backup: data.backup,
    cost: data.cost,
    security: data.security,
    resources: data.resources,
  };

  console.log(JSON.stringify(exportData, null, 2));
}

// Main command handler
async function showDashboard(options) {
  const startTime = Date.now();
  const correlationId = getCurrentCorrelationId();

  logger.info('Generating operational dashboard', {
    compact: options.compact,
    alertsOnly: options.alertsOnly,
    correlationId,
  });

  try {
    // Gather all data in parallel
    const [
      services,
      errors,
      ssl,
      backup,
      cost,
      security,
      resources,
    ] = await Promise.all([
      getServiceHealth(),
      getRecentErrors(),
      getSSLStatus(),
      getBackupStatus(),
      getCostStatus(),
      getSecurityStatus(),
      getSystemResources(),
    ]);

    const data = {
      services,
      errors,
      ssl,
      backup,
      cost,
      security,
      resources,
    };

    if (options.export === 'json') {
      exportJson(data);
    } else {
      printDashboard(data, {
        compact: options.compact,
        alertsOnly: options.alertsOnly,
      });

      if (!options.compact) {
        const duration = Date.now() - startTime;
        console.log(chalk.gray(`\nDashboard generated in ${duration}ms`));
        console.log(chalk.gray('Run `mc ops --watch` for live updates or `mc ops --alerts-only` to see issues only'));
      }
    }

    // Exit with error code if there are critical issues
    const hasCritical = [
      ...services,
      ssl,
      backup,
      cost,
      security,
      resources,
    ].some(c => c?.status === 'critical' || c?.status === 'down');

    if (hasCritical) {
      logger.warn('Dashboard generated with critical issues detected', {
        correlationId,
      });
      if (options.exitCode) {
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      }
    } else {
      logger.info('Dashboard generated successfully', {
        duration: Date.now() - startTime,
        correlationId,
      });
    }
  } catch (err) {
    logger.error('Failed to generate dashboard', {
      error: err.message,
      stack: err.stack,
      correlationId,
    });
    throw err;
  }
}

// Watch mode
async function watchDashboard(options) {
  const correlationId = getCurrentCorrelationId();

  console.log(chalk.blue('\n🔍 Watching for changes (press Ctrl+C to exit)...\n'));

  logger.info('Starting dashboard watch mode', {
    interval: options.interval || 30,
    correlationId,
  });

  // Initial display
  await showDashboard(options);

  // Set up interval
  const intervalMs = (parseInt(options.interval, 10) || 30) * 1000;
  const interval = setInterval(async () => {
    // Clear screen
    console.clear();
    try {
      await showDashboard(options);
    } catch (err) {
      logger.error('Error in watch mode', {
        error: err.message,
        correlationId,
      });
      console.error(chalk.red(`\n❌ Error: ${err.message}`));
    }
  }, intervalMs);

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    clearInterval(interval);
    logger.info('Stopping dashboard watch mode', { correlationId });
    console.log(chalk.blue('\n\n👋 Stopping watch mode'));
    process.exit(ExitCode.SUCCESS);
  });

  // Handle SIGTERM gracefully
  process.on('SIGTERM', () => {
    clearInterval(interval);
    logger.info('Stopping dashboard watch mode (SIGTERM)', { correlationId });
    console.log(chalk.blue('\n\n👋 Stopping watch mode'));
    process.exit(ExitCode.SUCCESS);
  });
}

// CLI definition
ops
  .description('Unified operational dashboard - view all MasterClaw health metrics in one place')
  .option('-c, --compact', 'Compact output for cron/terminals', false)
  .option('-w, --watch', 'Watch mode - auto-refresh every 30 seconds', false)
  .option('-i, --interval <seconds>', 'Refresh interval in watch mode', '30')
  .option('-a, --alerts-only', 'Show only items needing attention', false)
  .option('-e, --exit-code', 'Exit with non-zero code if critical issues found', false)
  .option('--export <format>', 'Export to format (json)', '')
  .action(wrapCommand(async (options) => {
    if (options.watch) {
      await watchDashboard(options);
    } else {
      await showDashboard(options);
    }
  }, 'ops'));

// Export internal functions for testing
module.exports = ops;
module.exports.calculateHealthScore = calculateHealthScore;
module.exports.getServiceHealth = getServiceHealth;
module.exports.getRecentErrors = getRecentErrors;
module.exports.getSSLStatus = getSSLStatus;
module.exports.getBackupStatus = getBackupStatus;
module.exports.getCostStatus = getCostStatus;
module.exports.getSecurityStatus = getSecurityStatus;
module.exports.getSystemResources = getSystemResources;
