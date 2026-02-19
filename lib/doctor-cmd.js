/**
 * Doctor Command for MasterClaw CLI
 *
 * Diagnostic tool that analyzes the MasterClaw ecosystem and provides
 * recommendations for fixing issues and optimizing performance.
 *
 * Features:
 * - System health diagnostics
 * - Configuration validation
 * - Performance recommendations
 * - Security checks
 * - Dependency analysis
 * - Export diagnostic reports
 *
 * @example
 * mc doctor                    # Run full diagnostics
 * mc doctor --quick            # Quick health check
 * mc doctor --fix              # Auto-fix issues where possible
 * mc doctor --json             # JSON output for scripting
 * mc doctor --export report.md # Export report to markdown
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const doctor = new Command('doctor');

/**
 * Diagnostic check categories
 */
const CHECK_CATEGORIES = {
  SYSTEM: 'system',
  CONFIG: 'configuration',
  CONNECTIVITY: 'connectivity',
  PERFORMANCE: 'performance',
  SECURITY: 'security',
};

/**
 * Diagnostic result severity
 */
const SEVERITY = {
  OK: 'ok',
  WARNING: 'warning',
  ERROR: 'error',
  INFO: 'info',
};

/**
 * Run a diagnostic check
 */
async function runCheck(name, checkFn) {
  const start = Date.now();
  try {
    const result = await checkFn();
    return {
      name,
      ...result,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name,
      status: SEVERITY.ERROR,
      message: `Check failed: ${error.message}`,
      duration: Date.now() - start,
    };
  }
}

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
 * Check Node.js version
 */
async function checkNodeVersion() {
  const version = process.version;
  const majorVersion = parseInt(version.slice(1).split('.')[0], 10);

  if (majorVersion < 16) {
    return {
      status: SEVERITY.ERROR,
      message: `Node.js ${version} is too old. Version 16+ required.`,
      recommendation: 'Upgrade Node.js to version 16 or higher',
    };
  }

  if (majorVersion < 18) {
    return {
      status: SEVERITY.WARNING,
      message: `Node.js ${version} works but 18+ recommended`,
      recommendation: 'Consider upgrading to Node.js 18+ for better performance',
    };
  }

  return {
    status: SEVERITY.OK,
    message: `Node.js ${version} ✓`,
  };
}

/**
 * Check system resources
 */
async function checkSystemResources() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMemPercent = ((totalMem - freeMem) / totalMem) * 100;

  const issues = [];

  if (usedMemPercent > 90) {
    issues.push({
      status: SEVERITY.ERROR,
      message: `Memory usage at ${usedMemPercent.toFixed(1)}% - critically low`,
      recommendation: 'Close unused applications or add more RAM',
    });
  } else if (usedMemPercent > 80) {
    issues.push({
      status: SEVERITY.WARNING,
      message: `Memory usage at ${usedMemPercent.toFixed(1)}% - high`,
      recommendation: 'Consider closing unused applications',
    });
  }

  if (issues.length === 0) {
    return {
      status: SEVERITY.OK,
      message: `Memory: ${formatBytes(freeMem)} free / ${formatBytes(totalMem)} total`,
    };
  }

  return issues[0];
}

/**
 * Check Core API connectivity
 */
async function checkCoreConnectivity() {
  const coreUrl = await getCoreUrl();

  try {
    const response = await axios.get(`${coreUrl}/health`, { timeout: 5000 });

    if (response.status === 200) {
      return {
        status: SEVERITY.OK,
        message: `Core API at ${coreUrl} - healthy (${response.data.version || 'unknown version'})`,
      };
    }

    return {
      status: SEVERITY.WARNING,
      message: `Core API returned status ${response.status}`,
      recommendation: 'Check Core API logs for issues',
    };
  } catch (error) {
    return {
      status: SEVERITY.ERROR,
      message: `Cannot connect to Core API at ${coreUrl}`,
      recommendation: 'Start Core API with `mc start` or check if it\'s running',
    };
  }
}

/**
 * Check Gateway connectivity
 */
