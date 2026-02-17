/**
 * Notification management for MasterClaw CLI
 * Provides commands to configure and test alert notifications
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const ora = require('ora');

const { findInfraDir } = require('./services');

const program = new Command('notify');

// Default config paths
async function getConfigPaths() {
  const infraDir = await findInfraDir() || process.cwd();
  const configDir = path.join(infraDir, 'config');
  await fs.ensureDir(configDir);
  
  return {
    infraDir,
    configDir,
    notifyConfig: path.join(configDir, 'notifications.json'),
    envFile: path.join(infraDir, '.env'),
  };
}

// Load notification configuration
async function loadConfig(configPath) {
  if (await fs.pathExists(configPath)) {
    return fs.readJson(configPath);
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
    },
  };
}

// Save notification configuration
async function saveConfig(configPath, config) {
  await fs.writeJson(configPath, config, { spaces: 2 });
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

// Save environment variables to .env
async function saveEnv(envPath, env) {
  let content = '';
  
  // Read existing content to preserve comments and order
  if (await fs.pathExists(envPath)) {
    content = await fs.readFile(envPath, 'utf8');
  }
  
  // Update or add new values
  for (const [key, value] of Object.entries(env)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const newLine = `${key}=${value}`;
    
    if (regex.test(content)) {
      content = content.replace(regex, newLine);
    } else {
      content += `\n${newLine}`;
    }
  }
  
  await fs.writeFile(envPath, content.trim() + '\n');
}

// Check if alert webhook is running
async function isWebhookRunning() {
  try {
    const pidFile = '/tmp/masterclaw-alert-webhook.pid';
    if (await fs.pathExists(pidFile)) {
      const pid = await fs.readFile(pidFile, 'utf8');
      process.kill(parseInt(pid.trim()), 0); // Check if process exists
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

// =============================================================================
// Status Command
// =============================================================================

program
  .command('status')
  .description('Show notification status and configuration')
  .option('-j, --json', 'output as JSON')
  .action(async (options) => {
    const paths = await getConfigPaths();
    const config = await loadConfig(paths.notifyConfig);
    const env = await loadEnv(paths.envFile);
    const webhookRunning = await isWebhookRunning();
    
    // Build status object
    const status = {
      webhook: {
        running: webhookRunning,
        port: env.ALERT_WEBHOOK_PORT || '8080 (default)',
      },
      channels: {
        whatsapp: {
          enabled: config.channels.whatsapp.enabled,
          configured: !!env.ALERT_NOTIFY_WHATSAPP,
          target: config.channels.whatsapp.target || env.ALERT_NOTIFY_WHATSAPP || null,
        },
        discord: {
          enabled: config.channels.discord.enabled,
          configured: !!env.ALERT_NOTIFY_DISCORD,
          hasWebhook: !!config.channels.discord.webhook || !!env.ALERT_NOTIFY_DISCORD,
        },
        slack: {
          enabled: config.channels.slack.enabled,
          configured: !!env.ALERT_NOTIFY_SLACK,
          hasWebhook: !!config.channels.slack.webhook || !!env.ALERT_NOTIFY_SLACK,
        },
        telegram: {
          enabled: config.channels.telegram.enabled,
          configured: !!env.ALERT_NOTIFY_TELEGRAM,
          hasToken: !!(config.channels.telegram.token && config.channels.telegram.chatId) ||
                    !!(env.ALERT_NOTIFY_TELEGRAM && env.ALERT_NOTIFY_TELEGRAM.includes(':')),
        },
      },
      alerts: config.alerts,
    };
    
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    
    console.log(chalk.blue('🐾 MasterClaw Notification Status\n'));
    
    // Webhook status
    const webhookIcon = webhookRunning ? chalk.green('●') : chalk.red('●');
    console.log(`${webhookIcon} Alert Webhook: ${webhookRunning ? chalk.green('Running') : chalk.red('Stopped')}`);
    if (webhookRunning) {
      console.log(chalk.gray(`   Port: ${status.webhook.port}`));
    } else {
      console.log(chalk.gray('   Run: mc notify start'));
    }
    console.log();
    
    // Channel status
    console.log(chalk.cyan('Notification Channels:\n'));
    
    const channels = [
      ['WhatsApp', status.channels.whatsapp],
      ['Discord', status.channels.discord],
      ['Slack', status.channels.slack],
      ['Telegram', status.channels.telegram],
    ];
    
    for (const [name, channel] of channels) {
      const enabledIcon = channel.enabled ? chalk.green('✅') : chalk.gray('○');
      const configuredIcon = channel.configured ? chalk.green('✓') : chalk.yellow('○');
      const statusText = channel.enabled 
        ? (channel.configured ? chalk.green('enabled') : chalk.yellow('enabled (not configured)'))
        : chalk.gray('disabled');
      
      console.log(`  ${enabledIcon} ${chalk.bold(name)}: ${statusText}`);
      if (channel.enabled && !channel.configured) {
        console.log(chalk.gray(`     Run: mc notify config ${name.toLowerCase()}`));
      }
    }
    
    console.log();
    
    // Alert types
    console.log(chalk.cyan('Active Alert Types:'));
    for (const [alert, enabled] of Object.entries(status.alerts)) {
      const icon = enabled ? chalk.green('✓') : chalk.gray('○');
      const name = alert.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      console.log(`  ${icon} ${name}`);
    }
    
    console.log();
    
    // Summary
    const enabledChannels = Object.values(status.channels).filter(c => c.enabled).length;
    const configuredChannels = Object.values(status.channels).filter(c => c.configured).length;
    
    if (enabledChannels === 0) {
      console.log(chalk.yellow('⚠️  No notification channels enabled'));
      console.log(chalk.gray('   Run: mc notify enable <channel>'));
    } else if (configuredChannels < enabledChannels) {
      console.log(chalk.yellow(`⚠️  ${enabledChannels - configuredChannels} enabled channel(s) need configuration`));
    } else {
      console.log(chalk.green(`✅ ${enabledChannels} channel(s) enabled and configured`));
    }
  });

// =============================================================================
// Start/Stop Commands
// =============================================================================

program
  .command('start')
  .description('Start the alert webhook server')
  .option('-p, --port <port>', 'port to listen on', '8080')
  .action(async (options) => {
    const paths = await getConfigPaths();
    
    // Update port in .env if different
    const env = await loadEnv(paths.envFile);
    if (options.port && options.port !== env.ALERT_WEBHOOK_PORT) {
      env.ALERT_WEBHOOK_PORT = options.port;
      await saveEnv(paths.envFile, env);
    }
    
    try {
      const scriptPath = path.join(paths.infraDir, 'scripts', 'alert-webhook.sh');
      if (!await fs.pathExists(scriptPath)) {
        console.log(chalk.red('❌ Alert webhook script not found'));
        console.log(chalk.gray(`   Expected: ${scriptPath}`));
        process.exit(1);
      }
      
      execSync(`${scriptPath} start`, { stdio: 'inherit' });
    } catch (err) {
      console.log(chalk.red(`❌ Failed to start webhook: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the alert webhook server')
  .action(async () => {
    try {
      const paths = await getConfigPaths();
      const scriptPath = path.join(paths.infraDir, 'scripts', 'alert-webhook.sh');
      execSync(`${scriptPath} stop`, { stdio: 'inherit' });
    } catch (err) {
      console.log(chalk.red(`❌ Failed to stop webhook: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('restart')
  .description('Restart the alert webhook server')
  .action(async () => {
    const paths = await getConfigPaths();
    const scriptPath = path.join(paths.infraDir, 'scripts', 'alert-webhook.sh');
    
    try {
      execSync(`${scriptPath} restart`, { stdio: 'inherit' });
    } catch (err) {
      console.log(chalk.red(`❌ Failed to restart webhook: ${err.message}`));
      process.exit(1);
    }
  });

// =============================================================================
// Channel Configuration Commands
// =============================================================================

program
  .command('config <channel>')
  .description('Configure a notification channel (whatsapp, discord, slack, telegram)')
  .option('-w, --webhook <url>', 'webhook URL (Discord/Slack)')
  .option('-t, --token <token>', 'bot token (Telegram)')
  .option('-c, --chat-id <id>', 'chat ID (Telegram)')
  .option('-n, --number <number>', 'phone number (WhatsApp)')
  .action(async (channel, options) => {
    const validChannels = ['whatsapp', 'discord', 'slack', 'telegram'];
    
    if (!validChannels.includes(channel)) {
      console.log(chalk.red(`❌ Unknown channel: ${channel}`));
      console.log(chalk.gray(`   Valid channels: ${validChannels.join(', ')}`));
      process.exit(1);
    }
    
    const paths = await getConfigPaths();
    const config = await loadConfig(paths.notifyConfig);
    const env = await loadEnv(paths.envFile);
    
    let envKey = '';
    let envValue = '';
    
    switch (channel) {
      case 'whatsapp':
        if (!options.number) {
          console.log(chalk.red('❌ WhatsApp requires --number'));
          console.log(chalk.gray('   Example: mc notify config whatsapp --number "+1234567890"'));
          process.exit(1);
        }
        config.channels.whatsapp.target = options.number;
        config.channels.whatsapp.enabled = true;
        envKey = 'ALERT_NOTIFY_WHATSAPP';
        envValue = options.number;
        break;
        
      case 'discord':
        if (!options.webhook) {
          console.log(chalk.red('❌ Discord requires --webhook'));
          console.log(chalk.gray('   Example: mc notify config discord --webhook "https://discord.com/api/webhooks/..."'));
          process.exit(1);
        }
        config.channels.discord.webhook = options.webhook;
        config.channels.discord.enabled = true;
        envKey = 'ALERT_NOTIFY_DISCORD';
        envValue = options.webhook;
        break;
        
      case 'slack':
        if (!options.webhook) {
          console.log(chalk.red('❌ Slack requires --webhook'));
          console.log(chalk.gray('   Example: mc notify config slack --webhook "https://hooks.slack.com/services/..."'));
          process.exit(1);
        }
        config.channels.slack.webhook = options.webhook;
        config.channels.slack.enabled = true;
        envKey = 'ALERT_NOTIFY_SLACK';
        envValue = options.webhook;
        break;
        
      case 'telegram':
        if (!options.token || !options.chatId) {
          console.log(chalk.red('❌ Telegram requires --token and --chat-id'));
          console.log(chalk.gray('   Example: mc notify config telegram --token "123456:ABC..." --chat-id "-1001234567890"'));
          process.exit(1);
        }
        config.channels.telegram.token = options.token;
        config.channels.telegram.chatId = options.chatId;
        config.channels.telegram.enabled = true;
        envKey = 'ALERT_NOTIFY_TELEGRAM';
        envValue = `${options.token}:${options.chatId}`;
        break;
    }
    
    // Save config
    await saveConfig(paths.notifyConfig, config);
    
    // Save to .env
    if (envKey && envValue) {
      env[envKey] = envValue;
      await saveEnv(paths.envFile, env);
    }
    
    console.log(chalk.green(`✅ ${channel.charAt(0).toUpperCase() + channel.slice(1)} configured successfully`));
    console.log(chalk.gray(`   Run: mc notify test ${channel}`));
  });

// =============================================================================
// Enable/Disable Commands
// =============================================================================

program
  .command('enable <channel>')
  .description('Enable a notification channel')
  .action(async (channel) => {
    const paths = await getConfigPaths();
    const config = await loadConfig(paths.notifyConfig);
    
    if (!config.channels[channel]) {
      console.log(chalk.red(`❌ Unknown channel: ${channel}`));
      process.exit(1);
    }
    
    config.channels[channel].enabled = true;
    await saveConfig(paths.notifyConfig, config);
    
    console.log(chalk.green(`✅ ${channel} notifications enabled`));
  });

program
  .command('disable <channel>')
  .description('Disable a notification channel')
  .action(async (channel) => {
    const paths = await getConfigPaths();
    const config = await loadConfig(paths.notifyConfig);
    
    if (!config.channels[channel]) {
      console.log(chalk.red(`❌ Unknown channel: ${channel}`));
      process.exit(1);
    }
    
    config.channels[channel].enabled = false;
    await saveConfig(paths.notifyConfig, config);
    
    console.log(chalk.yellow(`○ ${channel} notifications disabled`));
  });

// =============================================================================
// Test Command
// =============================================================================

program
  .command('test [channel]')
  .description('Send a test notification to a specific channel or all enabled channels')
  .option('-m, --message <text>', 'custom test message')
  .option('-s, --severity <level>', 'severity level (critical, warning, resolved)', 'warning')
  .action(async (channel, options) => {
    const paths = await getConfigPaths();
    const env = await loadEnv(paths.envFile);
    
    // Check if webhook is running
    if (!await isWebhookRunning()) {
      console.log(chalk.yellow('⚠️  Alert webhook is not running'));
      console.log(chalk.gray('   Starting it now...'));
      try {
        const scriptPath = path.join(paths.infraDir, 'scripts', 'alert-webhook.sh');
        execSync(`${scriptPath} start`, { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 1500)); // Wait for startup
      } catch (err) {
        console.log(chalk.red('❌ Failed to start webhook'));
        process.exit(1);
      }
    }
    
    const message = options.message || '🧪 This is a test notification from MasterClaw!';
    const severity = options.severity;
    
    const spinner = ora(`Sending test notification...`).start();
    
    try {
      const scriptPath = path.join(paths.infraDir, 'scripts', 'alert-webhook.sh');
      
      if (channel) {
        // Test specific channel by sending to webhook which will dispatch
        const testPayload = JSON.stringify({
          version: '4',
          status: 'firing',
          alerts: [{
            status: 'firing',
            labels: {
              alertname: 'TestNotification',
              severity: severity,
              instance: 'test',
              channel: channel,
            },
            annotations: {
              summary: message,
              description: `Testing ${channel} notifications`,
            },
            startsAt: new Date().toISOString(),
          }],
        });
        
        execSync(`curl -s -X POST http://localhost:${env.ALERT_WEBHOOK_PORT || 8080}/alerts \\
          -H "Content-Type: application/json" \\
          -d '${testPayload}'`, { stdio: 'ignore' });
        
        spinner.succeed(`Test notification sent to ${channel}`);
      } else {
        // Test all enabled channels
        execSync(`${scriptPath} test ${severity}`, { stdio: 'ignore' });
        spinner.succeed('Test notifications sent to all enabled channels');
      }
      
      console.log(chalk.green('✅ Check your notification channels for the test message'));
    } catch (err) {
      spinner.fail(`Failed to send test notification: ${err.message}`);
      process.exit(1);
    }
  });

// =============================================================================
// Alert Types Configuration
// =============================================================================

program
  .command('alerts')
  .description('Configure which alert types to receive')
  .option('--enable <type>', 'enable specific alert type')
  .option('--disable <type>', 'disable specific alert type')
  .option('--list', 'list all alert types')
  .action(async (options) => {
    const paths = await getConfigPaths();
    const config = await loadConfig(paths.notifyConfig);
    
    const validTypes = ['serviceDown', 'sslExpiring', 'highCost', 'securityThreat'];
    
    if (options.list || (!options.enable && !options.disable)) {
      console.log(chalk.blue('🐾 Available Alert Types\n'));
      
      const descriptions = {
        serviceDown: 'When services go down or become unhealthy',
        sslExpiring: 'When SSL certificates are expiring soon',
        highCost: 'When LLM usage costs exceed thresholds',
        securityThreat: 'When security threats are detected',
      };
      
      for (const type of validTypes) {
        const enabled = config.alerts[type];
        const icon = enabled ? chalk.green('✅') : chalk.gray('○');
        console.log(`  ${icon} ${type.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}`);
        console.log(chalk.gray(`     ${descriptions[type]}`));
      }
      
      console.log();
      console.log(chalk.gray('Enable/disable with: mc notify alerts --enable <type> / --disable <type>'));
      return;
    }
    
    if (options.enable) {
      if (!validTypes.includes(options.enable)) {
        console.log(chalk.red(`❌ Unknown alert type: ${options.enable}`));
        console.log(chalk.gray(`   Valid types: ${validTypes.join(', ')}`));
        process.exit(1);
      }
      config.alerts[options.enable] = true;
      await saveConfig(paths.notifyConfig, config);
      console.log(chalk.green(`✅ ${options.enable} alerts enabled`));
    }
    
    if (options.disable) {
      if (!validTypes.includes(options.disable)) {
        console.log(chalk.red(`❌ Unknown alert type: ${options.disable}`));
        console.log(chalk.gray(`   Valid types: ${validTypes.join(', ')}`));
        process.exit(1);
      }
      config.alerts[options.disable] = false;
      await saveConfig(paths.notifyConfig, config);
      console.log(chalk.yellow(`○ ${options.disable} alerts disabled`));
    }
  });

module.exports = program;
