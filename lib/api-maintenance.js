/**
 * API Maintenance Command for MasterClaw CLI
 *
 * Integrates with the masterclaw-core maintenance API to provide
 * remote maintenance operations and status monitoring.
 *
 * Features:
 * - Check maintenance status remotely
 * - Run maintenance tasks via API
 * - Dry-run mode for safe previews
 * - Task scheduling recommendations
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const apiMaintenance = new Command('api-maintenance').alias('apim');

/**
 * Get the Core API URL from config
 */
async function getCoreUrl() {
  return await config.get('core.url', 'http://localhost:8000');
}

/**
 * Get maintenance status from API
 */
async function fetchMaintenanceStatus(coreUrl, retentionDays = 30) {
  try {
    const response = await axios.get(
      `${coreUrl}/v1/maintenance/status?retention_days=${retentionDays}`,
      { timeout: 10000 }
    );
    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message
    };
  }
}

/**
 * Run maintenance task via API
 */
async function runMaintenanceTask(coreUrl, task, options = {}) {
  const { dryRun = false, days = 30, force = false } = options;

  try {
    const response = await axios.post(
      `${coreUrl}/v1/maintenance/run`,
      {
        task,
        dry_run: dryRun,
        days,
        force
      },
      { timeout: 60000 } // Maintenance can take time
    );
    return { success: true, data: response.data };
  } catch (err) {
    return {
      success: false,
      error: err.response?.data?.detail || err.message
    };
  }
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Status command - Show maintenance status
 */
apiMaintenance
  .command('status')
  .description('Check maintenance status from Core API')
  .option('-d, --days <n>', 'Retention period in days', '30')
  .option('--json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    const spinner = ora('Fetching maintenance status...').start();
    const coreUrl = await getCoreUrl();

    const result = await fetchMaintenanceStatus(coreUrl, parseInt(options.days));

    spinner.stop();

    if (!result.success) {
      console.log(chalk.red('❌ Failed to fetch maintenance status'));
      console.log(chalk.gray(`   Error: ${result.error}`));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }

    const data = result.data;

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(chalk.blue('🔧 Maintenance Status\n'));

    // Last maintenance
    if (data.last_maintenance) {
      const lastDate = new Date(data.last_maintenance);
      const daysAgo = Math.floor((Date.now() - lastDate) / (1000 * 60 * 60 * 24));
      console.log(chalk.gray(`Last maintenance: ${daysAgo} days ago (${lastDate.toLocaleString()})`));
    } else {
      console.log(chalk.yellow('⚠️  Maintenance has never been run'));
    }

    console.log('');

    // Health history
    console.log(chalk.white('Health History:'));
    console.log(`  Total records: ${chalk.cyan(data.health_history_count.toLocaleString())}`);
    if (data.old_health_records > 0) {
      console.log(`  ${chalk.yellow('⚠️  Old records: ' + data.old_health_records.toLocaleString())}`);
    } else {
      console.log(`  ${chalk.green('✓ No old records')}`);
    }

    console.log('');

    // Sessions
    console.log(chalk.white('Sessions:'));
    console.log(`  Total sessions: ${chalk.cyan(data.session_count.toLocaleString())}`);
    if (data.old_sessions > 0) {
      console.log(`  ${chalk.yellow('⚠️  Old sessions: ~' + data.old_sessions.toLocaleString())}`);
    } else {
      console.log(`  ${chalk.green('✓ No old sessions')}`);
    }

    console.log('');

    // Cache stats
    if (data.cache_stats && Object.keys(data.cache_stats).length > 0) {
      console.log(chalk.white('Cache:'));
      const stats = data.cache_stats;
      if (stats.size !== undefined) {
        console.log(`  Entries: ${chalk.cyan(stats.size.toLocaleString())}`);
      }
      if (stats.hit_rate !== undefined) {
        console.log(`  Hit rate: ${chalk.cyan((stats.hit_rate * 100).toFixed(1) + '%')}`);
      }
      if (stats.backend) {
        console.log(`  Backend: ${chalk.gray(stats.backend)}`);
      }
      console.log('');
    }

    // Recommendations
    if (data.recommendations && data.recommendations.length > 0) {
      console.log(chalk.yellow('📋 Recommendations:'));
      data.recommendations.forEach(rec => {
        console.log(`  • ${rec}`);
      });
      console.log('');
      console.log(chalk.gray('Run maintenance with: mc api-maintenance run --task all'));
    } else {
      console.log(chalk.green('✓ No maintenance recommendations'));
    }
  }, 'api-maintenance-status'));

/**
 * Run command - Execute maintenance tasks
 */
