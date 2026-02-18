const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const inquirer = require('inquirer');
const config = require('./config');

const cleanup = new Command('cleanup');

// Default retention periods
const DEFAULTS = {
  sessionRetentionDays: 30,
  memoryRetentionDays: 90,
  orphanCheck: true,
  dryRun: false,
};

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))  } ${  sizes[i]}`;
}

/**
 * Calculate days since a date
 */
function daysSince(date) {
  const now = new Date();
  const then = new Date(date);
  const diffTime = Math.abs(now - then);
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

/**
 * Fetch all sessions from the API
 */
async function fetchSessions(coreUrl) {
  try {
    const response = await axios.get(`${coreUrl}/v1/sessions?limit=500`, {
      timeout: 30000,
    });
    return response.data.sessions || [];
  } catch (err) {
    throw new Error(`Failed to fetch sessions: ${err.message}`);
  }
}

/**
 * Delete sessions in bulk via API (new efficient endpoint)
 */
async function deleteSessionsBulk(coreUrl, sessionIds, dryRun = false) {
  try {
    const response = await axios.post(`${coreUrl}/v1/sessions/bulk-delete`, {
      session_ids: sessionIds,
      dry_run: dryRun,
    }, {
      timeout: 60000, // 60 seconds for bulk operations
    });
    return response.data;
  } catch (err) {
    throw new Error(`Failed to delete sessions: ${err.message}`);
  }
}

/**
 * Delete sessions by age in bulk via API
 */
async function deleteSessionsByAge(coreUrl, olderThanDays, dryRun = false) {
  try {
    const response = await axios.post(`${coreUrl}/v1/sessions/bulk-delete`, {
      older_than_days: olderThanDays,
      dry_run: dryRun,
    }, {
      timeout: 120000, // 2 minutes for large cleanup operations
    });
    return response.data;
  } catch (err) {
    throw new Error(`Failed to delete sessions: ${err.message}`);
  }
}

/**
 * Get session statistics
 */
async function getSessionStats(coreUrl) {
  try {
    const response = await axios.get(`${coreUrl}/v1/sessions/stats/summary`, {
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    return null;
  }
}

// Main cleanup command
cleanup
  .description('Clean up old sessions and orphaned memories')
  .option('-d, --days <number>', 'Delete sessions older than N days', '30')
  .option('-m, --memory-days <number>', 'Delete memories older than N days (0 to skip)', '90')
  .option('--dry-run', 'Show what would be deleted without actually deleting')
  .option('-f, --force', 'Skip confirmation prompt')
  .option('--orphans-only', 'Only clean orphaned memories, keep sessions')
  .option('--sessions-only', 'Only clean old sessions, keep all memories')
  .option('-y, --yes', 'Auto-confirm (same as --force)')
  .action(async (options) => {
    const spinner = ora('Connecting to MasterClaw Core...').start();

    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';

      // Verify connection
      try {
        await axios.get(`${coreUrl}/health`, { timeout: 5000 });
        spinner.succeed('Connected to MasterClaw Core');
      } catch (err) {
        spinner.fail('Cannot connect to MasterClaw Core');
        console.log(chalk.gray('   Is MasterClaw running? Try: mc revive'));
        process.exit(1);
      }

      const sessionRetentionDays = parseInt(options.days, 10);
      const memoryRetentionDays = parseInt(options.memoryDays, 10);
      const isDryRun = options.dryRun;
      const skipConfirm = options.force || options.yes;

      console.log(chalk.blue('\n🧹 MasterClaw Cleanup\n'));
      console.log(chalk.gray('Configuration:'));
      console.log(`  Session retention: ${sessionRetentionDays} days`);
      if (!options.sessionsOnly && memoryRetentionDays > 0) {
        console.log(`  Memory retention: ${memoryRetentionDays} days`);
      }
      if (isDryRun) {
        console.log(chalk.yellow('  Mode: DRY RUN (no changes will be made)'));
      }
      console.log('');

      // Get current stats
      const statsSpinner = ora('Fetching session statistics...').start();
      const stats = await getSessionStats(coreUrl);
      const sessions = await fetchSessions(coreUrl);
      statsSpinner.succeed(`Found ${sessions.length} total sessions`);

      if (stats) {
        console.log(chalk.gray('\nCurrent Statistics:'));
        console.log(`  Total sessions: ${stats.total_sessions}`);
        console.log(`  Total messages: ${stats.total_messages}`);
        console.log(`  Active (24h): ${stats.active_sessions_24h}`);
        console.log(`  Active (7d): ${stats.active_sessions_7d}`);
      }

      // Identify old sessions
      const oldSessions = [];
      if (!options.orphansOnly) {
        for (const session of sessions) {
          const days = daysSince(session.last_active);
          if (days > sessionRetentionDays) {
            oldSessions.push({
              ...session,
              days_old: days,
            });
          }
        }
      }

      // Sort by age (oldest first)
      oldSessions.sort((a, b) => b.days_old - a.days_old);

      console.log(chalk.gray(`\nSessions older than ${sessionRetentionDays} days:`));
      if (oldSessions.length === 0) {
        console.log(chalk.green('  ✅ No old sessions found'));
      } else {
        console.log(chalk.yellow(`  ⚠️  ${oldSessions.length} sessions to clean up`));

        // Show sample of sessions to be deleted
        const sample = oldSessions.slice(0, 5);
        for (const session of sample) {
          console.log(chalk.gray(`     - ${session.session_id.substring(0, 16)}... (${session.days_old} days, ${session.message_count} messages)`));
        }
        if (oldSessions.length > 5) {
          console.log(chalk.gray(`     ... and ${oldSessions.length - 5} more`));
        }
      }

      // Calculate estimated impact
      const totalMessagesToDelete = oldSessions.reduce((sum, s) => sum + s.message_count, 0);

      console.log(chalk.gray('\nEstimated Impact:'));
      console.log(`  Sessions to delete: ${oldSessions.length}`);
      console.log(`  Messages to delete: ${totalMessagesToDelete}`);

      // Dry run exit
      if (isDryRun) {
        const dryRunSpinner = ora('Running dry-run preview...').start();
        try {
          const preview = await deleteSessionsByAge(coreUrl, sessionRetentionDays, true);
          dryRunSpinner.succeed('Dry-run preview complete');
          console.log(chalk.cyan(`\n🔍 Dry run complete. Would delete: ${preview.message}`));
          console.log(chalk.gray('   Run without --dry-run to perform cleanup.'));
        } catch (err) {
          dryRunSpinner.fail(`Dry-run failed: ${err.message}`);
        }
        return;
      }

      // Skip if nothing to do
      if (oldSessions.length === 0) {
        console.log(chalk.green('\n✅ Nothing to clean up!'));
        return;
      }

      // Confirmation
      if (!skipConfirm) {
        console.log('');
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: `Delete ${oldSessions.length} sessions and ${totalMessagesToDelete} messages?`,
          default: false,
        }]);

        if (!confirm) {
          console.log(chalk.gray('Cleanup cancelled.'));
          return;
        }
      }

      // Perform cleanup using bulk endpoint
      console.log('');
      const cleanupSpinner = ora(`Cleaning up ${oldSessions.length} sessions...`).start();

      let result;
      try {
        // Use the bulk delete by age endpoint for efficiency
        result = await deleteSessionsByAge(coreUrl, sessionRetentionDays, false);

        if (result.success) {
          cleanupSpinner.succeed(`Deleted ${result.sessions_deleted} sessions (${result.memories_deleted} memories) in ${result.duration_ms.toFixed(0)}ms`);
        } else {
          cleanupSpinner.warn(`Partially completed: ${result.sessions_deleted} deleted, ${result.sessions_failed} failed`);
        }
      } catch (err) {
        cleanupSpinner.fail(`Cleanup failed: ${err.message}`);
        throw err;
      }

      // Get new stats
      const newStats = await getSessionStats(coreUrl);
      if (newStats && stats) {
        console.log(chalk.gray('\nCleanup Results:'));
        const sessionsRemoved = stats.total_sessions - newStats.total_sessions;
        const messagesRemoved = stats.total_messages - newStats.total_messages;
        console.log(`  Sessions: ${stats.total_sessions} → ${newStats.total_sessions} (${sessionsRemoved} removed)`);
        console.log(`  Messages: ${stats.total_messages} → ${newStats.total_messages} (${messagesRemoved} removed)`);
        console.log(`  Duration: ${result.duration_ms.toFixed(0)}ms`);
      }

      console.log(chalk.green('\n✅ Cleanup complete!'));
      console.log(chalk.gray('   Run regularly to keep MasterClaw lean.'));
      if (result && result.sessions_failed > 0) {
        console.log(chalk.yellow(`   Note: ${result.sessions_failed} sessions failed to delete`));
      }

    } catch (err) {
      spinner.fail(`Cleanup failed: ${err.message}`);
      process.exit(1);
    }
  });

// Show cleanup status/status command
cleanup
  .command('status')
  .description('Show cleanup status and recommendations')
  .action(async () => {
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';

      console.log(chalk.blue('🧹 MasterClaw Cleanup Status\n'));

      const spinner = ora('Fetching data...').start();
      const stats = await getSessionStats(coreUrl);
      const sessions = await fetchSessions(coreUrl);
      spinner.succeed('Data loaded');

      if (!stats) {
        console.log(chalk.red('❌ Could not fetch statistics'));
        return;
      }

      // Calculate age distribution
      const now = new Date();
      const ageBuckets = {
        'Last 24h': 0,
        'Last 7 days': 0,
        'Last 30 days': 0,
        'Last 90 days': 0,
        'Older than 90 days': 0,
      };

      for (const session of sessions) {
        const days = daysSince(session.last_active);
        if (days <= 1) ageBuckets['Last 24h']++;
        else if (days <= 7) ageBuckets['Last 7 days']++;
        else if (days <= 30) ageBuckets['Last 30 days']++;
        else if (days <= 90) ageBuckets['Last 90 days']++;
        else ageBuckets['Older than 90 days']++;
      }

      console.log(chalk.gray('\nSession Age Distribution:'));
      for (const [label, count] of Object.entries(ageBuckets)) {
        const bar = '█'.repeat(Math.min(count, 20));
        const color = label.includes('Older') ? chalk.red : chalk.gray;
        console.log(`  ${label.padEnd(20)} ${color(bar)} ${count}`);
      }

      console.log(chalk.gray('\nRecommendations:'));

      if (ageBuckets['Older than 90 days'] > 100) {
        console.log(chalk.red(`  ⚠️  ${ageBuckets['Older than 90 days']} sessions older than 90 days`));
        console.log(chalk.gray('     Run: mc cleanup --days 90'));
      } else if (ageBuckets['Older than 90 days'] > 10) {
        console.log(chalk.yellow(`  ℹ️  ${ageBuckets['Older than 90 days']} sessions older than 90 days`));
        console.log(chalk.gray('     Consider running: mc cleanup --days 90'));
      } else {
        console.log(chalk.green('  ✅ Session age distribution looks healthy'));
      }

      if (stats.total_sessions > 1000) {
        console.log(chalk.yellow(`  ℹ️  High session count: ${stats.total_sessions}`));
        console.log(chalk.gray('     Consider more aggressive cleanup retention'));
      }

      console.log(chalk.gray('\nQuick Commands:'));
      console.log('  mc cleanup --dry-run      Preview what would be cleaned');
      console.log('  mc cleanup --days 30      Clean sessions older than 30 days');
      console.log('  mc cleanup --force        Clean without confirmation');

    } catch (err) {
      console.log(chalk.red(`\n❌ Error: ${err.message}`));
      console.log(chalk.gray('   Is MasterClaw running?'));
    }
  });

// Schedule command for cron setup
cleanup
  .command('schedule')
  .description('Show how to schedule automatic cleanup via cron')
  .action(() => {
    console.log(chalk.blue('🗓️  Scheduling MasterClaw Cleanup\n'));

    console.log(chalk.gray('Add to crontab for automatic cleanup:'));
    console.log('');
    console.log(chalk.cyan('# Clean sessions older than 30 days, weekly on Sundays at 2 AM'));
    console.log('0 2 * * 0 /usr/local/bin/mc cleanup --days 30 --force');
    console.log('');
    console.log(chalk.cyan('# Clean sessions older than 90 days, monthly on the 1st at 3 AM'));
    console.log('0 3 1 * * /usr/local/bin/mc cleanup --days 90 --force');
    console.log('');
    console.log(chalk.gray('To edit your crontab:'));
    console.log('  crontab -e');
    console.log('');
    console.log(chalk.gray('To view current crontab:'));
    console.log('  crontab -l');
  });

module.exports = cleanup;
