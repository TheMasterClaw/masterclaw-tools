/**
 * Info command - System information and diagnostics
 * 
 * Shows comprehensive information about the MasterClaw ecosystem:
 * - CLI and API versions
 * - System information (OS, Node.js version, etc.)
 * - Configuration summary
 * - Installation paths
 * - Feature availability
 */

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const axios = require('axios');

const config = require('./config');
const { findInfraDir } = require('./services');

const CLI_VERSION = require('../package.json').version;

/**
 * Get CLI version info
 */
async function getCliInfo() {
  return {
    version: CLI_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  };
}

/**
 * Get system information
 */
async function getSystemInfo() {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: formatBytes(os.totalmem()),
    freeMemory: formatBytes(os.freemem()),
    uptime: formatUptime(os.uptime()),
  };
}

/**
 * Get API version if available
 */
async function getApiInfo() {
  try {
    const coreUrl = await config.get('core.url') || 'http://localhost:8000';
    const response = await axios.get(coreUrl, { timeout: 3000 });
    return {
      available: true,
      version: response.data.version || 'unknown',
      status: response.data.status || 'unknown',
    };
  } catch (err) {
    return {
      available: false,
      error: err.code || 'unavailable',
    };
  }
}

/**
 * Get infrastructure info
 */
async function getInfraInfo() {
  const infraDir = await findInfraDir();
  
  if (!infraDir) {
    return {
      found: false,
      path: null,
    };
  }

  const info = {
    found: true,
    path: infraDir,
  };

  // Check for docker-compose.yml
  const composePath = path.join(infraDir, 'docker-compose.yml');
  info.hasDockerCompose = await fs.pathExists(composePath);

  // Check for .env
  const envPath = path.join(infraDir, '.env');
  info.hasEnv = await fs.pathExists(envPath);

  // Check for Makefile
  const makefilePath = path.join(infraDir, 'Makefile');
  info.hasMakefile = await fs.pathExists(makefilePath);

  // Check for monitoring
  const monitoringPath = path.join(infraDir, 'monitoring');
  info.hasMonitoring = await fs.pathExists(monitoringPath);

  return info;
}

/**
 * Get configuration summary (safe values only)
 */
async function getConfigSummary() {
  try {
    const allConfig = await config.list();
    
    // Only show keys, not values (for security)
    const keys = Object.keys(allConfig);
    
    return {
      configured: keys.length > 0,
      keys: keys,
      configPath: config.getConfigPath(),
    };
  } catch (err) {
    return {
      configured: false,
      error: err.message,
    };
  }
}

/**
 * Get Docker info
 */
