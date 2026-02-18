// deploy.js - Deployment management commands for mc CLI
// Enhanced with deployment notifications

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

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

// Get notification config paths
async function getNotifyConfigPaths() {
  const infraDir = findInfraDir();
  if (!infraDir) return null;
  
  const configDir = path.join(infraDir, 'config');
  const notifyConfig = path.join(configDir, 'notifications.json');
  const envFile = path.join(infraDir, '.env');
  
  return { infraDir, configDir, notifyConfig, envFile };
}

// Load notification configuration
async function loadNotifyConfig(configPath) {
  if (await fs.pathExists(configPath)) {
    const config = await fs.readJson(configPath);
    // Check if deployment alerts field exists
    if (config.alerts && config.alerts.deployment === undefined) {
      config.alerts.deployment = true; // Enable by default
    }
    return config;
  }
  return {
    version: '1.0',
    channels: {
      whatsapp: { enabled: false, target: '' },
      discord: { enabled: false, webhook: '' },
      slack: { enabled: false, webhook: '' },
      telegram: { enabled: false, token: '', chatId: '' },
    },
    alerts: {
      serviceDown: true,
      sslExpiring: true,
      highCost: true,
      securityThreat: true,
      deployment: true, // New: deployment notifications enabled by default
    },
  };
}

// Load .env file
async function loadEnv(envPath) {
  if (!await fs.pathExists(envPath)) {
    return {};
  }

  const content = await fs.readFile(envPath, 'utf8');
  const env = {};

  content.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      env[match[1].trim()] = match[2].trim();
    }
  });

  return env;
}

