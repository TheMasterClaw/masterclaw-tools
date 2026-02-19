/**
 * Test Command for MasterClaw CLI
 *
 * Run tests across the MasterClaw ecosystem.
 * Supports running tests for Core API, Tools, and Infrastructure.
 *
 * Features:
 * - Run all tests or specific test suites
 * - Watch mode for development
 * - Coverage reporting
 * - Test filtering by pattern
 * - Parallel execution options
 *
 * @example
 * mc test                    # Run all tests
 * mc test --core             # Run Core API tests only
 * mc test --tools            # Run Tools tests only
 * mc test --watch            # Watch mode
 * mc test --coverage         # With coverage report
 * mc test --pattern auth     # Run tests matching "auth"
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');

const test = new Command('test');

/**
 * Run command in directory
 */
function runCommand(cmd, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });

    let output = '';
    if (options.silent) {
      child.stdout?.on('data', (data) => {
        output += data.toString();
      });
      child.stderr?.on('data', (data) => {
        output += data.toString();
      });
    }

    child.on('close', (code) => {
      resolve({ code, output });
    });

    child.on('error', reject);
  });
}

/**
 * Get workspace directory
 */
async function getWorkspaceDir() {
  const infraDir = await config.get('infraDir');
  if (infraDir) {
    return path.dirname(infraDir);
  }
  return process.cwd();
}

/**
 * Main test command
 */
test
  .description('Run tests across the MasterClaw ecosystem')
  .option('--core', 'Run Core API tests only')
  .option('--tools', 'Run Tools tests only')
  .option('--infra', 'Run Infrastructure tests only')
  .option('-w, --watch', 'Watch mode - re-run tests on file changes')
  .option('--coverage', 'Generate coverage report')
  .option('-p, --pattern <pattern>', 'Run tests matching pattern')
  .option('-v, --verbose', 'Verbose output')
  .option('--list', 'List available test files without running')
  .action(wrapCommand(async (options) => {
    const workspaceDir = await getWorkspaceDir();

    // Check if pytest is available for core tests
    const hasPytest = await fs.pathExists(path.join(workspaceDir, 'masterclaw_core'));
    const hasToolsTests = await fs.pathExists(path.join(workspaceDir, 'masterclaw-tools', 'tests'));

    if (options.list) {
      console.log(chalk.blue('🧪 Available Test Suites\n'));

      if (hasPytest) {
        console.log(chalk.cyan('Core API Tests:'));
        const testDir = path.join(workspaceDir, 'masterclaw_core', 'tests');
        if (await fs.pathExists(testDir)) {
          const files = await fs.readdir(testDir);
          files.filter(f => f.endsWith('_test.py') || f.startsWith('test_')).forEach(f => {
            console.log(`  • ${f}`);
          });
        }
        console.log('');
      }

      if (hasToolsTests) {
        console.log(chalk.cyan('Tools Tests:'));
        const testDir = path.join(workspaceDir, 'masterclaw-tools', 'tests');
        if (await fs.pathExists(testDir)) {
          const files = await fs.readdir(testDir);
          files.filter(f => f.endsWith('.test.js')).forEach(f => {
            console.log(`  • ${f}`);
          });
        }
      }

      return;
    }

    const results = {
      core: null,
      tools: null,
    };

    // Run Core tests
    if (!options.tools || options.core) {
      if (hasPytest) {
        const spinner = ora('Running Core API tests...').start();

        const args = ['-m', 'pytest'];

        if (options.verbose) args.push('-v');
        if (options.coverage) args.push('--cov=masterclaw_core', '--cov-report=term-missing');
        if (options.pattern) args.push('-k', options.pattern);

        const coreDir = path.join(workspaceDir, 'masterclaw_core');

        try {
          const result = await runCommand('python3', args, coreDir, { silent: !options.verbose });
          results.core = result.code === 0;

          if (results.core) {
            spinner.succeed('Core API tests passed');
          } else {
            spinner.fail('Core API tests failed');
          }
        } catch (err) {
          spinner.fail(`Core API tests error: ${err.message}`);
          results.core = false;
        }
      } else {
        console.log(chalk.yellow('⚠️  Core API tests not found'));
      }
    }

    // Run Tools tests
    if (!options.core || options.tools) {
      if (hasToolsTests) {
        const spinner = ora('Running Tools tests...').start();

        const args = ['test'];

        if (options.watch) args.push('--watch');
        if (options.coverage) args.push('--coverage');
        if (options.pattern) args.push('--testPathPattern', options.pattern);
        if (options.verbose) args.push('--verbose');

        const toolsDir = path.join(workspaceDir, 'masterclaw-tools');

        try {
          const result = await runCommand('npm', args, toolsDir, { silent: !options.verbose });
          results.tools = result.code === 0;

          if (results.tools) {
            spinner.succeed('Tools tests passed');
          } else {
            spinner.fail('Tools tests failed');
          }
        } catch (err) {
          spinner.fail(`Tools tests error: ${err.message}`);
          results.tools = false;
        }
      } else {
        console.log(chalk.yellow('⚠️  Tools tests not found'));
      }
    }

    console.log('');
    console.log(chalk.blue('📊 Test Summary\n'));

    if (results.core !== null) {
      console.log(`  Core API: ${results.core ? chalk.green('✓ Passed') : chalk.red('✗ Failed')}`);
    }

    if (results.tools !== null) {
      console.log(`  Tools:    ${results.tools ? chalk.green('✓ Passed') : chalk.red('✗ Failed')}`);
    }

    const allPassed = Object.values(results).every(r => r === null || r === true);

    if (allPassed) {
      console.log(chalk.green('\n✓ All tests passed!'));
    } else {
      console.log(chalk.red('\n✗ Some tests failed'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'test'));

/**
 * Quick subcommand - Run smoke tests
 */
test
  .command('quick')
  .description('Run quick smoke tests')
  .action(wrapCommand(async () => {
    console.log(chalk.blue('🚀 Running Quick Smoke Tests\n'));

    const workspaceDir = await getWorkspaceDir();
    const coreDir = path.join(workspaceDir, 'masterclaw_core');

    // Check Core API health
    const spinner = ora('Checking Core API health...').start();

    try {
      const coreUrl = await config.get('core.url', 'http://localhost:8000');
      const axios = require('axios');

      const response = await axios.get(`${coreUrl}/health`, { timeout: 5000 });

      if (response.status === 200) {
        spinner.succeed(`Core API is healthy (${response.data.version || 'unknown'})`);
      } else {
        spinner.fail('Core API health check failed');
        process.exit(ExitCode.SERVICE_UNAVAILABLE);
      }
    } catch (err) {
      spinner.fail(`Core API unreachable: ${err.message}`);
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }

    console.log(chalk.green('\n✓ Quick smoke tests passed!'));
  }, 'test-quick'));

module.exports = test;
