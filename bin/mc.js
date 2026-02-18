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
const backup = require('../lib/backup');
const cleanup = require('../lib/cleanup');
const completion = require('../lib/completion');
const importer = require('../lib/import');
const exporter = require('../lib/export');
const deps = require('../lib/deps');
const cost = require('../lib/cost');
const env = require('../lib/env');
const backupVerify = require('../lib/backup-verify');
const update = require('../lib/update');
const info = require('../lib/info');
const notify = require('../lib/notify');
const { events } = require('../lib/events');
const { validate, printResults, getRemediationSteps } = require('../lib/validate');
const { wrapCommand, setupGlobalErrorHandlers, ExitCode } = require('../lib/error-handler');
const { verifyAuditIntegrity, rotateSigningKey } = require('../lib/audit');
const securityMonitor = require('../lib/security-monitor');
const rateLimiter = require('../lib/rate-limiter');
const ssl = require('../lib/ssl');
const { execInContainer, getRunningContainers, shell, ALLOWED_CONTAINERS } = require('../lib/exec');
const { runDoctor } = require('../lib/doctor');
const benchmark = require('../lib/benchmark');
const depsValidator = require('../lib/deps-validator');
const { envCmd } = require('../lib/env-manager');
const { runSmokeTests, runQuickSmokeTest } = require('../lib/smoke-test');
const maintenance = require('../lib/maintenance');
const configCmd = require('../lib/config-cmd');
const { getAllCircuitStatus, resetAllCircuits, CircuitState } = require('../lib/circuit-breaker');
const { secretsCmd } = require('../lib/secrets');
const contextCmd = require('../lib/context');
const performance = require('../lib/performance');
const { aliasCmd } = require('../lib/alias');
const { metricsCmd } = require('../lib/metrics');
const { topCmd } = require('../lib/top');
const changelogCmd = require('../lib/changelog');

// Setup global error handlers for uncaught exceptions and unhandled rejections
setupGlobalErrorHandlers();

const program = new Command();

program
  .name('mc')
  .description('MasterClaw CLI - Command your AI familiar')
  .version('0.31.0')  // Feature: Added mc changelog command to view ecosystem changelogs
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
program.addCommand(backup);
program.addCommand(restore);
program.addCommand(cleanup);
program.addCommand(completion);
program.addCommand(importer);
program.addCommand(exporter);
program.addCommand(deps);
program.addCommand(cost);
program.addCommand(ssl);
program.addCommand(backupVerify);
program.addCommand(update);
program.addCommand(notify);
program.addCommand(contextCmd);
program.addCommand(events);
program.addCommand(env.program);
program.addCommand(envCmd);
program.addCommand(maintenance);
program.addCommand(configCmd);
program.addCommand(secretsCmd);
program.addCommand(aliasCmd);
program.addCommand(metricsCmd);
program.addCommand(topCmd);
program.addCommand(changelogCmd);

// =============================================================================
// Benchmark Commands - Performance Testing
// =============================================================================

program
  .command('benchmark')
  .description('Run performance benchmarks against MasterClaw services')
  .option('--skip-llm', 'skip LLM provider benchmarks')
  .option('--skip-memory', 'skip memory store benchmarks')
  .option('--skip-api', 'skip API endpoint benchmarks')
  .option('--iterations <n>', 'number of iterations per test', '3')
  .option('--api-url <url>', 'API base URL', 'http://localhost:8000')
  .action(wrapCommand(async (options) => {
    const results = await benchmark.runBenchmarks({
      skipLLM: options.skipLlm,
      skipMemory: options.skipMemory,
      skipAPI: options.skipApi,
      iterations: parseInt(options.iterations, 10),
      apiUrl: options.apiUrl,
    });

    if (!results) {
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }

    if (!results.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'benchmark'));

program
  .command('benchmark-history')
  .description('View benchmark history and trends')
  .option('-a, --all', 'show all runs (default: last 10)')
  .action(wrapCommand(async (options) => {
    await benchmark.showHistory({ all: options.all });
  }, 'benchmark-history'));

program
  .command('benchmark-compare')
  .description('Compare recent benchmark runs')
  .action(wrapCommand(async () => {
    await benchmark.compareRuns();
  }, 'benchmark-compare'));

program
  .command('benchmark-export')
  .description('Export benchmark history to file')
  .option('-f, --format <format>', 'export format (json, csv)', 'json')
  .option('-o, --output <path>', 'output file path')
  .action(wrapCommand(async (options) => {
    await benchmark.exportResults(options.format, options.output);
  }, 'benchmark-export'));

// =============================================================================
// Smoke Test Commands - Post-Deployment Verification
// =============================================================================

program
  .command('smoke-test')
  .description('Run post-deployment smoke tests to verify API functionality')
  .option('--api-url <url>', 'API base URL (auto-detected if not provided)')
  .option('--quick', 'run quick test (critical endpoints only)')
  .option('-j, --json', 'output results as JSON')
  .action(wrapCommand(async (options) => {
    if (options.quick) {
      const result = await runQuickSmokeTest({ apiUrl: options.apiUrl });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      }

      if (!result.success) {
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      }
    } else {
      const result = await runSmokeTests({ apiUrl: options.apiUrl });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      }

      if (!result.success) {
        process.exit(result.critical ? ExitCode.SERVICE_UNAVAILABLE : ExitCode.GENERAL_ERROR);
      }
    }
  }, 'smoke-test'));

