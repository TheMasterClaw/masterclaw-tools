/**
 * restart.js - Service restart command for mc CLI
 * Provides graceful service restart with health checking
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const logger = require('./logger').child('restart');
const { findInfraDir } = require('./services');
const { validateContainerName, validateComposeArgs } = require('./docker');
const { wrapCommand, ExitCode } = require('./error-handler');
const rateLimiter = require('./rate-limiter');

const restart = new Command('restart');

// Service configuration for health checks
const SERVICES = {
  core: { port: 8000, name: 'AI Core', healthPath: '/health' },
  backend: { port: 3001, name: 'Backend API', healthPath: '/health' },
  interface: { port: 3000, name: 'Interface', healthPath: '/' },
  gateway: { port: 3000, name: 'Gateway', healthPath: '/health' },
  chroma: { port: 8000, name: 'ChromaDB', healthPath: '/api/v1/heartbeat' },
};

/**
 * Execute docker compose command with security validation
 * @param {string[]} args - Compose arguments
 * @param {string} infraDir - Infrastructure directory
 * @param {Object} options - Spawn options
 * @returns {Promise<{exitCode: number, output: string}>}
 */
async function execCompose(args, infraDir, options = {}) {
  // Security validation
  validateComposeArgs(args);
  
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: infraDir,
      stdio: options.silent ? 'pipe' : 'inherit',
      env: { ...process.env, ...options.env },
    });

    let output = '';
    if (options.silent && child.stdout) {
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({ exitCode: code || 0, output });
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to execute docker compose: ${err.message}`));
    });
  });
}

/**
 * Check if a service is healthy
 * @param {string} service - Service name
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>}
 */
async function waitForService(service, timeoutMs = 60000) {
  const config = SERVICES[service];
  if (!config) {
    // Unknown service, assume healthy after delay
    await new Promise(r => setTimeout(r, 5000));
    return true;
  }

  const startTime = Date.now();
  const checkInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await axios.get(
        `http://localhost:${config.port}${config.healthPath}`,
        { timeout: 3000 }
      );
      if (response.status === 200) {
        return true;
      }
    } catch {
      // Service not ready yet
    }
    await new Promise(r => setTimeout(r, checkInterval));
  }

  return false;
}

/**
 * Get running services
 * @param {string} infraDir - Infrastructure directory
 * @returns {Promise<string[]>}
 */
async function getRunningServices(infraDir) {
  try {
    const { output } = await execCompose(
      ['ps', '--format', 'json'],
      infraDir,
      { silent: true }
    );
    
    // Parse docker compose ps output
    const lines = output.trim().split('\n').filter(Boolean);
    const services = [];
    
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.Service && data.State === 'running') {
          services.push(data.Service);
        }
      } catch {
        // Try alternative format
        const match = line.match(/"Service":\s*"([^"]+)"/);
        if (match) services.push(match[1]);
      }
    }
    
    return services;
  } catch (err) {
    logger.warn('Failed to get running services', { error: err.message });
    return Object.keys(SERVICES);
  }
}

/**
 * Restart a single service
 * @param {string} service - Service name
 * @param {string} infraDir - Infrastructure directory
 * @param {Object} options - Restart options
 * @returns {Promise<{success: boolean, duration: number}>}
 */
async function restartService(service, infraDir, options = {}) {
  const startTime = Date.now();
  
  logger.info(`Restarting service: ${service}`, { service, graceful: !options.force });

  // Validate service name for security
  validateContainerName(service);

  const restartArgs = options.force 
    ? ['restart', '-t', '10', service]  // Force restart with 10s timeout
    : ['restart', service];              // Graceful restart

  const result = await execCompose(restartArgs, infraDir);
  
  if (result.exitCode !== 0) {
    throw new Error(`Failed to restart ${service}: exit code ${result.exitCode}`);
  }

  // Wait for service to be healthy if requested
  if (options.wait) {
    const healthy = await waitForService(service, options.timeout || 60000);
    if (!healthy) {
      throw new Error(`Service ${service} did not become healthy within timeout`);
    }
  }

  const duration = Date.now() - startTime;
  logger.info(`Service restarted successfully`, { service, duration });
  
  return { success: true, duration };
}

/**
 * Restart all services
 * @param {string} infraDir - Infrastructure directory
 * @param {Object} options - Restart options
 * @returns {Promise<{success: boolean, results: Object}>}
 */
