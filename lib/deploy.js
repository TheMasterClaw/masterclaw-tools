// deploy.js - Deployment management commands for mc CLI

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const deploy = new Command('deploy');

// Find infrastructure directory
function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
  ];

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'scripts', 'deploy-zero-downtime.sh'))) {
      return dir;
    }
  }

  // Try to find from git remote
  try {
    const gitRemote = execSync('git remote get-url origin', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    if (gitRemote.includes('masterclaw-infrastructure')) {
      return process.cwd();
    }
  } catch (e) {
    // ignore
  }

  return null;
}

// Execute deployment script
function runDeployScript(args = '') {
  const infraDir = findInfraDir();

  if (!infraDir) {
    console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
    console.log(chalk.gray('Set MASTERCLAW_INFRA environment variable or run from infra directory'));
    process.exit(1);
  }

  const scriptPath = path.join(infraDir, 'scripts', 'deploy-zero-downtime.sh');

  if (!fs.existsSync(scriptPath)) {
    console.error(chalk.red('❌ Deployment script not found'));
    console.log(chalk.gray(`Expected: ${  scriptPath}`));
    process.exit(1);
  }

  try {
    execSync(`${scriptPath} ${args}`, {
      cwd: infraDir,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' }
    });
  } catch (err) {
    process.exit(err.status || 1);
  }
}

// Zero-downtime deployment
deploy
  .command('rolling')
  .description('Deploy with zero downtime using blue-green strategy')
  .option('-f, --force', 'Force deployment even if tests fail')
  .option('--skip-tests', 'Skip pre-deployment tests')
  .action((options) => {
    console.log(chalk.blue('🚀 Starting zero-downtime deployment...\n'));

    let args = '';
    if (options.force) args += ' --force';
    if (options.skipTests) args += ' --skip-tests';

    runDeployScript(args);
  });

// Canary deployment
deploy
  .command('canary <percent>')
  .description('Deploy canary version to percentage of traffic (1-100)')
  .option('-f, --force', 'Force deployment even if tests fail')
  .action((percent, options) => {
    const pct = parseInt(percent, 10);
    if (isNaN(pct) || pct < 1 || pct > 100) {
      console.error(chalk.red('❌ Percentage must be between 1 and 100'));
      process.exit(1);
    }

    console.log(chalk.blue(`🚀 Starting canary deployment (${pct}% traffic)...\n`));

    let args = `--canary ${pct}`;
    if (options.force) args += ' --force';

    runDeployScript(args);
  });

// Rollback
deploy
  .command('rollback')
  .description('Rollback to previous deployment version')
  .action(() => {
    console.log(chalk.yellow('🔄 Rolling back to previous version...\n'));
    runDeployScript('--rollback');
  });

// Status
deploy
  .command('status')
  .description('Show current deployment status')
  .action(async () => {
    const infraDir = findInfraDir();

    if (!infraDir) {
      console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const stateFile = path.join(infraDir, '.deployments', 'state.json');

    console.log(chalk.blue('📊 Deployment Status\n'));
    console.log('====================');

    if (await fs.pathExists(stateFile)) {
      try {
        const state = await fs.readJson(stateFile);
        console.log(`Active Color:   ${state.active_color === 'blue' ? chalk.blue('🔵 Blue') : chalk.green('🟢 Green')}`);
        console.log(`Version:        ${state.version || 'unknown'}`);
        console.log(`Deployed:       ${state.timestamp || 'unknown'}`);
        console.log(`Domain:         ${state.domain || 'unknown'}`);
      } catch (err) {
        console.log(chalk.yellow('⚠️  Could not parse deployment state'));
      }
    } else {
      console.log(chalk.gray('No deployment state found'));
      console.log(chalk.gray('Run "mc deploy rolling" to create initial deployment'));
    }

    console.log('');
    console.log(chalk.blue('Active Containers:'));

    try {
      const output = execSync('docker ps --filter "name=mc-core" --format "{{.Names}}: {{.Status}}"', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      });

      if (output.trim()) {
        output.trim().split('\n').forEach(line => {
          const [name, ...statusParts] = line.split(': ');
          const status = statusParts.join(': ');
          const color = status.includes('healthy') ? chalk.green : chalk.yellow;
          console.log(`  ${color('●')} ${name}: ${color(status)}`);
        });
      } else {
        console.log(chalk.gray('  No containers running'));
      }
    } catch (err) {
      console.log(chalk.gray('  Docker not available'));
    }
  });

// History
deploy
  .command('history')
  .description('Show deployment history')
  .option('-n, --limit <num>', 'Number of entries to show', '10')
  .action(async (options) => {
    const infraDir = findInfraDir();

    if (!infraDir) {
      console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const historyFile = path.join(infraDir, '.deployments', 'history.log');

    console.log(chalk.blue('📜 Deployment History\n'));

    if (await fs.pathExists(historyFile)) {
      try {
        const lines = (await fs.readFile(historyFile, 'utf8')).trim().split('\n');
        const limit = parseInt(options.limit, 10);
        const recent = lines.slice(-limit).reverse();

        recent.forEach((line, index) => {
          try {
            const entry = JSON.parse(line);
            const color = entry.color === 'blue' ? '🔵' : '🟢';
            const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'unknown';
            console.log(`${color} ${entry.color.padEnd(5)} │ ${entry.version.substring(0, 8).padEnd(8)} │ ${time}`);
          } catch (e) {
            console.log(chalk.gray(`  [invalid entry]`));
          }
        });

        if (lines.length > limit) {
          console.log(chalk.gray(`\n... and ${lines.length - limit} more entries`));
        }
      } catch (err) {
        console.log(chalk.yellow('⚠️  Could not read deployment history'));
      }
    } else {
      console.log(chalk.gray('No deployment history found'));
    }
  });

module.exports = deploy;
