#!/usr/bin/env node
/**
 * MasterClaw CLI - mc
 * Enhanced with memory, task, and advanced commands
 * 
 * Features:
 * - Comprehensive error handling with user-friendly messages
 * - Security audit logging integration
 * - Graceful shutdown handling
 * - Proper exit codes for CI/CD integration
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
const session = require('../lib/session');
const deploy = require('../lib/deploy');
const health = require('../lib/health');
const logs = require('../lib/logs');
const restore = require('../lib/restore');
const cleanup = require('../lib/cleanup');
const completion = require('../lib/completion');
const importer = require('../lib/import');
const { validate, printResults, getRemediationSteps } = require('../lib/validate');
const { wrapCommand, setupGlobalErrorHandlers, ExitCode } = require('../lib/error-handler');
const { verifyAuditIntegrity, rotateSigningKey } = require('../lib/audit');

// Setup global error handlers for uncaught exceptions and unhandled rejections
setupGlobalErrorHandlers();

const program = new Command();

program
  .name('mc')
  .description('MasterClaw CLI - Command your AI familiar')
  .version('0.11.0')
  .option('-v, --verbose', 'verbose output')
  .option('-i, --infra-dir <path>', 'path to infrastructure directory');

// =============================================================================
// Core Commands
// =============================================================================

// Status command with comprehensive error handling
program
  .command('status')
  .description('Check health of all MasterClaw services')
  .option('-w, --watch', 'watch mode - continuous monitoring')
  .action(wrapCommand(async (options) => {
    console.log(chalk.blue('🐾 MasterClaw Status\n'));
    
    const statuses = await getAllStatuses();
    
    let healthyCount = 0;
    let downCount = 0;
    
    statuses.forEach(s => {
      const icon = s.status === 'healthy' ? chalk.green('✅') : 
                   s.status === 'unhealthy' ? chalk.yellow('⚠️') : chalk.red('❌');
      const statusColor = s.status === 'healthy' ? chalk.green : 
                          s.status === 'unhealthy' ? chalk.yellow : chalk.red;
      
      console.log(`  ${icon} ${chalk.bold(s.name)}: ${statusColor(s.status)}`);
      
      if (s.responseTime) {
        console.log(chalk.gray(`     Response: ${s.responseTime}`));
      }
      if (s.error) {
        console.log(chalk.gray(`     Error: ${s.error}`));
      }
      
      if (s.status === 'healthy') healthyCount++;
      else downCount++;
    });
    
    console.log('');
    if (downCount === 0) {
      console.log(chalk.green(`✅ All ${healthyCount} services are healthy`));
    } else {
      console.log(chalk.yellow(`⚠️  ${healthyCount} healthy, ${downCount} down/unhealthy`));
      console.log(chalk.gray('   Run "mc revive" to restart services'));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }
  }, 'status'));

// =============================================================================
// Subcommand Modules
// =============================================================================

program.addCommand(memory);
program.addCommand(task);
program.addCommand(session);
program.addCommand(deploy);
program.addCommand(health);
program.addCommand(logs);
program.addCommand(restore);
program.addCommand(cleanup);
program.addCommand(completion);
program.addCommand(importer);

// =============================================================================
// Environment Commands
// =============================================================================

// Validate command - pre-flight environment check
program
  .command('validate')
  .description('Validate environment before deployment')
  .option('-d, --dev', 'development mode (skip production checks)')
  .option('-q, --quiet', 'minimal output')
  .option('--fix-suggestions', 'show remediation steps')
  .option('--skip-ports', 'skip port availability checks')
  .action(wrapCommand(async (options) => {
    if (options.fixSuggestions) {
      console.log(getRemediationSteps());
      return;
    }
    
    const infraDir = await findInfraDir() || process.cwd();
    
    const results = await validate({
      infraDir,
      dev: options.dev,
      skipPorts: options.skipPorts,
    });
    
    printResults(results, { quiet: options.quiet });
    
    // Exit with error code if validation failed
    if (!results.passed) {
      process.exit(ExitCode.VALIDATION_FAILED);
    }
  }, 'validate'));

// Self-heal command
program
  .command('heal')
  .description('Self-heal MasterClaw - fix common issues')
  .action(wrapCommand(async () => {
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
      issues.push(`${downServices.length} service(s) down: ${downServices.map(s => s.name).join(', ')}`);
      fixes.push('Run: mc revive');
    }
    
    // Check for common config issues
    try {
      const infraDir = await findInfraDir();
      if (!infraDir) {
        issues.push('Infrastructure directory not found');
        fixes.push('Ensure you are in the masterclaw-infrastructure directory');
      }
    } catch (err) {
      issues.push('Could not locate infrastructure directory');
      fixes.push('Set --infra-dir or run from the correct directory');
    }
    
    if (issues.length === 0) {
      console.log(chalk.green('✅ No issues detected - MasterClaw is healthy!'));
    } else {
      console.log(chalk.yellow(`⚠️  Found ${issues.length} issue(s):\n`));
      issues.forEach((issue, i) => {
        console.log(`  ${chalk.red(`${i + 1}.`)} ${issue}`);
        console.log(chalk.gray(`     Fix: ${fixes[i]}`));
      });
      console.log('');
      console.log(chalk.cyan('💡 Run "mc doctor" for comprehensive diagnostics'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'heal'));

// Doctor command - comprehensive diagnostics
program
  .command('doctor')
  .description('Run comprehensive diagnostics')
  .action(wrapCommand(async () => {
    console.log(chalk.blue('🔬 MasterClaw Doctor\n'));
    
    const checks = [
      { name: 'Docker', check: docker.isDockerAvailable },
      { name: 'Docker Compose', check: docker.isComposeAvailable },
      { name: 'Services', check: getAllStatuses },
    ];
    
    let passedChecks = 0;
    let failedChecks = 0;
    
    for (const { name, check } of checks) {
      process.stdout.write(`Checking ${name}... `);
      try {
        await check();
        console.log(chalk.green('✅'));
        passedChecks++;
      } catch (err) {
        console.log(chalk.red('❌'));
        if (process.env.MC_VERBOSE) {
          console.log(chalk.gray(`   Error: ${err.message}`));
        }
        failedChecks++;
      }
    }

    // Config security check
    process.stdout.write('Checking config security... ');
    try {
      const audit = await config.securityAudit();
      if (audit.secure) {
        console.log(chalk.green('✅'));
        passedChecks++;
      } else {
        console.log(chalk.yellow('⚠️'));
        console.log(chalk.gray(`   Issues: ${audit.issues.join(', ')}`));
        failedChecks++;
      }
    } catch (err) {
      console.log(chalk.red('❌'));
      if (process.env.MC_VERBOSE) {
        console.log(chalk.gray(`   Error: ${err.message}`));
      }
      failedChecks++;
    }
    
    console.log('');
    console.log(chalk.cyan(`Results: ${chalk.green(`${passedChecks} passed`)}, ${chalk.red(`${failedChecks} failed`)}`));
    
    if (failedChecks > 0) {
      console.log(chalk.gray('\nRun with --verbose for more details'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'doctor'));

// =============================================================================
// Communication Commands
// =============================================================================

// Chat command - quick chat with MasterClaw
program
  .command('chat <message>')
  .description('Send a quick message to MasterClaw')
  .action(wrapCommand(async (message) => {
    console.log(chalk.blue('🐾 Sending message...\n'));
    
    const coreUrl = await config.get('core.url') || 'http://localhost:8000';
    const axios = require('axios');
    
    const response = await axios.post(`${coreUrl}/v1/chat`, {
      message,
      session_id: `cli-${Date.now()}`,
    }, {
      timeout: 30000, // 30 second timeout
    });
    
    console.log(chalk.cyan('MasterClaw:'));
    console.log(response.data.response);
  }, 'chat'));

// =============================================================================
// Data Management Commands
// =============================================================================

// Export command - export all data
program
  .command('export')
  .description('Export all MasterClaw data')
  .option('-o, --output <dir>', 'output directory', './mc-export')
  .action(wrapCommand(async (options) => {
    const ora = require('ora');
    const spinner = ora('Exporting data...').start();
    
    try {
      await fs.ensureDir(options.output);
      
      // Export config
      const cfg = await config.list();
      await fs.writeJson(path.join(options.output, 'config.json'), cfg, { spaces: 2 });
      
      spinner.succeed(`Data exported to ${options.output}`);
      console.log(chalk.gray(`   Config: ${path.join(options.output, 'config.json')}`));
    } catch (err) {
      spinner.fail(`Export failed: ${err.message}`);
      throw err; // Re-throw for error handler
    }
  }, 'export'));

// =============================================================================
// Security Commands
// =============================================================================

// Config security commands
program
  .command('config-audit')
  .description('Run security audit on configuration files')
  .action(wrapCommand(async () => {
    console.log(chalk.blue('🔒 MasterClaw Config Security Audit\n'));
    
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
      process.exit(ExitCode.SECURITY_VIOLATION);
    }
  }, 'config-audit'));

program
  .command('config-fix')
  .description('Fix configuration file permissions')
  .action(wrapCommand(async () => {
    console.log(chalk.blue('🔧 Fixing Config Permissions\n'));
    
    const result = await config.fixPermissions();
    
    if (result.success) {
      console.log(chalk.green('✅ Permissions fixed:'));
      result.results.forEach(r => {
        console.log(`   ${r.path}: mode ${r.mode}`);
      });
    } else {
      throw new Error(result.error || 'Failed to fix permissions');
    }
  }, 'config-fix'));

// Audit log verification command
program
  .command('audit-verify')
  .description('Verify audit log integrity (detect tampering)')
  .option('-v, --verbose', 'show detailed verification results')
  .option('--hours <n>', 'check entries from last N hours', '168')
  .option('--rotate-key', 'rotate the audit signing key (invalidates old signatures)')
  .action(wrapCommand(async (options) => {
    if (options.rotateKey) {
      console.log(chalk.blue('🔑 Rotating Audit Signing Key\n'));
      console.log(chalk.yellow('⚠️  Warning: This will invalidate all existing audit signatures'));
      console.log(chalk.gray('   New entries will be signed with the new key.\n'));
      
      const result = await rotateSigningKey();
      if (result) {
        console.log(chalk.green('✅ Audit signing key rotated successfully'));
        console.log(chalk.gray('   Future entries will use the new key'));
      } else {
        throw new Error('Failed to rotate audit signing key');
      }
      return;
    }

    console.log(chalk.blue('🔒 Verifying Audit Log Integrity\n'));
    
    const hours = parseInt(options.hours, 10) || 168;
    const result = await verifyAuditIntegrity({ 
      verbose: options.verbose,
      hours,
    });
    
    console.log(chalk.cyan('Results:'));
    console.log(`  Files checked: ${result.filesChecked.length}`);
    console.log(`  Total entries: ${result.totalEntries}`);
    console.log(`  Valid signatures: ${chalk.green(result.validSignatures)}`);
    
    if (result.unsignedEntries > 0) {
      console.log(`  Unsigned entries: ${chalk.yellow(result.unsignedEntries)}`);
    }
    
    if (result.invalidSignatures > 0) {
      console.log(`  ${chalk.red('⚠️  INVALID signatures: ' + result.invalidSignatures)}`);
    }
    
    console.log('');
    
    if (result.invalidSignatures > 0) {
      console.log(chalk.red('❌ Audit log integrity check FAILED'));
      console.log(chalk.yellow('⚠️  Some entries may have been tampered with!'));
      
      if (options.verbose) {
        console.log(chalk.gray('\nDetails:'));
        result.errors.forEach(err => {
          console.log(chalk.gray(`  ${err.file}:${err.line} - ${err.error}`));
        });
      } else {
        console.log(chalk.gray('\nRun with --verbose for details'));
      }
      
      process.exit(ExitCode.SECURITY_VIOLATION);
    } else if (result.valid) {
      console.log(chalk.green('✅ Audit log integrity verified'));
      console.log(chalk.gray('   All entries have valid signatures'));
    } else {
      console.log(chalk.yellow('⚠️  Audit log verification completed with warnings'));
    }
  }, 'audit-verify'));

// =============================================================================
// Parse and Execute
// =============================================================================

program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
