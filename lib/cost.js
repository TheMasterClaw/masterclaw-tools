/**
 * cost.js - Cost tracking and reporting for MasterClaw CLI
 *
 * Provides commands to view LLM usage costs, track spending,
 * and analyze cost trends across providers and models.
 *
 * Features:
 * - Cost summary and daily breakdown
 * - Budget configuration with persistent storage
 * - Budget alerts with notification integration
 * - Cost trend analysis and projections
 * - Automated budget monitoring support
 */

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const { findInfraDir } = require('./services');

const cost = new Command('cost');

// Helper to format currency
function formatCost(cost) {
  if (cost < 0.01) {
    return `$${(cost * 100).toFixed(2)}¢`;
  }
  return `$${cost.toFixed(4)}`;
}

// Helper to format tokens
function formatTokens(tokens) {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(2)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

// Get core API URL
async function getCoreUrl() {
  return await config.get('core.url') || 'http://localhost:8000';
}

// Get budget config path
async function getBudgetConfigPath() {
  const infraDir = await findInfraDir() || process.cwd();
  const configDir = path.join(infraDir, 'config');
  await fs.ensureDir(configDir);
  return path.join(configDir, 'budget.json');
}

// Load budget configuration
async function loadBudgetConfig() {
  const configPath = await getBudgetConfigPath();
  if (await fs.pathExists(configPath)) {
    return fs.readJson(configPath);
  }
  return {
    version: '1.0',
    monthlyBudget: 100,
    warningThreshold: 80,
    criticalThreshold: 95,
    enabled: true,
    notifications: true,
    lastAlertSent: null,
    alertCooldownHours: 24,
    history: [],
  };
}

// Save budget configuration
async function saveBudgetConfig(budgetConfig) {
  const configPath = await getBudgetConfigPath();
  await fs.writeJson(configPath, budgetConfig, { spaces: 2 });
}

// Check if alert webhook is available
async function isWebhookAvailable() {
  try {
    const pidFile = '/tmp/masterclaw-alert-webhook.pid';
    if (await fs.pathExists(pidFile)) {
      const pid = await fs.readFile(pidFile, 'utf8');
      process.kill(parseInt(pid.trim(), 10), 0);
      return true;
    }
  } catch {
    // Process not running
  }
  return false;
}

// Send budget alert notification
async function sendBudgetAlert(level, spent, budget, percentage) {
  try {
    const webhookRunning = await isWebhookAvailable();
    if (!webhookRunning) {
      return { sent: false, reason: 'webhook_not_running' };
    }

    const infraDir = await findInfraDir() || process.cwd();
    const envPath = path.join(infraDir, '.env');
    let webhookPort = '8080';

    if (await fs.pathExists(envPath)) {
      const envContent = await fs.readFile(envPath, 'utf8');
      const portMatch = envContent.match(/ALERT_WEBHOOK_PORT=(\d+)/);
      if (portMatch) {
        webhookPort = portMatch[1];
      }
    }

    const severity = level === 'critical' ? 'critical' : 'warning';
    const emoji = level === 'critical' ? '🔴' : '⚠️';
    const title = level === 'critical' 
      ? 'CRITICAL: Monthly Budget Nearly Exhausted!'
      : 'WARNING: Monthly Budget Threshold Reached';

    const alertPayload = {
      version: '4',
      status: 'firing',
      alerts: [{
        status: 'firing',
        labels: {
          alertname: 'BudgetAlert',
          severity: severity,
          instance: 'masterclaw-core',
        },
        annotations: {
          summary: `${emoji} ${title}`,
          description: `LLM spending is at ${percentage.toFixed(1)}% of monthly budget ($${spent.toFixed(2)} / $${budget.toFixed(2)})`,
        },
        startsAt: new Date().toISOString(),
      }],
    };

    execSync(`curl -s -X POST http://localhost:${webhookPort}/alerts \
      -H "Content-Type: application/json" \
      -d '${JSON.stringify(alertPayload)}'`, { stdio: 'ignore' });

    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

// =============================================================================
// Cost Commands
// =============================================================================

/**
 * Summary command - show cost overview
 */
cost
  .command('summary')
  .description('Show cost summary for the specified period')
  .option('-d, --days <n>', 'Number of days to look back', '30')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const days = parseInt(options.days, 10) || 30;
    const coreUrl = await getCoreUrl();

    try {
      const response = await axios.get(`${coreUrl}/v1/costs?days=${days}`, {
        timeout: 10000,
      });

      const data = response.data;

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.blue(`💰 MasterClaw Cost Summary - Last ${days} Days\n`));

      // Overall stats
      console.log(chalk.cyan('Overall:'));
      console.log(`  Total Cost:      ${chalk.yellow(formatCost(data.total_cost))}`);
      console.log(`  Input Cost:      ${chalk.gray(formatCost(data.total_input_cost))}`);
      console.log(`  Output Cost:     ${chalk.gray(formatCost(data.total_output_cost))}`);
      console.log(`  Total Tokens:    ${chalk.cyan(formatTokens(data.total_tokens))}`);
      console.log(`  Total Requests:  ${chalk.cyan(data.total_requests.toLocaleString())}`);
      console.log(`  Avg per Request: ${chalk.gray(formatCost(data.average_cost_per_request))}`);
      console.log();

      // By provider
      if (Object.keys(data.by_provider).length > 0) {
        console.log(chalk.cyan('By Provider:'));
        for (const [provider, info] of Object.entries(data.by_provider)) {
          const providerIcon = provider === 'openai' ? '🟢' : provider === 'anthropic' ? '⚫' : '🔵';
          console.log(`  ${providerIcon} ${chalk.bold(provider.padEnd(12))} ${chalk.yellow(formatCost(info.cost).padEnd(10))} ${chalk.gray(`${formatTokens(info.tokens)} tokens, ${info.requests} reqs`)}`);
        }
        console.log();
      }

      // By model
      if (Object.keys(data.by_model).length > 0) {
        console.log(chalk.cyan('By Model:'));
        const sortedModels = Object.entries(data.by_model)
          .sort((a, b) => b[1].cost - a[1].cost);

        for (const [model, info] of sortedModels.slice(0, 8)) {
          const shortModel = model.length > 25 ? `${model.slice(0, 22)  }...` : model;
          console.log(`  ${chalk.yellow(formatCost(info.cost).padEnd(10))} ${shortModel.padEnd(28)} ${chalk.gray(`${formatTokens(info.tokens)} tokens`)}`);
        }
        if (sortedModels.length > 8) {
          console.log(chalk.gray(`  ... and ${sortedModels.length - 8} more models`));
        }
        console.log();
      }

      // Top sessions
      if (data.top_sessions && data.top_sessions.length > 0) {
        console.log(chalk.cyan('Top Sessions by Cost:'));
        for (const session of data.top_sessions.slice(0, 5)) {
          const shortId = session.session_id.length > 12
            ? `${session.session_id.slice(0, 12)  }...`
            : session.session_id;
          console.log(`  ${chalk.yellow(formatCost(session.cost).padEnd(10))} ${shortId.padEnd(16)} ${chalk.gray(`${formatTokens(session.tokens)} tokens, ${session.requests} reqs`)}`);
        }
        console.log();
      }

      console.log(chalk.gray(`Last updated: ${new Date(data.timestamp).toLocaleString()}`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Cost tracking endpoint not available.'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running the latest version.'));
      } else {
        console.error(chalk.red(`❌ Error fetching cost data: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Daily command - show daily cost breakdown
 */
cost
  .command('daily')
  .description('Show daily cost breakdown')
  .option('-d, --days <n>', 'Number of days to look back', '30')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const days = parseInt(options.days, 10) || 30;
    const coreUrl = await getCoreUrl();

    try {
      const response = await axios.get(`${coreUrl}/v1/costs/daily?days=${days}`, {
        timeout: 10000,
      });

      const data = response.data;

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.blue(`📅 Daily Costs - Last ${days} Days\n`));

      if (data.daily_costs.length === 0) {
        console.log(chalk.gray('No cost data available for this period.'));
        return;
      }

      // Find max for simple bar chart
      const maxCost = Math.max(...data.daily_costs.map(d => d.cost));

      console.log(chalk.cyan('Date          Cost        Tokens    Requests  Bar'));
      console.log(chalk.gray('─'.repeat(70)));

      for (const day of data.daily_costs) {
        const date = day.date;
        const costStr = formatCost(day.cost).padEnd(10);
        const tokensStr = formatTokens(day.tokens).padEnd(9);
        const reqsStr = day.requests.toString().padEnd(9);

        // Simple ASCII bar
        const barLength = maxCost > 0 ? Math.round((day.cost / maxCost) * 20) : 0;
        const bar = '█'.repeat(barLength).padEnd(20);

        const costColor = day.cost > 1.0 ? chalk.red :
          day.cost > 0.5 ? chalk.yellow : chalk.green;

        console.log(`${date}  ${costColor(costStr)} ${tokensStr} ${reqsStr} ${costColor(bar)}`);
      }

      // Summary
      const totalCost = data.daily_costs.reduce((sum, d) => sum + d.cost, 0);
      const totalTokens = data.daily_costs.reduce((sum, d) => sum + d.tokens, 0);
      const totalRequests = data.daily_costs.reduce((sum, d) => sum + d.requests, 0);

      console.log(chalk.gray('─'.repeat(70)));
      console.log(`Total:        ${chalk.yellow(formatCost(totalCost).padEnd(10))} ${formatTokens(totalTokens).padEnd(9)} ${totalRequests.toString().padEnd(9)}`);
      console.log();
      console.log(chalk.gray(`Last updated: ${new Date(data.timestamp).toLocaleString()}`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Cost tracking endpoint not available.'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running the latest version.'));
      } else {
        console.error(chalk.red(`❌ Error fetching daily costs: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Pricing command - show current pricing
 */
cost
  .command('pricing')
  .description('Show current LLM pricing')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const coreUrl = await getCoreUrl();

    try {
      const response = await axios.get(`${coreUrl}/v1/costs/pricing`, {
        timeout: 10000,
      });

      const data = response.data;

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.blue('💵 Current LLM Pricing (per 1K tokens)\n'));

      for (const [provider, models] of Object.entries(data.providers)) {
        const providerIcon = provider === 'openai' ? '🟢' : provider === 'anthropic' ? '⚫' : '🔵';
        console.log(chalk.cyan(`${providerIcon} ${provider.toUpperCase()}`));

        // Sort by input cost
        const sortedModels = Object.entries(models)
          .filter(([name]) => name !== 'default')
          .sort((a, b) => a[1].input - b[1].input);

        for (const [model, prices] of sortedModels) {
          const shortModel = model.length > 35 ? `${model.slice(0, 32)  }...` : model;
          console.log(`  ${shortModel.padEnd(38)} In: ${chalk.green(`$${prices.input.toFixed(4)}`).padEnd(12)} Out: ${chalk.yellow(`$${prices.output.toFixed(4)}`)}`);
        }
        console.log();
      }

      console.log(chalk.gray('Prices are per 1,000 tokens. Output = generated text, Input = prompt text.'));
      console.log(chalk.gray(`Last updated: ${new Date(data.timestamp).toLocaleString()}`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Pricing endpoint not available.'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running the latest version.'));
      } else {
        console.error(chalk.red(`❌ Error fetching pricing: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Check command - alias for summary with warning thresholds
 */
cost
  .command('check')
  .description('Check costs against budget thresholds')
  .option('-d, --days <n>', 'Number of days to look back', '30')
  .option('-b, --budget <amount>', 'Monthly budget in USD', '100')
  .option('-w, --warn <percent>', 'Warning threshold percentage', '80')
  .option('-c, --critical <percent>', 'Critical threshold percentage', '95')
  .action(async (options) => {
    const days = parseInt(options.days, 10) || 30;
    const budget = parseFloat(options.budget) || 100;
    const warnPercent = parseInt(options.warn, 10) || 80;
    const criticalPercent = parseInt(options.critical, 10) || 95;

    const coreUrl = await getCoreUrl();

    try {
      const response = await axios.get(`${coreUrl}/v1/costs?days=${days}`, {
        timeout: 10000,
      });

      const data = response.data;
      const spent = data.total_cost;

      // Calculate percentage of budget used
      const usedPercent = (spent / budget) * 100;

      console.log(chalk.blue('💰 Budget Check\n'));
      console.log(`Budget:   ${chalk.cyan(formatCost(budget))}`);
      console.log(`Spent:    ${chalk.yellow(formatCost(spent))}`);
      console.log(`Used:     ${usedPercent.toFixed(1)}%`);
      console.log(`Period:   Last ${days} days`);
      console.log();

      if (usedPercent >= criticalPercent) {
        console.log(chalk.red('🔴 CRITICAL: Budget nearly exhausted!'));
        console.log(chalk.red(`   Consider reducing usage or increasing budget.`));
        process.exit(2);
      } else if (usedPercent >= warnPercent) {
        console.log(chalk.yellow('⚠️  WARNING: Budget usage is high.'));
        console.log(chalk.yellow(`   Consider monitoring usage more closely.`));
        process.exit(1);
      } else {
        console.log(chalk.green('✅ Budget usage is healthy.'));
      }

    } catch (err) {
      console.error(chalk.red(`❌ Error checking costs: ${err.message}`));
      process.exit(1);
    }
  });

// =============================================================================
// Budget Management Commands
// =============================================================================

/**
 * Budget set command - configure monthly budget
 */
cost
  .command('budget-set')
  .description('Configure monthly budget and alert thresholds')
  .option('-a, --amount <amount>', 'Monthly budget amount in USD', '100')
  .option('-w, --warn <percent>', 'Warning threshold percentage', '80')
  .option('-c, --critical <percent>', 'Critical threshold percentage', '95')
  .option('--notifications <boolean>', 'Enable/disable notifications', 'true')
  .option('--cooldown <hours>', 'Minimum hours between alerts', '24')
  .action(async (options) => {
    const budgetConfig = await loadBudgetConfig();

    budgetConfig.monthlyBudget = parseFloat(options.amount);
    budgetConfig.warningThreshold = parseInt(options.warn, 10);
    budgetConfig.criticalThreshold = parseInt(options.critical, 10);
    budgetConfig.notifications = options.notifications === 'true';
    budgetConfig.alertCooldownHours = parseInt(options.cooldown, 10) || 24;
    budgetConfig.enabled = true;

    await saveBudgetConfig(budgetConfig);

    console.log(chalk.green('✅ Budget configuration saved'));
    console.log();
    console.log(chalk.cyan('Budget Settings:'));
    console.log(`  Monthly Budget:     ${chalk.yellow(formatCost(budgetConfig.monthlyBudget))}`);
    console.log(`  Warning Threshold:  ${chalk.yellow(budgetConfig.warningThreshold + '%')}`);
    console.log(`  Critical Threshold: ${chalk.red(budgetConfig.criticalThreshold + '%')}`);
    console.log(`  Notifications:      ${budgetConfig.notifications ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Alert Cooldown:     ${budgetConfig.alertCooldownHours} hours`);
    console.log();
    console.log(chalk.gray('Run "mc cost budget-check" to verify against current spending'));
    console.log(chalk.gray('Run "mc cost budget-monitor" to enable automated monitoring'));
  });

/**
 * Budget show command - display current budget configuration
 */
cost
  .command('budget-show')
  .description('Show current budget configuration and status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const budgetConfig = await loadBudgetConfig();
    const coreUrl = await getCoreUrl();

    let currentSpending = 0;
    let projectedMonthly = 0;

    try {
      const response = await axios.get(`${coreUrl}/v1/costs?days=30`, {
        timeout: 10000,
      });
      currentSpending = response.data.total_cost;

      // Calculate projected monthly spend based on daily average
      const dailyData = await axios.get(`${coreUrl}/v1/costs/daily?days=7`, {
        timeout: 10000,
      });
      const dailyCosts = dailyData.data.daily_costs;
      if (dailyCosts.length > 0) {
        const avgDaily = dailyCosts.reduce((sum, d) => sum + d.cost, 0) / dailyCosts.length;
        projectedMonthly = avgDaily * 30;
      }
    } catch (err) {
      // Continue without current spending data
    }

    const usedPercent = (currentSpending / budgetConfig.monthlyBudget) * 100;
    const projectedPercent = (projectedMonthly / budgetConfig.monthlyBudget) * 100;

    if (options.json) {
      console.log(JSON.stringify({
        config: budgetConfig,
        current: {
          spent: currentSpending,
          projected: projectedMonthly,
          usedPercent,
          projectedPercent,
          status: usedPercent >= budgetConfig.criticalThreshold ? 'critical' :
                  usedPercent >= budgetConfig.warningThreshold ? 'warning' : 'ok',
        },
      }, null, 2));
      return;
    }

    console.log(chalk.blue('💰 Budget Configuration\n'));

    // Status indicator
    let statusIcon, statusColor, statusText;
    if (usedPercent >= budgetConfig.criticalThreshold) {
      statusIcon = '🔴';
      statusColor = chalk.red;
      statusText = 'CRITICAL';
    } else if (usedPercent >= budgetConfig.warningThreshold) {
      statusIcon = '⚠️';
      statusColor = chalk.yellow;
      statusText = 'WARNING';
    } else {
      statusIcon = '✅';
      statusColor = chalk.green;
      statusText = 'HEALTHY';
    }

    console.log(`${statusIcon} Status: ${statusColor(statusText)}`);
    console.log();

    console.log(chalk.cyan('Budget Settings:'));
    console.log(`  Monthly Budget:     ${chalk.yellow(formatCost(budgetConfig.monthlyBudget))}`);
    console.log(`  Warning Threshold:  ${chalk.yellow(budgetConfig.warningThreshold + '%')}`);
    console.log(`  Critical Threshold: ${chalk.red(budgetConfig.criticalThreshold + '%')}`);
    console.log(`  Notifications:      ${budgetConfig.notifications ? chalk.green('enabled') : chalk.gray('disabled')}`);
    console.log(`  Alert Cooldown:     ${budgetConfig.alertCooldownHours} hours`);
    console.log();

    console.log(chalk.cyan('Current Spending (30 days):'));
    console.log(`  Spent:              ${chalk.yellow(formatCost(currentSpending))}`);
    console.log(`  Used:               ${statusColor(usedPercent.toFixed(1) + '%')}`);
    console.log(`  Remaining:          ${chalk.cyan(formatCost(Math.max(0, budgetConfig.monthlyBudget - currentSpending)))}`);
    console.log();

    if (projectedMonthly > 0) {
      const projectedColor = projectedPercent >= budgetConfig.criticalThreshold ? chalk.red :
                              projectedPercent >= budgetConfig.warningThreshold ? chalk.yellow : chalk.green;
      console.log(chalk.cyan('Projected (based on 7-day avg):'));
      console.log(`  Projected Monthly:  ${projectedColor(formatCost(projectedMonthly))}`);
      console.log(`  Projected Use:      ${projectedColor(projectedPercent.toFixed(1) + '%')}`);
      console.log();
    }

    if (budgetConfig.lastAlertSent) {
      const lastAlert = new Date(budgetConfig.lastAlertSent);
      const hoursAgo = (Date.now() - lastAlert.getTime()) / (1000 * 60 * 60);
      console.log(chalk.gray(`Last alert sent: ${hoursAgo.toFixed(1)} hours ago (${lastAlert.toLocaleString()})`));
    }

    // Progress bar
    const barLength = 40;
    const filledLength = Math.min(barLength, Math.round((usedPercent / 100) * barLength));
    const emptyLength = barLength - filledLength;
    const barColor = usedPercent >= budgetConfig.criticalThreshold ? chalk.red :
                     usedPercent >= budgetConfig.warningThreshold ? chalk.yellow : chalk.green;
    const bar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);

    console.log();
    console.log(chalk.cyan('Budget Usage:'));
    console.log(`  ${barColor(bar)} ${barColor(usedPercent.toFixed(1) + '%')}`);
    console.log();

    if (usedPercent >= budgetConfig.criticalThreshold) {
      console.log(chalk.red('🔴 You have exceeded your critical budget threshold!'));
      console.log(chalk.gray('   Consider immediately reviewing your usage or increasing your budget.'));
    } else if (usedPercent >= budgetConfig.warningThreshold) {
      console.log(chalk.yellow('⚠️  You have exceeded your warning budget threshold.'));
      console.log(chalk.gray('   Consider monitoring your usage more closely.'));
    }
  });

/**
 * Budget check command - check current spending against configured budget
 */
cost
  .command('budget-check')
  .description('Check current spending against configured budget with notifications')
  .option('--no-notify', 'Skip sending notifications')
  .action(async (options) => {
    const budgetConfig = await loadBudgetConfig();

    if (!budgetConfig.enabled) {
      console.log(chalk.yellow('⚠️  Budget monitoring is not enabled'));
      console.log(chalk.gray('   Run "mc cost budget-set" to configure'));
      process.exit(1);
    }

    const coreUrl = await getCoreUrl();

    try {
      const response = await axios.get(`${coreUrl}/v1/costs?days=30`, {
        timeout: 10000,
      });

      const spent = response.data.total_cost;
      const budget = budgetConfig.monthlyBudget;
      const usedPercent = (spent / budget) * 100;

      console.log(chalk.blue('💰 Budget Check\n'));
      console.log(`Budget:   ${chalk.cyan(formatCost(budget))}`);
      console.log(`Spent:    ${chalk.yellow(formatCost(spent))}`);
      console.log(`Used:     ${usedPercent.toFixed(1)}%`);
      console.log();

      let level = null;

      if (usedPercent >= budgetConfig.criticalThreshold) {
        level = 'critical';
        console.log(chalk.red('🔴 CRITICAL: Budget nearly exhausted!'));
      } else if (usedPercent >= budgetConfig.warningThreshold) {
        level = 'warning';
        console.log(chalk.yellow('⚠️  WARNING: Budget usage is high.'));
      } else {
        console.log(chalk.green('✅ Budget usage is healthy.'));
      }

      // Send notification if needed and enabled
      if (level && options.notify !== false && budgetConfig.notifications) {
        const lastAlert = budgetConfig.lastAlertSent ? new Date(budgetConfig.lastAlertSent) : null;
        const cooldownMs = budgetConfig.alertCooldownHours * 60 * 60 * 1000;

        if (!lastAlert || (Date.now() - lastAlert.getTime()) > cooldownMs) {
          console.log();
          console.log(chalk.gray('Sending notification...'));

          const result = await sendBudgetAlert(level, spent, budget, usedPercent);

          if (result.sent) {
            console.log(chalk.green('✅ Notification sent'));
            budgetConfig.lastAlertSent = new Date().toISOString();
            await saveBudgetConfig(budgetConfig);
          } else {
            console.log(chalk.yellow(`⚠️  Notification not sent: ${result.reason}`));
          }
        } else {
          const hoursSince = ((Date.now() - lastAlert.getTime()) / (1000 * 60 * 60)).toFixed(1);
          console.log();
          console.log(chalk.gray(`Notification skipped: ${hoursSince}h since last alert (cooldown: ${budgetConfig.alertCooldownHours}h)`));
        }
      }

      // Exit with appropriate code
      if (level === 'critical') {
        process.exit(2);
      } else if (level === 'warning') {
        process.exit(1);
      }

    } catch (err) {
      console.error(chalk.red(`❌ Error checking budget: ${err.message}`));
      process.exit(1);
    }
  });

/**
 * Budget monitor command - setup automated budget monitoring
 */
cost
  .command('budget-monitor')
  .description('Setup or manage automated budget monitoring')
  .option('--enable', 'Enable automated monitoring via cron')
  .option('--disable', 'Disable automated monitoring')
  .option('--status', 'Show monitoring status')
  .option('--interval <hours>', 'Check interval in hours (default: 6)', '6')
  .action(async (options) => {
    const { findInfraDir } = require('./services');
    const infraDir = await findInfraDir() || process.cwd();
    const cronMarker = '# MasterClaw Budget Monitor';

    const crontab = execSync('crontab -l 2>/dev/null || echo ""', { encoding: 'utf8' });

    if (options.status || (!options.enable && !options.disable)) {
      const hasEntry = crontab.includes(cronMarker);

      console.log(chalk.blue('💰 Budget Monitor Status\n'));

      if (hasEntry) {
        const line = crontab.split('\n').find(l => l.includes(cronMarker));
        const match = line.match(/\*\/\d+/);
        const interval = match ? match[0].replace('*/', '') : '?';

        console.log(chalk.green('✅ Automated budget monitoring is enabled'));
        console.log(`   Check interval: Every ${interval} hours`);
        console.log(chalk.gray(`   Command: mc cost budget-check`));
        console.log();
        console.log(chalk.gray('To disable: mc cost budget-monitor --disable'));
      } else {
        console.log(chalk.gray('○ Automated budget monitoring is disabled'));
        console.log();
        console.log(chalk.gray('To enable: mc cost budget-monitor --enable'));
      }
      return;
    }

    if (options.disable) {
      if (!crontab.includes(cronMarker)) {
        console.log(chalk.gray('Budget monitoring is already disabled'));
        return;
      }

      const newCrontab = crontab
        .split('\n')
        .filter(line => !line.includes(cronMarker))
        .join('\n');

      execSync(`echo "${newCrontab}" | crontab -`);
      console.log(chalk.green('✅ Budget monitoring disabled'));
      return;
    }

    if (options.enable) {
      const interval = parseInt(options.interval, 10) || 6;
      const cronEntry = `0 */${interval} * * * cd ${infraDir} && mc cost budget-check ${cronMarker}`;

      if (crontab.includes(cronMarker)) {
        // Update existing entry
        const newCrontab = crontab
          .split('\n')
          .filter(line => !line.includes(cronMarker))
          .concat([cronEntry])
          .join('\n');
        execSync(`echo "${newCrontab}" | crontab -`);
      } else {
        // Add new entry
        const newCrontab = crontab.trim() + '\n' + cronEntry + '\n';
        execSync(`echo "${newCrontab}" | crontab -`);
      }

      console.log(chalk.green('✅ Budget monitoring enabled'));
      console.log(`   Check interval: Every ${interval} hours`);
      console.log(chalk.gray(`   Budget alerts will be sent when thresholds are exceeded`));
    }
  });

/**
 * Budget history command - show budget alert history
 */
cost
  .command('budget-history')
  .description('Show budget alert history')
  .option('-n, --limit <number>', 'Number of entries to show', '10')
  .action(async (options) => {
    const budgetConfig = await loadBudgetConfig();
    const limit = parseInt(options.limit, 10) || 10;

    console.log(chalk.blue('💰 Budget Alert History\n'));

    if (!budgetConfig.history || budgetConfig.history.length === 0) {
      console.log(chalk.gray('No budget alerts in history'));
      return;
    }

    const sorted = budgetConfig.history
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    console.log(chalk.cyan('Date                    Level      Spent       Budget      Used'));
    console.log(chalk.gray('─'.repeat(70)));

    for (const entry of sorted) {
      const date = new Date(entry.timestamp).toLocaleString();
      const levelColor = entry.level === 'critical' ? chalk.red : chalk.yellow;
      const level = levelColor(entry.level.toUpperCase().padEnd(8));
      const spent = formatCost(entry.spent).padEnd(10);
      const budget = formatCost(entry.budget).padEnd(10);
      const used = levelColor(entry.usedPercent.toFixed(1) + '%');

      console.log(`${date}  ${level}  ${spent}  ${budget}  ${used}`);
    }

    console.log();
    console.log(chalk.gray(`Showing last ${sorted.length} of ${budgetConfig.history.length} alerts`));
  });

// Default action - show summary
cost
  .action(async () => {
    // Delegate to summary with default options
    await cost.commands.find(c => c.name() === 'summary').action({ days: '30', json: false });
  });

module.exports = cost;
