/**
 * Environment configuration management
 * Compare, validate, and sync environment configurations
 * 
 * Features:
 * - Compare .env files between environments
 * - Validate required variables
 * - Check for security issues
 * - Sync non-sensitive config
 * - Template generation
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const { findInfraDir, getRepoRoot } = require('./services');

// Environment configuration schemas
const ENV_SCHEMA = {
  required: [
    'DOMAIN',
    'ACME_EMAIL',
    'GATEWAY_TOKEN',
  ],
  sensitive: [
    'GATEWAY_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'SMTP_PASS',
    'ALERT_NOTIFY_TELEGRAM',
  ],
  urls: [
    'DOMAIN',
  ],
  emails: [
    'ACME_EMAIL',
    'ALERT_FROM',
  ],
  recommended: [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'RETENTION_DAYS',
    'BACKUP_DIR',
  ],
};

// Color coding for diff display
const COLORS = {
  added: chalk.green,
  removed: chalk.red,
  modified: chalk.yellow,
  unchanged: chalk.gray,
  header: chalk.cyan.bold,
  sensitive: chalk.magenta,
};

/**
 * Parse .env file into key-value object
 */
function parseEnvFile(content) {
  const env = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Parse KEY=value
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();
      
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      env[key] = value;
    }
  }
  
  return env;
}

/**
 * Serialize env object back to .env format
 */
function serializeEnv(env, comments = {}) {
  const lines = [];
  const keys = Object.keys(env).sort();
  
  for (const key of keys) {
    if (comments[key]) {
      lines.push(`# ${comments[key]}`);
    }
    const value = env[key];
    // Quote values with spaces or special characters
    if (value.includes(' ') || value.includes('#')) {
      lines.push(`${key}="${value}"`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }
  
  return lines.join('\n');
}

/**
 * Load environment from file
 */
async function loadEnvFile(filePath) {
  if (!await fs.pathExists(filePath)) {
    throw new Error(`Environment file not found: ${filePath}`);
  }
  
  const content = await fs.readFile(filePath, 'utf-8');
  return {
    path: filePath,
    content,
    env: parseEnvFile(content),
  };
}

/**
 * Compare two environment configurations
 */
function compareEnvs(local, remote) {
  const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const diff = {
    added: [],      // In remote but not local
    removed: [],    // In local but not remote
    modified: [],   // Different values
    unchanged: [],  // Same values
    sensitive: [],  // Sensitive key differences
  };
  
  for (const key of allKeys) {
    const inLocal = key in local;
    const inRemote = key in remote;
    const isSensitive = ENV_SCHEMA.sensitive.includes(key);
    
    if (!inLocal) {
      diff.added.push({ key, value: remote[key] });
    } else if (!inRemote) {
      diff.removed.push({ key, value: local[key] });
    } else if (local[key] !== remote[key]) {
      const item = { 
        key, 
        local: local[key], 
        remote: remote[key],
      };
      if (isSensitive) {
        diff.sensitive.push(item);
      } else {
        diff.modified.push(item);
      }
    } else {
      diff.unchanged.push({ key, value: local[key] });
    }
  }
  
  return diff;
}

/**
 * Validate environment configuration
 */
function validateEnv(env, options = {}) {
  const issues = [];
  const warnings = [];
  
  // Check required variables
  for (const key of ENV_SCHEMA.required) {
    if (!env[key] || env[key].trim() === '' || env[key].includes('...')) {
      issues.push({
        type: 'required',
        key,
        message: `Required variable ${key} is missing or not configured`,
      });
    }
  }
  
  // Check recommended variables
  if (!options.skipRecommended) {
    for (const key of ENV_SCHEMA.recommended) {
      if (!env[key] || env[key].trim() === '' || env[key].includes('...')) {
        warnings.push({
          type: 'recommended',
          key,
          message: `Recommended variable ${key} is not configured`,
        });
      }
    }
  }
  
  // Validate URL formats
  for (const key of ENV_SCHEMA.urls) {
    if (env[key] && !env[key].includes('...')) {
      if (env[key].includes('http://') || env[key].includes('https://')) {
        issues.push({
          type: 'format',
          key,
          message: `${key} should not include protocol (http/https)`,
        });
      }
    }
  }
  
  // Validate email formats
  for (const key of ENV_SCHEMA.emails) {
    if (env[key] && !env[key].includes('...')) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(env[key])) {
        issues.push({
          type: 'format',
          key,
          message: `${key} does not appear to be a valid email`,
        });
      }
    }
  }
  
  // Check for example/placeholder values
  const placeholderPatterns = [
    /your-.*-here/i,
    /^example\.com$/i,              // Only exact match for example.com domain
    /\.example\.com$/i,             // Subdomains of example.com
    /changeme/i,
    /placeholder/i,
    /^(?:\d{1,3}\.){3}\d{1,3}$/,     // Raw IP addresses as domain values
    /^localhost$/i,
    /^127\./,                        // Loopback IPs
    /^192\.168\./,                  // Private IPs
    /^10\./,                         // Private IPs
    /\.local$/i,                     // mDNS domains
    /^$/                             // Empty values
  ];
  
  for (const [key, value] of Object.entries(env)) {
    for (const pattern of placeholderPatterns) {
      if (pattern.test(value)) {
        issues.push({
          type: 'placeholder',
          key,
          message: `${key} contains placeholder value: "${value}"`,
        });
        break;
      }
    }
  }
  
  // Security checks
  for (const key of ENV_SCHEMA.sensitive) {
    if (env[key] && env[key].length < 10 && env[key].length > 0) {
      warnings.push({
        type: 'security',
        key,
        message: `${key} appears to be unusually short, verify it's correct`,
      });
    }
  }
  
  return { issues, warnings, valid: issues.length === 0 };
}

