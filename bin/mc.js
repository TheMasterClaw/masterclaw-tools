#!/usr/bin/env node
/**
 * MasterClaw CLI - mc
 * Enhanced with memory, task, and advanced commands
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');

const { getAllStatuses, findInfraDir } = require('../lib/services');
const config = require('../lib/config');
const docker = require('../lib/docker');
const memory = require('../lib/memory');
const task = require('../lib/task');
const deploy = require('../lib/deploy');

const program = new Command();

program
  .name('mc')
  .description('MasterClaw CLI - Command your AI familiar')
  .version('0.3.0')
  .option('-v, --verbose', 'verbose output')
  .option('-i, --infra-dir <path>', 'path to infrastructure directory');

// [Previous commands: status, logs, backup, config, revive, update remain the same]

// Status command
program
  .command('status')
  .description('Check health of all MasterClaw services')
  .option('-w, --watch', 'watch mode - continuous monitoring')
  .action(async (options) => {
    // ... existing status implementation
    console.log(chalk.blue('🐾 MasterClaw Status'));
    const statuses = await getAllStatuses();
    statuses.forEach(s => {
      const icon = s.status === 'healthy' ? chalk.green('✅') : chalk.red('❌');
      console.log(`  ${icon} ${s.name}: ${s.status}`);
    });
  });

// Add memory commands
program.addCommand(memory);

// Add task commands
program.addCommand(task);

// Add deployment commands
program.addCommand(deploy);

// Self-heal command
program
  .command('heal')
  .description('Self-heal MasterClaw - fix common issues')
  .action(async () => {
    console.log(chalk.blue('🩹 MasterClaw Self-Heal\n'));
    
    const issues = [];
    const fixes = [];
    
    // Check Docker
    const dockerAvailable = await docker.isDockerAvailable();
    if (!dockerAvailable) {
      issues.push('Docker not available');
      fixes.push('Install Docker: https://docs.docker.com/get-docker/');
    }
    
    // Check services
    const statuses = await getAllStatuses();
    const downServices = statuses.filter(s => s.status === 'down');
    
    if (downServices.length > 0) {
      issues.push(`${downServices.length} service(s) down`);
      fixes.push('Run: mc revive');
    }
    
    if (issues.length === 0) {
      console.log(chalk.green('✅ No issues detected - MasterClaw is healthy!'));
    } else {
      console.log(chalk.yellow('⚠️  Issues detected:\n'));
      issues.forEach((issue, i) => {
        console.log(`  ${i + 1}. ${issue}`);
        console.log(chalk.gray(`     Fix: ${fixes[i]}`));
      });
    }
  });

// Doctor command - comprehensive diagnostics
program
  .command('doctor')
  .description('Run comprehensive diagnostics')
  .action(async () => {
    console.log(chalk.blue('🔬 MasterClaw Doctor\n'));
    
    const checks = [
      { name: 'Docker', check: docker.isDockerAvailable },
      { name: 'Docker Compose', check: docker.isComposeAvailable },
      { name: 'Services', check: getAllStatuses },
    ];
    
    for (const { name, check } of checks) {
      process.stdout.write(`Checking ${name}... `);
      try {
        await check();
        console.log(chalk.green('✅'));
      } catch (err) {
        console.log(chalk.red('❌'));
      }
    }

    // Config security check
    process.stdout.write('Checking config security... ');
    try {
      const audit = await config.securityAudit();
      if (audit.secure) {
        console.log(chalk.green('✅'));
      } else {
        console.log(chalk.yellow('⚠️'));
        console.log(chalk.gray(`   Issues: ${audit.issues.join(', ')}`));
      }
    } catch (err) {
      console.log(chalk.red('❌'));
    }
  });

// Chat command - quick chat with MasterClaw
program
  .command('chat <message>')
  .description('Send a quick message to MasterClaw')
  .action(async (message) => {
    console.log(chalk.blue('🐾 Sending message...\n'));
    
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';
      const axios = require('axios');
      
      const response = await axios.post(`${coreUrl}/v1/chat`, {
        message,
        session_id: `cli-${Date.now()}`,
      });
      
      console.log(chalk.cyan('MasterClaw:'));
      console.log(response.data.response);
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
      console.log(chalk.gray('Is the core service running? Try: mc revive'));
    }
  });

// Export command - export all data
program
  .command('export')
  .description('Export all MasterClaw data')
  .option('-o, --output <dir>', 'output directory', './mc-export')
  .action(async (options) => {
    const ora = require('ora');
    const spinner = ora('Exporting data...').start();
    
    try {
      await fs.ensureDir(options.output);
      
      // Export config
      const cfg = await config.list();
      await fs.writeJson(path.join(options.output, 'config.json'), cfg, { spaces: 2 });
      
      spinner.succeed(`Data exported to ${options.output}`);
      
    } catch (err) {
      spinner.fail(`Export failed: ${err.message}`);
    }
  });

// Config security commands
program
  .command('config-audit')
  .description('Run security audit on configuration files')
  .action(async () => {
    console.log(chalk.blue('🔒 MasterClaw Config Security Audit\n'));
    
    try {
      const audit = await config.securityAudit();
      
      console.log(`Timestamp: ${audit.timestamp}`);
      console.log(`Status: ${audit.secure ? chalk.green('✅ Secure') : chalk.red('❌ Issues Found')}\n`);
      
      if (audit.issues.length > 0) {
        console.log(chalk.yellow('Issues:'));
        audit.issues.forEach((issue, i) => {
          console.log(`  ${i + 1}. ${issue}`);
        });
        console.log('');
      }
      
      if (audit.recommendations.length > 0) {
        console.log(chalk.cyan('Recommendations:'));
        audit.recommendations.forEach((rec, i) => {
          console.log(`  ${i + 1}. ${rec}`);
        });
        console.log('');
      }
      
      if (audit.checks.hasSensitiveData) {
        console.log(chalk.gray('ℹ️  Config contains sensitive data (tokens/keys)'));
      }
      
      if (audit.secure) {
        console.log(chalk.green('✅ Configuration is secure'));
      } else {
        console.log(chalk.yellow('⚠️  Run "mc config-fix" to fix permissions'));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`❌ Audit failed: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('config-fix')
  .description('Fix configuration file permissions')
  .action(async () => {
    console.log(chalk.blue('🔧 Fixing Config Permissions\n'));
    
    try {
      const result = await config.fixPermissions();
      
      if (result.success) {
        console.log(chalk.green('✅ Permissions fixed:'));
        result.results.forEach(r => {
          console.log(`   ${r.path}: mode ${r.mode}`);
        });
      } else {
        console.error(chalk.red(`❌ Failed: ${result.error}`));
        process.exit(1);
      }
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
      process.exit(1);
    }
  });

// Parse
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
