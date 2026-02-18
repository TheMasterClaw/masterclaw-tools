// disaster.js - Disaster recovery commands for mc CLI
// Provides quick access to disaster recovery procedures and tools

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const disaster = new Command('disaster');

// Find infrastructure directory
async function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(os.homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];

  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'restore.sh'))) {
      return dir;
    }
  }

  return null;
}

// Find rex-deus directory
async function findRexDeusDir() {
  const candidates = [
    process.env.REX_DEUS_DIR,
    path.join(os.homedir(), 'rex-deus'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'rex-deus'),
    path.join(process.cwd(), 'rex-deus'),
    path.join(process.cwd(), '..', 'rex-deus'),
  ];

  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'docs', 'disaster-recovery.md'))) {
      return dir;
    }
  }

  return null;
}

// Main disaster command - show recovery options
disaster
  .description('Disaster recovery tools and procedures')
  .action(async () => {
    console.log(chalk.red.bold('🚨 MasterClaw Disaster Recovery\n'));
    console.log(chalk.gray('When things go wrong, use these commands:\n'));

    console.log(chalk.cyan('Quick Actions:'));
    console.log(`  ${chalk.bold('mc disaster status')}      - Check disaster recovery readiness`);
    console.log(`  ${chalk.bold('mc disaster runbook')}     - Open the disaster recovery runbook`);
    console.log(`  ${chalk.bold('mc disaster restore')}     - Start interactive restore process`);
    console.log(`  ${chalk.bold('mc disaster verify')}      - Verify backup integrity`);
    console.log('');

    console.log(chalk.cyan('Emergency Procedures:'));
    console.log(`  ${chalk.bold('mc disaster scenario 1')}  - Complete server failure`);
    console.log(`  ${chalk.bold('mc disaster scenario 2')}  - Database corruption`);
    console.log(`  ${chalk.bold('mc disaster scenario 3')}  - SSL certificate expiry`);
    console.log(`  ${chalk.bold('mc disaster scenario 4')}  - Service crash loop`);
    console.log(`  ${chalk.bold('mc disaster scenario 5')}  - Security breach`);
    console.log('');

    console.log(chalk.cyan('Manual Recovery:'));
    console.log(`  ${chalk.bold('mc restore')}              - Restore from backup`);
    console.log(`  ${chalk.bold('mc revive')}               - Restart all services`);
    console.log(`  ${chalk.bold('mc backup-verify')}        - Verify backup integrity`);
    console.log('');

    console.log(chalk.gray('For detailed procedures, run: mc disaster runbook'));
  });

// Check disaster recovery readiness
disaster
  .command('status')
  .description('Check disaster recovery readiness')
  .action(async () => {
    console.log(chalk.blue('🛡️  Disaster Recovery Readiness Check\n'));

    const checks = [];

    // Check 1: Infrastructure directory
    const infraDir = await findInfraDir();
    checks.push({
      name: 'Infrastructure Directory',
      status: infraDir ? 'pass' : 'fail',
      message: infraDir ? `Found: ${infraDir}` : 'Not found - set MASTERCLAW_INFRA',
    });

    // Check 2: Backup directory exists
    let backupDir = null;
    if (infraDir) {
      backupDir = path.join(infraDir, 'backups');
      const hasBackupDir = await fs.pathExists(backupDir);
      checks.push({
        name: 'Backup Directory',
        status: hasBackupDir ? 'pass' : 'warn',
        message: hasBackupDir ? `Found: ${backupDir}` : 'Not found - run mc backup',
      });
    }

    // Check 3: Recent backups exist
    if (backupDir && await fs.pathExists(backupDir)) {
      try {
        const files = await fs.readdir(backupDir);
        const backups = files.filter(f => f.startsWith('masterclaw_backup_') && f.endsWith('.tar.gz'));
        const hasRecent = backups.length > 0;
        checks.push({
          name: 'Local Backups',
          status: hasRecent ? 'pass' : 'warn',
          message: hasRecent ? `${backups.length} backup(s) found` : 'No backups found - run mc backup',
        });
      } catch {
        checks.push({
          name: 'Local Backups',
          status: 'warn',
          message: 'Unable to check backup directory',
        });
      }
    }

    // Check 4: Cloud backup config
    const hasCloudConfig = process.env.BACKUP_CLOUD_PROVIDER || 
                          process.env.B2_APPLICATION_KEY_ID || 
                          process.env.AWS_ACCESS_KEY_ID;
    checks.push({
      name: 'Cloud Backup Config',
      status: hasCloudConfig ? 'pass' : 'warn',
      message: hasCloudConfig ? 'Configured' : 'Not configured - backups are local only',
    });

    // Check 5: Runbook available
    const rexDeusDir = await findRexDeusDir();
    checks.push({
      name: 'Disaster Recovery Runbook',
      status: rexDeusDir ? 'pass' : 'warn',
      message: rexDeusDir ? 'Found in rex-deus/docs/' : 'Not found - see online documentation',
    });

    // Check 6: Services healthy
    try {
      const docker = require('./docker');
      const dockerAvailable = await docker.isDockerAvailable();
      checks.push({
        name: 'Docker Available',
        status: dockerAvailable ? 'pass' : 'warn',
        message: dockerAvailable ? 'Running' : 'Not available',
      });
    } catch {
      checks.push({
        name: 'Docker Available',
        status: 'warn',
        message: 'Unable to check',
      });
    }

    // Display results
    let passed = 0;
    let warnings = 0;
    let failed = 0;

    for (const check of checks) {
      let icon, color;
      if (check.status === 'pass') {
        icon = '✅';
        color = chalk.green;
        passed++;
      } else if (check.status === 'warn') {
        icon = '⚠️';
        color = chalk.yellow;
        warnings++;
      } else {
        icon = '❌';
        color = chalk.red;
        failed++;
      }

      console.log(`${icon} ${color(check.name.padEnd(30))} ${check.message}`);
    }

    console.log('');
    console.log(chalk.cyan(`Results: ${chalk.green(`${passed} passed`)}, ${chalk.yellow(`${warnings} warnings`)}, ${chalk.red(`${failed} failed`)}`));

    // Overall status
    console.log('');
    if (failed === 0 && warnings === 0) {
      console.log(chalk.green('✅ Disaster recovery readiness: EXCELLENT'));
    } else if (failed === 0) {
      console.log(chalk.yellow('⚠️  Disaster recovery readiness: GOOD (address warnings to improve)'));
    } else {
      console.log(chalk.red('❌ Disaster recovery readiness: POOR (immediate action required)'));
    }

    // Recommendations
    if (warnings > 0 || failed > 0) {
      console.log('');
      console.log(chalk.cyan('Recommendations:'));
      if (!hasCloudConfig) {
        console.log('  • Configure cloud backups for off-site protection');
      }
      if (backupDir && !(await fs.pathExists(backupDir))) {
        console.log('  • Run mc backup to create initial backup');
      }
      if (!rexDeusDir) {
        console.log('  • Review disaster recovery documentation');
      }
    }
  });

