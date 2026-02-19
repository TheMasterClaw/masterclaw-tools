/**
 * backup.js - Backup management commands for mc CLI
 *
 * Provides comprehensive backup management:
 * - Create new backups on demand
 * - List backup history with details
 * - View backup statistics and trends
 * - Clean up old backups
 * - Export backup metadata
 *
 * Security features:
 * - Path traversal prevention
 * - Input validation
 * - Audit logging
 * - Secure file permissions
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const ora = require('ora');
const inquirer = require('inquirer');

const { findInfraDir } = require('./services');
const { logAudit, AuditEventType } = require('./audit');
const { containsPathTraversal } = require('./security');

const backup = new Command('backup');

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get backup directory path
 */
async function getBackupDir(infraDir) {
  const backupDir = process.env.BACKUP_DIR || path.join(infraDir, 'backups');
  await fs.ensureDir(backupDir);
  return backupDir;
}

/**
 * List all backups with metadata
 */
async function listBackups(backupDir) {
  const files = await fs.readdir(backupDir);
  const backups = [];

  for (const file of files) {
    if (file.match(/^masterclaw_backup_\d{8}_\d{6}\.tar\.gz$/)) {
      const filePath = path.join(backupDir, file);
      const stats = await fs.stat(filePath);

      // Parse date from filename
      const match = file.match(/masterclaw_backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
      let backupDate = stats.mtime;

      if (match) {
        const [_, year, month, day, hour, minute, second] = match;
        backupDate = new Date(year, month - 1, day, hour, minute, second);
      }

      backups.push({
        name: file,
        path: filePath,
        size: formatSize(stats.size),
        sizeBytes: stats.size,
        created: backupDate,
        age: formatAge(stats.mtime),
        ageDays: Math.floor((Date.now() - stats.mtime) / (1000 * 60 * 60 * 24)),
      });
    }
  }

  // Sort by date (newest first)
  return backups.sort((a, b) => b.created - a.created);
}

/**
 * Format file size
 */
function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format age
 */
function formatAge(date) {
  const now = new Date();
  const diff = now - date;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return `${months} month${months > 1 ? 's' : ''} ago`;
  } else if (days > 0) {
    return `${days} day${days > 1 ? 's' : ''} ago`;
  } else if (hours > 0) {
    return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  } else {
    const minutes = Math.floor(diff / (1000 * 60));
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  }
}

/**
 * Get backup statistics
 */
function getBackupStats(backups) {
  if (backups.length === 0) {
    return null;
  }

  const totalSize = backups.reduce((sum, b) => sum + b.sizeBytes, 0);
  const avgSize = totalSize / backups.length;
  const oldest = backups[backups.length - 1];
  const newest = backups[0];

  // Calculate growth trend
  let growthTrend = 0;
  if (backups.length >= 3) {
    const recent = backups.slice(0, 3).reduce((sum, b) => sum + b.sizeBytes, 0) / 3;
    const older = backups.slice(-3).reduce((sum, b) => sum + b.sizeBytes, 0) / 3;
    growthTrend = ((recent - older) / older) * 100;
  }

  // Calculate backup frequency (average days between backups)
  let frequency = 0;
  if (backups.length >= 2) {
    const timeSpan = backups[0].created - backups[backups.length - 1].created;
    frequency = timeSpan / (backups.length - 1) / (1000 * 60 * 60 * 24);
  }

  return {
    totalCount: backups.length,
    totalSize,
    avgSize,
    oldestBackup: oldest.created,
    newestBackup: newest.created,
    growthTrend,
    frequency,
  };
}

/**
 * Execute backup script
 */
async function runBackup(infraDir, options = {}) {
  const scriptPath = path.join(infraDir, 'scripts', 'backup.sh');

  if (!await fs.pathExists(scriptPath)) {
    throw new Error(`Backup script not found: ${scriptPath}`);
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env };

    // Set retention if specified
    if (options.retentionDays) {
      env.RETENTION_DAYS = options.retentionDays.toString();
    }

    const child = spawn('bash', [scriptPath], {
      cwd: infraDir,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (!options.quiet) {
        process.stdout.write(data);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (!options.quiet) {
        process.stderr.write(data);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr });
      } else {
        reject(new Error(`Backup failed with exit code ${code}: ${stderr}`));
      }
    });

    child.on('error', reject);
  });
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Create a new backup
 */
