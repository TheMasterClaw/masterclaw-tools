/**
 * Dashboard command for mc CLI
 * Open monitoring dashboards (Grafana, Prometheus, Loki) from the command line
 * 
 * Features:
 * - Open Grafana, Prometheus, Loki, and Traefik dashboards
 * - Support for custom URLs via configuration
 * - Cross-platform (macOS, Linux, Windows)
 * - List all available dashboards
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const dashboardCmd = new Command('dashboard');

// Default dashboard URLs
const DEFAULT_URLS = {
  grafana: 'http://localhost:3003',
  prometheus: 'http://localhost:9090',
  loki: 'http://localhost:3100',
  traefik: 'http://localhost:8080',
  alertmanager: 'http://localhost:9093',
};

// Dashboard metadata
const DASHBOARDS = {
  grafana: {
    name: 'Grafana',
    description: 'Metrics visualization and dashboards',
    defaultUrl: DEFAULT_URLS.grafana,
    icon: '📊',
    paths: ['/dashboards', '/explore'],
  },
  prometheus: {
    name: 'Prometheus',
    description: 'Metrics collection and querying',
    defaultUrl: DEFAULT_URLS.prometheus,
    icon: '📈',
    paths: ['/graph', '/targets', '/alerts'],
  },
  loki: {
    name: 'Loki',
    description: 'Log aggregation and search',
    defaultUrl: DEFAULT_URLS.loki,
    icon: '📜',
    paths: ['/'],
  },
  traefik: {
    name: 'Traefik',
    description: 'Reverse proxy and load balancer dashboard',
    defaultUrl: DEFAULT_URLS.traefik,
    icon: '🌐',
    paths: ['/dashboard'],
  },
  alertmanager: {
    name: 'Alertmanager',
    description: 'Alert routing and management',
    defaultUrl: DEFAULT_URLS.alertmanager,
    icon: '🔔',
    paths: ['/'],
  },
};

/**
 * Detect the operating system
 * @returns {string} - 'macos', 'linux', 'windows', or 'unknown'
 */
function detectOS() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

/**
 * Open a URL in the default browser
 * @param {string} url - URL to open
 * @returns {Promise<void>}
 */
function openBrowser(url) {
  return new Promise((resolve, reject) => {
    const os = detectOS();
    let command;
    let args;

    switch (os) {
      case 'macos':
        command = 'open';
        args = [url];
        break;
      case 'linux':
        // Try xdg-open first, then fall back to common browsers
        command = 'xdg-open';
        args = [url];
        break;
      case 'windows':
        command = 'cmd';
        args = ['/c', 'start', '', url];
        break;
      default:
        reject(new Error(`Unsupported platform: ${os}`));
        return;
    }

    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });

    child.on('error', (err) => {
      // On Linux, try fallback browsers if xdg-open fails
      if (os === 'linux' && command === 'xdg-open') {
        tryFallbackBrowsers(url).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else if (os === 'linux' && command === 'xdg-open') {
        // Try fallback browsers
        tryFallbackBrowsers(url).then(resolve).catch(reject);
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });

    // Unref so the parent can exit independently
    child.unref();
  });
}

/**
 * Try fallback browsers on Linux
 * @param {string} url - URL to open
 * @returns {Promise<void>}
 */
