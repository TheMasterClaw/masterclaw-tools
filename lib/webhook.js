/**
 * Webhook Management Module for MasterClaw CLI
 *
 * Manage GitHub webhook integration from the command line:
 * - Check webhook status and configuration
 * - Test webhook connectivity
 * - View recent webhook deliveries
 * - Generate webhook secrets
 * - Configure webhook events
 *
 * Security:
 * - Secrets are generated with cryptographically secure random
 * - Configuration is written to .env with secure permissions
 * - Audit logging for all webhook configuration changes
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const crypto = require('crypto');
const { Command } = require('commander');
const axios = require('axios');
const { findInfraDir } = require('./services');
const { logAudit, AuditEventType } = require('./audit');
const httpClient = require('./http-client');

const program = new Command('webhook');

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a cryptographically secure webhook secret
 * @returns {string} Secure random string
 */
function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Load environment variables from .env file
 * @param {string} infraDir - Infrastructure directory
 * @returns {Object} Environment variables
 */
async function loadEnv(infraDir) {
  const envPath = path.join(infraDir, '.env');
  const env = {};
  
  if (await fs.pathExists(envPath)) {
    const content = await fs.readFile(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match && !line.startsWith('#')) {
        env[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  
  return env;
}

/**
 * Save environment variables to .env file
 * @param {string} infraDir - Infrastructure directory
 * @param {Object} env - Environment variables
 */
async function saveEnv(infraDir, env) {
  const envPath = path.join(infraDir, '.env');
  
  // Read existing content to preserve comments
  let content = '';
  if (await fs.pathExists(envPath)) {
    content = await fs.readFile(envPath, 'utf8');
  }
  
  // Update or add each variable
  for (const [key, value] of Object.entries(env)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const newLine = `${key}=${value}`;
    
    if (pattern.test(content)) {
      content = content.replace(pattern, newLine);
    } else {
      content += `\n${newLine}`;
    }
  }
  
  // Write with secure permissions
  await fs.writeFile(envPath, content.trim() + '\n', { mode: 0o600 });
}

/**
 * Get the API URL from environment
 * @param {string} infraDir - Infrastructure directory
 * @returns {string} API URL
 */
async function getApiUrl(infraDir) {
  const env = await loadEnv(infraDir);
  const domain = env.DOMAIN || 'localhost';
  
  if (domain === 'localhost') {
    return 'http://localhost:8000';
  }
  
  return `https://api.${domain}`;
}

// =============================================================================
// Commands
// =============================================================================

// Status command
program
  .command('status')
  .description('Check GitHub webhook configuration status')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const infraDir = await findInfraDir() || process.cwd();
    const env = await loadEnv(infraDir);
    
    try {
      const apiUrl = await getApiUrl(infraDir);
      const response = await httpClient.get(`${apiUrl}/webhooks/github`);
      
      if (options.json) {
        console.log(JSON.stringify(response.data, null, 2));
        return;
      }
      
      const status = response.data;
      
      console.log(chalk.blue('🔗 GitHub Webhook Status\n'));
      
      // Overall status
      if (status.enabled) {
        console.log(chalk.green('✅ Webhooks are enabled'));
      } else {
        console.log(chalk.yellow('⚠️  Webhooks not configured'));
        console.log(chalk.gray('   Run: mc webhook setup'));
      }
      
      console.log('');
      console.log(chalk.cyan('Configuration:'));
      console.log(`  Secret configured: ${status.secret_configured ? chalk.green('Yes') : chalk.red('No')}`);
      console.log(`  Allowed events: ${status.allowed_events.join(', ')}`);
      console.log(`  Endpoint: ${status.endpoint_url}`);
      
      if (status.documentation) {
        console.log(`  Docs: ${status.documentation}`);
      }
      
      // Show configuration instructions if not enabled
      if (!status.enabled) {
        console.log('');
        console.log(chalk.cyan('Setup Instructions:'));
        console.log('  1. Run: mc webhook setup');
        console.log('  2. Copy the generated secret');
        console.log('  3. Go to GitHub repository → Settings → Webhooks');
        console.log('  4. Add webhook with the endpoint URL above');
      }
      
    } catch (err) {
      if (options.json) {
        console.log(JSON.stringify({ error: err.message }, null, 2));
        return;
      }
      
      console.log(chalk.red(`❌ Failed to check webhook status: ${err.message}`));
      
      if (err.code === 'ECONNREFUSED') {
        console.log(chalk.gray('   MasterClaw Core may not be running'));
        console.log(chalk.gray('   Run: mc revive'));
      }
      
      process.exit(1);
    }
  });

// Setup command
program
  .command('setup')
  .description('Set up GitHub webhook integration')
  .option('-s, --secret <secret>', 'Use specific secret (or auto-generate)')
  .option('-e, --events <events>', 'Comma-separated list of events', 'push,pull_request,workflow_run,release')
  .option('--skip-env', 'Skip writing to .env file')
  .action(async (options) => {
    const infraDir = await findInfraDir() || process.cwd();
    
    console.log(chalk.blue('🔗 GitHub Webhook Setup\n'));
    
    // Generate or use provided secret
    const secret = options.secret || generateWebhookSecret();
    const events = options.events;
    
    console.log(chalk.cyan('Generated Configuration:'));
    console.log(`  GITHUB_WEBHOOK_SECRET=${secret.substring(0, 8)}...${secret.substring(-8)}`);
    console.log(`  GITHUB_WEBHOOK_EVENTS=${events}`);
    console.log('');
    
    // Update .env file
    if (!options.skipEnv) {
      const env = await loadEnv(infraDir);
      env.GITHUB_WEBHOOK_SECRET = secret;
      env.GITHUB_WEBHOOK_EVENTS = events;
      await saveEnv(infraDir, env);
      
      console.log(chalk.green('✅ Configuration saved to .env'));
      
      // Audit log
      await logAudit(AuditEventType.CONFIG_CHANGE, {
        command: 'webhook setup',
        events: events.split(','),
      });
    }
    
    // Get API URL for webhook configuration
    const apiUrl = await getApiUrl(infraDir);
    const webhookUrl = `${apiUrl}/webhooks/github`;
    
    console.log('');
    console.log(chalk.cyan('GitHub Webhook Configuration:'));
    console.log(`  Payload URL: ${webhookUrl}`);
    console.log(`  Content type: application/json`);
    console.log(`  Secret: ${secret}`);
    console.log(`  Events: ${events.split(',').join(', ')}`);
    console.log('');
    console.log(chalk.yellow('⚠️  Important: Restart MasterClaw Core to apply changes'));
    console.log(chalk.gray('   Run: mc revive'));
  });

// Test command
program
  .command('test')
  .description('Test webhook endpoint connectivity')
  .option('--secret <secret>', 'Override webhook secret')
  .option('--event <event>', 'Test event type', 'ping')
  .option('--payload <payload>', 'Custom payload (JSON)')
  .action(async (options) => {
    const infraDir = await findInfraDir() || process.cwd();
    const env = await loadEnv(infraDir);
    
    console.log(chalk.blue('🧪 Testing GitHub Webhook\n'));
    
    const secret = options.secret || env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.log(chalk.red('❌ No webhook secret configured'));
      console.log(chalk.gray('   Run: mc webhook setup'));
      process.exit(1);
    }
    
    const apiUrl = await getApiUrl(infraDir);
    const webhookUrl = `${apiUrl}/webhooks/github`;
    
    // Build test payload
    let payload;
    if (options.payload) {
      try {
        payload = JSON.parse(options.payload);
      } catch (err) {
        console.log(chalk.red(`❌ Invalid JSON payload: ${err.message}`));
        process.exit(1);
      }
    } else {
      payload = {
        zen: 'Keep it logically awesome.',
        hook_id: 12345,
        repository: {
          full_name: 'test/repo',
        },
      };
    }
    
    const payloadBody = JSON.stringify(payload);
    
    // Generate signature
    const signature = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(payloadBody)
      .digest('hex');
    
    console.log(chalk.cyan('Sending test webhook:'));
    console.log(`  URL: ${webhookUrl}`);
    console.log(`  Event: ${options.event}`);
    console.log(`  Payload: ${payloadBody.substring(0, 100)}...`);
    console.log('');
    
    try {
      const response = await httpClient.post(webhookUrl, payload, {
        headers: {
          'X-GitHub-Event': options.event,
          'X-Hub-Signature-256': signature,
          'X-GitHub-Delivery': `test-${Date.now()}`,
          'Content-Type': 'application/json',
        },
      });
      
      console.log(chalk.green('✅ Webhook test successful'));
      console.log(chalk.gray(`   Status: ${response.status}`));
      console.log(chalk.gray(`   Response: ${JSON.stringify(response.data, null, 2)}`));
      
    } catch (err) {
      console.log(chalk.red('❌ Webhook test failed'));
      
      if (err.response) {
        console.log(chalk.gray(`   Status: ${err.response.status}`));
        console.log(chalk.gray(`   Response: ${JSON.stringify(err.response.data, null, 2)}`));
      } else {
        console.log(chalk.gray(`   Error: ${err.message}`));
      }
      
      process.exit(1);
    }
  });