backup
  .description('Create a new backup of MasterClaw data')
  .option('-r, --retention-days <days>', 'override retention period', parseInt)
  .option('-q, --quiet', 'minimal output')
  .option('--no-cleanup', 'skip cleanup of old backups')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA environment variable or run from the correct directory'));
      process.exit(1);
    }

    await logAudit(AuditEventType.BACKUP_CREATE, {
      action: 'backup_start',
      retentionDays: options.retentionDays,
      quiet: options.quiet,
    });

    const spinner = options.quiet ? null : ora('Creating backup...').start();

    try {
      await runBackup(infraDir, {
        retentionDays: options.retentionDays,
        quiet: options.quiet,
      });

      if (spinner) spinner.succeed('Backup completed successfully');

      await logAudit(AuditEventType.BACKUP_CREATE, { success: true });

      // Show recent backups
      if (!options.quiet) {
        const backupDir = await getBackupDir(infraDir);
        const backups = await listBackups(backupDir);

        if (backups.length > 0) {
          console.log(chalk.gray(`\n   Latest backup: ${backups[0].name} (${backups[0].size})`));
          console.log(chalk.gray(`   Total backups: ${backups.length}`));
        }
      }
    } catch (err) {
      if (spinner) spinner.fail(`Backup failed: ${err.message}`);

      await logAudit(AuditEventType.BACKUP_CREATE, { error: err.message });
      process.exit(1);
    }
  });

/**
 * List all backups
 */
backup
  .command('list')
  .description('List all backups with details')
  .option('-l, --limit <n>', 'limit number of results', parseInt, 10)
  .option('-j, --json', 'output as JSON')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);

    if (backups.length === 0) {
      console.log(chalk.yellow('⚠️  No backups found'));
      console.log(chalk.gray('   Run: mc backup'));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(backups.slice(0, options.limit), null, 2));
      return;
    }

    console.log(chalk.blue('🐾 MasterClaw Backups\n'));

    const displayBackups = backups.slice(0, options.limit);

    displayBackups.forEach((b, index) => {
      const icon = index === 0 ? chalk.green('●') : chalk.gray('○');
      console.log(`${icon} ${chalk.bold(b.name)}`);
      console.log(chalk.gray(`   Size: ${b.size}  |  Created: ${b.created.toLocaleString()}  |  ${b.age}`));
    });

    if (backups.length > options.limit) {
      console.log(chalk.gray(`\n... and ${backups.length - options.limit} more`));
    }

    console.log(chalk.gray(`\nTotal: ${backups.length} backups`));
    console.log(chalk.gray(`Run 'mc restore' to restore from a backup`));
  });

/**
 * Show backup statistics
 */
backup
  .command('stats')
  .description('Show backup statistics and trends')
  .option('-j, --json', 'output as JSON')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);

    if (backups.length === 0) {
      console.log(chalk.yellow('⚠️  No backups found'));
      return;
    }

    const stats = getBackupStats(backups);

    if (options.json) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }

    console.log(chalk.blue('🐾 Backup Statistics\n'));

    console.log(chalk.cyan('Overview:'));
    console.log(`  Total backups: ${chalk.bold(stats.totalCount)}`);
    console.log(`  Total size: ${chalk.bold(formatSize(stats.totalSize))}`);
    console.log(`  Average size: ${chalk.bold(formatSize(stats.avgSize))}`);
    console.log();

    console.log(chalk.cyan('Timeline:'));
    console.log(`  Oldest backup: ${chalk.gray(stats.oldestBackup.toLocaleDateString())}`);
    console.log(`  Newest backup: ${chalk.green(stats.newestBackup.toLocaleDateString())}`);
    if (stats.frequency > 0) {
      console.log(`  Backup frequency: ${chalk.gray(`~${stats.frequency.toFixed(1)} days`)}`);
    }
    console.log();

    if (stats.growthTrend !== 0) {
      const trendColor = stats.growthTrend > 0 ? chalk.yellow : chalk.green;
      const trendIcon = stats.growthTrend > 0 ? '📈' : '📉';
      console.log(chalk.cyan('Trends:'));
      console.log(`  Size trend: ${trendColor(`${trendIcon} ${Math.abs(stats.growthTrend).toFixed(1)}%`)}`);
      console.log();
    }

    // Retention info
    const retentionDays = parseInt(process.env.RETENTION_DAYS, 10) || 7;
    const oldBackups = backups.filter(b => b.ageDays > retentionDays);

    if (oldBackups.length > 0) {
      console.log(chalk.cyan('Retention:'));
      console.log(`  Policy: ${retentionDays} days`);
      console.log(`  Backups past retention: ${chalk.yellow(oldBackups.length)}`);
      console.log(chalk.gray(`  Run 'mc backup cleanup' to remove old backups`));
    }
  });

