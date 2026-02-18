/**
 * restore.js - Backup restore commands for mc CLI
 *
 * Provides disaster recovery capabilities:
 * - List available backups
 * - Preview backup contents
 * - Full or selective restore
 * - Dry-run mode for safety
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn, execSync } = require('child_process');
const inquirer = require('inquirer');
const ora = require('ora');

const restore = new Command('restore');

// Find infrastructure directory
async function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];

  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'restore.sh'))) {
      return dir;
    }
  }

  return null;
}

// Get backup directory
async function getBackupDir(infraDir) {
  const backupDir = process.env.BACKUP_DIR || path.join(infraDir, 'backups');
  await fs.ensureDir(backupDir);
  return backupDir;
}

// List available backups
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
      });
    }
  }

  // Sort by date (newest first)
  return backups.sort((a, b) => b.created - a.created);
}

// Format file size
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

// Format age
function formatAge(date) {
  const now = new Date();
  const diff = now - date;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
  return 'just now';
}

// Preview backup contents
async function previewBackup(backupPath) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-tzf', backupPath]);
    let output = '';

    tar.stdout.on('data', (data) => {
      output += data.toString();
    });

    tar.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Failed to read backup contents'));
        return;
      }

      const files = output.trim().split('\n').filter(f => f.trim());
      const components = {
        backend: files.some(f => f.includes('backend')),
        gateway: files.some(f => f.includes('gateway')),
        core: files.some(f => f.includes('core')),
        chroma: files.some(f => f.includes('chroma')),
        env: files.some(f => f.includes('.env')),
      };

      resolve({ files: files.slice(0, 20), components, totalFiles: files.length });
    });
  });
}

// Run restore script
async function runRestore(infraDir, backupPath, options = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      BACKUP_DIR: path.dirname(backupPath),
      FORCE_COLOR: '1',
    };

    // For non-interactive mode, we need to handle the prompts
    const args = [];
    if (options.component) {
      args.push('--component', options.component);
    }

    const restore = spawn('bash', [path.join(infraDir, 'scripts', 'restore.sh'), ...args], {
      cwd: infraDir,
      env,
      stdio: 'pipe',
    });

    let output = '';

    restore.stdout.on('data', (data) => {
      output += data.toString();
    });

    restore.stderr.on('data', (data) => {
      output += data.toString();
    });

    restore.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Restore failed with code ${code}\n${output}`));
      } else {
        resolve(output);
      }
    });
  });
}

// Check if services are running
async function checkServices(infraDir) {
  try {
    const output = execSync('docker-compose ps -q', {
      cwd: infraDir,
      encoding: 'utf8',
      timeout: 10000,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// Commands
// =============================================================================

// List command
restore
  .command('list')
  .description('List available backups')
  .option('-n, --number <count>', 'number of backups to show', '10')
  .action(async (options) => {
    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA environment variable or run from project directory'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);

    if (backups.length === 0) {
      console.log(chalk.yellow('⚠️  No backups found'));
      console.log(chalk.gray(`   Backup directory: ${backupDir}`));
      console.log(chalk.gray('   Run "mc backup" to create a backup'));
      return;
    }

    console.log(chalk.blue('🐾 Available Backups\n'));
    console.log(chalk.gray(`${backups.length} backup(s) found in ${backupDir}\n`));

    const limit = parseInt(options.number);
    const displayBackups = backups.slice(0, limit);

    displayBackups.forEach((backup, index) => {
      const icon = index === 0 ? chalk.green('▶') : chalk.gray(' ');
      console.log(`${icon} ${chalk.white(backup.name)}`);
      console.log(`   ${chalk.gray('Size:')} ${backup.size}  ${chalk.gray('Created:')} ${backup.created.toLocaleString()} (${backup.age})`);
      console.log('');
    });

    if (backups.length > limit) {
      console.log(chalk.gray(`... and ${backups.length - limit} more (use -n ${backups.length} to see all)`));
    }
  });

// Preview command
restore
  .command('preview <backup-name>')
  .description('Preview backup contents without restoring')
  .action(async (backupName) => {
    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backupPath = path.join(backupDir, backupName);

    if (!await fs.pathExists(backupPath)) {
      // Try to find by partial match
      const backups = await listBackups(backupDir);
      const match = backups.find(b => b.name.includes(backupName));
      if (match) {
        backupPath = match.path;
      } else {
        console.log(chalk.red(`❌ Backup not found: ${backupName}`));
        console.log(chalk.gray('   Run "mc restore list" to see available backups'));
        process.exit(1);
      }
    }

    const spinner = ora('Reading backup contents...').start();

    try {
      const preview = await previewBackup(backupPath);
      spinner.succeed('Backup contents loaded');

      console.log(chalk.blue('\n📦 Backup Components:\n'));

      const components = [
        { key: 'backend', name: 'Backend Data', icon: '💾' },
        { key: 'gateway', name: 'Gateway Data', icon: '🌐' },
        { key: 'core', name: 'Core Data', icon: '🧠' },
        { key: 'chroma', name: 'ChromaDB Vectors', icon: '🔍' },
        { key: 'env', name: 'Environment Config', icon: '⚙️' },
      ];

      components.forEach(comp => {
        const status = preview.components[comp.key]
          ? chalk.green('✅ included')
          : chalk.gray('not included');
        console.log(`  ${comp.icon} ${comp.name}: ${status}`);
      });

      console.log(chalk.gray(`\n  Total files: ${preview.totalFiles}`));

      if (preview.files.length > 0) {
        console.log(chalk.gray('\n  Sample contents:'));
        preview.files.slice(0, 10).forEach(file => {
          console.log(chalk.gray(`    • ${file}`));
        });
        if (preview.files.length > 10) {
          console.log(chalk.gray(`    ... and ${preview.totalFiles - 10} more files`));
        }
      }

    } catch (err) {
      spinner.fail(`Failed to read backup: ${err.message}`);
      process.exit(1);
    }
  });

// Run command - interactive restore
restore
  .command('run [backup-name]')
  .description('Restore from backup (interactive)')
  .option('-y, --yes', 'skip confirmation prompts')
  .option('--dry-run', 'show what would be restored without doing it')
  .action(async (backupName, options) => {
    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA environment variable or run from project directory'));
      process.exit(1);
    }

    const backupDir = await getBackupDir(infraDir);
    const backups = await listBackups(backupDir);

    if (backups.length === 0) {
      console.log(chalk.yellow('⚠️  No backups found'));
      console.log(chalk.gray('   Run "mc backup" to create a backup'));
      process.exit(1);
    }

    // Select backup
    let selectedBackup;

    if (backupName) {
      selectedBackup = backups.find(b => b.name === backupName || b.name.includes(backupName));
      if (!selectedBackup) {
        console.log(chalk.red(`❌ Backup not found: ${backupName}`));
        process.exit(1);
      }
    } else {
      const { selected } = await inquirer.prompt([{
        type: 'list',
        name: 'selected',
        message: 'Select backup to restore:',
        choices: backups.map((b, i) => ({
          name: `${b.name} (${b.size}, ${b.age})`,
          value: b,
          short: b.name,
        })),
      }]);
      selectedBackup = selected;
    }

    // Preview
    if (!options.yes) {
      console.log(chalk.blue('\n📦 Selected Backup:'));
      console.log(`  Name: ${chalk.white(selectedBackup.name)}`);
      console.log(`  Size: ${selectedBackup.size}`);
      console.log(`  Created: ${selectedBackup.created.toLocaleString()}`);

      // Check if services are running
      const servicesRunning = await checkServices(infraDir);
      if (servicesRunning) {
        console.log(chalk.yellow('\n⚠️  Warning: Services are currently running'));
        console.log(chalk.gray('   They will be stopped during restore'));
      }

      console.log('');

      if (options.dryRun) {
        console.log(chalk.cyan('🔍 Dry run mode - no changes will be made\n'));
        console.log(chalk.green('✅ Dry run complete'));
        console.log(chalk.gray('   Run without --dry-run to perform the restore'));
        return;
      }

      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: chalk.red('⚠️  This will REPLACE current data. Are you sure?'),
        default: false,
      }]);

      if (!confirm) {
        console.log(chalk.yellow('❌ Restore cancelled'));
        process.exit(0);
      }

      // Second confirmation for safety
      const { confirmText } = await inquirer.prompt([{
        type: 'input',
        name: 'confirmText',
        message: 'Type "restore" to confirm:',
      }]);

      if (confirmText.toLowerCase() !== 'restore') {
        console.log(chalk.yellow('❌ Restore cancelled'));
        process.exit(0);
      }
    }

    // Perform restore
    console.log(chalk.blue('\n🔄 Starting restore...\n'));

    try {
      // Set the backup to restore via environment
      process.env.RESTORE_BACKUP = selectedBackup.path;

      // Run the restore script
      const result = await runRestore(infraDir, selectedBackup.path);
      console.log(result);

      console.log(chalk.green('\n✅ Restore completed successfully'));
      console.log(chalk.gray('   Run "mc status" to verify services'));

    } catch (err) {
      console.log(chalk.red(`\n❌ Restore failed: ${err.message}`));
      console.log(chalk.gray('   Check the output above for details'));
      process.exit(1);
    }
  });

// Quick alias - mc restore runs list by default
restore.action(async () => {
  await restore.commands.find(c => c.name() === 'list').action({ number: '10' });
});

module.exports = restore;
