// deps.js - Service dependency management commands for mc CLI
// Provides commands to visualize and check service dependencies

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const deps = new Command('deps');

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
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'wait-for-deps.sh'))) {
      return dir;
    }
  }

  return null;
}

// Show dependency tree
function showDependencyTree() {
  console.log(chalk.blue('🐾 MasterClaw Service Dependencies'));
  console.log('');

  const tree = {
    'traefik': {
      deps: ['gateway', 'core', 'backend', 'interface'],
      desc: 'Reverse proxy & SSL termination'
    },
    'interface': {
      deps: ['backend'],
      desc: 'React web frontend'
    },
    'backend': {
      deps: ['gateway', 'core'],
      desc: 'Node.js API server'
    },
    'core': {
      deps: ['chroma'],
      desc: 'Python AI brain (FastAPI)'
    },
    'gateway': {
      deps: [],
      desc: 'OpenClaw Gateway'
    },
    'chroma': {
      deps: [],
      desc: 'ChromaDB vector database'
    },
    'watchtower': {
      deps: [],
      desc: 'Auto-updater for containers'
    }
  };

  // Print tree
  console.log(chalk.cyan('Service Dependency Map:'));
  console.log('');

  for (const [service, info] of Object.entries(tree)) {
    const hasDeps = info.deps.length > 0;
    const icon = hasDeps ? '📦' : '🔧';

    console.log(`${icon} ${chalk.bold(service)}`);
    console.log(`   ${chalk.gray(info.desc)}`);

    if (hasDeps) {
      console.log(`   ${chalk.gray('depends on:')} ${info.deps.map(d => chalk.cyan(d)).join(', ')}`);
    } else {
      console.log(`   ${chalk.gray('(no dependencies)')}`);
    }
    console.log('');
  }

  console.log(chalk.gray('Legend: 📦 = has dependencies, 🔧 = base service'));
}

// Check dependencies command
deps
  .command('check')
  .alias('status')
  .description('Check health of all service dependencies')
  .option('-w, --watch', 'Continuous monitoring mode')
  .option('-s, --service <name>', 'Check specific service dependencies')
  .action(async (options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.error(chalk.red('❌ Infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA or run from the infrastructure directory'));
      process.exit(1);
    }

    const scriptPath = path.join(infraDir, 'scripts', 'wait-for-deps.sh');

    const runCheck = () => {
      return new Promise((resolve) => {
        const proc = spawn('bash', [scriptPath, '--check-all'], {
          cwd: infraDir,
          stdio: 'inherit'
        });

        proc.on('close', (code) => {
          resolve(code === 0);
        });
      });
    };

    if (options.watch) {
      console.log(chalk.blue('👀 Watching service dependencies (Ctrl+C to exit)...\n'));

      const check = async () => {
        console.clear();
        await runCheck();
        console.log(chalk.gray('\nRefreshing in 5 seconds...'));
      };

      await check();
      const interval = setInterval(check, 5000);

      process.on('SIGINT', () => {
        clearInterval(interval);
        console.log(chalk.blue('\n👋 Stopped watching.'));
        process.exit(0);
      });
    } else if (options.service) {
      // Check specific service
      console.log(chalk.blue(`🔍 Checking dependencies for ${options.service}...\n`));

      const proc = spawn('bash', [scriptPath, options.service], {
        cwd: infraDir,
        stdio: 'inherit'
      });

      proc.on('close', (code) => {
        process.exit(code);
      });
    } else {
      // Check all
      await runCheck();
    }
  });

// Wait for dependencies command
deps
  .command('wait <service>')
  .description('Wait for a service\'s dependencies to be ready')
  .option('-t, --timeout <seconds>', 'Timeout in seconds', '120')
  .action(async (service, options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.error(chalk.red('❌ Infrastructure directory not found'));
      process.exit(1);
    }

    const scriptPath = path.join(infraDir, 'scripts', 'wait-for-deps.sh');

    const timeout = parseInt(options.timeout, 10);
    if (isNaN(timeout) || timeout < 1) {
      console.error(chalk.red('❌ Timeout must be a positive number'));
      process.exit(1);
    }

    console.log(chalk.blue(`⏳ Waiting for ${service} dependencies (timeout: ${timeout}s)...\n`));

    const proc = spawn('bash', [scriptPath, service, String(timeout)], {
      cwd: infraDir,
      stdio: 'inherit'
    });

    proc.on('close', (code) => {
      process.exit(code);
    });
  });

// Default action - show tree
deps
  .action(() => {
    showDependencyTree();
    console.log('');
    console.log(chalk.gray('Commands:'));
    console.log(`  ${chalk.cyan('mc deps check')}        Check all service dependencies`);
    console.log(`  ${chalk.cyan('mc deps check -w')}     Watch mode - continuous monitoring`);
    console.log(`  ${chalk.cyan('mc deps wait core')}    Wait for core service dependencies`);
    console.log('');
  });

module.exports = deps;
