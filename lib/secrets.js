/**
 * Secrets Management Module for MasterClaw CLI
 * 
 * Provides secure secrets management across the ecosystem:
 * - Check: Validate required secrets are configured
 * - Set/Get: Securely manage secret values
 * - List: View configured secrets (masked)
 * - Rotate: Generate and rotate secrets
 * - Sync: Sync secrets between .env and CLI config
 * - Validate: Verify secrets work with their services
 * 
 * Security features:
 * - Secrets are never logged in plain text
 * - Masked display by default
 * - Secure file permissions (0o600)
 * - Validation before saving
 * - Support for external secret providers (future)
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { Command } = require('commander');

const { findInfraDir } = require('./services');
const { loadConfig, saveConfig, CONFIG_DIR } = require('./config');
const { logAudit } = require('./audit');
const { maskSensitiveData } = require('./security');

// Secrets file path
const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.json');

// Secure file permissions
const SECURE_FILE_MODE = 0o600;

// Required secrets for MasterClaw operation
const REQUIRED_SECRETS = [
  { key: 'GATEWAY_TOKEN', description: 'OpenClaw Gateway authentication token', required: true },
  { key: 'OPENAI_API_KEY', description: 'OpenAI API key for GPT models', required: false },
  { key: 'ANTHROPIC_API_KEY', description: 'Anthropic API key for Claude models', required: false },
];

// Secret validation patterns
const SECRET_PATTERNS = {
  GATEWAY_TOKEN: /^[a-zA-Z0-9_-]{16,}$/,
  OPENAI_API_KEY: /^sk-[a-zA-Z0-9]{48,}$/,
  ANTHROPIC_API_KEY: /^sk-ant-[a-zA-Z0-9]{32,}$/,
  DOMAIN: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i,
  ACME_EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};

// =============================================================================
// File Operations
// =============================================================================

/**
 * Ensure secrets file exists with secure permissions
 */
async function ensureSecretsFile() {
  await fs.ensureDir(CONFIG_DIR);
  
  if (!(await fs.pathExists(SECRETS_FILE))) {
    await fs.writeJson(SECRETS_FILE, {}, { spaces: 2 });
  }
  
  // Ensure secure permissions
  try {
    await fs.chmod(SECRETS_FILE, SECURE_FILE_MODE);
  } catch (err) {
    // Non-fatal, but log warning
    console.warn(chalk.yellow(`Warning: Could not set secure permissions on secrets file: ${err.message}`));
  }
}

/**
 * Load secrets from file
 */
async function loadSecrets() {
  await ensureSecretsFile();
  
  try {
    const secrets = await fs.readJson(SECRETS_FILE);
    return secrets || {};
  } catch (err) {
    console.error(chalk.red(`Error reading secrets file: ${err.message}`));
    return {};
  }
}

/**
 * Save secrets to file with secure permissions
 */
async function saveSecrets(secrets) {
  await ensureSecretsFile();
  await fs.writeJson(SECRETS_FILE, secrets, { spaces: 2 });
  
  try {
    await fs.chmod(SECRETS_FILE, SECURE_FILE_MODE);
  } catch (err) {
    console.warn(chalk.yellow(`Warning: Could not set secure permissions: ${err.message}`));
  }
}

// =============================================================================
// Secret Operations
// =============================================================================

/**
 * Set a secret value
 */