/**
 * Clean up old backups
 */
backup
  .command('cleanup')
  .description('Remove backups older than retention period')
  .option('-r, --retention-days <days>', 'override retention period', parseInt)
  .option('-f, --force', 'skip confirmation prompt')
  .option('-d, --dry-run', 'show what would be deleted without deleting')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const retentionDays = options.retentionDays || parseInt(process.env.RETENTION_DAYS, 10) || 7;
    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const oldBackups = backups.filter(b => b.created < cutoffDate);

    if (oldBackups.length === 0) {
      console.log(chalk.green('✅ No old backups to clean up'));
      return;
    }

    const totalSize = oldBackups.reduce((sum, b) => sum + b.sizeBytes, 0);

    console.log(chalk.blue('🐾 Backup Cleanup\n'));
    console.log(chalk.yellow(`Found ${oldBackups.length} backup(s) older than ${retentionDays} days`));
    console.log(chalk.gray(`Total size to free: ${formatSize(totalSize)}\n`));

    if (options.dryRun) {
      console.log(chalk.cyan('Would delete:'));
      oldBackups.forEach(b => {
        console.log(chalk.gray(`  - ${b.name} (${b.size}, ${b.age})`));
      });
      return;
    }

    if (!options.force) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete ${oldBackups.length} old backup(s)?`,
        default: false,
      }]);

      if (!confirm) {
        console.log(chalk.gray('Cleanup cancelled'));
        return;
      }
    }

    const spinner = ora('Cleaning up old backups...').start();
    let deleted = 0;
    let failed = 0;

    for (const b of oldBackups) {
      try {
        await fs.remove(b.path);
        deleted++;
      } catch (err) {
        failed++;
        console.error(chalk.red(`\nFailed to delete ${b.name}: ${err.message}`));
      }
    }

    spinner.stop();

    await logAudit(AuditEventType.BACKUP_CREATE, {
      action: 'backup_cleanup',
      retentionDays,
      deleted,
      failed,
      freedBytes: totalSize,
    });

    if (failed === 0) {
      console.log(chalk.green(`✅ Deleted ${deleted} backup(s), freed ${formatSize(totalSize)}`));
    } else {
      console.log(chalk.yellow(`⚠️  Deleted ${deleted} backup(s), ${failed} failed`));
    }
  });

/**
 * Export backup metadata
 */
backup
  .command('export')
  .description('Export backup metadata to file')
  .option('-o, --output <path>', 'output file path', './mc-backups.json')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    // Validate output path
    if (containsPathTraversal(options.output)) {
      console.log(chalk.red('❌ Invalid output path'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);
    const stats = getBackupStats(backups);

    const exportData = {
      exportedAt: new Date().toISOString(),
      backupDir,
      stats,
      backups,
    };

    await fs.writeJson(options.output, exportData, { spaces: 2 });

    console.log(chalk.green(`✅ Exported ${backups.length} backup(s) to ${options.output}`));
  });

// =============================================================================
// Cloud Backup Subcommand
// =============================================================================
const { cloudBackup } = require('./cloud-backup');
backup.addCommand(cloudBackup);

module.exports = backup;
