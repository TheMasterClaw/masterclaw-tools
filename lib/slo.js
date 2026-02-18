#!/usr/bin/env node
/**
 * mc slo - Service Level Objective tracking and monitoring
 * 
 * View SLO status, check error budgets, and monitor burn rates
 * to ensure service reliability targets are met.
 * 
 * Examples:
 *   mc slo list                    # List all configured SLOs
 *   mc slo status                  # Check status of all SLOs
 *   mc slo status api_availability # Check specific SLO
 *   mc slo alerts                  # Show burn rate alerts
 *   mc slo explain                 # Explain SLO concepts
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fetch = require('node-fetch');

const { findCoreApiUrl, getGatewayToken } = require('./client');
const { wrapCommand, ExitCode } = require('./error-handler');
const logger = require('./logger').child('slo');

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Make authenticated API request to core
 */
async function apiRequest(path, options = {}) {
  const baseUrl = await findCoreApiUrl();
  const token = getGatewayToken();
  
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API request failed: ${response.status} ${error}`);
  }

  return response.json();
}

/**
 * Format percentage value with color
 */
function formatPercent(value, thresholds = { warning: 0.95, critical: 0.90 }) {
  const percent = (value * 100).toFixed(2);
  if (value < thresholds.critical) {
    return chalk.red(`${percent}%`);
  } else if (value < thresholds.warning) {
    return chalk.yellow(`${percent}%`);
  }
  return chalk.green(`${percent}%`);
}

/**
 * Format burn rate with color
 */
function formatBurnRate(rate) {
  if (rate > 6) {
    return chalk.red(`${rate.toFixed(2)}x 🔥`);
  } else if (rate > 1) {
    return chalk.yellow(`${rate.toFixed(2)}x ⚠️`);
  } else if (rate > 0) {
    return chalk.green(`${rate.toFixed(2)}x`);
  }
  return chalk.gray('0x');
}

/**
 * Format error budget remaining with color
 */
function formatErrorBudget(ratio) {
  const percent = (ratio * 100).toFixed(1);
  if (ratio <= 0) {
    return chalk.red(`${percent}% (EXHAUSTED)`);
  } else if (ratio < 0.2) {
    return chalk.red(`${percent}%`);
  } else if (ratio < 0.5) {
    return chalk.yellow(`${percent}%`);
  }
  return chalk.green(`${percent}%`);
}

/**
 * Format SLO status indicator
 */
function formatStatus(compliant) {
  return compliant 
    ? chalk.green('✅ Compliant')
    : chalk.red('❌ Violated');
}

// =============================================================================
// Command Implementations
// =============================================================================

/**
 * List all configured SLOs
 */
async function listSlos() {
  const data = await apiRequest('/slo');
  
  console.log(chalk.bold('\n🎯 Configured Service Level Objectives\n'));
  
  if (data.slos.length === 0) {
    console.log(chalk.gray('No SLOs configured.'));
    return;
  }
  
  for (const slo of data.slos) {
    const target = slo.type === 'availability' 
      ? `${(slo.target * 100).toFixed(1)}%`
      : `p${Math.round(slo.target * 100)} < ${(slo.threshold * 1000).toFixed(0)}ms`;
    
    console.log(`${chalk.cyan(slo.name)}`);
    console.log(`  Type: ${slo.type}`);
    console.log(`  Target: ${chalk.bold(target)}`);
    console.log(`  Window: ${slo.window_days} days`);
    console.log(`  Error Budget: ${(slo.error_budget * 100).toFixed(2)}%`);
    if (slo.description) {
      console.log(`  Description: ${chalk.gray(slo.description)}`);
    }
    console.log('');
  }
  
  console.log(chalk.gray(`Total: ${data.count} SLO(s) configured`));
}

/**
 * Get SLO status
 */
async function getSloStatus(sloName, options) {
  const windowParam = options.window ? `?window_days=${options.window}` : '';
  const data = await apiRequest(`/slo/${sloName}${windowParam}`);
  
  console.log(chalk.bold(`\n🎯 SLO Status: ${sloName}\n`));
  
  // SLO Info
  console.log(chalk.underline('Configuration:'));
  console.log(`  Name: ${data.slo.name}`);
  console.log(`  Type: ${data.slo.type}`);
  console.log(`  Target: ${(data.slo.target * 100).toFixed(1)}%`);
  console.log(`  Window: ${data.slo.window_days} days`);
  console.log('');
  
  // Status
  console.log(chalk.underline('Current Status:'));
  console.log(`  Status: ${formatStatus(data.status.compliant)}`);
  console.log(`  Current Ratio: ${formatPercent(data.status.current_ratio)}`);
  console.log(`  Error Budget Remaining: ${formatErrorBudget(data.status.error_budget_remaining)}`);
  console.log(`  Burn Rate: ${formatBurnRate(data.status.burn_rate)}`);
  console.log('');
  
  // Metrics
  console.log(chalk.underline('Metrics:'));
  console.log(`  Total Requests: ${data.metrics.total_requests.toLocaleString()}`);
  console.log(`  Successful: ${chalk.green(data.metrics.successful_requests.toLocaleString())}`);
  console.log(`  Failed: ${chalk.red(data.metrics.failed_requests.toLocaleString())}`);
  
  if (data.metrics.p50_latency_ms !== null) {
    console.log('');
    console.log(chalk.underline('Latency Percentiles:'));
    console.log(`  p50: ${data.metrics.p50_latency_ms?.toFixed(2)}ms`);
    console.log(`  p95: ${data.metrics.p95_latency_ms?.toFixed(2)}ms`);
    console.log(`  p99: ${data.metrics.p99_latency_ms?.toFixed(2)}ms`);
    console.log(`  Above Threshold: ${data.metrics.requests_above_threshold}`);
  }
  
  // Window
  console.log('');
  console.log(chalk.underline('Evaluation Window:'));
  console.log(`  From: ${new Date(data.window.start).toLocaleString()}`);
  console.log(`  To: ${new Date(data.window.end).toLocaleString()}`);
  
  // Burn rate interpretation
  if (data.status.burn_rate > 1) {
    console.log('');
    console.log(chalk.yellow('⚠️  Warning: Error budget is burning faster than sustainable rate.'));
    const hoursUntilExhausted = data.slo.window_days * 24 / data.status.burn_rate;
    console.log(chalk.yellow(`   At current rate, budget will exhaust in ~${hoursUntilExhausted.toFixed(1)} hours.`));
  }
}

/**
 * Get all SLOs status
 */
async function getAllSloStatus(options) {
  const windowParam = options.window ? `?window_days=${options.window}` : '';
  const data = await apiRequest(`/slo/status/all${windowParam}`);
  
  console.log(chalk.bold('\n🎯 SLO Status Summary\n'));
  
  // Overall summary
  const summary = data.summary;
  const overallColor = summary.overall_healthy ? chalk.green : chalk.red;
  console.log(overallColor(`${summary.compliant}/${summary.total_slos} SLOs compliant`));
  
  if (summary.violated > 0) {
    console.log(chalk.red(`⚠️  ${summary.violated} SLO(s) currently violated`));
  }
  console.log('');
  
  // Individual SLOs
  console.log(chalk.underline('Individual SLOs:'));
  for (const slo of data.slos) {
    const status = slo.status.compliant ? chalk.green('✓') : chalk.red('✗');
    const burnRate = formatBurnRate(slo.status.burn_rate);
    const budget = formatErrorBudget(slo.status.error_budget_remaining);
    
    console.log(`  ${status} ${chalk.cyan(slo.slo.name.padEnd(20))} ${burnRate.padStart(10)} ${budget.padStart(15)}`);
  }
  
  // Alerts
  if (data.alerts.length > 0) {
    console.log('');
    console.log(chalk.underline('Active Alerts:'));
    for (const alert of data.alerts) {
      const color = alert.severity === 'critical' ? chalk.red : chalk.yellow;
      console.log(color(`  ${alert.severity.toUpperCase()}: ${alert.message}`));
    }
  }
}

/**
 * Get burn rate alerts
 */
async function getSloAlerts(options) {
  const threshold = options.threshold || 1.0;
  const data = await apiRequest(`/slo/alerts?threshold=${threshold}`);
  
  console.log(chalk.bold(`\n🚨 SLO Burn Rate Alerts (threshold: ${threshold}x)\n`));
  
  if (data.alert_count === 0) {
    console.log(chalk.green('✅ No SLOs burning error budget too fast.'));
    console.log(chalk.gray('\nAll SLOs are within sustainable burn rates.'));
    return;
  }
  
  console.log(chalk.yellow(`Found ${data.alert_count} alert(s):\n`));
  
  for (const alert of data.alerts) {
    const color = alert.severity === 'critical' ? chalk.red : chalk.yellow;
    console.log(color(`${alert.severity.toUpperCase()}: ${alert.slo_name}`));
    console.log(`  Burn Rate: ${formatBurnRate(alert.burn_rate)}`);
    console.log(`  Error Budget Remaining: ${formatErrorBudget(alert.error_budget_remaining)}`);
    console.log('');
  }
  
  if (data.has_critical) {
    console.log(chalk.red('🔥 Critical alerts require immediate attention!'));
  }
}

/**
 * Explain SLO concepts
 */
function explainSLOs() {
  console.log(chalk.bold('\n🎯 Understanding Service Level Objectives (SLOs)\n'));
  
  console.log(chalk.underline('What is an SLO?'));
  console.log(`
An SLO (Service Level Objective) is a target reliability level for a service.
It defines what "good enough" looks like and helps teams balance reliability
with the velocity of new features.
`);
  
  console.log(chalk.underline('Key Concepts:'));
  console.log(`
${chalk.cyan('1. Service Level Indicator (SLI)')}
   A quantitative measure of service quality (e.g., availability, latency)

${chalk.cyan('2. Service Level Objective (SLO)')}
   A target value for an SLI over a time period (e.g., 99.9% availability)

${chalk.cyan('3. Error Budget')}
   The "acceptable failure" derived from the SLO. For 99.9% availability,
   the error budget is 0.1% - you can "spend" this on deployments, experiments, etc.

${chalk.cyan('4. Burn Rate')}
   How fast you're consuming your error budget:
   • 1x = Sustainable (will last the full window)
   • 2x = Will exhaust in half the time
   • 6x = Will exhaust in 1/6th of the time (page someone!)
`);
  
  console.log(chalk.underline('Default MasterClaw SLOs:'));
  console.log(`
• API Availability: 99.9% over 30 days
  (43.8 minutes of downtime allowed per month)

• API Latency (p95): 95% of requests under 200ms over 30 days
  (5% of requests can be slower)

• Chat Availability: 99.5% over 7 days  
  (50.4 minutes of downtime allowed per week)
`);
  
  console.log(chalk.underline('Alert Thresholds:'));
  console.log(`
• Warning: Burn rate > 1x (burning faster than sustainable)
• Critical: Burn rate > 6x (will exhaust budget very quickly)
• SLO Violation: Compliance drops below target
`);
  
  console.log(chalk.underline('Best Practices:'));
  console.log(`
• Start with loose SLOs and tighten them as you gain confidence
• Use error budgets to decide when to halt feature launches
• Page on fast burn (6x+) but not on every SLO miss
• Review and adjust SLOs quarterly based on user feedback
`);
}

// =============================================================================
// CLI Setup
// =============================================================================

const program = new Command();

program
  .name('slo')
  .description('Service Level Objective tracking and monitoring')
  .helpOption('-h, --help', 'Display help for command');

program
  .command('list')
  .description('List all configured SLOs')
  .action(wrapCommand(listSlos, { service: 'slo' }));

program
  .command('status [slo-name]')
  .description('Get SLO status (all or specific SLO)')
  .option('-w, --window <days>', 'Evaluation window in days', parseInt)
  .action(wrapCommand(async (sloName, options) => {
    if (sloName) {
      await getSloStatus(sloName, options);
    } else {
      await getAllSloStatus(options);
    }
  }, { service: 'slo' }));

program
  .command('alerts')
  .description('Show SLO burn rate alerts')
  .option('-t, --threshold <rate>', 'Burn rate threshold (default: 1.0)', parseFloat)
  .action(wrapCommand(getSloAlerts, { service: 'slo' }));

program
  .command('explain')
  .description('Explain SLO concepts and best practices')
  .action(explainSLOs);

module.exports = program;