/**
 * Generate environment template
 */
function generateTemplate(options = {}) {
  const template = {
    DOMAIN: options.domain || 'mc.yourdomain.com',
    ACME_EMAIL: options.email || 'admin@yourdomain.com',
    GATEWAY_TOKEN: 'your-gateway-token-here',
    OPENAI_API_KEY: options.includeOptional ? 'sk-...' : '',
    ANTHROPIC_API_KEY: options.includeOptional ? 'sk-ant-...' : '',
    TRAEFIK_LOG_LEVEL: 'INFO',
    RETENTION_DAYS: '7',
    BACKUP_DIR: './backups',
    DEPENDENCY_CHECK_TIMEOUT: '120',
  };
  
  const comments = {
    DOMAIN: 'Your domain name (e.g., mc.yourdomain.com)',
    ACME_EMAIL: 'Admin email for SSL certificates',
    GATEWAY_TOKEN: 'OpenClaw Gateway token - get from your OpenClaw instance',
    OPENAI_API_KEY: 'Optional: OpenAI API key for GPT models',
    ANTHROPIC_API_KEY: 'Optional: Anthropic API key for Claude models',
    RETENTION_DAYS: 'Backup retention period in days',
  };
  
  return serializeEnv(template, comments);
}

/**
 * Sync non-sensitive configuration from source to target
 */
async function syncEnv(sourcePath, targetPath, options = {}) {
  const source = await loadEnvFile(sourcePath);
  const target = await loadEnvFile(targetPath);
  
  const synced = { ...target.env };
  const syncedKeys = [];
  const skippedKeys = [];
  
  for (const [key, value] of Object.entries(source.env)) {
    // Skip sensitive keys unless explicitly allowed
    if (ENV_SCHEMA.sensitive.includes(key) && !options.includeSensitive) {
      skippedKeys.push(key);
      continue;
    }
    
    // Skip empty values
    if (!value || value.trim() === '') continue;
    
    // Skip placeholder values
    if (value.includes('...') || value.includes('your-') || value.includes('example.')) continue;
    
    // Update if different
    if (synced[key] !== value) {
      synced[key] = value;
      syncedKeys.push(key);
    }
  }
  
  if (!options.dryRun) {
    // Backup target first
    const backupPath = `${targetPath}.backup-${Date.now()}`;
    await fs.copy(targetPath, backupPath);
    
    // Write updated config
    const content = serializeEnv(synced);
    await fs.writeFile(targetPath, content);
  }
  
  return {
    synced: syncedKeys,
    skipped: skippedKeys,
    backupPath: options.dryRun ? null : `${targetPath}.backup-${Date.now()}`,
  };
}