// Generate secret command
program
  .command('generate-secret')
  .description('Generate a new webhook secret')
  .option('--copy', 'Copy to clipboard (if available)')
  .action(async (options) => {
    const secret = generateWebhookSecret();
    
    console.log(chalk.blue('🔑 Generated Webhook Secret\n'));
    console.log(secret);
    console.log('');
    console.log(chalk.yellow('⚠️  Save this secret securely!'));
    console.log(chalk.gray('   Set it in your .env file as GITHUB_WEBHOOK_SECRET'));
    console.log(chalk.gray('   And in your GitHub webhook configuration.'));
  });

// Configure events command
program
  .command('events')
  .description('Configure which GitHub events to process')
  .option('-l, --list', 'List supported events')
  .option('-s, --set <events>', 'Set events (comma-separated)')
  .action(async (options) => {
    const infraDir = await findInfraDir() || process.cwd();
    const env = await loadEnv(infraDir);
    
    const supportedEvents = [
      'push',
      'pull_request',
      'workflow_run',
      'workflow_job',
      'release',
    ];
    
    if (options.list) {
      console.log(chalk.blue('📋 Supported GitHub Events\n'));
      
      const currentEvents = (env.GITHUB_WEBHOOK_EVENTS || 'push,pull_request,workflow_run,release').split(',');
      
      for (const event of supportedEvents) {
        const isEnabled = currentEvents.includes(event);
        const icon = isEnabled ? chalk.green('✅') : chalk.gray('○');
        console.log(`  ${icon} ${event}`);
      }
      
      console.log('');
      console.log(chalk.gray('Enabled events are marked with ✅'));
      return;
    }
    
    if (options.set) {
      const events = options.set.split(',').map(e => e.trim());
      const invalidEvents = events.filter(e => !supportedEvents.includes(e));
      
      if (invalidEvents.length > 0) {
        console.log(chalk.red(`❌ Invalid events: ${invalidEvents.join(', ')}`));
        console.log(chalk.gray(`   Supported: ${supportedEvents.join(', ')}`));
        process.exit(1);
      }
      
      env.GITHUB_WEBHOOK_EVENTS = events.join(',');
      await saveEnv(infraDir, env);
      
      console.log(chalk.green('✅ Events updated'));
      console.log(chalk.gray(`   Processing: ${events.join(', ')}`));
      console.log('');
      console.log(chalk.yellow('⚠️  Restart MasterClaw Core to apply changes'));
      
      await logAudit(AuditEventType.CONFIG_CHANGE, {
        command: 'webhook events',
        events: events,
      });
      
      return;
    }
    
    // Default: show current events
    const currentEvents = (env.GITHUB_WEBHOOK_EVENTS || 'push,pull_request,workflow_run,release').split(',');
    console.log(chalk.blue('📋 Current GitHub Events\n'));
    console.log(`Processing: ${currentEvents.join(', ')}`);
    console.log('');
    console.log(chalk.gray('Use --set to change, --list to see all options'));
  });

module.exports = program;
module.exports.generateWebhookSecret = generateWebhookSecret;
module.exports.loadEnv = loadEnv;
module.exports.saveEnv = saveEnv;
module.exports.getApiUrl = getApiUrl;