async function setSecret(key, value, options = {}) {
  const { skipValidation = false, source = 'cli' } = options;
  
  // Validate key name
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid secret key name: ${key}. Use UPPER_SNAKE_CASE format.`);
  }
  
  // Validate value if pattern exists
  if (!skipValidation && SECRET_PATTERNS[key]) {
    if (!SECRET_PATTERNS[key].test(value)) {
      throw new Error(`Invalid format for ${key}. Expected pattern: ${SECRET_PATTERNS[key]}`);
    }
  }
  
  const secrets = await loadSecrets();
  const oldValue = secrets[key];
  
  secrets[key] = {
    value,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source,
    rotated: oldValue ? true : false,
  };
  
  await saveSecrets(secrets);
  
  // Log audit event (without the actual value)
  await logAuditEvent({
    action: oldValue ? 'secret_rotated' : 'secret_set',
    resource: `secret:${key}`,
    details: { source, rotated: oldValue ? true : false },
  });
  
  return { key, created: !oldValue, rotated: oldValue ? true : false };
}

/**
 * Get a secret value (for internal use only)
 */
async function getSecret(key) {
  const secrets = await loadSecrets();
  return secrets[key]?.value || null;
}

/**
 * Get secret metadata (without value)
 */
async function getSecretMetadata(key) {
  const secrets = await loadSecrets();
  const secret = secrets[key];
  
  if (!secret) return null;
  
  // Return metadata only, mask the value
  return {
    key,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    source: secret.source,
    rotated: secret.rotated,
    value: maskValue(secret.value),
  };
}

/**
 * List all secrets (with masked values)
 */
async function listSecrets() {
  const secrets = await loadSecrets();
  
  return Object.entries(secrets).map(([key, data]) => ({
    key,
    value: maskValue(data.value),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    source: data.source,
    rotated: data.rotated,
  }));
}

/**
 * Delete a secret
 */
async function deleteSecret(key) {
  const secrets = await loadSecrets();
  
  if (!secrets[key]) {
    throw new Error(`Secret '${key}' not found`);
  }
  
  delete secrets[key];
  await saveSecrets(secrets);
  
  await logAuditEvent({
    action: 'secret_deleted',
    resource: `secret:${key}`,
  });
  
  return { key, deleted: true };
}

/**
 * Generate a cryptographically secure random token
 */
function generateToken(length = 32) {
  return crypto.randomBytes(length).toString('base64url');
}

/**
 * Rotate a secret (generate new value)
 */
async function rotateSecret(key, options = {}) {
  const { customValue = null } = options;
  
  // Check if it's a known secret type
  const knownSecret = REQUIRED_SECRETS.find(s => s.key === key);
  
  let newValue;
  if (customValue) {
    newValue = customValue;
  } else if (key === 'GATEWAY_TOKEN') {
    newValue = `mc_${generateToken(24)}`;
  } else {
    // For API keys, we can't generate them - user must provide
    throw new Error(
      `Cannot auto-generate ${key}. ` +
      `Please provide a new value: mc secrets rotate ${key} --value <new-value>`
    );
  }
  
  return await setSecret(key, newValue, { source: 'rotation' });
}

// =============================================================================
// Validation & Checking
// =============================================================================

/**
 * Check if required secrets are configured
 */
async function checkSecrets() {
  const secrets = await loadSecrets();
  const infraDir = await findInfraDir();
  
  // Also check .env file
  const envSecrets = await loadEnvSecrets(infraDir);
  
  const results = {
    cli: {},
    env: {},
    combined: {},
    missing: [],
    invalid: [],
  };
  
  for (const req of REQUIRED_SECRETS) {
    const cliValue = secrets[req.key]?.value;
    const envValue = envSecrets[req.key];
    const hasValue = !!(cliValue || envValue);
    
    results.cli[req.key] = !!cliValue;
    results.env[req.key] = !!envValue;
    results.combined[req.key] = hasValue;
    
    if (req.required && !hasValue) {
      results.missing.push(req.key);
    }
    
    // Validate format if value exists
    const value = cliValue || envValue;
    if (value && SECRET_PATTERNS[req.key] && !SECRET_PATTERNS[req.key].test(value)) {
      results.invalid.push({
        key: req.key,
        location: cliValue ? 'cli' : 'env',
        reason: 'Invalid format',
      });
    }
  }
  
  results.valid = results.missing.length === 0 && results.invalid.length === 0;
  
  return results;
}

/**
 * Load secrets from .env file
 */
async function loadEnvSecrets(infraDir) {
  if (!infraDir) return {};
  
  const envPath = path.join(infraDir, '.env');
  
  if (!(await fs.pathExists(envPath))) {
    return {};
  }
  
  const envContent = await fs.readFile(envPath, 'utf-8');
  const secrets = {};
  
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) {
      const [, key, value] = match;
      secrets[key] = value.replace(/^["']|["']$/g, ''); // Remove quotes
    }
  }
  
  return secrets;
}

/**
 * Validate a specific secret against its service
 */
async function validateSecret(key) {
  const value = await getSecret(key);
  
  if (!value) {
    return { valid: false, error: 'Secret not found' };
  }
  
  switch (key) {
    case 'OPENAI_API_KEY':
      return await validateOpenAIKey(value);
    case 'ANTHROPIC_API_KEY':
      return await validateAnthropicKey(value);
    case 'GATEWAY_TOKEN':
      return await validateGatewayToken(value);
    default:
      return { valid: true, message: 'No validation available for this secret type' };
  }
}

/**
 * Validate OpenAI API key
 */
async function validateOpenAIKey(key) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    
    if (response.status === 200) {
      return { valid: true, message: 'API key is valid' };
    } else if (response.status === 401) {
      return { valid: false, error: 'Invalid API key' };
    } else {
      return { valid: false, error: `API returned status ${response.status}` };
    }
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Validate Anthropic API key
 */
async function validateAnthropicKey(key) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });
    
    if (response.status === 200) {
      return { valid: true, message: 'API key is valid' };
    } else if (response.status === 401) {
      return { valid: false, error: 'Invalid API key' };
    } else {
      return { valid: false, error: `API returned status ${response.status}` };
    }
  } catch (err) {
    return { valid: false, error: `Network error: ${err.message}` };
  }
}

/**
 * Validate Gateway token by checking local gateway
 */
async function validateGatewayToken(token) {
  try {
    const config = await loadConfig();
    const gatewayUrl = config.gateway?.url || 'http://localhost:3000';
    
    const response = await fetch(`${gatewayUrl}/health`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    
    if (response.status === 200) {
      return { valid: true, message: 'Gateway token is valid' };
    } else if (response.status === 401) {
      return { valid: false, error: 'Invalid gateway token' };
    } else {
      return { valid: false, error: `Gateway returned status ${response.status}` };
    }
  } catch (err) {
    return { valid: false, error: `Cannot connect to gateway: ${err.message}` };
  }
}

// =============================================================================
// Sync Operations
// =============================================================================

/**
 * Sync secrets between CLI storage and .env file
 */
async function syncSecrets(options = {}) {
  const { direction = 'to-env', dryRun = false } = options;
  const infraDir = await findInfraDir();
  
  if (!infraDir) {
    throw new Error('Infrastructure directory not found. Run from within the masterclaw-infrastructure repository.');
  }
  
  const envPath = path.join(infraDir, '.env');
  const cliSecrets = await loadSecrets();
  const envSecrets = await loadEnvSecrets(infraDir);
  
  const changes = [];
  
  if (direction === 'to-env') {
    // Sync CLI secrets to .env
    for (const [key, data] of Object.entries(cliSecrets)) {
      if (envSecrets[key] !== data.value) {
        changes.push({ key, action: envSecrets[key] ? 'update' : 'add', location: '.env' });
        if (!dryRun) {
          envSecrets[key] = data.value;
        }
      }
    }
    
    if (!dryRun && changes.length > 0) {
      await saveEnvSecrets(envPath, envSecrets);
    }
  } else if (direction === 'from-env') {
    // Sync .env secrets to CLI
    for (const [key, value] of Object.entries(envSecrets)) {
      if (REQUIRED_SECRETS.some(s => s.key === key) && cliSecrets[key]?.value !== value) {
        changes.push({ key, action: cliSecrets[key] ? 'update' : 'add', location: 'cli' });
        if (!dryRun) {
          await setSecret(key, value, { source: 'env-sync' });
        }
      }
    }
  }
  
  return { changes, dryRun };
}

/**
 * Save secrets to .env file
 */
async function saveEnvSecrets(envPath, secrets) {
  let content = '';
  
  // Read existing content to preserve comments and non-secret values
  if (await fs.pathExists(envPath)) {
    content = await fs.readFile(envPath, 'utf-8');
  }
  
  // Update or add secrets
  for (const [key, value] of Object.entries(secrets)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    
    if (pattern.test(content)) {
      content = content.replace(pattern, line);
    } else {
      content += `\n${line}`;
    }
  }
  
  await fs.writeFile(envPath, content.trim() + '\n');
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Mask a secret value for display
 */
function maskValue(value) {
  if (!value || value.length < 8) return '***';
  
  const visible = Math.min(4, Math.floor(value.length / 4));
  return value.substring(0, visible) + '***' + value.substring(value.length - visible);
}

/**
 * Export secrets in various formats
 */
async function exportSecrets(format = 'json') {
  const secrets = await loadSecrets();
  
  // Always mask values in exports unless explicitly requested
  const masked = {};
  for (const [key, data] of Object.entries(secrets)) {
    masked[key] = {
      ...data,
      value: maskValue(data.value),
    };
  }
  
  if (format === 'json') {
    return JSON.stringify(masked, null, 2);
  } else if (format === 'env') {
    let env = '# MasterClaw Secrets - Export\n';
    env += '# Generated: ' + new Date().toISOString() + '\n\n';
    for (const [key, data] of Object.entries(masked)) {
      env += `# Source: ${data.source}, Updated: ${data.updatedAt}\n`;
      env += `# ${key}=${data.value}\n\n`;
    }
    return env;
  }
  
  throw new Error(`Unknown export format: ${format}`);
}