// =============================================================================
// CLI Commands
// =============================================================================

const program = new Command();

program
  .name('env')
  .description('Environment configuration management');

// Diff command
program
  .command('diff')
  .description('Compare local .env with another environment')
  .argument('[source]', 'Source env file', '.env')
  .argument('[target]', 'Target env file to compare with', '.env.prod')
  .option('-s, --show-values', 'Show actual values (default: masked)', false)
  .option('--json', 'Output as JSON')
  .action(async (source, target, options) => {
    try {
      const local = await loadEnvFile(source);
      const remote = await loadEnvFile(target);
      
      const diff = compareEnvs(local.env, remote.env);
      
      if (options.json) {
        console.log(JSON.stringify(diff, null, 2));
        return;
      }
      
      console.log(COLORS.header('🐾 Environment Diff'));
      console.log(chalk.gray(`  ${source} → ${target}\n`));
      
      // Added keys
      if (diff.added.length > 0) {
        console.log(COLORS.added(`✨ Added in ${target} (${diff.added.length}):`));
        for (const { key, value } of diff.added) {
          const displayValue = options.showValues ? value : maskValue(value);
          console.log(COLORS.added(`  + ${key}=${displayValue}`));
        }
        console.log('');
      }
      
      // Removed keys
      if (diff.removed.length > 0) {
        console.log(COLORS.removed(`🗑️  Removed from ${source} (${diff.removed.length}):`));
        for (const { key, value } of diff.removed) {
          const displayValue = options.showValues ? value : maskValue(value);
          console.log(COLORS.removed(`  - ${key}=${displayValue}`));
        }
        console.log('');
      }
      
      // Modified keys
      if (diff.modified.length > 0) {
        console.log(COLORS.modified(`📝 Modified (${diff.modified.length}):`));
        for (const { key, local: localVal, remote: remoteVal } of diff.modified) {
          const localDisplay = options.showValues ? localVal : maskValue(localVal);
          const remoteDisplay = options.showValues ? remoteVal : maskValue(remoteVal);
          console.log(COLORS.modified(`  ~ ${key}:`));
          console.log(COLORS.removed(`    - ${localDisplay}`));
          console.log(COLORS.added(`    + ${remoteDisplay}`));
        }
        console.log('');
      }
      
      // Sensitive key differences
      if (diff.sensitive.length > 0) {
        console.log(COLORS.sensitive(`🔒 Sensitive values differ (${diff.sensitive.length}):`));
        for (const { key } of diff.sensitive) {
          console.log(COLORS.sensitive(`  * ${key} (values hidden)`));
        }
        console.log('');
      }
      
      // Unchanged count
      if (diff.unchanged.length > 0) {
        console.log(COLORS.unchanged(`✅ Unchanged: ${diff.unchanged.length} variables`));
      }
      
      // Summary
      const totalChanges = diff.added.length + diff.removed.length + 
                          diff.modified.length + diff.sensitive.length;
      console.log('');
      if (totalChanges === 0) {
        console.log(chalk.green('✨ Environments are in sync!'));
      } else {
        console.log(chalk.yellow(`⚠️  ${totalChanges} difference(s) found`));
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// Check command
program
  .command('check')
  .description('Validate environment configuration')
  .argument('[file]', 'Env file to check', '.env')
  .option('--skip-recommended', 'Skip recommended variable checks')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      const envData = await loadEnvFile(file);
      const result = validateEnv(envData.env, {
        skipRecommended: options.skipRecommended,
      });
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.valid ? 0 : 1);
      }
      
      console.log(COLORS.header('🐾 Environment Check'));
      console.log(chalk.gray(`  ${file}\n`));
      
      // Issues
      if (result.issues.length > 0) {
        console.log(chalk.red(`❌ Issues found (${result.issues.length}):`));
        for (const issue of result.issues) {
          console.log(chalk.red(`  • [${issue.type}] ${issue.message}`));
        }
        console.log('');
      }
      
      // Warnings
      if (result.warnings.length > 0) {
        console.log(chalk.yellow(`⚠️  Warnings (${result.warnings.length}):`));
        for (const warning of result.warnings) {
          console.log(chalk.yellow(`  • [${warning.type}] ${warning.message}`));
        }
        console.log('');
      }
      
      // Stats
      const keyCount = Object.keys(envData.env).length;
      const requiredSet = ENV_SCHEMA.required.filter(k => envData.env[k] && !envData.env[k].includes('...')).length;
      const recommendedSet = ENV_SCHEMA.recommended.filter(k => envData.env[k] && !envData.env[k].includes('...')).length;
      
      console.log(chalk.cyan('📊 Summary:'));
      console.log(`  Total variables: ${keyCount}`);
      console.log(`  Required: ${requiredSet}/${ENV_SCHEMA.required.length} ${requiredSet === ENV_SCHEMA.required.length ? chalk.green('✅') : chalk.red('❌')}`);
      console.log(`  Recommended: ${recommendedSet}/${ENV_SCHEMA.recommended.length} ${recommendedSet === ENV_SCHEMA.recommended.length ? chalk.green('✅') : chalk.yellow('⚠️')}`);
      
      console.log('');
      if (result.valid) {
        console.log(chalk.green('✅ Configuration is valid'));
      } else {
        console.log(chalk.red('❌ Configuration has issues that need to be fixed'));
        process.exit(1);
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// Sync command
program
  .command('sync')
  .description('Sync non-sensitive configuration from source to target')
  .argument('[source]', 'Source env file', '.env.prod')
  .argument('[target]', 'Target env file', '.env')
  .option('-d, --dry-run', 'Show what would be synced without making changes')
  .option('--include-sensitive', 'Include sensitive keys (use with caution)')
  .action(async (source, target, options) => {
    try {
      console.log(COLORS.header('🐾 Environment Sync'));
      console.log(chalk.gray(`  ${source} → ${target}\n`));
      
      if (options.dryRun) {
        console.log(chalk.cyan('🔍 Dry run mode - no changes will be made\n'));
      }
      
      const result = await syncEnv(source, target, {
        dryRun: options.dryRun,
        includeSensitive: options.includeSensitive,
      });
      
      if (result.synced.length > 0) {
        console.log(chalk.green(`✅ Synced ${result.synced.length} variable(s):`));
        for (const key of result.synced) {
          console.log(chalk.green(`  • ${key}`));
        }
      } else {
        console.log(chalk.gray('No variables needed syncing'));
      }
      
      if (result.skipped.length > 0) {
        console.log(chalk.yellow(`\n⏭️  Skipped ${result.skipped.length} sensitive variable(s):`));
        for (const key of result.skipped) {
          console.log(chalk.yellow(`  • ${key}`));
        }
        console.log(chalk.gray('Use --include-sensitive to sync these (not recommended)'));
      }
      
      if (!options.dryRun && result.synced.length > 0) {
        console.log(chalk.gray(`\n💾 Backup saved to: ${result.backupPath}`));
      }
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// Template command
program
  .command('template')
  .description('Generate a new .env template')
  .option('-o, --output <file>', 'Output file', '.env')
  .option('--include-optional', 'Include optional API keys')
  .option('-f, --force', 'Overwrite existing file')
  .action(async (options) => {
    try {
      if (await fs.pathExists(options.output) && !options.force) {
        console.log(chalk.yellow(`⚠️  ${options.output} already exists`));
        console.log(chalk.gray('Use --force to overwrite'));
        process.exit(1);
      }
      
      const template = generateTemplate({
        includeOptional: options.includeOptional,
      });
      
      await fs.writeFile(options.output, template);
      console.log(chalk.green(`✅ Template generated: ${options.output}`));
      console.log(chalk.gray('Edit the file and replace placeholder values'));
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// Export for programmatic use
module.exports = {
  program,
  parseEnvFile,
  serializeEnv,
  compareEnvs,
  validateEnv,
  generateTemplate,
  syncEnv,
  ENV_SCHEMA,
};

// Helper function
function maskValue(value) {
  if (!value || value.length <= 4) return '****';
  return value.substring(0, 2) + '****' + value.substring(value.length - 2);
}

// Run if called directly
if (require.main === module) {
  program.parse();
}
