// health.js - Health monitoring commands for mc CLI
// Enhanced with health history API integration

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const health = new Command('health');

// Core API URL
const CORE_URL = process.env.CORE_URL || 'http://localhost:8000';

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
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'health-check.sh'))) {
      return dir;
    }
  }

  return null;
}

// Check individual service health via HTTP
async function checkServiceHealth(name, url) {
  try {
    const start = Date.now();
    const response = await axios.get(`${url}/health`, {
      timeout: 5000,
      validateStatus: () => true
    });
    const responseTime = Date.now() - start;

    return {
      name,
      url,
      status: response.status === 200 ? 'healthy' : 'unhealthy',
      statusCode: response.status,
      responseTime: `${responseTime}ms`,
      healthy: response.status === 200,
    };
  } catch (error) {
    return {
      name,
      url,
      status: 'down',
      error: error.code || error.message,
      healthy: false,
    };
  }
}

// Check all services
async function checkAllServices() {
  const services = [
    { name: 'Interface', url: 'http://localhost:3000' },
    { name: 'Backend API', url: 'http://localhost:3001' },
    { name: 'AI Core', url: 'http://localhost:8000' },
    { name: 'Gateway', url: 'http://localhost:3000' },
  ];

  const results = [];
  for (const svc of services) {
    results.push(await checkServiceHealth(svc.name, svc.url));
  }

  return results;
}

// Check Docker containers
async function checkDockerContainers() {
  return new Promise((resolve) => {
    const docker = spawn('docker', ['ps', '--format', '{{.Names}}|{{.Status}}|{{.Image}}']);
    let output = '';

    docker.stdout.on('data', (data) => {
      output += data.toString();
    });

    docker.on('close', (code) => {
      if (code !== 0) {
        resolve({ available: false, containers: [] });
        return;
      }

      const containers = output.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split('|');
          return {
            name: parts[0],
            status: parts[1],
            image: parts[2],
          };
        })
        .filter(c => c.name && c.name.startsWith('mc-'));

      resolve({ available: true, containers });
    });
  });
}

// Check SSL certificates
async function checkSSLCerts() {
  const infraDir = await findInfraDir();
  if (!infraDir) {
    return { available: false, message: 'Infrastructure directory not found' };
  }

  const sslScript = path.join(infraDir, 'scripts', 'ssl-cert-check.sh');
  if (!await fs.pathExists(sslScript)) {
    return { available: false, message: 'SSL check script not found' };
  }

  try {
    const output = execSync(`${sslScript} check 2>&1`, {
      encoding: 'utf8',
      timeout: 30000,
    });

    // Parse output for summary
    const healthy = (output.match(/OK/g) || []).length;
    const warning = (output.match(/WARNING/g) || []).length;
    const critical = (output.match(/CRITICAL/g) || []).length;

    return {
      available: true,
      output,
      summary: { healthy, warning, critical },
      healthy: critical === 0,
    };
  } catch (err) {
    // Script returns non-zero on critical errors
    const output = err.stdout?.toString() || err.message;
    return {
      available: true,
      output,
      summary: { healthy: 0, warning: 0, critical: 1 },
      healthy: false,
    };
  }
}