// =============================================================================
// Info Command
// =============================================================================

program
  .command('info')
  .description('Show comprehensive system information')
  .option('-j, --json', 'output as JSON')
  .action(wrapCommand(async (options) => {
    await info.showInfo(options);
  }, 'info'));

// =============================================================================
// Doctor Command - Comprehensive Diagnostics
// =============================================================================

program
  .command('doctor')
  .description('Run comprehensive diagnostics and troubleshooting')
  .option('-c, --category <category>', 'run checks for specific category (system,docker,services,config,network,security,performance)')
  .option('--fix', 'attempt automatic fixes (interactive)', false)
  .option('-j, --json', 'output as JSON', false)
  .action(wrapCommand(async (options) => {
    const report = await runDoctor({
      category: options.category,
      fix: options.fix,
      json: options.json,
    });

    // Exit with error if critical or high issues found
    if (!report.summary.healthy) {
      process.exit(ExitCode.VALIDATION_FAILED);
    }
  }, 'doctor'));

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

// Check command - dependency validation with actionable remediation
program
  .command('check')
  .description('Check command dependencies before execution')
  .argument('[command]', 'Command to check dependencies for (e.g., status, revive, deploy)')
  .option('-a, --all', 'Check all common dependencies')
  .option('-d, --deps <deps...>', 'Check specific dependencies (docker, compose, infra-dir, config)')
  .option('-q, --quiet', 'Minimal output, exit code only')
  .action(wrapCommand(async (commandName, options) => {
    const {
      validateCommandDeps,
      validateCustomDeps,
      validateDocker,
      validateDockerCompose,
      validateInfraDir,
      validateDiskSpace,
      validateMemory,
      DependencyType
    } = depsValidator;

    // Determine what to check
    let results;

    if (options.all || (!commandName && !options.deps)) {
      // Check all common dependencies
      if (!options.quiet) {
        console.log(chalk.blue('🔍 Checking MasterClaw Dependencies\n'));
      }

      results = await validateCustomDeps([
        DependencyType.DOCKER,
        DependencyType.DOCKER_COMPOSE,
        DependencyType.INFRA_DIR,
        DependencyType.CONFIG,
        DependencyType.DISK_SPACE,
        DependencyType.MEMORY,
      ]);
    } else if (options.deps) {
      // Check specific dependencies
      const depMap = {
        'docker': DependencyType.DOCKER,
        'compose': DependencyType.DOCKER_COMPOSE,
        'docker-compose': DependencyType.DOCKER_COMPOSE,
        'infra': DependencyType.INFRA_DIR,
        'infra-dir': DependencyType.INFRA_DIR,
        'config': DependencyType.CONFIG,
        'disk': DependencyType.DISK_SPACE,
        'memory': DependencyType.MEMORY,
      };

      const depsToCheck = options.deps.map(d => depMap[d]).filter(Boolean);

      if (!options.quiet) {
        console.log(chalk.blue(`🔍 Checking dependencies: ${options.deps.join(', ')}\n`));
      }

      results = await validateCustomDeps(depsToCheck);
    } else if (commandName) {
      // Check dependencies for a specific command
      if (!options.quiet) {
        console.log(chalk.blue(`🔍 Checking dependencies for '${commandName}'\n`));
      }

      results = await validateCommandDeps(commandName);
    }

    // Display results
    if (!options.quiet) {
      let passed = 0;
      let failed = 0;

      for (const result of results.results) {
        const icon = result.satisfied
          ? chalk.green('✅')
          : result.severity === 'critical'
            ? chalk.red('❌')
            : chalk.yellow('⚠️');

        console.log(`${icon} ${result.message}`);

        if (!result.satisfied && result.remediation) {
          for (const step of result.remediation.slice(0, 3)) {
            console.log(chalk.gray(`   → ${step}`));
          }
        }

        if (result.satisfied) {
          passed++;
        } else {
          failed++;
        }
      }

      console.log('');
      console.log(chalk.cyan(`Results: ${chalk.green(`${passed} passed`)}, ${failed > 0 ? chalk.red(`${failed} failed`) : chalk.green(`${failed} failed`)}`));

      if (results.canProceed) {
        console.log(chalk.green('\n✅ All critical dependencies satisfied - ready to proceed!'));
      } else {
        console.log(chalk.red('\n❌ Critical dependencies missing - cannot proceed'));
      }
    }

    // Exit with appropriate code
    if (!results.canProceed) {
      process.exit(ExitCode.VALIDATION_FAILED);
    }
  }, 'check'));