async function getDockerInfo() {
  try {
    const output = execSync('docker version --format "{{.Server.Version}}"', { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    
    return {
      installed: true,
      version: output,
    };
  } catch (err) {
    return {
      installed: false,
      error: 'Docker not available',
    };
  }
}

/**
 * Get feature availability
 */
async function getFeatureInfo() {
  const features = {
    monitoring: false,
    ssl: false,
    backup: false,
    canaryDeploy: false,
  };

  const infraDir = await findInfraDir();
  if (infraDir) {
    // Check for monitoring stack
    const monitoringCompose = path.join(infraDir, 'docker-compose.monitoring.yml');
    features.monitoring = await fs.pathExists(monitoringCompose);

    // Check for SSL scripts
    const sslScript = path.join(infraDir, 'scripts', 'ssl-cert-check.sh');
    features.ssl = await fs.pathExists(sslScript);

    // Check for backup scripts
    const backupScript = path.join(infraDir, 'scripts', 'backup.sh');
    features.backup = await fs.pathExists(backupScript);

    // Check for deploy scripts (blue-green)
    const deployScript = path.join(infraDir, 'scripts', 'deploy.sh');
    features.canaryDeploy = await fs.pathExists(deployScript);
  }

  return features;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format uptime to human readable
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  
  return parts.join(' ') || '< 1m';
}

/**
 * Main info command
 */
async function showInfo(options = {}) {
  const format = options.json ? 'json' : 'pretty';
  
  // Gather all information
  const info = {
    timestamp: new Date().toISOString(),
    cli: await getCliInfo(),
    system: await getSystemInfo(),
    api: await getApiInfo(),
    infrastructure: await getInfraInfo(),
    config: await getConfigSummary(),
    docker: await getDockerInfo(),
    features: await getFeatureInfo(),
  };

  if (format === 'json') {
    console.log(JSON.stringify(info, null, 2));
    return info;
  }

  // Pretty format output
  console.log(chalk.blue('🐾 MasterClaw System Information\n'));

  // CLI Info
  console.log(chalk.cyan('CLI:'));
  console.log(`  Version: ${chalk.bold(info.cli.version)}`);
  console.log(`  Node.js: ${info.cli.nodeVersion}`);
  console.log(`  Platform: ${info.cli.platform} (${info.cli.arch})`);
  console.log('');

  // API Info
  console.log(chalk.cyan('Core API:'));
  if (info.api.available) {
    console.log(`  Status: ${chalk.green('● Running')}`);
    console.log(`  Version: ${chalk.bold(info.api.version)}`);
  } else {
    console.log(`  Status: ${chalk.red('● Not available')}`);
    console.log(chalk.gray(`  Error: ${info.api.error}`));
  }
  console.log('');

  // System Info
  console.log(chalk.cyan('System:'));
  console.log(`  Hostname: ${info.system.hostname}`);
  console.log(`  OS: ${info.system.platform} ${info.system.release} (${info.system.arch})`);
  console.log(`  CPUs: ${info.system.cpus}`);
  console.log(`  Memory: ${info.system.freeMemory} free / ${info.system.totalMemory} total`);
  console.log(`  Uptime: ${info.system.uptime}`);
  console.log('');

  // Docker Info
  console.log(chalk.cyan('Docker:'));
  if (info.docker.installed) {
    console.log(`  Status: ${chalk.green('● Installed')}`);
    console.log(`  Version: ${info.docker.version}`);
  } else {
    console.log(`  Status: ${chalk.red('● Not installed')}`);
  }
  console.log('');

  // Infrastructure Info
  console.log(chalk.cyan('Infrastructure:'));
  if (info.infrastructure.found) {
    console.log(`  Path: ${chalk.gray(info.infrastructure.path)}`);
    console.log(`  Docker Compose: ${info.infrastructure.hasDockerCompose ? chalk.green('✓') : chalk.red('✗')}`);
    console.log(`  Environment: ${info.infrastructure.hasEnv ? chalk.green('✓') : chalk.yellow('⚠')}`);
    console.log(`  Makefile: ${info.infrastructure.hasMakefile ? chalk.green('✓') : chalk.red('✗')}`);
    console.log(`  Monitoring: ${info.infrastructure.hasMonitoring ? chalk.green('✓') : chalk.gray('-')}`);
  } else {
    console.log(`  Status: ${chalk.yellow('⚠ Not found')}`);
    console.log(chalk.gray('  Run from masterclaw-infrastructure directory or set --infra-dir'));
  }
  console.log('');

  // Config Info
  console.log(chalk.cyan('Configuration:'));
  console.log(`  Config file: ${chalk.gray(info.config.configPath)}`);
  if (info.config.configured) {
    console.log(`  Settings: ${info.config.keys.length} key(s) configured`);
    if (info.config.keys.length > 0) {
      console.log(chalk.gray(`    ${info.config.keys.join(', ')}`));
    }
  } else {
    console.log(`  Settings: ${chalk.yellow('Not configured')}`);
  }
  console.log('');

  // Features
  console.log(chalk.cyan('Features:'));
  const featureList = [
    { name: 'Monitoring Stack', enabled: info.features.monitoring },
    { name: 'SSL Management', enabled: info.features.ssl },
    { name: 'Automated Backups', enabled: info.features.backup },
    { name: 'Canary Deployment', enabled: info.features.canaryDeploy },
  ];
  
  for (const feature of featureList) {
    const icon = feature.enabled ? chalk.green('✓') : chalk.gray('-');
    const status = feature.enabled ? chalk.green('available') : chalk.gray('not available');
    console.log(`  ${icon} ${feature.name}: ${status}`);
  }
  console.log('');

  // Quick actions hint
  console.log(chalk.gray('Quick commands:'));
  console.log(chalk.gray('  mc status        Check service health'));
  console.log(chalk.gray('  mc doctor        Run comprehensive diagnostics'));
  console.log(chalk.gray('  mc validate      Validate environment'));
  console.log('');

  return info;
}

module.exports = {
  showInfo,
  getCliInfo,
  getSystemInfo,
  getApiInfo,
  getInfraInfo,
  getConfigSummary,
  getDockerInfo,
  getFeatureInfo,
};
