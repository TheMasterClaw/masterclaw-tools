/**
 * Whoami Command for MasterClaw CLI
 *
 * Displays information about the current user context and system configuration.
 * Useful for debugging, verifying setup, and understanding the current environment.
 *
 * Features:
 * - Shows current user information
 * - Displays system configuration
 * - Shows active environment variables
 * - Lists configured API keys (masked)
 * - Displays current working directory and paths
 * - Shows CLI configuration
 *
 * @example
 * mc whoami              # Show full user context
 * mc whoami --short      # Brief summary
 * mc whoami --json       # JSON output for scripting
 * mc whoami --secrets    # Include secret configuration status
 */

const { Command } = require('commander');
const chalk = require('chalk');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const whoami = new Command('whoami');

/**
 * Get system information
 */
async function getSystemInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMemory: formatBytes(os.totalmem()),
    freeMemory: formatBytes(os.freemem()),
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    cwd: process.cwd(),
    shell: process.env.SHELL || process.env.ComSpec || 'unknown',
    user: process.env.USER || process.env.USERNAME || 'unknown',
  };
}

/**
 * Get CLI configuration
 */
async function getCliConfig() {
  const infraDir = await config.get('infraDir');
  const coreUrl = await config.get('core.url');
  const gatewayUrl = await config.get('gateway.url');

  return {
    infraDir: infraDir || 'Not configured',
    coreUrl: coreUrl || 'http://localhost:8000 (default)',
    gatewayUrl: gatewayUrl || 'http://localhost:3000 (default)',
    configFile: path.join(os.homedir(), '.masterclaw', 'config.json'),
  };
}

/**
 * Get environment status
 */
async function getEnvironmentStatus() {
  const envVars = {
    OPENAI_API_KEY: maskSecret(process.env.OPENAI_API_KEY),
    ANTHROPIC_API_KEY: maskSecret(process.env.ANTHROPIC_API_KEY),
    GATEWAY_TOKEN: maskSecret(process.env.GATEWAY_TOKEN),
    MASTERCLAW_INFRA: process.env.MASTERCLAW_INFRA || 'Not set',
    NODE_ENV: process.env.NODE_ENV || 'Not set',
    ENV: process.env.ENV || 'Not set',
  };

  return envVars;
}

/**
 * Check if infrastructure directory exists
 */
async function checkInfraStatus(infraDir) {
  if (!infraDir || infraDir === 'Not configured') {
    return { exists: false, dockerCompose: false, envFile: false };
  }

  const dockerComposePath = path.join(infraDir, 'docker-compose.yml');
  const envPath = path.join(infraDir, '.env');

  return {
    exists: await fs.pathExists(infraDir),
    dockerCompose: await fs.pathExists(dockerComposePath),
    envFile: await fs.pathExists(envPath),
    path: infraDir,
  };
}

/**
 * Check Core API connectivity
 */
async function checkCoreStatus(coreUrl) {
  const axios = require('axios');

  try {
    const response = await axios.get(`${coreUrl}/health`, { timeout: 5000 });
    return {
      reachable: true,
      status: response.data.status,
      version: response.data.version,
    };
  } catch (err) {
    return {
      reachable: false,
      error: err.message,
    };
  }
}

/**
 * Mask a secret value for display
 */