// =============================================================================
// Communication Commands
// =============================================================================

// Chat command - quick chat with MasterClaw
program
  .command('chat <message>')
  .description('Send a quick message to MasterClaw')
  .option('--no-stream', 'disable streaming response (if supported)')
  .action(wrapCommand(async (message, options) => {
    // Security: Validate and sanitize input
    const { validateChatInput, sanitizeChatInput } = require('../lib/chat-security');

    // Validate input before processing
    const validation = validateChatInput(message);
    if (!validation.valid) {
      console.log(chalk.yellow(`⚠️  ${validation.error}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    // Sanitize input to prevent injection
    const sanitizedMessage = sanitizeChatInput(message);

    // Rate limiting for chat command (10 per minute)
    await rateLimiter.enforceRateLimit('chat', { command: 'chat', messageLength: sanitizedMessage.length });

    console.log(chalk.blue('🐾 Sending message...\n'));

    const coreUrl = await config.get('core.url') || 'http://localhost:8000';
    const axios = require('axios');

    try {
      const response = await axios.post(`${coreUrl}/v1/chat`, {
        message: sanitizedMessage,
        session_id: `cli-${Date.now()}`,
      }, {
        timeout: 60000, // 60 second timeout for AI responses
        maxContentLength: 100 * 1024, // 100KB max response
        maxBodyLength: 50 * 1024, // 50KB max request body
      });

      // Validate response structure
      if (!response.data || typeof response.data.response !== 'string') {
        throw new Error('Invalid response from MasterClaw API');
      }

      console.log(chalk.cyan('MasterClaw:'));
      console.log(response.data.response);
    } catch (err) {
      if (err.response) {
        // API returned an error response
        const status = err.response.status;
        if (status === 429) {
          console.log(chalk.yellow('⚠️  Rate limited by MasterClaw API. Please wait before sending more messages.'));
          process.exit(ExitCode.SECURITY_VIOLATION);
        } else if (status >= 500) {
          console.log(chalk.red(`❌ MasterClaw API error (${status}). The service may be overloaded.`));
          process.exit(ExitCode.SERVICE_UNAVAILABLE);
        } else {
          console.log(chalk.red(`❌ API error: ${err.response.data?.detail || err.message}`));
          process.exit(ExitCode.GENERAL_ERROR);
        }
      }
      throw err; // Re-throw for default error handling
    }
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
    // Enforce rate limiting
    await rateLimiter.enforceRateLimit('config-audit', { command: 'config-audit' });

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
    // Enforce rate limiting
    await rateLimiter.enforceRateLimit('config-fix', { command: 'config-fix' });

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
    // Enforce rate limiting
    await rateLimiter.enforceRateLimit('audit-verify', { command: 'audit-verify' });

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
      console.log(`  ${chalk.red(`⚠️  INVALID signatures: ${  result.invalidSignatures}`)}`);
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
// Audit Log Viewer Commands
// =============================================================================

const { queryAuditLog, getSecuritySummary, AuditEventType, Severity } = require('../lib/audit');

program
  .command('audit')
  .description('View and analyze security audit logs')
  .option('-n, --limit <number>', 'number of entries to show', '50')
  .option('-t, --type <type>', 'filter by event type (e.g., SECURITY_VIOLATION, AUTH_FAILURE)')
  .option('-s, --severity <level>', 'filter by severity (debug, info, warning, error, critical)')
  .option('--hours <n>', 'show entries from last N hours', '24')
  .option('--summary', 'show security summary statistics only', false)
  .option('--json', 'output as JSON', false)
  .option('--search <term>', 'search for text in audit entries')
  .option('--verify', 'verify integrity of displayed entries', false)
  .action(wrapCommand(async (options) => {
    // Enforce rate limiting
    await rateLimiter.enforceRateLimit('audit', { command: 'audit' });

    const limit = parseInt(options.limit, 10) || 50;
    const hours = parseInt(options.hours, 10) || 24;

    // Show summary mode
    if (options.summary) {
      console.log(chalk.blue('🔒 Security Audit Summary\n'));
      console.log(chalk.gray(`   Last ${hours} hours\n`));

      const summary = await getSecuritySummary(hours);

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(chalk.cyan('Event Statistics:'));
      console.log(`  Total events: ${summary.totalEvents}`);
      console.log(`  Security violations: ${summary.securityViolations > 0 ? chalk.red(summary.securityViolations) : chalk.green(summary.securityViolations)}`);
      console.log(`  Failed authentications: ${summary.failedAuthentications > 0 ? chalk.yellow(summary.failedAuthentications) : chalk.green(summary.failedAuthentications)}`);
      console.log('');

      if (Object.keys(summary.bySeverity).length > 0) {
        console.log(chalk.cyan('By Severity:'));
        const severityColors = {
          debug: chalk.gray,
          info: chalk.blue,
          warning: chalk.yellow,
          error: chalk.red,
          critical: chalk.bgRed.white,
        };
        for (const [sev, count] of Object.entries(summary.bySeverity).sort((a, b) => {
          const order = ['critical', 'error', 'warning', 'info', 'debug'];
          return order.indexOf(a[0]) - order.indexOf(b[0]);
        })) {
          const color = severityColors[sev] || chalk.white;
          console.log(`  ${color(sev.padEnd(10))} ${count}`);
        }
        console.log('');
      }

      if (Object.keys(summary.byType).length > 0) {
        console.log(chalk.cyan('Top Event Types:'));
        const sortedTypes = Object.entries(summary.byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);
        for (const [type, count] of sortedTypes) {
          console.log(`  ${type.padEnd(30)} ${count}`);
        }
      }

      return;
    }

    // Normal log viewing mode
    console.log(chalk.blue('📋 Audit Log Viewer\n'));
    console.log(chalk.gray(`   Showing last ${limit} entries from ${hours} hours ago\n`));

    const queryOpts = {
      limit,
      hours,
      eventType: options.type || null,
      severity: options.severity || null,
    };

    const entries = await queryAuditLog(queryOpts);

    if (entries.length === 0) {
      console.log(chalk.yellow('⚠️  No audit entries found matching criteria'));
      return;
    }

    // Apply search filter if specified
    let filteredEntries = entries;
    if (options.search) {
      const searchLower = options.search.toLowerCase();
      filteredEntries = entries.filter(e =>
        JSON.stringify(e).toLowerCase().includes(searchLower)
      );
    }

    if (options.json) {
      console.log(JSON.stringify(filteredEntries, null, 2));
      return;
    }

    // Display entries
    const severityIcons = {
      debug: chalk.gray('◦'),
      info: chalk.blue('ℹ'),
      warning: chalk.yellow('⚠'),
      error: chalk.red('✖'),
      critical: chalk.bgRed.white('!'),
    };

    console.log(chalk.cyan(`Found ${filteredEntries.length} entries:\n`));

    for (const entry of filteredEntries) {
      const icon = severityIcons[entry.severity] || chalk.white('•');
      const time = new Date(entry.timestamp).toLocaleString();
      const sigStatus = entry._signature ? chalk.green('✓') : chalk.yellow('○');

      console.log(`${icon} ${chalk.gray(time)} ${chalk.bold(entry.eventType)} ${sigStatus}`);

      if (entry.details && Object.keys(entry.details).length > 0) {
        const detailStr = Object.entries(entry.details)
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        if (detailStr) {
          console.log(chalk.gray(`   ${detailStr.substring(0, 100)}${detailStr.length > 100 ? '...' : ''}`));
        }
      }

      if (entry.context && entry.context.command) {
        console.log(chalk.gray(`   cmd: ${entry.context.command}`));
      }

      console.log('');
    }

    // Verify integrity if requested
    if (options.verify && filteredEntries.length > 0) {
      console.log(chalk.blue('🔍 Verifying entry signatures...\n'));

      const { verifyEntrySignature, getAuditSigningKey } = require('../lib/audit');
      const key = await getAuditSigningKey();

      let validCount = 0;
      let invalidCount = 0;
      let unsignedCount = 0;

      for (const entry of filteredEntries) {
        if (!entry._signature) {
          unsignedCount++;
        } else {
          const isValid = await verifyEntrySignature(entry, key);
          if (isValid) validCount++;
          else invalidCount++;
        }
      }

      console.log(chalk.cyan('Verification Results:'));
      console.log(`  Valid signatures: ${chalk.green(validCount)}`);
      console.log(`  Invalid signatures: ${invalidCount > 0 ? chalk.red(invalidCount) : chalk.green(invalidCount)}`);
      console.log(`  Unsigned entries: ${unsignedCount > 0 ? chalk.yellow(unsignedCount) : chalk.green(unsignedCount)}`);

      if (invalidCount > 0) {
        console.log(chalk.red('\n⚠️  Some entries have invalid signatures!'));
        process.exit(ExitCode.SECURITY_VIOLATION);
      }
    }
  }, 'audit'));

// =============================================================================
// Rate Limiting Commands
// =============================================================================

program
  .command('rate-limit')
  .description('Manage command rate limiting')
  .option('-s, --status', 'show current rate limit status', false)
  .option('--reset <command>', 'reset rate limit for a specific command (requires --force)')
  .option('--reset-all', 'reset all rate limits (requires --force)')
  .option('--force', 'force reset without confirmation (security-sensitive)')
  .action(wrapCommand(async (options) => {
    const chalk = require('chalk');

    // Handle reset operations
    if (options.reset || options.resetAll) {
      if (!options.force) {
        console.log(chalk.red('❌ Rate limit reset requires --force flag'));
        console.log(chalk.gray('   This is a security-sensitive operation'));
        process.exit(ExitCode.SECURITY_VIOLATION);
      }

      try {
        await rateLimiter.resetRateLimits(options.resetAll ? null : options.reset, true);
        console.log(chalk.green('✅ Rate limits reset successfully'));
        if (options.reset) {
          console.log(chalk.gray(`   Reset command: ${options.reset}`));
        } else {
          console.log(chalk.gray('   Reset all commands'));
        }
        return;
      } catch (err) {
        throw err;
      }
    }

    // Default: show status
    console.log(chalk.blue('🚦 MasterClaw Rate Limit Status\n'));

    const status = await rateLimiter.getRateLimitStatus();

    console.log(chalk.cyan('Command Rate Limits (sliding window):\n'));

    // Group commands by sensitivity
    const highSecurity = ['config-audit', 'config-fix', 'audit-verify', 'security', 'exec', 'restore'];
    const deployment = ['deploy', 'revive'];
    const dataMod = ['cleanup', 'import'];
    const readOnly = ['status', 'health', 'logs', 'validate'];

    function printGroup(title, commands, color) {
      console.log(color(`${title}:`));
      for (const cmd of commands) {
        if (status[cmd]) {
          const s = status[cmd];
          const usageColor = s.remaining === 0 ? chalk.red :
            s.remaining < s.limit * 0.2 ? chalk.yellow : chalk.green;
          console.log(`  ${chalk.bold(cmd.padEnd(15))} ${usageColor(`${s.used}/${s.limit}`)} ${chalk.gray(`(resets at ${new Date(s.resetTime).toLocaleTimeString()})`)}`);
        }
      }
      console.log('');
    }

    printGroup('🔒 High Security', highSecurity, chalk.red);
    printGroup('🚀 Deployment', deployment, chalk.yellow);
    printGroup('💾 Data Modification', dataMod, chalk.cyan);
    printGroup('📖 Read-Only', readOnly, chalk.green);

    console.log(chalk.gray('Rate limits help prevent abuse and accidental command flooding.'));
    console.log(chalk.gray('Limits are per-minute (except where noted).'));
  }, 'rate-limit'));

// =============================================================================
// Circuit Breaker Commands - Service Resilience
// =============================================================================

program
  .command('circuits')
  .description('View and manage circuit breaker status for service resilience')
  .option('-s, --status', 'show detailed circuit status', true)
  .option('--reset <service>', 'reset circuit for a specific service (core, backend, interface, gateway)')
  .option('--reset-all', 'reset all circuits')
  .option('--json', 'output as JSON')
  .action(wrapCommand(async (options) => {
    // Handle reset operations
    if (options.reset || options.resetAll) {
      if (options.resetAll) {
        resetAllCircuits();
        console.log(chalk.green('✅ All circuits reset'));
        return;
      }

      const circuitName = `service-${options.reset}`;
      const { getCircuit } = require('../lib/circuit-breaker');
      const circuit = getCircuit(circuitName);
      if (circuit) {
        circuit.closeCircuit();
        console.log(chalk.green(`✅ Circuit for '${options.reset}' reset`));
      } else {
        console.log(chalk.yellow(`⚠️  No circuit found for '${options.reset}'`));
      }
      return;
    }

    // Default: show status
    const statuses = getAllCircuitStatus();

    if (options.json) {
      console.log(JSON.stringify(statuses, null, 2));
      return;
    }

    console.log(chalk.blue('⚡ MasterClaw Circuit Breaker Status\n'));

    if (statuses.length === 0) {
      console.log(chalk.gray('No active circuits. Run health checks to initialize.'));
      return;
    }

    // Service name mapping
    const serviceNames = {
      'service-core': 'AI Core',
      'service-backend': 'Backend API',
      'service-interface': 'Interface',
      'service-gateway': 'Gateway',
    };

    for (const status of statuses) {
      const displayName = serviceNames[status.name] || status.name;

      // State icon
      let stateIcon, stateColor;
      switch (status.state) {
        case 'CLOSED':
          stateIcon = '✅';
          stateColor = chalk.green;
          break;
        case 'OPEN':
          stateIcon = '🔴';
          stateColor = chalk.red;
          break;
        case 'HALF_OPEN':
          stateIcon = '🟡';
          stateColor = chalk.yellow;
          break;
        default:
          stateIcon = '⚪';
          stateColor = chalk.gray;
      }

      // Health icon
      let healthIcon;
      switch (status.health) {
        case 'healthy':
          healthIcon = chalk.green('●');
          break;
        case 'degraded':
          healthIcon = chalk.yellow('●');
          break;
        case 'unhealthy':
          healthIcon = chalk.red('●');
          break;
        default:
          healthIcon = chalk.gray('○');
      }

      console.log(`${stateIcon} ${chalk.bold(displayName)}`);
      console.log(`   State: ${stateColor(status.state)} ${healthIcon}`);
      console.log(`   Calls: ${status.stats.totalCalls} total (${status.stats.totalSuccesses} success, ${status.stats.totalFailures} failed)`);
      console.log(`   Error Rate: ${status.stats.errorRate}`);

      if (status.stats.failuresInWindow > 0) {
        console.log(chalk.yellow(`   Recent Failures: ${status.stats.failuresInWindow} in last ${status.config.monitorWindowMs / 1000}s`));
      }
      console.log('');
    }

    console.log(chalk.gray('Circuits protect against cascading failures by failing fast when services are unstable.'));
    console.log(chalk.gray('States: CLOSED (normal), OPEN (failing fast), HALF_OPEN (testing recovery)'));
  }, 'circuits'));

// =============================================================================
// Security Monitor Commands
// =============================================================================

program
  .command('security')
  .description('Security monitoring and threat detection')
  .option('-s, --scan', 'run full security scan', false)
  .option('-w, --watch', 'continuous security monitoring', false)
  .option('--hours <n>', 'hours to look back for analysis', '24')
  .option('--json', 'output results as JSON', false)
  .option('--status', 'quick security status check', false)
  .action(wrapCommand(async (options) => {
    // Enforce rate limiting for security command
    await rateLimiter.enforceRateLimit('security', { command: 'security' });

    // Quick status mode
    if (options.status) {
      const status = await securityMonitor.getQuickSecurityStatus();

      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        const statusIcon = status.status === 'ok' ? chalk.green('✅') : chalk.yellow('⚠️');
        console.log(`${statusIcon} Security Status: ${status.status.toUpperCase()}`);
        console.log(chalk.gray(`   Last hour: ${status.lastHour.totalEvents} events, ${status.lastHour.securityViolations} violations`));
        console.log(chalk.gray(`   Config secure: ${status.configSecure ? 'Yes' : 'No'}`));
      }

      if (status.status !== 'ok') {
        process.exit(ExitCode.SECURITY_VIOLATION);
      }
      return;
    }

    // Full scan mode (default)
    const hours = parseInt(options.hours, 10) || 24;

    if (!options.json) {
      console.log(chalk.blue('🔒 MasterClaw Security Scan'));
      console.log(chalk.gray(`   Analyzing last ${hours} hours...\n`));
    }

    const ora = require('ora');
    const spinner = ora('Scanning for security threats...').start();

    const result = await securityMonitor.runSecurityScan({ hours });

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // Display results
      console.log(chalk.cyan('Scan Summary:'));
      console.log(`  Scan ID: ${result.scanId}`);
      console.log(`  Duration: ${result.scanDurationMs}ms`);
      console.log(`  Time window: Last ${hours} hours\n`);

      // Threat summary
      const { summary } = result;
      const totalThreats = summary.critical + summary.high + summary.medium + summary.low;

      if (totalThreats === 0) {
        console.log(chalk.green('✅ No threats detected'));
      } else {
        console.log(chalk.yellow(`⚠️  Threats detected: ${totalThreats}`));
        if (summary.critical > 0) console.log(chalk.red(`   Critical: ${summary.critical}`));
        if (summary.high > 0) console.log(chalk.red(`   High: ${summary.high}`));
        if (summary.medium > 0) console.log(chalk.yellow(`   Medium: ${summary.medium}`));
        if (summary.low > 0) console.log(chalk.gray(`   Low: ${summary.low}`));
      }

      // Configuration health
      if (!result.configHealthy) {
        console.log(chalk.red('\n❌ Configuration issues detected:'));
        result.configIssues.forEach(issue => {
          console.log(chalk.red(`   • ${issue}`));
        });
      }

      // Detailed threat information
      if (result.threats.length > 0) {
        console.log(chalk.cyan('\nDetailed Threat Information:'));
        result.threats.slice(0, 5).forEach((threat, i) => {
          const levelColor = threat.level === 'critical' ? chalk.red :
            threat.level === 'high' ? chalk.red :
              threat.level === 'medium' ? chalk.yellow : chalk.gray;
          console.log(`\n  ${i + 1}. ${levelColor(threat.type.toUpperCase())} (${levelColor(threat.level)})`);
          console.log(`     Source: ${threat.source}`);
          console.log(`     Time: ${threat.timestamp}`);
          if (threat.details.description) {
            console.log(`     Description: ${threat.details.description}`);
          }
        });

        if (result.threats.length > 5) {
          console.log(chalk.gray(`\n  ... and ${result.threats.length - 5} more threats`));
        }
      }

      // Recommendations
      if (totalThreats > 0) {
        console.log(chalk.cyan('\nRecommendations:'));
        if (summary.critical > 0) {
          console.log(chalk.red('  • Immediate action required: Investigate critical threats'));
        }
        if (summary.high > 0) {
          console.log(chalk.yellow('  • Review high-severity threats and take appropriate action'));
        }
        if (!result.configHealthy) {
          console.log('  • Run "mc config-fix" to resolve configuration issues');
        }
        console.log('  • Review audit logs for more details: mc logs query');
      }
    }

    // Exit with error if critical threats found
    if (result.summary.critical > 0) {
      process.exit(ExitCode.SECURITY_VIOLATION);
    }
  }, 'security'));

// =============================================================================
// Container Execution Commands
// =============================================================================

program
  .command('exec')
  .description('Execute a command in a running MasterClaw container')
  .argument('<container>', 'Container name (mc-core, mc-backend, mc-gateway, mc-chroma)')
  .argument('<command>', 'Command to execute (use quotes for multi-word commands)')
  .option('-i, --interactive', 'Run in interactive mode (keep STDIN open)', false)
  .option('-t, --tty', 'Allocate a pseudo-TTY (for colored output)', false)
  .option('-w, --workdir <dir>', 'Working directory inside the container')
  .option('-e, --env <vars...>', 'Environment variables (KEY=value format)')
  .option('--shell', 'Open a shell in the container (shortcut for -it with sh)')
  .action(wrapCommand(async (container, commandArg, options) => {
    // Enforce rate limiting for exec command (security-sensitive)
    await rateLimiter.enforceRateLimit('exec', { command: 'exec', container });

    // Handle shell shortcut
    if (options.shell) {
      options.interactive = true;
      options.tty = true;
    }

    // Parse environment variables
    const env = {};
    if (options.env) {
      for (const envVar of options.env) {
        const [key, ...valueParts] = envVar.split('=');
        if (key && valueParts.length > 0) {
          env[key] = valueParts.join('=');
        }
      }
    }

    // Parse command (split by space unless already an array)
    const command = commandArg.split(' ').filter(Boolean);

    if (!options.interactive) {
      console.log(chalk.blue(`🐾 Executing in ${container}:`));
      console.log(chalk.gray(`   ${command.join(' ')}\n`));
    }

    try {
      const result = await execInContainer({
        container,
        command,
        interactive: options.interactive,
        tty: options.tty,
        workdir: options.workdir,
        env,
      });

      if (options.interactive) {
        // Interactive mode: just show exit code
        console.log('');
        if (result.exitCode === 0) {
          console.log(chalk.green(`✅ Shell exited successfully`));
        } else if (result.resourceViolation) {
          console.log(chalk.red(`❌ Shell killed: ${result.resourceViolation.description}`));
          console.log(chalk.cyan(`   💡 ${result.resourceViolation.suggestion}`));
        } else {
          console.log(chalk.yellow(`⚠️  Shell exited with code ${result.exitCode}`));
        }
      } else {
        // Non-interactive mode: show output
        if (result.stdout) {
          console.log(result.stdout);
        }
        if (result.stderr) {
          console.error(chalk.yellow(result.stderr));
        }

        if (result.exitCode === 0) {
          console.log(chalk.gray(`\n✅ Completed in ${result.duration}ms`));
        } else {
          // Check for resource limit violations
          if (result.resourceViolation) {
            console.log(chalk.red(`\n❌ Resource limit exceeded: ${result.resourceViolation.violationType}`));
            console.log(chalk.yellow(`   ${result.resourceViolation.description}`));
            console.log(chalk.cyan(`   💡 ${result.resourceViolation.suggestion}`));
            console.log(chalk.gray(`   Exit code: ${result.exitCode} (${result.duration}ms)`));
            process.exit(ExitCode.SECURITY_VIOLATION);
          } else {
            console.log(chalk.yellow(`\n⚠️  Exit code: ${result.exitCode} (${result.duration}ms)`));
            process.exit(result.exitCode);
          }
        }
      }
    } catch (error) {
      if (error.code === 'CONTAINER_NOT_RUNNING') {
        console.log(chalk.red(`❌ Container '${container}' is not running`));
        console.log(chalk.gray('   Run "mc status" to check service status'));
        console.log(chalk.gray('   Run "mc revive" to start services'));
      } else if (error.code === 'BLOCKED_COMMAND') {
        console.log(chalk.red(`❌ Command blocked for security: ${error.details?.command}`));
      } else {
        console.log(chalk.red(`❌ ${error.message}`));
      }
      throw error;
    }
  }, 'exec'));

// List containers subcommand
program
  .command('containers')
  .description('List running MasterClaw containers')
  .option('-a, --all', 'Show all containers including stopped', false)
  .action(wrapCommand(async (options) => {
    console.log(chalk.blue('🐾 MasterClaw Containers\n'));

    const containers = await getRunningContainers();

    if (containers.length === 0) {
      console.log(chalk.yellow('No MasterClaw containers are running'));
      console.log(chalk.gray('   Run "mc revive" to start services'));
      return;
    }

    console.log(chalk.cyan('Running Containers:'));
    for (const c of containers) {
      console.log(`  ${chalk.green('●')} ${chalk.bold(c.name)}`);
      console.log(chalk.gray(`     Status: ${c.uptime}`));
    }

    console.log('');
    console.log(chalk.gray(`Use 'mc exec <container> <command>' to run commands`));
    console.log(chalk.gray(`Use 'mc exec <container> sh --shell' for interactive shell`));
  }, 'containers'));

// =============================================================================
// Performance Profiling Commands
// =============================================================================

program
  .command('performance')
  .description('View API performance metrics and profiling data')
  .option('--summary', 'Show performance summary (default)')
  .option('--stats', 'Show detailed endpoint statistics')
  .option('--slowest [n]', 'Show top N slowest endpoints', parseInt)
  .option('--profiles [n]', 'Show recent request profiles', parseInt)
  .option('--slow-only', 'Only show slow requests (with --profiles)')
  .option('--clear', 'Clear all performance profiles')
  .action(wrapCommand(async (options) => {
    if (options.clear) {
      await performance.clearProfiles();
    } else if (options.stats) {
      await performance.showStats();
    } else if (options.slowest) {
      const n = typeof options.slowest === 'number' ? options.slowest : 10;
      await performance.showSlowest(n);
    } else if (options.profiles) {
      const limit = typeof options.profiles === 'number' ? options.profiles : 20;
      await performance.showProfiles({ limit, slowOnly: options.slowOnly });
    } else {
      // Default to summary
      await performance.showSummary();
    }
  }, 'performance'));

// =============================================================================
// Parse and Execute
// =============================================================================

program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
