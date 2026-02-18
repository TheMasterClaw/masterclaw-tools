// health.js - Health monitoring commands for mc CLI

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const health = new Command('health');

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

// Main health check command
health
  .command('check')
  .description('Comprehensive health check of all MasterClaw services')
  .option('-w, --watch', 'Continuous monitoring mode (refresh every 5s)')
  .option('-n, --notify', 'Send notification on health changes')
  .option('-c, --compact', 'Compact output (cron-friendly)')
  .action(async (options) => {
    const watchMode = options.watch;
    const notifyMode = options.notify;
    const compactMode = options.compact;

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

// Quick alias - mc health runs check by default
health
  .action(async () => {
    // Delegate to check command with no options
    await health.commands.find(c => c.name() === 'check').action({});
  });

module.exports = health;