// Check if alert webhook is running
async function isWebhookRunning(infraDir) {
  try {
    const env = await loadEnv(path.join(infraDir, '.env'));
    const port = env.ALERT_WEBHOOK_PORT || '8080';
    
    // Quick check if webhook responds
    await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

// Send deployment notification
async function sendDeploymentNotification(infraDir, type, details = {}) {
  const paths = await getNotifyConfigPaths();
  if (!paths) return false;

  const config = await loadNotifyConfig(paths.notifyConfig);
  const env = await loadEnv(paths.envFile);

  // Check if deployment notifications are enabled
  if (!config.alerts.deployment) {
    return false;
  }

  // Check if any channel is enabled
  const hasEnabledChannel = Object.values(config.channels).some(c => c.enabled);
  if (!hasEnabledChannel) {
    return false;
  }

  // Check if webhook is running
  if (!await isWebhookRunning(infraDir)) {
    // Try to start it
    try {
      const scriptPath = path.join(infraDir, 'scripts', 'alert-webhook.sh');
      execSync(`${scriptPath} start`, { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      return false;
    }
  }

  const port = env.ALERT_WEBHOOK_PORT || '8080';
  const { version, color, duration, error, initiator } = details;

  // Build notification based on type
  let summary, description, severity;
  
  switch (type) {
    case 'started':
      severity = 'info';
      summary = '🚀 Deployment Started';
      description = `Deploying MasterClaw${version ? ` v${version}` : ''}${color ? ` (${color})` : ''}${initiator ? ` by ${initiator}` : ''}`;
      break;
    case 'success':
      severity = 'resolved';
      summary = '✅ Deployment Successful';
      description = `MasterClaw deployment completed successfully${version ? ` (v${version})` : ''}${color ? ` on ${color}` : ''}${duration ? ` in ${duration}` : ''}`;
      break;
    case 'failed':
      severity = 'critical';
      summary = '❌ Deployment Failed';
      description = `MasterClaw deployment failed${version ? ` (v${version})` : ''}${color ? ` on ${color}` : ''}${error ? `: ${error}` : ''}${duration ? ` after ${duration}` : ''}`;
      break;
    case 'rolled_back':
      severity = 'warning';
      summary = '↩️ Deployment Rolled Back';
      description = `Rolled back to previous version${duration ? ` in ${duration}` : ''}`;
      break;
    default:
      severity = 'info';
      summary = 'Deployment Update';
      description = 'Deployment status update';
  }

  const payload = {
    version: '4',
    status: type === 'success' || type === 'rolled_back' ? 'resolved' : 'firing',
    alerts: [{
      status: type === 'success' || type === 'rolled_back' ? 'resolved' : 'firing',
      labels: {
        alertname: 'DeploymentNotification',
        severity: severity,
        instance: 'masterclaw',
        deployment_type: type,
      },
      annotations: {
        summary: summary,
        description: description,
      },
      startsAt: new Date().toISOString(),
    }],
  };

  try {
    await axios.post(`http://localhost:${port}/alerts`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });
    return true;
  } catch (err) {
    // Silently fail - don't break deployment for notification failures
    return false;
  }
}

// Execute deployment script with notifications
async function runDeployScriptWithNotifications(args = '', options = {}) {
  const infraDir = findInfraDir();

  if (!infraDir) {
    console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
    console.log(chalk.gray('Set MASTERCLAW_INFRA environment variable or run from infra directory'));
    process.exit(1);
  }

  const scriptPath = path.join(infraDir, 'scripts', 'deploy-zero-downtime.sh');

  if (!fs.existsSync(scriptPath)) {
    console.error(chalk.red('❌ Deployment script not found'));
    console.log(chalk.gray(`Expected: ${scriptPath}`));
    process.exit(1);
  }

  // Get deployment details
  const stateFile = path.join(infraDir, '.deployments', 'state.json');
  let currentVersion = 'unknown';
  let currentColor = 'unknown';
  
  if (await fs.pathExists(stateFile)) {
    try {
      const state = await fs.readJson(stateFile);
      currentVersion = state.version || 'unknown';
      currentColor = state.active_color || 'unknown';
    } catch {
      // ignore
    }
  }

  const startTime = Date.now();
  const initiator = process.env.USER || 'unknown';

  // Send start notification
  await sendDeploymentNotification(infraDir, 'started', {
    version: currentVersion,
    color: currentColor,
    initiator,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args.split(' ').filter(Boolean), {
      cwd: infraDir,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    child.on('close', async (code) => {
      const duration = formatDuration(Date.now() - startTime);
      
      if (code === 0) {
        // Success
        const isRollback = args.includes('--rollback');
        await sendDeploymentNotification(infraDir, isRollback ? 'rolled_back' : 'success', {
          version: currentVersion,
          color: currentColor,
          duration,
        });
        resolve(code);
      } else {
        // Failure
        await sendDeploymentNotification(infraDir, 'failed', {
          version: currentVersion,
          color: currentColor,
          duration,
          error: `Exit code ${code}`,
        });
        reject(new Error(`Deployment failed with exit code ${code}`));
      }
    });

    child.on('error', async (err) => {
      const duration = formatDuration(Date.now() - startTime);
      await sendDeploymentNotification(infraDir, 'failed', {
        version: currentVersion,
        color: currentColor,
        duration,
        error: err.message,
      });
      reject(err);
    });
  });
}

// Format duration in human-readable format
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// Legacy execute deployment script (for backwards compatibility)
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
    console.log(chalk.gray(`Expected: ${scriptPath}`));
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
  .option('--notify', 'Send deployment notifications (requires configured channels)')
  .action(async (options) => {
    console.log(chalk.blue('🚀 Starting zero-downtime deployment...\n'));

    let args = '';
    if (options.force) args += ' --force';
    if (options.skipTests) args += ' --skip-tests';

    if (options.notify) {
      try {
        await runDeployScriptWithNotifications(args);
      } catch {
        process.exit(1);
      }
    } else {
      runDeployScript(args);
    }
  });

// Canary deployment
deploy
  .command('canary <percent>')
  .description('Deploy canary version to percentage of traffic (1-100)')
  .option('-f, --force', 'Force deployment even if tests fail')
  .option('--notify', 'Send deployment notifications')
  .action(async (percent, options) => {
    const pct = parseInt(percent, 10);
    if (isNaN(pct) || pct < 1 || pct > 100) {
      console.error(chalk.red('❌ Percentage must be between 1 and 100'));
      process.exit(1);
    }

    console.log(chalk.blue(`🚀 Starting canary deployment (${pct}% traffic)...\n`));

    let args = `--canary ${pct}`;
    if (options.force) args += ' --force';

    if (options.notify) {
      try {
        await runDeployScriptWithNotifications(args);
      } catch {
        process.exit(1);
      }
    } else {
      runDeployScript(args);
    }
  });

// Rollback
deploy
  .command('rollback')
  .description('Rollback to previous deployment version')
  .option('--notify', 'Send deployment notifications')
  .action(async (options) => {
    console.log(chalk.yellow('🔄 Rolling back to previous version...\n'));
    
    if (options.notify) {
      try {
        await runDeployScriptWithNotifications('--rollback');
      } catch {
        process.exit(1);
      }
    } else {
      runDeployScript('--rollback');
    }
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

// =============================================================================
// Deployment Notifications Configuration
// =============================================================================

deploy
  .command('notify')
  .description('Configure deployment notifications')
  .option('--enable', 'Enable deployment notifications')
  .option('--disable', 'Disable deployment notifications')
  .option('--status', 'Show deployment notification status')
  .action(async (options) => {
    const paths = await getNotifyConfigPaths();
    
    if (!paths) {
      console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    const config = await loadNotifyConfig(paths.notifyConfig);
    const env = await loadEnv(paths.envFile);

    // Show status if no options provided
    if (!options.enable && !options.disable) {
      console.log(chalk.blue('🐾 Deployment Notifications\n'));
      
      const enabled = config.alerts.deployment;
      const icon = enabled ? chalk.green('✅') : chalk.gray('○');
      console.log(`${icon} Deployment notifications: ${enabled ? chalk.green('enabled') : chalk.gray('disabled')}`);
      
      // Show channel status
      console.log(chalk.cyan('\nConfigured Channels:'));
      const channels = ['whatsapp', 'discord', 'slack', 'telegram'];
      let hasEnabled = false;
      
      for (const channel of channels) {
        const ch = config.channels[channel];
        const envKey = `ALERT_NOTIFY_${channel.toUpperCase()}`;
        const isConfigured = ch.enabled && (ch.webhook || ch.target || (ch.token && ch.chatId) || env[envKey]);
        if (isConfigured) {
          hasEnabled = true;
          console.log(`  ${chalk.green('●')} ${channel.charAt(0).toUpperCase() + channel.slice(1)}`);
        }
      }
      
      if (!hasEnabled) {
        console.log(chalk.yellow('  ⚠️  No notification channels configured'));
        console.log(chalk.gray('     Run: mc notify config <channel> to set up'));
      }

      console.log(chalk.gray('\nUsage:'));
      console.log(chalk.gray('  mc deploy rolling --notify    # Deploy with notifications'));
      console.log(chalk.gray('  mc deploy notify --enable     # Enable deployment notifications'));
      console.log(chalk.gray('  mc deploy notify --disable    # Disable deployment notifications'));
      return;
    }

    if (options.enable) {
      config.alerts.deployment = true;
      await fs.ensureDir(paths.configDir);
      await fs.writeJson(paths.notifyConfig, config, { spaces: 2 });
      console.log(chalk.green('✅ Deployment notifications enabled'));
      console.log(chalk.gray('   Use --notify flag with deploy commands to send notifications'));
      console.log(chalk.gray('   Example: mc deploy rolling --notify'));
    }

    if (options.disable) {
      config.alerts.deployment = false;
      await fs.ensureDir(paths.configDir);
      await fs.writeJson(paths.notifyConfig, config, { spaces: 2 });
      console.log(chalk.yellow('○ Deployment notifications disabled'));
    }
  });

// Test deployment notification
deploy
  .command('notify-test')
  .description('Send a test deployment notification')
  .action(async () => {
    const infraDir = findInfraDir();
    
    if (!infraDir) {
      console.error(chalk.red('❌ Could not find masterclaw-infrastructure directory'));
      process.exit(1);
    }

    console.log(chalk.blue('🧪 Sending test deployment notification...\n'));

    const sent = await sendDeploymentNotification(infraDir, 'started', {
      version: 'test',
      color: 'blue',
      initiator: process.env.USER || 'test',
    });

    if (sent) {
      console.log(chalk.green('✅ Test notification sent!'));
      console.log(chalk.gray('   Check your configured notification channels'));
    } else {
      console.log(chalk.yellow('⚠️  Could not send notification'));
      console.log(chalk.gray('   Ensure:'));
      console.log(chalk.gray('     1. At least one notification channel is configured (mc notify config)'));
      console.log(chalk.gray('     2. Deployment notifications are enabled (mc deploy notify --enable)'));
      console.log(chalk.gray('     3. Alert webhook is running (mc notify start)'));
    }
  });

module.exports = deploy;