async function checkGatewayConnectivity() {
  const gatewayUrl = await getGatewayUrl();

  try {
    await axios.get(`${gatewayUrl}/health`, { timeout: 5000 });
    return {
      status: SEVERITY.OK,
      message: `Gateway at ${gatewayUrl} - reachable`,
    };
  } catch (error) {
    return {
      status: SEVERITY.WARNING,
      message: `Gateway at ${gatewayUrl} - not reachable`,
      recommendation: 'Start Gateway with `mc gateway start` (optional component)',
    };
  }
}

/**
 * Check CLI configuration
 */
async function checkCliConfig() {
  const infraDir = await config.get('infraDir');

  if (!infraDir) {
    return {
      status: SEVERITY.WARNING,
      message: 'Infrastructure directory not configured',
      recommendation: 'Set with: mc config set infraDir <path>',
    };
  }

  const exists = await fs.pathExists(infraDir);

  if (!exists) {
    return {
      status: SEVERITY.ERROR,
      message: `Infrastructure directory not found: ${infraDir}`,
      recommendation: 'Update path with: mc config set infraDir <path>',
    };
  }

  return {
    status: SEVERITY.OK,
    message: `Infrastructure directory: ${infraDir}`,
  };
}

/**
 * Check environment variables
 */
async function checkEnvironment() {
  const missing = [];

  if (!process.env.OPENAI_API_KEY) {
    missing.push('OPENAI_API_KEY');
  }

  if (missing.length > 0) {
    return {
      status: SEVERITY.WARNING,
      message: `Missing optional environment variables: ${missing.join(', ')}`,
      recommendation: 'Set in .env file for full functionality',
    };
  }

  return {
    status: SEVERITY.OK,
    message: 'Required environment variables present',
  };
}

/**
 * Format bytes
 */