// =============================================================================
// Command Handlers
// =============================================================================

/**
 * Handle 'mc secrets check' command
 */
async function handleCheck(options = {}) {
  console.log(chalk.blue('🔐 MasterClaw Secrets Check\n'));
  
  const results = await checkSecrets();
  
  // Display CLI secrets
  console.log(chalk.bold('CLI Secrets:'));
  for (const [key, configured] of Object.entries(results.cli)) {
    const icon = configured ? chalk.green('✅') : chalk.gray('❌');
    const req = REQUIRED_SECRETS.find(s => s.key === key);
    const required = req?.required ? chalk.red('(required)') : chalk.gray('(optional)');
    console.log(`  ${icon} ${key} ${required}`);
  }
  
  console.log('');
  
  // Display .env secrets
  console.log(chalk.bold('.env File Secrets:'));
  for (const [key, configured] of Object.entries(results.env)) {
    const icon = configured ? chalk.green('✅') : chalk.gray('❌');
    console.log(`  ${icon} ${key}`);
  }
  
  console.log('');
  
  // Display issues
  if (results.missing.length > 0) {
    console.log(chalk.red('❌ Missing Required Secrets:'));
    for (const key of results.missing) {
      console.log(`  - ${key}`);
    }
    console.log(chalk.gray(`\n  Set them with: mc secrets set ${results.missing[0]} <value>`));
  }
  
  if (results.invalid.length > 0) {
    console.log(chalk.yellow('⚠️  Invalid Secrets:'));
    for (const { key, location, reason } of results.invalid) {
      console.log(`  - ${key} (${location}): ${reason}`);
    }
  }
  
  if (results.valid) {
    console.log(chalk.green('✅ All secrets are properly configured!'));
    return 0;
  } else {
    console.log(chalk.yellow('\n⚠️  Some secrets need attention.'));
    return 1;
  }
}

