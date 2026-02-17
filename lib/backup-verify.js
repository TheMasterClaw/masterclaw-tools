/**
 * backup-verify.js - Backup verification commands for mc CLI
 * 
 * Verifies backup integrity and restorability:
 * - Check archive integrity
 * - Test restore capability
 * - Report verification status
 * - Prometheus metrics export
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn } = require('child_process');
const ora = require('ora');

const backupVerify = new Command('backup-verify');

// Find infrastructure directory
async function findInfraDir() {
  const fs = require('fs-extra');
  const path = require('path');
  
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];
  
  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'backup-verify.sh'))) {
      return dir;
    }
  }
  
  return null;
}

backupVerify
  .description('Verify backup integrity and restorability')
  .option('-f, --file <path>', 'verify specific backup file')
  .option('-l, --latest', 'verify the most recent backup (default)')
  .option('-a, --all', 'verify all backups within retention period')
  .option('-m, --metrics', 'output Prometheus metrics format')
  .option('-q, --quiet', 'minimal output (exit code only)')
  .action(async (options) => {
    const infraDir = await findInfraDir();
    
    if (!infraDir) {
      console.error(chalk.red('❌ MasterClaw infrastructure directory not found'));
      console.error(chalk.gray('   Set MASTERCLAW_INFRA environment variable or run from infrastructure directory'));
      process.exit(1);
    }
    
    const scriptPath = require('path').join(infraDir, 'scripts', 'backup-verify.sh');
    
    // Build arguments
    const args = [];
    if (options.file) args.push('--file', options.file);
    if (options.latest) args.push('--latest');
    if (options.all) args.push('--all');
    if (options.metrics) args.push('--metrics');
    if (options.quiet) args.push('--quiet');
    
    if (!options.metrics && !options.quiet) {
      console.log(chalk.blue('🔍 MasterClaw Backup Verification\n'));
    }
    
    return new Promise((resolve, reject) => {
      const child = spawn(scriptPath, args, {
        cwd: infraDir,
        stdio: options.quiet ? 'pipe' : 'inherit',
      });
      
      let stdout = '';
      if (options.quiet || options.metrics) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }
      
      child.on('close', (code) => {
        if (options.metrics || options.quiet) {
          console.log(stdout);
        }
        
        if (code === 0) {
          if (!options.metrics && !options.quiet) {
            console.log(chalk.green('\n✅ Backup verification complete'));
          }
          resolve();
        } else if (code === 2) {
          if (!options.metrics && !options.quiet) {
            console.log(chalk.yellow('\n⚠️  No backups found to verify'));
          }
          reject(new Error('No backups found'));
        } else {
          if (!options.metrics && !options.quiet) {
            console.log(chalk.red('\n❌ Backup verification failed'));
          }
          reject(new Error('Verification failed'));
        }
      });
      
      child.on('error', (err) => {
        reject(err);
      });
    });
  });

module.exports = backupVerify;
