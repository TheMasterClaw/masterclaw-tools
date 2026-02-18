/**
 * Config commands for mc CLI
 * Manage MasterClaw CLI configuration
 *
 * Commands:
 * - mc config get <key>      Get a configuration value
 * - mc config set <key> <value>  Set a configuration value
 * - mc config list           List all configuration
 * - mc config export [file]  Export config to JSON file
 * - mc config import <file>  Import config from JSON file
 * - mc config reset          Reset config to defaults
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const { wrapCommand, ExitCode } = require('./error-handler');
const rateLimiter = require('./rate-limiter');

const configCmd = new Command('config');

// Get config value
configCmd
  .command('get <key>')
  .description('Get a configuration value by key (supports dot notation, e.g., gateway.url)')
  .action(wrapCommand(async (key) => {
    const value = await config.get(key);

    if (value === undefined) {
      console.log(chalk.yellow(`⚠️  Key '${key}' not found in configuration`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Mask sensitive values
    const sensitiveKeys = ['token', 'password', 'secret', 'key', 'apikey'];
    const isSensitive = sensitiveKeys.some(sk => key.toLowerCase().includes(sk));

    if (isSensitive && typeof value === 'string' && value.length > 8) {
      const masked = `${value.substring(0, 4)  }****${  value.substring(value.length - 4)}`;
      console.log(`${chalk.cyan(key)}: ${masked}`);
      console.log(chalk.gray('   (Value masked for security)'));
    } else {
      console.log(`${chalk.cyan(key)}: ${JSON.stringify(value, null, 2)}`);
    }
  }, 'config'));

// Set config value
configCmd
  .command('set <key> <value>')
  .description('Set a configuration value by key (supports dot notation)')
  .option('--json', 'Parse value as JSON instead of string')
  .action(wrapCommand(async (key, value, options) => {
    // Enforce rate limiting for config changes
    await rateLimiter.enforceRateLimit('config-set', { command: 'config-set' });

    let parsedValue = value;

    if (options.json) {
      try {
        parsedValue = JSON.parse(value);
      } catch (err) {
        console.log(chalk.red(`❌ Invalid JSON: ${err.message}`));
        process.exit(ExitCode.VALIDATION_FAILED);
      }
    } else {
      // Auto-convert common types
      if (value === 'true') parsedValue = true;
      else if (value === 'false') parsedValue = false;
      else if (value === 'null') parsedValue = null;
      else if (!isNaN(value) && value !== '') parsedValue = Number(value);
    }

    await config.set(key, parsedValue);
    console.log(chalk.green(`✅ Set ${chalk.cyan(key)} = ${JSON.stringify(parsedValue)}`));
  }, 'config-set'));

// List all config
configCmd
  .command('list')
  .description('List all configuration values')
  .option('--json', 'Output as JSON')
  .option('--no-mask', 'Show sensitive values (not recommended)')
  .action(wrapCommand(async (options) => {
    const cfg = await config.list();

    if (options.json) {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }

    console.log(chalk.blue('🐾 MasterClaw Configuration\n'));

    const sensitiveKeys = ['token', 'password', 'secret', 'key', 'apikey'];

    function printObject(obj, prefix = '') {
      for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const isSensitive = sensitiveKeys.some(sk => key.toLowerCase().includes(sk));

        if (value && typeof value === 'object' && !Array.isArray(value)) {
          console.log(chalk.cyan(`\n[${fullKey}]`));
          printObject(value, fullKey);
        } else {
          let displayValue = value;

          if (isSensitive && !options.noMask && typeof value === 'string' && value) {
            if (value.length > 8) {
              displayValue = `${value.substring(0, 4)  }****${  value.substring(value.length - 4)}`;
            } else {
              displayValue = '****';
            }
          }

          const valueColor = value === null ? chalk.gray :
            typeof value === 'boolean' ? (value ? chalk.green : chalk.red) :
              isSensitive ? chalk.yellow : chalk.white;

          console.log(`  ${chalk.gray(fullKey.padEnd(25))} ${valueColor(String(displayValue))}`);
        }
      }
    }

    printObject(cfg);
    console.log('');
    console.log(chalk.gray('Use --no-mask to show sensitive values (not recommended in shared environments)'));
  }, 'config'));

// Export config
configCmd
  .command('export [file]')
  .description('Export configuration to a JSON file')
  .option('--no-mask', 'Export sensitive values unmasked (use with caution)')
  .action(wrapCommand(async (file, options) => {
    const outputFile = file || `masterclaw-config-${new Date().toISOString().split('T')[0]}.json`;

    const cfg = await config.list();

    if (options.mask !== false) {
      // Mask sensitive values in export
      const sensitiveKeys = ['token', 'password', 'secret', 'key', 'apikey'];

      function maskSensitive(obj) {
        const masked = {};
        for (const [key, value] of Object.entries(obj)) {
          const isSensitive = sensitiveKeys.some(sk => key.toLowerCase().includes(sk));

          if (value && typeof value === 'object' && !Array.isArray(value)) {
            masked[key] = maskSensitive(value);
          } else if (isSensitive && typeof value === 'string' && value) {
            masked[key] = '[REDACTED]';
          } else {
            masked[key] = value;
          }
        }
        return masked;
      }

      const maskedCfg = maskSensitive(cfg);
      await fs.writeJson(outputFile, maskedCfg, { spaces: 2 });
      console.log(chalk.green(`✅ Config exported to ${outputFile}`));
      console.log(chalk.yellow('⚠️  Sensitive values were masked for security'));
      console.log(chalk.gray('   Use --no-mask to export unmasked (not recommended)'));
    } else {
      await fs.writeJson(outputFile, cfg, { spaces: 2 });
      console.log(chalk.green(`✅ Config exported to ${outputFile}`));
      console.log(chalk.red('⚠️  WARNING: Sensitive values are included in this export!'));
    }
  }, 'config'));

// Import config
configCmd
  .command('import <file>')
  .description('Import configuration from a JSON file')
  .option('--force', 'Overwrite existing values without confirmation')
  .option('--dry-run', 'Preview changes without applying them')
  .action(wrapCommand(async (file, options) => {
    // Enforce rate limiting for config imports
    await rateLimiter.enforceRateLimit('config-import', { command: 'config-import' });

    if (!await fs.pathExists(file)) {
      console.log(chalk.red(`❌ File not found: ${file}`));
      process.exit(ExitCode.VALIDATION_FAILED);
    }

    let newConfig;
    try {
      newConfig = await fs.readJson(file);
    } catch (err) {
      console.log(chalk.red(`❌ Invalid JSON file: ${err.message}`));
      process.exit(ExitCode.VALIDATION_FAILED);
    }

    const currentConfig = await config.list();

    // Find differences
    const changes = [];
    function findChanges(newObj, currentObj, prefix = '') {
      for (const [key, value] of Object.entries(newObj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const currentValue = currentObj?.[key];

        if (value && typeof value === 'object' && !Array.isArray(value)) {
          findChanges(value, currentValue || {}, fullKey);
        } else if (value !== currentValue) {
          changes.push({
            key: fullKey,
            oldValue: currentValue,
            newValue: value,
          });
        }
      }
    }
    findChanges(newConfig, currentConfig);

    if (changes.length === 0) {
      console.log(chalk.green('✅ No changes detected - configuration is already up to date'));
      return;
    }

    console.log(chalk.blue('🐾 Configuration Changes\n'));

    for (const change of changes) {
      const oldStr = change.oldValue === undefined ? chalk.gray('(unset)') : JSON.stringify(change.oldValue);
      const newStr = change.newValue === '[REDACTED]' ? chalk.yellow('[REDACTED - will not change]') : JSON.stringify(change.newValue);

      console.log(`  ${chalk.cyan(change.key)}:`);
      console.log(`    ${chalk.red('-')} ${oldStr}`);
      console.log(`    ${chalk.green('+')} ${newStr}`);
    }

    if (options.dryRun) {
      console.log(chalk.gray('\n(Dry run - no changes made)'));
      return;
    }

    if (!options.force) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question(chalk.yellow('\nApply these changes? [y/N] '), resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 'y') {
        console.log(chalk.gray('Import cancelled'));
        return;
      }
    }

    // Apply changes
    for (const change of changes) {
      if (change.newValue !== '[REDACTED]') {
        await config.set(change.key, change.newValue);
      }
    }

    console.log(chalk.green(`✅ Applied ${changes.length} configuration change(s)`));
  }, 'config-import'));

// Reset config
configCmd
  .command('reset')
  .description('Reset configuration to defaults')
  .option('--force', 'Skip confirmation prompt')
  .action(wrapCommand(async (options) => {
    if (!options.force) {
      console.log(chalk.yellow('⚠️  WARNING: This will reset all configuration to defaults!'));

      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise(resolve => {
        rl.question(chalk.red('Type "RESET" to confirm: '), resolve);
      });
      rl.close();

      if (answer !== 'RESET') {
        console.log(chalk.gray('Reset cancelled'));
        return;
      }
    }

    await config.reset();
    console.log(chalk.green('✅ Configuration reset to defaults'));
  }, 'config'));

module.exports = configCmd;