// Open/runbook command
disaster
  .command('runbook')
  .description('Display disaster recovery runbook')
  .option('--open', 'Open runbook in default viewer')
  .action(async (options) => {
    const rexDeusDir = await findRexDeusDir();
    const runbookPath = rexDeusDir 
      ? path.join(rexDeusDir, 'docs', 'disaster-recovery.md')
      : null;

    if (runbookPath && await fs.pathExists(runbookPath)) {
      if (options.open) {
        // Try to open with system default
        const { exec } = require('child_process');
        const platform = process.platform;
        const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} "${runbookPath}"`);
        console.log(chalk.green(`✅ Opening runbook: ${runbookPath}`));
      } else {
        // Display key sections
        const content = await fs.readFile(runbookPath, 'utf8');
        
        console.log(chalk.blue('📖 MasterClaw Disaster Recovery Runbook\n'));
        console.log(chalk.gray(`Location: ${runbookPath}\n`));

        // Extract and display quick reference table
        const quickRefMatch = content.match(/## Quick Reference[\s\S]*?(?=##|$)/);
        if (quickRefMatch) {
          console.log(quickRefMatch[0].replace('## Quick Reference', chalk.cyan('Quick Reference:')));
        }

        console.log('');
        console.log(chalk.cyan('Available Scenarios:'));
        const scenarios = [
          ['1', 'Complete server failure', '🔴 Critical'],
          ['2', 'Database corruption', '🔴 Critical'],
          ['3', 'SSL certificate expiry', '🟡 High'],
          ['4', 'Service crash loop', '🟡 High'],
          ['5', 'Security breach', '🔴 Critical'],
          ['6', 'Configuration error', '🟢 Medium'],
        ];

        for (const [num, name, severity] of scenarios) {
          console.log(`  ${chalk.bold(num)}. ${name} ${severity}`);
        }

        console.log('');
        console.log(chalk.gray('Run mc disaster scenario <number> for detailed steps'));
        console.log(chalk.gray(`Or read full runbook: ${runbookPath}`));
      }
    } else {
      console.log(chalk.yellow('⚠️  Runbook not found locally'));
      console.log('');
      console.log(chalk.cyan('Key Recovery Commands:'));
      console.log('  mc restore              - Restore from backup');
      console.log('  mc revive               - Restart all services');
      console.log('  mc backup-verify        - Verify backup integrity');
      console.log('  mc ssl renew            - Renew SSL certificates');
      console.log('  mc status               - Check service health');
      console.log('');
      console.log(chalk.gray('For full documentation, see:'));
      console.log(chalk.gray('  https://github.com/TheMasterClaw/rex-deus/docs/disaster-recovery.md'));
    }
  });

// Scenario commands - provide step-by-step guidance
disaster
  .command('scenario <number>')
  .description('Show detailed steps for specific disaster scenario (1-6)')
  .action(async (number) => {
    const scenarios = {
      '1': {
        title: 'Complete Server Failure',
        severity: '🔴 Critical',
        rto: '4 hours',
        steps: [
          'Verify server status via provider dashboard',
          'Provision new server or repair existing',
          'Update DNS if IP address changed',
          'SSH into new server',
          'Run: curl -fsSL https://raw.githubusercontent.com/TheMasterClaw/masterclaw-infrastructure/main/scripts/install.sh | sudo bash',
          'Restore from backup: mc restore',
          'Verify restoration: mc status && mc smoke-test',
          'Update monitoring and alerts',
        ],
      },
      '2': {
        title: 'Database Corruption',
        severity: '🔴 Critical',
        rto: '2 hours',
        steps: [
          'Stop all services: mc stop',
          'Identify corrupted component from logs: mc logs --service core --since 1h',
          'Document error messages for post-mortem',
          'Locate latest clean backup: mc backup-cloud-list',
          'Remove corrupted data: rm -rf ~/masterclaw-infrastructure/data/core/*',
          'Restore: mc restore',
          'Verify: mc status && mc smoke-test',
        ],
      },
      '3': {
        title: 'SSL Certificate Expiry',
        severity: '🟡 High',
        rto: '1 hour',
        steps: [
          'Check certificate status: mc ssl check',
          'Force immediate renewal: mc ssl renew',
          'Verify renewal: mc ssl check',
          'If failed, check logs: mc logs --service traefik --since 24h',
          'Enable automated monitoring: mc ssl monitor --install --auto-renew',
        ],
      },
      '4': {
        title: 'Service Crash Loop',
        severity: '🟡 High',
        rto: '30 minutes',
        steps: [
          'Identify failing service: mc status',
          'Check recent logs: mc logs --service <service> --follow',
          'Check resource usage: mc top',
          'Check circuit breakers: mc circuits',
          'Reset circuit if tripped: mc circuits --reset <service>',
          'Restart services: mc revive',
          'If still failing, clear and restart: mc stop && docker-compose rm <service> && mc revive',
        ],
      },
      '5': {
        title: 'Security Breach',
        severity: '🔴 Critical',
        rto: '4 hours',
        steps: [
          'ISOLATE: Stop all services immediately: mc stop',
          'PRESERVE: Create evidence snapshot',
          'ASSESS: Check audit logs: mc audit --hours 48',
          'ROTATE: Change all secrets: mc secrets rotate <KEY>',
          'RESTORE: Restore from pre-breach backup: mc restore',
          'VERIFY: Run security scan: mc security --scan',
          'RESTART: Start with new secrets: mc revive',
        ],
      },
      '6': {
        title: 'Configuration Error',
        severity: '🟢 Medium',
        rto: '30 minutes',
        steps: [
          'Run diagnostics: mc doctor',
          'Check recent changes: git diff HEAD~5 -- .env',
          'Restore previous config: cp .env.backup .env',
          'Fix permissions if needed: mc config-fix',
          'Restart: mc revive',
        ],
      },
    };

    const scenario = scenarios[number];
    if (!scenario) {
      console.log(chalk.red(`❌ Unknown scenario: ${number}`));
      console.log(chalk.gray('Available scenarios: 1-6'));
      console.log(chalk.gray('Run mc disaster runbook for list'));
      return;
    }

    console.log(chalk.blue(`🚨 Scenario ${number}: ${scenario.title}`));
    console.log(chalk.gray(`Severity: ${scenario.severity} | RTO: ${scenario.rto}\n`));

    console.log(chalk.cyan('Recovery Steps:'));
    for (let i = 0; i < scenario.steps.length; i++) {
      console.log(`  ${chalk.bold(`${i + 1}.`)} ${scenario.steps[i]}`);
    }

    console.log('');
    console.log(chalk.gray('For more details, see: mc disaster runbook'));
  });

// Quick restore command
disaster
  .command('restore')
  .description('Start interactive restore process (alias for mc restore)')
  .action(async () => {
    const infraDir = await findInfraDir();
    
    if (!infraDir) {
      console.log(chalk.red('❌ MasterClaw infrastructure not found'));
      console.log(chalk.gray('Set MASTERCLAW_INFRA or run from infrastructure directory'));
      process.exit(1);
    }

    console.log(chalk.blue('🔄 Starting Disaster Recovery Restore\n'));
    console.log(chalk.yellow('⚠️  This will replace current data with backup contents\n'));

    const restoreScript = path.join(infraDir, 'scripts', 'restore.sh');
    
    try {
      spawn(restoreScript, [], {
        cwd: infraDir,
        stdio: 'inherit',
      });
    } catch (err) {
      console.log(chalk.red(`❌ Restore failed: ${err.message}`));
      process.exit(1);
    }
  });

// Verify command - alias for backup-verify
disaster
  .command('verify')
  .description('Verify backup integrity (alias for mc backup-verify)')
  .action(async () => {
    const { runVerify } = require('./backup-verify');
    await runVerify();
  });

module.exports = disaster;