async function tryFallbackBrowsers(url) {
  const browsers = ['google-chrome', 'chromium', 'firefox', 'firefox-esr', 'opera', 'brave'];
  
  for (const browser of browsers) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(browser, [url], {
          stdio: 'ignore',
          detached: true,
        });
        
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}`));
        });
        child.unref();
      });
      return; // Success
    } catch {
      // Try next browser
      continue;
    }
  }
  
  throw new Error('Could not open browser. Please open the URL manually.');
}

/**
 * Get dashboard URL from config or use default
 * @param {string} name - Dashboard name
 * @returns {Promise<string>} - Dashboard URL
 */
async function getDashboardUrl(name) {
  const configKey = `dashboards.${name}.url`;
  const customUrl = await config.get(configKey);
  
  if (customUrl) {
    return customUrl;
  }
  
  const dashboard = DASHBOARDS[name];
  if (!dashboard) {
    throw new Error(`Unknown dashboard: ${name}`);
  }
  
  return dashboard.defaultUrl;
}

/**
 * Check if a URL is accessible
 * @param {string} url - URL to check
 * @returns {Promise<boolean>}
 */
async function isUrlAccessible(url) {
  const axios = require('axios');
  try {
    await axios.get(url, {
      timeout: 3000,
      validateStatus: () => true,
    });
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Commands
// =============================================================================

// List all dashboards
dashboardCmd
  .command('list')
  .description('List all available dashboards')
  .option('-j, --json', 'Output as JSON')
  .option('--check', 'Check if dashboards are accessible')
  .action(wrapCommand(async (options) => {
    const dashboards = [];
    
    for (const [key, info] of Object.entries(DASHBOARDS)) {
      const url = await getDashboardUrl(key);
      let status = 'unknown';
      
      if (options.check) {
        const accessible = await isUrlAccessible(url);
        status = accessible ? 'accessible' : 'unreachable';
      }
      
      dashboards.push({
        key,
        name: info.name,
        description: info.description,
        url,
        icon: info.icon,
        status,
      });
    }
    
    if (options.json) {
      console.log(JSON.stringify(dashboards, null, 2));
      return;
    }
    
    console.log(chalk.blue('🐾 MasterClaw Dashboards\n'));
    
    for (const db of dashboards) {
      const statusIcon = options.check
        ? db.status === 'accessible'
          ? chalk.green('✅')
          : chalk.red('❌')
        : '';
      
      console.log(`${db.icon} ${chalk.bold(db.name)} ${statusIcon}`);
      console.log(`   ${chalk.gray(db.description)}`);
      console.log(`   ${chalk.cyan(db.url)}`);
      
      if (options.check) {
        const statusColor = db.status === 'accessible' ? chalk.green : chalk.red;
        console.log(`   Status: ${statusColor(db.status)}`);
      }
      console.log('');
    }
    
    console.log(chalk.gray('Usage: mc dashboard open <name>'));
    console.log(chalk.gray('Example: mc dashboard open grafana'));
  }, 'dashboard'));

// Open a specific dashboard
dashboardCmd
  .command('open')
  .description('Open a dashboard in your default browser')
  .argument('<name>', 'Dashboard name (grafana, prometheus, loki, traefik, alertmanager)')
  .option('-p, --path <path>', 'Specific path to open (e.g., /explore, /graph)')
  .option('--url-only', 'Print URL instead of opening browser')
  .action(wrapCommand(async (name, options) => {
    // Validate dashboard name
    const validNames = Object.keys(DASHBOARDS);
    if (!validNames.includes(name)) {
      console.log(chalk.red(`❌ Unknown dashboard: ${name}`));
      console.log(chalk.gray(`Valid dashboards: ${validNames.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
    
    let url = await getDashboardUrl(name);
    const dashboard = DASHBOARDS[name];
    
    // Append specific path if provided
    if (options.path) {
      // Ensure path starts with /
      const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
      url = `${url}${path}`;
    }
    
    if (options.urlOnly) {
      console.log(url);
      return;
    }
    
    console.log(chalk.blue(`🐾 Opening ${dashboard.icon} ${dashboard.name}...`));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green(`✅ Opened ${dashboard.name} in browser`));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.yellow(`⚠️  Please open this URL manually:`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

// Quick shortcuts for common dashboards
dashboardCmd
  .command('grafana')
  .description('Shortcut: Open Grafana dashboard')
  .action(wrapCommand(async () => {
    const url = await getDashboardUrl('grafana');
    console.log(chalk.blue('🐾 Opening 📊 Grafana...'));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green('✅ Opened Grafana in browser'));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

dashboardCmd
  .command('prometheus')
  .description('Shortcut: Open Prometheus dashboard')
  .action(wrapCommand(async () => {
    const url = await getDashboardUrl('prometheus');
    console.log(chalk.blue('🐾 Opening 📈 Prometheus...'));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green('✅ Opened Prometheus in browser'));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

dashboardCmd
  .command('loki')
  .description('Shortcut: Open Loki dashboard')
  .action(wrapCommand(async () => {
    const url = await getDashboardUrl('loki');
    console.log(chalk.blue('🐾 Opening 📜 Loki...'));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green('✅ Opened Loki in browser'));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

dashboardCmd
  .command('traefik')
  .description('Shortcut: Open Traefik dashboard')
  .action(wrapCommand(async () => {
    const url = await getDashboardUrl('traefik');
    console.log(chalk.blue('🐾 Opening 🌐 Traefik...'));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green('✅ Opened Traefik in browser'));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

dashboardCmd
  .command('alertmanager')
  .description('Shortcut: Open Alertmanager dashboard')
  .action(wrapCommand(async () => {
    const url = await getDashboardUrl('alertmanager');
    console.log(chalk.blue('🐾 Opening 🔔 Alertmanager...'));
    console.log(chalk.gray(`   ${url}`));
    
    try {
      await openBrowser(url);
      console.log(chalk.green('✅ Opened Alertmanager in browser'));
    } catch (err) {
      console.log(chalk.red(`❌ Could not open browser: ${err.message}`));
      console.log(chalk.cyan(`   ${url}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'dashboard'));

// Open all dashboards
dashboardCmd
  .command('open-all')
  .description('Open all dashboards in browser')
  .option('--exclude <names>', 'Comma-separated list of dashboards to exclude')
  .action(wrapCommand(async (options) => {
    const excludeList = options.exclude
      ? options.exclude.split(',').map(s => s.trim().toLowerCase())
      : [];
    
    const dashboards = Object.entries(DASHBOARDS)
      .filter(([key]) => !excludeList.includes(key));
    
    console.log(chalk.blue(`🐾 Opening ${dashboards.length} dashboards...\n`));
    
    let opened = 0;
    let failed = 0;
    
    for (const [key, info] of dashboards) {
      const url = await getDashboardUrl(key);
      process.stdout.write(`${info.icon} ${info.name}... `);
      
      try {
        await openBrowser(url);
        console.log(chalk.green('opened'));
        opened++;
      } catch (err) {
        console.log(chalk.red(`failed (${err.message})`));
        failed++;
      }
      
      // Small delay between opening to avoid overwhelming the browser
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log('');
    console.log(chalk.green(`✅ Opened ${opened} dashboards`));
    if (failed > 0) {
      console.log(chalk.red(`❌ Failed to open ${failed} dashboards`));
    }
  }, 'dashboard'));

// Configure custom dashboard URLs
dashboardCmd
  .command('config')
  .description('Configure custom dashboard URLs')
  .argument('<name>', 'Dashboard name (grafana, prometheus, loki, traefik, alertmanager)')
  .argument('<url>', 'Custom URL for the dashboard')
  .action(wrapCommand(async (name, url) => {
    const validNames = Object.keys(DASHBOARDS);
    if (!validNames.includes(name)) {
      console.log(chalk.red(`❌ Unknown dashboard: ${name}`));
      console.log(chalk.gray(`Valid dashboards: ${validNames.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
    
    // Basic URL validation
    try {
      new URL(url);
    } catch {
      console.log(chalk.red(`❌ Invalid URL: ${url}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
    
    const configKey = `dashboards.${name}.url`;
    await config.set(configKey, url);
    
    console.log(chalk.green(`✅ Set ${chalk.cyan(name)} dashboard URL to:`));
    console.log(chalk.cyan(`   ${url}`));
  }, 'dashboard'));

// Default action: show help
dashboardCmd
  .action(() => {
    dashboardCmd.help();
  });

module.exports = dashboardCmd;
module.exports.DASHBOARDS = DASHBOARDS;
module.exports.getDashboardUrl = getDashboardUrl;
module.exports.openBrowser = openBrowser;