/**
 * Handle 'mc secrets list' command
 */
async function handleList(options = {}) {
  const { showValues = false } = options;
  
  console.log(chalk.blue('🔐 MasterClaw Secrets\n'));
  
  const secrets = await listSecrets();
  
  if (secrets.length === 0) {
    console.log(chalk.gray('No secrets configured.'));
    console.log(chalk.gray(`Set secrets with: mc secrets set <KEY> <value>`));
    return;
  }
  
  console.log(chalk.bold(`${secrets.length} secret(s) configured:\n`));
  
  for (const secret of secrets) {
    const req = REQUIRED_SECRETS.find(s => s.key === secret.key);
    const required = req?.required ? chalk.red('★') : chalk.gray(' ');
    
    console.log(`${required} ${chalk.bold(secret.key)}`);
    console.log(`  Value:    ${showValues ? chalk.yellow(secret.value) : secret.value}`);
    console.log(`  Source:   ${chalk.gray(secret.source)}`);
    console.log(`  Updated:  ${chalk.gray(new Date(secret.updatedAt).toLocaleString())}`);
    if (secret.rotated) {
      console.log(`  ${chalk.yellow('⚠️  Rotated')}`);
    }
    console.log('');
  }
  
  if (!showValues) {
    console.log(chalk.gray('Values are masked. Use --show-values to reveal (not recommended).'));
  }
}