// Run infrastructure health check script
async function runInfraHealthCheck() {
  const infraDir = await findInfraDir();
  if (!infraDir) {
    return { available: false, message: 'Infrastructure directory not found' };
  }

  const scriptPath = path.join(infraDir, 'scripts', 'health-check.sh');
  if (!await fs.pathExists(scriptPath)) {
    return { available: false, message: 'Health check script not found' };
  }

  return new Promise((resolve) => {
    const check = spawn('bash', [scriptPath], {
      cwd: infraDir,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    let stdout = '';
    let stderr = '';

    check.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    check.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    check.on('close', (code) => {
      resolve({
        available: true,
        healthy: code === 0,
        output: stdout,
        errors: stderr,
        exitCode: code,
      });
    });
  });
}

// Format health status for display
function formatStatus(result) {
  if (result.healthy) {
    return chalk.green('✅ healthy');
  } else if (result.status === 'unhealthy') {
    return chalk.yellow('⚠️  unhealthy');
  } else {
    return chalk.red('❌ down');
  }
}

// Format history status with color
function formatHistoryStatus(status) {
  switch (status) {
    case 'healthy':
      return chalk.green('✅ healthy');
    case 'degraded':
      return chalk.yellow('⚠️  degraded');
    case 'unhealthy':
      return chalk.red('❌ unhealthy');
    default:
      return chalk.gray(`? ${status}`);
  }
}

// Format timestamp to relative time
function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

// Main health check command
health
  .command('check')
  .description('Comprehensive health check of all MasterClaw services')
  .option('-w, --watch', 'Continuous monitoring mode (refresh every 5s)')
  .option('-n, --notify', 'Send notification on health changes')
  .option('-c, --compact', 'Compact output (cron-friendly)')
  .option('--record', 'Record health check to history API')
  .action(async (options) => {
    const watchMode = options.watch;
    const notifyMode = options.notify;
    const compactMode = options.compact;
    const recordMode = options.record;

    let previousStatus = null;

    const runCheck = async () => {
      if (!compactMode) {
        console.clear();
        console.log(chalk.blue('🐾 MasterClaw Health Check'));
        console.log('==========================');
        console.log();
      }

      const results = {
        timestamp: new Date().toISOString(),
        services: [],
        docker: null,
        ssl: null,
        infra: null,
        overallHealthy: true,
      };

      // Check HTTP services
      if (!compactMode) {
        console.log(chalk.cyan('📡 Service Endpoints:'));
      }

      const services = await checkAllServices();
      results.services = services;

      for (const svc of services) {
        results.overallHealthy = results.overallHealthy && svc.healthy;

        if (compactMode) {
          console.log(`${svc.name}:${svc.healthy ? 'OK' : 'FAIL'}`);
        } else {
          const status = formatStatus(svc);
          const details = svc.responseTime
            ? chalk.gray(`(${svc.statusCode}, ${svc.responseTime})`)
            : chalk.gray(`(${svc.error})`);
          console.log(`  ${status} ${svc.name} ${details}`);
        }
      }

      if (!compactMode) console.log();

      // Check Docker containers
      if (!compactMode) {
        console.log(chalk.cyan('📦 Docker Containers:'));
      }

      const docker = await checkDockerContainers();
      results.docker = docker;

      if (!docker.available) {
        results.overallHealthy = false;
        if (!compactMode) {
          console.log(chalk.yellow('  ⚠️  Docker not available'));
        }
      } else if (docker.containers.length === 0) {
        results.overallHealthy = false;
        if (!compactMode) {
          console.log(chalk.yellow('  ⚠️  No MasterClaw containers running'));
        }
      } else {
        for (const container of docker.containers) {
          const isHealthy = container.status.includes('healthy') ||
                          container.status.includes('Up');
          results.overallHealthy = results.overallHealthy && isHealthy;

          if (compactMode) {
            console.log(`${container.name}:${isHealthy ? 'OK' : 'FAIL'}`);
          } else {
            const status = isHealthy
              ? chalk.green('✅')
              : chalk.yellow('⚠️');
            console.log(`  ${status} ${container.name}: ${container.status}`);
          }
        }
      }

      if (!compactMode) console.log();

      // Check SSL certificates
      if (!compactMode) {
        console.log(chalk.cyan('🔒 SSL Certificates:'));
      }

      const ssl = await checkSSLCerts();
      results.ssl = ssl;

      if (!ssl.available) {
        if (!compactMode) {
          console.log(chalk.gray('  ℹ️  SSL check not available (local development)'));
        }
      } else {
        results.overallHealthy = results.overallHealthy && ssl.healthy;

        if (compactMode) {
          const { healthy, warning, critical } = ssl.summary;
          console.log(`SSL:H${healthy}:W${warning}:C${critical}`);
        } else {
          const { healthy, warning, critical } = ssl.summary;
          console.log(`  ${chalk.green('✅')} Healthy: ${healthy}`);
          console.log(`  ${chalk.yellow('⚠️')} Warning: ${warning}`);
          console.log(`  ${chalk.red('❌')} Critical: ${critical}`);
        }
      }

      if (!compactMode) console.log();

      // Infrastructure health check
      if (!compactMode) {
        console.log(chalk.cyan('🏥 Infrastructure Check:'));
      }

      const infra = await runInfraHealthCheck();
      results.infra = infra;

      if (!infra.available) {
        if (!compactMode) {
          console.log(chalk.gray(`  ℹ️  ${infra.message || 'Infrastructure check not available'}`));
        }
      } else {
        results.overallHealthy = results.overallHealthy && infra.healthy;

        if (!compactMode) {
          if (infra.healthy) {
            console.log(chalk.green('  ✅ Infrastructure healthy'));
          } else {
            console.log(chalk.red('  ❌ Infrastructure issues detected'));
          }
        }
      }

      // Record to health history if requested
      if (recordMode) {
        try {
          await axios.post(`${CORE_URL}/health/history/record`, {
            status: results.overallHealthy ? 'healthy' : 'unhealthy',
            component: 'cli_health_check',
            details: `Services: ${results.services.filter(s => s.healthy).length}/${results.services.length} healthy`,
          }, {
            timeout: 3000,
            validateStatus: () => true,
          });
          if (!compactMode) {
            console.log();
            console.log(chalk.gray('  📝 Recorded to health history'));
          }
        } catch (e) {
          if (!compactMode) {
            console.log();
            console.log(chalk.gray('  ⚠️  Could not record to health history'));
          }
        }
      }

      // Summary
      if (!compactMode) {
        console.log();
        console.log('==========================');
        if (results.overallHealthy) {
          console.log(chalk.green('🐾 MasterClaw is healthy and watching.'));
        } else {
          console.log(chalk.yellow('⚠️  Some services need attention.'));
        }
        console.log();
        console.log(chalk.gray(`Last check: ${new Date().toLocaleString()}`));
        if (watchMode) {
          console.log(chalk.gray('Press Ctrl+C to exit watch mode'));
        }
      } else {
        // Compact exit code
        process.exit(results.overallHealthy ? 0 : 1);
      }

      // Notification on status change
      if (notifyMode && previousStatus !== null && previousStatus !== results.overallHealthy) {
        const message = results.overallHealthy
          ? '✅ MasterClaw is now healthy!'
          : '❌ MasterClaw health check failed!';

        // Use notify-send if available (Linux)
        try {
          execSync(`notify-send "MasterClaw Health" "${message}"`, { stdio: 'ignore' });
        } catch (e) {
          // notify-send not available, ignore
        }
      }

      previousStatus = results.overallHealthy;
      return results.overallHealthy;
    };

    // Initial check
    await runCheck();

    // Watch mode
    if (watchMode) {
      const interval = setInterval(runCheck, 5000);

      // Handle Ctrl+C gracefully
      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log();
        console.log(chalk.blue('👋 Health monitoring stopped.'));
        process.exit(0);
      });
    }
  });

