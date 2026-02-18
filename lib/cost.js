/**
 * cost.js - Cost tracking and reporting for MasterClaw CLI
 *
 * Provides commands to view LLM usage costs, track spending,
 * and analyze cost trends across providers and models.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const config = require('./config');

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

// Default action - show summary
cost
  .action(async () => {
    // Delegate to summary with default options
    await cost.commands.find(c => c.name() === 'summary').action({ days: '30', json: false });
  });

module.exports = cost;