async function restartAllServices(infraDir, options = {}) {
  const startTime = Date.now();
  const results = {};

  // Get currently running services
  const runningServices = await getRunningServices(infraDir);
  logger.info(`Found ${runningServices.length} running services`, { services: runningServices });

  if (runningServices.length === 0) {
    console.log(chalk.yellow('⚠️  No running services found. Use "mc revive" to start services.'));
    return { success: false, results };
  }

  console.log(chalk.blue(`🔄 Restarting ${runningServices.length} service(s)...\n`));

  // Restart each service
  for (const service of runningServices) {
    process.stdout.write(`  ${chalk.gray('→')} Restarting ${chalk.bold(service)}... `);
    
    try {
      const result = await restartService(service, infraDir, options);
      results[service] = { success: true, duration: result.duration };
      console.log(chalk.green(`✅ (${result.duration}ms)`));
    } catch (err) {
      results[service] = { success: false, error: err.message };
      console.log(chalk.red(`❌`));
      if (options.verbose) {
        console.log(chalk.gray(`     ${err.message}`));
      }
    }
  }

  const totalDuration = Date.now() - startTime;
  const successCount = Object.values(results).filter(r => r.success).length;
  const failCount = Object.values(results).length - successCount;

  console.log('');
  console.log(chalk.cyan(`Results: ${chalk.green(`${successCount} restarted`)}, ${failCount > 0 ? chalk.red(`${failCount} failed`) : chalk.green(`${failCount} failed`)}, ${chalk.gray(`${totalDuration}ms`)}`));

  return { success: failCount === 0, results };
}

// =============================================================================
// CLI Commands
// =============================================================================

restart
  .description('Restart MasterClaw services')
  .argument('[service]', 'Service to restart (core, backend, gateway, interface, chroma) - restarts all if omitted')
  .option('-f, --force', 'Force restart (kill immediately without graceful shutdown)', false)
  .option('-w, --wait', 'Wait for services to be healthy after restart', true)
  .option('-t, --timeout <ms>', 'Health check timeout in milliseconds', '60000')
  .option('-v, --verbose', 'Show detailed output')
  .action(wrapCommand(async (service, options) => {
    // Enforce rate limiting for restart command
    await rateLimiter.enforceRateLimit('restart', { command: 'restart', service });

    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.red('❌ Infrastructure directory not found'));
      console.log(chalk.gray('   Run from masterclaw-infrastructure directory or set MASTERCLAW_INFRA'));
      process.exit(ExitCode.VALIDATION_FAILED);
    }

    const restartOptions = {
      force: options.force,
      wait: options.wait,
      timeout: parseInt(options.timeout, 10) || 60000,
      verbose: options.verbose,
    };

    if (service) {
      // Restart specific service
      const validServices = Object.keys(SERVICES);
      if (!validServices.includes(service)) {
        console.log(chalk.red(`❌ Unknown service: ${service}`));
        console.log(chalk.gray(`   Valid services: ${validServices.join(', ')}`));
        process.exit(ExitCode.INVALID_ARGUMENTS);
      }

      console.log(chalk.blue(`🔄 Restarting ${chalk.bold(service)}...`));
      if (options.force) {
        console.log(chalk.yellow('   (force mode: immediate shutdown)\n'));
      }

      try {
        const result = await restartService(service, infraDir, restartOptions);
        console.log(chalk.green(`\n✅ ${chalk.bold(service)} restarted successfully in ${result.duration}ms`));
        
        if (options.wait) {
          console.log(chalk.gray('   Health check passed'));
        }
      } catch (err) {
        console.log(chalk.red(`\n❌ Failed to restart ${service}: ${err.message}`));
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      }
    } else {
      // Restart all services
      const result = await restartAllServices(infraDir, restartOptions);
      
      if (!result.success) {
        console.log(chalk.yellow('\n⚠️  Some services failed to restart'));
        console.log(chalk.gray('   Run "mc status" to check service health'));
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      } else {
        console.log(chalk.green('\n✅ All services restarted successfully'));
      }
    }
  }, 'restart'));

// Add restart-status subcommand for checking restart history
restart
  .command('history')
  .description('Show recent restart history')
  .option('-n, --limit <number>', 'Number of entries to show', '10')
  .action(wrapCommand(async (options) => {
    const limit = parseInt(options.limit, 10) || 10;
    
    // Read from audit log or maintain a simple history file
    const historyPath = path.join(require('os').homedir(), '.masterclaw', 'restart-history.json');
    
    if (!await fs.pathExists(historyPath)) {
      console.log(chalk.gray('No restart history found'));
      return;
    }

    const history = await fs.readJson(historyPath);
    const recent = history.slice(-limit);

    console.log(chalk.blue(`📋 Recent Restarts (last ${recent.length})\n`));
    
    for (const entry of recent.reverse()) {
      const time = new Date(entry.timestamp).toLocaleString();
      const icon = entry.success ? chalk.green('✅') : chalk.red('❌');
      const service = entry.service || 'all';
      
      console.log(`${icon} ${chalk.gray(time)} ${chalk.bold(service)} ${entry.duration ? chalk.gray(`(${entry.duration}ms)`) : ''}`);
      if (entry.error) {
        console.log(chalk.red(`   ${entry.error}`));
      }
    }
  }, 'restart-history'));

module.exports = restart;
module.exports.restartService = restartService;
module.exports.restartAllServices = restartAllServices;