// =============================================================================
// Health History API Integration Commands
// =============================================================================

/**
 * Get health history from API
 */
health
  .command('history')
  .description('View health check history from the Core API')
  .option('-c, --component <name>', 'Filter by component name')
  .option('-s, --since <hours>', 'Show records from last N hours', '24')
  .option('-l, --limit <n>', 'Maximum records to show', '20')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const params = {
        limit: parseInt(options.limit, 10),
      };

      if (options.component) {
        params.component = options.component;
      }

      if (options.since) {
        const since = new Date();
        since.setHours(since.getHours() - parseInt(options.since, 10));
        params.since = since.toISOString();
      }

      const response = await axios.get(`${CORE_URL}/health/history`, { params, timeout: 5000 });

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const records = response.data.records || [];

      console.log(chalk.blue('🐾 Health Check History'));
      console.log('=======================');
      console.log();

      if (records.length === 0) {
        console.log(chalk.gray('No health history records found.'));
        console.log();
        console.log(chalk.gray('Tip: Run `mc health check --record` to start recording health checks.'));
        return;
      }

      console.log(chalk.cyan(`Showing last ${records.length} records:`));
      console.log();

      // Group records by component
      const byComponent = {};
      records.forEach(record => {
        if (!byComponent[record.component]) {
          byComponent[record.component] = [];
        }
        byComponent[record.component].push(record);
      });

      for (const [component, compRecords] of Object.entries(byComponent)) {
        console.log(chalk.bold(component));
        console.log(chalk.gray('─'.repeat(component.length)));

        for (const record of compRecords.slice(0, 5)) {
          const status = formatHistoryStatus(record.status);
          const time = chalk.gray(formatRelativeTime(record.timestamp));
          const responseTime = record.response_time_ms
            ? chalk.gray(`(${record.response_time_ms.toFixed(0)}ms)`)
            : '';
          const error = record.error ? chalk.red(` [${record.error}]`) : '';

          console.log(`  ${status} ${time} ${responseTime}${error}`);

          if (record.details && record.details.length > 40) {
            console.log(chalk.gray(`    ${record.details.substring(0, 40)}...`));
          } else if (record.details) {
            console.log(chalk.gray(`    ${record.details}`));
          }
        }

        if (compRecords.length > 5) {
          console.log(chalk.gray(`  ... and ${compRecords.length - 5} more records`));
        }
        console.log();
      }

      console.log(chalk.gray(`Total: ${records.length} records in last ${options.since}h`));

    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }));
        process.exit(1);
      }

      console.log(chalk.red('❌ Failed to fetch health history'));
      console.log();

      if (error.code === 'ECONNREFUSED') {
        console.log(chalk.yellow('Could not connect to Core API.'));
        console.log(chalk.gray(`  URL: ${CORE_URL}`));
        console.log();
        console.log(chalk.gray('Make sure MasterClaw Core is running:'));
        console.log(chalk.gray('  mc status'));
      } else {
        console.log(chalk.gray(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Get health summary from API
 */
health
  .command('summary')
  .description('View health status summary from the Core API')
  .option('-c, --component <name>', 'Filter by component')
  .option('-s, --since <hours>', 'Summary period in hours', '24')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const params = {};

      if (options.component) {
        params.component = options.component;
      }

      if (options.since) {
        const since = new Date();
        since.setHours(since.getHours() - parseInt(options.since, 10));
        params.since = since.toISOString();
      }

      const response = await axios.get(`${CORE_URL}/health/history/summary`, { params, timeout: 5000 });

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const data = response.data;

      console.log(chalk.blue('🐾 Health Summary'));
      console.log('=================');
      console.log();

      if (!data.period) {
        console.log(chalk.gray('No summary data available.'));
        return;
      }

      // Overall stats
      console.log(chalk.cyan('Overall:'));
      const overall = data.overall || {};
      const total = overall.total_checks || 0;

      if (total === 0) {
        console.log(chalk.gray('  No health checks recorded.'));
      } else {
        const healthy = overall.healthy || 0;
        const degraded = overall.degraded || 0;
        const unhealthy = overall.unhealthy || 0;
        const availability = overall.availability_percent || 0;

        console.log(`  ${chalk.green('✅')} Healthy:   ${healthy.toString().padStart(4)} (${((healthy/total)*100).toFixed(1)}%)`);
        console.log(`  ${chalk.yellow('⚠️')}  Degraded:  ${degraded.toString().padStart(4)} (${((degraded/total)*100).toFixed(1)}%)`);
        console.log(`  ${chalk.red('❌')} Unhealthy: ${unhealthy.toString().padStart(4)} (${((unhealthy/total)*100).toFixed(1)}%)`);
        console.log();
        console.log(`  ${chalk.bold('Availability:')} ${availability >= 99 ? chalk.green(`${availability}%`) : availability >= 95 ? chalk.yellow(`${availability}%`) : chalk.red(`${availability}%`)}`);
      }

      // Component breakdown
      if (data.components && Object.keys(data.components).length > 0) {
        console.log();
        console.log(chalk.cyan('By Component:'));
        console.log();

        for (const [comp, stats] of Object.entries(data.components)) {
          const compTotal = stats.total || 0;
          const compHealthy = stats.healthy || 0;
          const compDegraded = stats.degraded || 0;
          const compUnhealthy = stats.unhealthy || 0;
          const compAvail = compTotal > 0 ? (((compHealthy + compDegraded) / compTotal) * 100).toFixed(1) : '0.0';

          const availColor = compAvail >= 99 ? chalk.green : compAvail >= 95 ? chalk.yellow : chalk.red;

          console.log(`  ${chalk.bold(comp)}`);
          console.log(`    Checks: ${compTotal} | ${chalk.green(`✓${compHealthy}`)} ${chalk.yellow(`~${compDegraded}`)} ${chalk.red(`✗${compUnhealthy}`)} | Avail: ${availColor(compAvail + '%')}`);

          if (stats.avg_response_time_ms) {
            console.log(`    Avg Response: ${stats.avg_response_time_ms.toFixed(1)}ms`);
          }
        }
      }

      console.log();
      console.log(chalk.gray(`Period: ${options.since}h | Generated: ${new Date().toLocaleString()}`));

    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }));
        process.exit(1);
      }

      console.log(chalk.red('❌ Failed to fetch health summary'));
      console.log();

      if (error.code === 'ECONNREFUSED') {
        console.log(chalk.yellow('Could not connect to Core API.'));
        console.log(chalk.gray(`  URL: ${CORE_URL}`));
        console.log();
        console.log(chalk.gray('Make sure MasterClaw Core is running.'));
      } else {
        console.log(chalk.gray(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Get uptime statistics from API
 */
health
  .command('uptime')
  .description('View uptime statistics from the Core API')
  .option('-c, --component <name>', 'Component to check (default: overall)', 'overall')
  .option('-d, --days <n>', 'Period in days', '7')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const params = {
        component: options.component,
      };

      if (options.days) {
        const since = new Date();
        since.setDate(since.getDate() - parseInt(options.days, 10));
        params.since = since.toISOString();
      }

      const response = await axios.get(`${CORE_URL}/health/history/uptime`, { params, timeout: 5000 });

      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }

      const data = response.data;

      console.log(chalk.blue(`🐾 Uptime Statistics: ${data.component || options.component}`));
      console.log('========================================' + '='.repeat((data.component || options.component).length));
      console.log();

      if (data.uptime_percent === null) {
        console.log(chalk.gray('No data available for the specified period.'));
        console.log();
        console.log(chalk.gray('Tip: Run `mc health check --record` to start recording health checks.'));
        return;
      }

      // Uptime percentage with color coding
      const uptime = data.uptime_percent;
      const uptimeColor = uptime >= 99.9 ? chalk.green : uptime >= 99 ? chalk.yellow : chalk.red;
      const uptimeEmoji = uptime >= 99.9 ? '🟢' : uptime >= 99 ? '🟡' : '🔴';

      console.log(`${uptimeEmoji}  Uptime: ${uptimeColor(uptime.toFixed(2) + '%')}`);
      console.log();

      // Stats
      console.log(chalk.cyan('Statistics:'));
      console.log(`  Total Records: ${data.total_records}`);
      console.log(`  Outage Count:  ${data.outage_count || 0}`);
      console.log();

      // Outages
      if (data.outages && data.outages.length > 0) {
        console.log(chalk.cyan('Outages:'));
        console.log();

        for (const outage of data.outages.slice(0, 10)) {
          const started = new Date(outage.started);
          const ended = outage.ended ? new Date(outage.ended) : null;

          if (outage.ongoing) {
            console.log(`  🔴 ${chalk.red('ONGOING')} - Started: ${started.toLocaleString()}`);
          } else {
            const duration = ended - started;
            const durationMins = Math.floor(duration / 60000);
            const durationStr = durationMins < 60
              ? `${durationMins}m`
              : `${(durationMins / 60).toFixed(1)}h`;

            console.log(`  ⚫ ${durationStr} - ${started.toLocaleString()} to ${ended.toLocaleString()}`);
          }
        }

        if (data.outages.length > 10) {
          console.log(chalk.gray(`  ... and ${data.outages.length - 10} more outages`));
        }
      } else {
        console.log(chalk.green('✅ No outages recorded in this period!'));
      }

      console.log();
      console.log(chalk.gray(`Period: ${options.days} days | Generated: ${new Date().toLocaleString()}`));

    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }));
        process.exit(1);
      }

      console.log(chalk.red('❌ Failed to fetch uptime statistics'));
      console.log();

      if (error.code === 'ECONNREFUSED') {
        console.log(chalk.yellow('Could not connect to Core API.'));
        console.log(chalk.gray(`  URL: ${CORE_URL}`));
        console.log();
        console.log(chalk.gray('Make sure MasterClaw Core is running.'));
      } else {
        console.log(chalk.gray(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Record a health check manually
 */
health
  .command('record')
  .description('Record a health check to the history API')
  .option('-s, --status <status>', 'Status: healthy, degraded, unhealthy', 'healthy')
  .option('-c, --component <name>', 'Component name', 'manual')
  .option('-d, --details <text>', 'Details/description')
  .option('-r, --response-time <ms>', 'Response time in milliseconds')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const payload = {
        status: options.status,
        component: options.component,
      };

      if (options.details) {
        payload.details = options.details;
      }

      if (options.responseTime) {
        payload.response_time_ms = parseFloat(options.responseTime);
      }

      const response = await axios.post(`${CORE_URL}/health/history/record`, payload, {
        timeout: 5000,
      });

      if (options.json) {
        console.log(JSON.stringify({ success: true, recorded: payload }, null, 2));
        return;
      }

      console.log(chalk.green('✅ Health check recorded'));
      console.log();
      console.log(chalk.cyan('Recorded:'));
      console.log(`  Status:    ${formatHistoryStatus(options.status)}`);
      console.log(`  Component: ${options.component}`);
      if (options.details) {
        console.log(`  Details:   ${options.details}`);
      }
      if (options.responseTime) {
        console.log(`  Response:  ${options.responseTime}ms`);
      }

    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ error: error.message }));
        process.exit(1);
      }

      console.log(chalk.red('❌ Failed to record health check'));
      console.log();

      if (error.code === 'ECONNREFUSED') {
        console.log(chalk.yellow('Could not connect to Core API.'));
        console.log(chalk.gray(`  URL: ${CORE_URL}`));
        console.log();
        console.log(chalk.gray('Make sure MasterClaw Core is running.'));
      } else if (error.response) {
        console.log(chalk.gray(`API Error: ${error.response.status} - ${error.response.statusText}`));
        if (error.response.data?.detail) {
          console.log(chalk.gray(`Details: ${error.response.data.detail}`));
        }
      } else {
        console.log(chalk.gray(`Error: ${error.message}`));
      }
      process.exit(1);
    }
  });

// Quick alias - mc health runs check by default
health
  .action(async () => {
    // Delegate to check command with no options
    await health.commands.find(c => c.name() === 'check').action({});
  });

module.exports = health;