function maskSecret(value) {
  if (!value) return 'Not set';
  if (value.length <= 8) return '****';
  return value.substring(0, 4) + '****' + value.substring(value.length - 4);
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Main whoami command
 */
whoami
  .description('Show current user context and system information')
  .option('-s, --short', 'Brief summary only')
  .option('-j, --json', 'Output as JSON')
  .option('--secrets', 'Include detailed secret configuration status')
  .option('--no-color', 'Disable colored output')
  .action(wrapCommand(async (options) => {
    const system = await getSystemInfo();
    const cliConfig = await getCliConfig();
    const environment = await getEnvironmentStatus();
    const infraStatus = await checkInfraStatus(cliConfig.infraDir);
    const coreStatus = await checkCoreStatus(
      (await config.get('core.url')) || 'http://localhost:8000'
    );

    if (options.json) {
      const output = {
        system,
        cli: cliConfig,
        environment,
        infrastructure: infraStatus,
        core: coreStatus,
        timestamp: new Date().toISOString(),
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    if (options.short) {
      console.log(chalk.blue('🐾 MasterClaw CLI'));
      console.log(`User: ${chalk.cyan(system.user)}@${chalk.cyan(system.hostname)}`);
      console.log(`Platform: ${chalk.gray(system.platform)} (${system.arch})`);
      console.log(`Node: ${chalk.gray(system.nodeVersion)}`);
      console.log(`Infra: ${infraStatus.exists ? chalk.green('✓') : chalk.red('✗')} ${cliConfig.infraDir}`);
      console.log(`Core: ${coreStatus.reachable ? chalk.green('● Online') : chalk.red('● Offline')}`);
      return;
    }

    // Full output
    console.log(chalk.blue('🐾 MasterClaw User Context\n'));

    // System section
    console.log(chalk.white('System:'));
    console.log(`  User: ${chalk.cyan(system.user)}`);
    console.log(`  Host: ${chalk.cyan(system.hostname)}`);
    console.log(`  Platform: ${chalk.gray(system.platform)} (${system.arch})`);
    console.log(`  Node.js: ${chalk.gray(system.nodeVersion)}`);
    console.log(`  Shell: ${chalk.gray(system.shell)}`);
    console.log(`  CPUs: ${chalk.gray(system.cpus)} cores`);
    console.log(`  Memory: ${chalk.gray(system.freeMemory)} free / ${chalk.gray(system.totalMemory)} total`);
    console.log('');

    // Paths section
    console.log(chalk.white('Paths:'));
    console.log(`  Working Directory: ${chalk.gray(system.cwd)}`);
    console.log(`  Home Directory: ${chalk.gray(system.homeDir)}`);
    console.log(`  Temp Directory: ${chalk.gray(system.tmpDir)}`);
    console.log('');

    // CLI Configuration section
    console.log(chalk.white('CLI Configuration:'));
    console.log(`  Config File: ${chalk.gray(cliConfig.configFile)}`);
    console.log(`  Infrastructure: ${chalk.gray(cliConfig.infraDir)}`);
    console.log(`  Core URL: ${chalk.gray(cliConfig.coreUrl)}`);
    console.log(`  Gateway URL: ${chalk.gray(cliConfig.gatewayUrl)}`);
    console.log('');

    // Infrastructure Status section
    console.log(chalk.white('Infrastructure Status:'));
    if (infraStatus.exists) {
      console.log(`  Directory: ${chalk.green('✓')} ${infraStatus.path}`);
      console.log(`  docker-compose.yml: ${infraStatus.dockerCompose ? chalk.green('✓ Found') : chalk.red('✗ Missing')}`);
      console.log(`  .env file: ${infraStatus.envFile ? chalk.green('✓ Found') : chalk.yellow('⚠ Missing')}`);
    } else {
      console.log(`  Directory: ${chalk.red('✗ Not found')}`);
      console.log(chalk.gray('  Run `mc config set infraDir <path>` to configure'));
    }
    console.log('');

    // Core API Status section
    console.log(chalk.white('Core API Status:'));
    if (coreStatus.reachable) {
      console.log(`  Status: ${chalk.green('● Online')}`);
      console.log(`  Health: ${chalk.green(coreStatus.status)}`);
      console.log(`  Version: ${chalk.gray(coreStatus.version || 'unknown')}`);
    } else {
      console.log(`  Status: ${chalk.red('● Offline')}`);
      console.log(`  Error: ${chalk.gray(coreStatus.error)}`);
    }
    console.log('');

    // Environment section
    console.log(chalk.white('Environment:'));
    console.log(`  NODE_ENV: ${chalk.gray(environment.NODE_ENV)}`);
    console.log(`  ENV: ${chalk.gray(environment.ENV)}`);
    console.log(`  MASTERCLAW_INFRA: ${chalk.gray(environment.MASTERCLAW_INFRA)}`);

    if (options.secrets) {
      console.log('');
      console.log(chalk.white('Secrets:'));
      console.log(`  OPENAI_API_KEY: ${chalk.yellow(environment.OPENAI_API_KEY)}`);
      console.log(`  ANTHROPIC_API_KEY: ${chalk.yellow(environment.ANTHROPIC_API_KEY)}`);
      console.log(`  GATEWAY_TOKEN: ${chalk.yellow(environment.GATEWAY_TOKEN)}`);
    } else {
      console.log('');
      console.log(chalk.gray('Use --secrets to show secret configuration status'));
    }

    console.log('');
    console.log(chalk.gray('Use --json for machine-readable output'));
  }, 'whoami'));

module.exports = whoami;
module.exports.getSystemInfo = getSystemInfo;
module.exports.getCliConfig = getCliConfig;
module.exports.getEnvironmentStatus = getEnvironmentStatus;
module.exports.checkInfraStatus = checkInfraStatus;
module.exports.maskSecret = maskSecret;
module.exports.formatBytes = formatBytes;
