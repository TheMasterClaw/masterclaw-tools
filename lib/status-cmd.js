/**
 * Status Command for MasterClaw CLI
 *
 * Display comprehensive dashboard-style status of all MasterClaw services.
 * Shows Core API, Gateway, Infrastructure, and system health in one view.
 *
 * Features:
 * - Overall system health score
 * - Individual service status
 * - Quick health indicators
 * - JSON output for scripting
 * - Watch mode for continuous monitoring
 *
 * @example
 * mc status              # Show full status dashboard
 * mc status --watch      # Continuous monitoring
 * mc status --json       # JSON output
 * mc status --services   # Show only service status
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const os = require('os');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const status = new Command('status');

/**
 * Get Core API URL
 */
async function getCoreUrl() {
  return await config.get('core.url', 'http://localhost:8000');
}

/**
 * Get Gateway URL
 */
async function getGatewayUrl() {
  return await config.get('gateway.url', 'http://localhost:3000');
}

/**
 * Check service health
 */
async function checkServiceHealth(url, name) {
  try {
    const response = await axios.get(`${url}/health`, { timeout: 5000 });
    return {
      name,
      url,
      status: 'healthy',
      responseTime: response.duration || 0,
      version: response.data?.version,
    };
  } catch (err) {
    return {
      name,
      url,
      status: 'unhealthy',
      error: err.message,
    };
  }
}

/**
 * Get status color
 */
function getStatusColor(status) {
  switch (status) {
    case 'healthy':
      return chalk.green;
    case 'degraded':
      return chalk.yellow;
    case 'unhealthy':
      return chalk.red;
    default:
      return chalk.gray;
  }
}

/**
 * Get status icon
 */
function getStatusIcon(status) {
  switch (status) {
    case 'healthy':
      return '●';
    case 'degraded':
      return '◐';
    case 'unhealthy':
      return '○';
    default:
      return '?';
  }
}

/**
 * Calculate overall health score
 */
function calculateHealthScore(services) {
  if (services.length === 0) return 0;
  const healthy = services.filter(s => s.status === 'healthy').length;
  return Math.round((healthy / services.length) * 100);
}

/**
 * Main status command
 */
status
  .description('Show comprehensive status of all MasterClaw services')
  .option('-w, --watch', 'Watch mode - continuous monitoring')
  .option('-i, --interval <seconds>', 'Update interval in seconds', '5')
  .option('-s, --services', 'Show only service status')
  .option('-j, --json', 'Output as JSON')
  .option('--no-color', 'Disable colored output')
  .action(wrapCommand(async (options) => {
    const coreUrl = await getCoreUrl();
    const gatewayUrl = await getGatewayUrl();

    if (options.watch) {
      console.log(chalk.blue('📊 MasterClaw Status Monitor (Press Ctrl+C to exit)\n'));

      const interval = parseInt(options.interval, 10) * 1000;

      const check = async () => {
        console.clear();
        console.log(chalk.blue('📊 MasterClaw Status Monitor (Press Ctrl+C to exit)\n'));

        const services = await Promise.all([
          checkServiceHealth(coreUrl, 'Core API'),
          checkServiceHealth(gatewayUrl, 'Gateway'),
        ]);

        const score = calculateHealthScore(services);
        const scoreColor = score >= 90 ? chalk.green : score >= 70 ? chalk.yellow : chalk.red;

        console.log(chalk.white('Overall Health:'), scoreColor(`${score}%`));
        console.log('');

        services.forEach(service => {
          const color = getStatusColor(service.status);
          const icon = getStatusIcon(service.status);
          console.log(`  ${color(icon)} ${service.name}: ${color(service.status)}`);
          if (service.version) {
            console.log(chalk.gray(`     Version: ${service.version}`));
          }
        });

        console.log(chalk.gray(`\nLast updated: ${new Date().toLocaleString()}`));
        console.log(chalk.gray(`Next update in ${options.interval}s...`));
      };

      await check();
      setInterval(check, interval);
      return;
    }

    const spinner = ora('Checking service status...').start();

    const services = await Promise.all([
      checkServiceHealth(coreUrl, 'Core API'),
      checkServiceHealth(gatewayUrl, 'Gateway'),
    ]);

    spinner.stop();

    const score = calculateHealthScore(services);

    if (options.json) {
      console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        overallHealth: score,
        services,
        system: {
          platform: os.platform(),
          uptime: os.uptime(),
        },
      }, null, 2));
      return;
    }

    console.log(chalk.blue('📊 MasterClaw System Status\n'));

    // Overall Health
    const scoreColor = score >= 90 ? chalk.green : score >= 70 ? chalk.yellow : chalk.red;
    console.log(chalk.white('Overall Health:'), scoreColor(`${score}%`));
    console.log('');

    // Services
    console.log(chalk.white('Services:'));
    services.forEach(service => {
      const color = getStatusColor(service.status);
      const icon = getStatusIcon(service.status);
      console.log(`  ${color(icon)} ${chalk.bold(service.name)}`);
      console.log(chalk.gray(`     URL: ${service.url}`));
      console.log(chalk.gray(`     Status: ${color(service.status)}`));
      if (service.version) {
        console.log(chalk.gray(`     Version: ${service.version}`));
      }
      if (service.error) {
        console.log(chalk.red(`     Error: ${service.error}`));
      }
      console.log('');
    });

    // System Info
    if (!options.services) {
      console.log(chalk.white('System:'));
      console.log(`  Platform: ${chalk.gray(os.platform())}`);
      console.log(`  Node.js: ${chalk.gray(process.version)}`);
      console.log(`  Uptime: ${chalk.gray(Math.floor(os.uptime() / 60))} minutes`);
    }

    console.log('');

    if (score < 100) {
      console.log(chalk.yellow('⚠️  Some services are not healthy'));
      console.log(chalk.gray('Run `mc doctor` for detailed diagnostics'));
    } else {
      console.log(chalk.green('✓ All systems operational'));
    }
  }, 'status'));

module.exports = status;