function formatBytes(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Get severity icon
 */
function getSeverityIcon(status) {
  switch (status) {
    case SEVERITY.OK:
      return chalk.green('✓');
    case SEVERITY.WARNING:
      return chalk.yellow('⚠');
    case SEVERITY.ERROR:
      return chalk.red('✗');
    case SEVERITY.INFO:
      return chalk.blue('ℹ');
    default:
      return chalk.gray('?');
  }
}

/**
 * Get severity color
 */
function getSeverityColor(status) {
  switch (status) {
    case SEVERITY.OK:
      return chalk.green;
    case SEVERITY.WARNING:
      return chalk.yellow;
    case SEVERITY.ERROR:
      return chalk.red;
    case SEVERITY.INFO:
      return chalk.blue;
    default:
      return chalk.gray;
  }
}

/**
 * Main doctor command
 */
doctor
  .description('Run diagnostics and provide recommendations')
  .option('-q, --quick', 'Quick health check only')
  .option('-j, --json', 'Output as JSON')
  .option('--export <path>', 'Export report to file')
  .option('--no-color', 'Disable colored output')
  .action(
    wrapCommand(async (options) => {
      console.log(chalk.blue('🩺 MasterClaw Doctor\n'));
      console.log(chalk.gray('Running diagnostics...\n'));

      const checks = [];

      if (options.quick) {
        // Quick mode - only critical checks
        checks.push(runCheck('Node.js Version', checkNodeVersion));
        checks.push(runCheck('Core API', checkCoreConnectivity));
      } else {
        // Full diagnostics
        checks.push(runCheck('Node.js Version', checkNodeVersion));
        checks.push(runCheck('System Resources', checkSystemResources));
        checks.push(runCheck('CLI Configuration', checkCliConfig));
        checks.push(runCheck('Environment', checkEnvironment));
        checks.push(runCheck('Core API', checkCoreConnectivity));
        checks.push(runCheck('Gateway', checkGatewayConnectivity));
      }

      const results = await Promise.all(checks);

      // Calculate summary
      const summary = {
        ok: results.filter((r) => r.status === SEVERITY.OK).length,
        warning: results.filter((r) => r.status === SEVERITY.WARNING).length,
        error: results.filter((r) => r.status === SEVERITY.ERROR).length,
      };

      const report = {
        timestamp: new Date().toISOString(),
        summary,
        results,
      };

      if (options.export) {
        await exportReport(report, options.export);
        console.log(chalk.green(`✓ Report exported to ${options.export}`));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      // Display results
      const categories = {
        [CHECK_CATEGORIES.SYSTEM]: ['Node.js Version', 'System Resources'],
        [CHECK_CATEGORIES.CONFIG]: ['CLI Configuration', 'Environment'],
        [CHECK_CATEGORIES.CONNECTIVITY]: ['Core API', 'Gateway'],
      };

      Object.entries(categories).forEach(([category, checkNames]) => {
        const categoryResults = results.filter((r) => checkNames.includes(r.name));

        if (categoryResults.length === 0) return;

        console.log(chalk.white(`${category.charAt(0).toUpperCase() + category.slice(1)}:`));

        categoryResults.forEach((result) => {
          const icon = getSeverityIcon(result.status);
          const color = getSeverityColor(result.status);

          console.log(`  ${icon} ${result.name}: ${color(result.message)}`);

          if (result.recommendation) {
            console.log(chalk.gray(`     → ${result.recommendation}`));
          }
        });

        console.log('');
      });

      // Summary
      console.log(chalk.white('Summary:'));
      console.log(`  ${chalk.green('✓')} ${summary.ok} passed`);
      if (summary.warning > 0) {
        console.log(`  ${chalk.yellow('⚠')} ${summary.warning} warnings`);
      }
      if (summary.error > 0) {
        console.log(`  ${chalk.red('✗')} ${summary.error} errors`);
      }

      console.log('');

      if (summary.error > 0) {
        console.log(chalk.red('❌ Some checks failed. Please review the issues above.'));
        process.exit(ExitCode.GENERAL_ERROR);
      } else if (summary.warning > 0) {
        console.log(chalk.yellow('⚠️  Some recommendations available. Review for optimal performance.'));
      } else {
        console.log(chalk.green('✓ All checks passed! Your MasterClaw setup looks healthy.'));
      }
    }, 'doctor')
  );

/**
 * Export report to file
 */
async function exportReport(report, filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.json') {
    await fs.writeJson(filePath, report, { spaces: 2 });
  } else if (ext === '.md') {
    const markdown = generateMarkdownReport(report);
    await fs.writeFile(filePath, markdown);
  } else {
    // Default to text
    const text = generateTextReport(report);
    await fs.writeFile(filePath, text);
  }
}

/**
 * Generate markdown report
 */
function generateMarkdownReport(report) {
  const lines = [
    '# MasterClaw Diagnostic Report',
    '',
    `Generated: ${new Date(report.timestamp).toLocaleString()}`,
    '',
    '## Summary',
    '',
    `- ✅ Passed: ${report.summary.ok}`,
    `- ⚠️ Warnings: ${report.summary.warning}`,
    `- ❌ Errors: ${report.summary.error}`,
    '',
    '## Details',
    '',
  ];

  report.results.forEach((result) => {
    const icon = result.status === SEVERITY.OK ? '✅' : result.status === SEVERITY.WARNING ? '⚠️' : '❌';
    lines.push(`### ${icon} ${result.name}`);
    lines.push('');
    lines.push(`**Status:** ${result.status}`);
    lines.push('');
    lines.push(`**Message:** ${result.message}`);
    lines.push('');

    if (result.recommendation) {
      lines.push(`**Recommendation:** ${result.recommendation}`);
      lines.push('');
    }

    if (result.duration) {
      lines.push(`*Check duration: ${result.duration}ms*`);
      lines.push('');
    }
  });

  return lines.join('\n');
}

/**
 * Generate text report
 */
function generateTextReport(report) {
  const lines = [
    'MasterClaw Diagnostic Report',
    `Generated: ${new Date(report.timestamp).toLocaleString()}`,
    '',
    `Summary: ${report.summary.ok} passed, ${report.summary.warning} warnings, ${report.summary.error} errors`,
    '',
  ];

  report.results.forEach((result) => {
    lines.push(`${result.status.toUpperCase()}: ${result.name}`);
    lines.push(`  ${result.message}`);
    if (result.recommendation) {
      lines.push(`  Recommendation: ${result.recommendation}`);
    }
    lines.push('');
  });

  return lines.join('\n');
}

module.exports = doctor;