/**
 * Handle 'mc secrets set' command
 */
async function handleSet(key, value, options = {}) {
  const { force = false, skipValidation = false } = options;
  
  // Check if already exists
  const existing = await getSecretMetadata(key);
  
  if (existing && !force) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Secret '${key}' already exists. Overwrite?`,
      default: false,
    }]);
    
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }
  
  try {
    const result = await setSecret(key, value, { skipValidation });
    
    if (result.rotated) {
      console.log(chalk.green(`✅ Secret '${key}' rotated successfully.`));
      console.log(chalk.yellow('⚠️  Remember to sync to .env: mc secrets sync'));
    } else {
      console.log(chalk.green(`✅ Secret '${key}' set successfully.`));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle 'mc secrets get' command
 */
async function handleGet(key, options = {}) {
  const metadata = await getSecretMetadata(key);
  
  if (!metadata) {
    console.error(chalk.red(`❌ Secret '${key}' not found.`));
    process.exit(1);
  }
  
  console.log(chalk.blue(`🔐 Secret: ${key}\n`));
  console.log(`Value:    ${chalk.yellow(metadata.value)}`);
  console.log(`Source:   ${chalk.gray(metadata.source)}`);
  console.log(`Created:  ${chalk.gray(new Date(metadata.createdAt).toLocaleString())}`);
  console.log(`Updated:  ${chalk.gray(new Date(metadata.updatedAt).toLocaleString())}`);
}

/**
 * Handle 'mc secrets delete' command
 */
async function handleDelete(key, options = {}) {
  const { force = false } = options;
  
  if (!force) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Delete secret '${key}'? This cannot be undone.`,
      default: false,
    }]);
    
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }
  
  try {
    await deleteSecret(key);
    console.log(chalk.green(`✅ Secret '${key}' deleted.`));
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle 'mc secrets rotate' command
 */
async function handleRotate(key, options = {}) {
  const { value: customValue = null, force = false } = options;
  
  // Check if secret exists
  const existing = await getSecretMetadata(key);
  
  if (!existing && !customValue) {
    console.error(chalk.red(`❌ Secret '${key}' not found. Set it first with: mc secrets set ${key} <value>`));
    process.exit(1);
  }
  
  if (!force) {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Rotate secret '${key}'? This will invalidate the old value.`,
      default: false,
    }]);
    
    if (!confirm) {
      console.log(chalk.gray('Cancelled.'));
      return;
    }
  }
  
  try {
    const result = await rotateSecret(key, { customValue });
    console.log(chalk.green(`✅ Secret '${key}' rotated successfully.`));
    
    if (key === 'GATEWAY_TOKEN') {
      console.log(chalk.yellow('\n⚠️  Important: Update your OpenClaw gateway configuration!'));
      console.log(chalk.gray('   Then restart services: mc revive'));
    } else {
      console.log(chalk.yellow('\n⚠️  Remember to sync to .env: mc secrets sync'));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle 'mc secrets validate' command
 */
async function handleValidate(key, options = {}) {
  console.log(chalk.blue(`🔐 Validating ${key}...\n`));
  
  const result = await validateSecret(key);
  
  if (result.valid) {
    console.log(chalk.green(`✅ ${result.message}`));
  } else {
    console.log(chalk.red(`❌ ${result.error}`));
    process.exit(1);
  }
}

/**
 * Handle 'mc secrets sync' command
 */
async function handleSync(options = {}) {
  const { direction = 'to-env', dryRun = false } = options;
  
  console.log(chalk.blue('🔄 Syncing Secrets\n'));
  console.log(`Direction: ${direction === 'to-env' ? 'CLI → .env' : '.env → CLI'}`);
  if (dryRun) {
    console.log(chalk.yellow('Mode: Dry run (no changes will be made)\n'));
  }
  console.log('');
  
  try {
    const result = await syncSecrets({ direction, dryRun });
    
    if (result.changes.length === 0) {
      console.log(chalk.green('✅ Secrets are already in sync.'));
      return;
    }
    
    console.log(chalk.bold(`${result.changes.length} change(s):\n`));
    
    for (const change of result.changes) {
      const action = change.action === 'add' ? chalk.green('+') : chalk.yellow('~');
      console.log(`  ${action} ${change.key} → ${change.location}`);
    }
    
    if (!dryRun) {
      console.log(chalk.green(`\n✅ Synced ${result.changes.length} secret(s).`));
    } else {
      console.log(chalk.gray('\nRun without --dry-run to apply changes.'));
    }
  } catch (err) {
    console.error(chalk.red(`❌ Error: ${err.message}`));
    process.exit(1);
  }
}

/**
 * Handle 'mc secrets export' command
 */
async function handleExport(options = {}) {
  const { format = 'json', output = null } = options;
  
  const content = await exportSecrets(format);
  
  if (output) {
    await fs.writeFile(output, content);
    console.log(chalk.green(`✅ Exported to ${output}`));
    console.log(chalk.yellow('⚠️  Warning: Exported file contains sensitive metadata.'));
  } else {
    console.log(content);
  }
}

// =============================================================================
// Command Definition
// =============================================================================

const secretsCmd = new Command('secrets')
  .description('Manage MasterClaw secrets and API keys');

secretsCmd
  .command('check')
  .description('Check if all required secrets are configured')
  .action(() => handleCheck());

secretsCmd
  .command('list')
  .description('List all configured secrets (masked)')
  .option('--show-values', 'show actual values (not recommended)', false)
  .action((options) => handleList(options));

secretsCmd
  .command('set <key> <value>')
  .description('Set a secret value')
  .option('-f, --force', 'overwrite existing without confirmation', false)
  .option('--skip-validation', 'skip format validation', false)
  .action((key, value, options) => handleSet(key, value, options));

secretsCmd
  .command('get <key>')
  .description('Get a secret value (masked)')
  .action((key) => handleGet(key));

secretsCmd
  .command('delete <key>')
  .description('Delete a secret')
  .option('-f, --force', 'delete without confirmation', false)
  .action((key, options) => handleDelete(key, options));

secretsCmd
  .command('rotate <key>')
  .description('Rotate (generate new) a secret')
  .option('-v, --value <value>', 'provide custom value instead of generating')
  .option('-f, --force', 'rotate without confirmation', false)
  .action((key, options) => handleRotate(key, options));

secretsCmd
  .command('validate <key>')
  .description('Validate a secret against its service')
  .action((key) => handleValidate(key));

secretsCmd
  .command('sync')
  .description('Sync secrets between CLI and .env file')
  .option('-d, --direction <dir>', 'sync direction (to-env|from-env)', 'to-env')
  .option('--dry-run', 'show what would change without applying', false)
  .action((options) => handleSync(options));

secretsCmd
  .command('export')
  .description('Export secrets (masked) to file')
  .option('-f, --format <format>', 'export format (json|env)', 'json')
  .option('-o, --output <file>', 'output file (default: stdout)')
  .action((options) => handleExport(options));

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  // Command
  secretsCmd,
  
  // Core functions
  setSecret,
  getSecret,
  getSecretMetadata,
  listSecrets,
  deleteSecret,
  rotateSecret,
  checkSecrets,
  validateSecret,
  syncSecrets,
  exportSecrets,
  generateToken,
  
  // Constants
  REQUIRED_SECRETS,
  SECRET_PATTERNS,
};