apiMaintenance
  .command('run')
  .description('Run maintenance tasks via Core API')
  .option('-t, --task <name>', 'Task to run (health_history_cleanup, cache_clear, session_cleanup, memory_optimize, all)', 'all')
  .option('-d, --days <n>', 'Retention period in days for cleanup tasks', '30')
  .option('--dry-run', 'Preview changes without applying')
  .option('--force', 'Force operation even if checks fail')
  .option('--json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    const coreUrl = await getCoreUrl();
    const task = options.task;
    const dryRun = options.dryRun;
    const days = parseInt(options.days);

    // Validate task
    const validTasks = ['health_history_cleanup', 'cache_clear', 'session_cleanup', 'memory_optimize', 'all'];
    if (!validTasks.includes(task)) {
      console.log(chalk.red(`❌ Invalid task: ${task}`));
      console.log(chalk.gray(`Valid tasks: ${validTasks.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    if (dryRun) {
      console.log(chalk.blue('🔍 Dry Run Mode - No changes will be made\n'));
    } else {
      console.log(chalk.blue('🔧 Running Maintenance\n'));
    }

    console.log(chalk.gray(`Task: ${task}`));
    console.log(chalk.gray(`Retention: ${days} days`));
    console.log(chalk.gray(`API: ${coreUrl}`));
    console.log('');

    const spinner = ora(dryRun ? 'Simulating maintenance tasks...' : 'Running maintenance tasks...').start();

    const result = await runMaintenanceTask(coreUrl, task, {
      dryRun,
      days,
      force: options.force
    });

    spinner.stop();

    if (!result.success) {
      console.log(chalk.red('❌ Maintenance failed'));
      console.log(chalk.gray(`   Error: ${result.error}`));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }

    const data = result.data;

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    // Display results
    console.log(chalk.blue(`📊 Results${dryRun ? ' (Dry Run)' : ''}\n`));

    data.results.forEach(r => {
      const icon = r.success ? chalk.green('✓') : chalk.red('✗');
      const status = r.success ? chalk.green('success') : chalk.red('failed');

      console.log(`${icon} ${chalk.bold(r.task)} (${status})`);
      console.log(`  ${r.message}`);

      if (r.items_processed > 0) {
        console.log(`  Processed: ${chalk.cyan(r.items_processed.toLocaleString())}`);
      }
      if (r.items_deleted > 0) {
        console.log(`  Deleted: ${chalk.yellow(r.items_deleted.toLocaleString())}`);
      }
      if (r.error) {
        console.log(`  ${chalk.red('Error: ' + r.error)}`);
      }
      console.log(chalk.gray(`  Duration: ${r.duration_ms.toFixed(2)}ms`));
      console.log('');
    });

    // Summary
    const summary = data.summary;
    console.log(chalk.white('Summary:'));
    console.log(`  Tasks: ${summary.successful}/${summary.total_tasks} successful`);
    if (summary.total_deleted > 0) {
      console.log(`  Total items ${dryRun ? 'that would be ' : ''}deleted: ${chalk.yellow(summary.total_deleted.toLocaleString())}`);
    }
    console.log(`  Total duration: ${chalk.cyan(summary.duration_ms.toFixed(2))}ms`);

    if (data.success) {
      console.log('');
      console.log(chalk.green('✓ Maintenance completed successfully'));
    } else {
      console.log('');
      console.log(chalk.yellow('⚠️  Some tasks failed'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'api-maintenance-run'));

/**
 * Tasks command - List available maintenance tasks
 */
apiMaintenance
  .command('tasks')
  .description('List available maintenance tasks')
  .action(wrapCommand(async () => {
    console.log(chalk.blue('🔧 Available Maintenance Tasks\n'));

    const tasks = [
      {
        name: 'health_history_cleanup',
        description: 'Remove old health history records',
        impact: 'Frees disk space from old health check data'
      },
      {
        name: 'cache_clear',
        description: 'Clear the response cache',
        impact: 'Frees memory, forces fresh API responses'
      },
      {
        name: 'session_cleanup',
        description: 'Remove old sessions',
        impact: 'Frees database space from inactive sessions'
      },
      {
        name: 'memory_optimize',
        description: 'Optimize memory store',
        impact: 'Improves memory search performance'
      },
      {
        name: 'all',
        description: 'Run all maintenance tasks',
        impact: 'Complete system maintenance'
      }
    ];

    tasks.forEach(task => {
      console.log(chalk.cyan(`${task.name}`));
      console.log(`  ${task.description}`);
      console.log(chalk.gray(`  Impact: ${task.impact}`));
      console.log('');
    });

    console.log(chalk.gray('Usage:'));
    console.log(chalk.gray('  mc api-maintenance run --task health_history_cleanup'));
    console.log(chalk.gray('  mc api-maintenance run --task all --dry-run'));
  }, 'api-maintenance-tasks'));

module.exports = apiMaintenance;
