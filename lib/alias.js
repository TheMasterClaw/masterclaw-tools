/**
 * Alias commands for mc CLI
 * Manage command aliases and shortcuts
 *
 * Commands:
 * - mc alias                 List all aliases
 * - mc alias <name>          Execute an alias
 * - mc alias add <name> <command>  Add a new alias
 * - mc alias remove <name>   Remove an alias
 * - mc alias show <name>     Show alias details
 * - mc alias export [file]   Export aliases to file
 * - mc alias import <file>   Import aliases from file
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const { wrapCommand, ExitCode } = require('./error-handler');
const rateLimiter = require('./rate-limiter');
const logger = require('./logger');

// Paths
const REX_DEUS_DIR = process.env.REX_DEUS_DIR || path.join(process.env.HOME || '/home/ubuntu', '.openclaw/workspace/rex-deus');
const ALIASES_FILE = path.join(REX_DEUS_DIR, 'config', 'aliases.json');

// Default aliases
const DEFAULT_ALIASES = {
  aliases: {
    s: 'status',
    l: 'logs',
    b: 'backup',
    r: 'revive',
    u: 'update',
    cfg: 'config',
    d: 'deploy',
    st: 'status',
    log: 'logs',
    bk: 'backup',
    rs: 'restore',
    ex: 'exec',
    ev: 'events',
    nt: 'notify',
    perf: 'performance',
    sm: 'smoke-test',
    val: 'validate'
  },
  shortcuts: {
    deploy: 'cd /opt/masterclaw-infrastructure && ./scripts/deploy.sh',
    'logs-backend': 'mc logs mc-backend --follow',
    'logs-core': 'mc logs mc-core --follow',
    'logs-gateway': 'mc logs mc-gateway --follow',
    'quick-status': 'mc status --compact',
    'full-backup': 'mc backup && mc backup-cloud',
    'health-watch': 'mc health --watch'
  }
};

// Ensure aliases file exists
async function ensureAliasesFile() {
  try {
    await fs.ensureDir(path.dirname(ALIASES_FILE));
    if (!await fs.pathExists(ALIASES_FILE)) {
      await fs.writeJson(ALIASES_FILE, DEFAULT_ALIASES, { spaces: 2 });
      logger.debug('Created default aliases file', { file: ALIASES_FILE });
    }
  } catch (error) {
    logger.error('Failed to create aliases file', { error: error.message });
    throw error;
  }
}

// Load aliases
async function loadAliases() {
  await ensureAliasesFile();
  try {
    return await fs.readJson(ALIASES_FILE);
  } catch (error) {
    logger.error('Failed to load aliases', { error: error.message });
    return DEFAULT_ALIASES;
  }
}

// Save aliases
async function saveAliases(aliases) {
  await fs.writeJson(ALIASES_FILE, aliases, { spaces: 2 });
  logger.debug('Saved aliases file');
}

// Format command for display
function formatCommand(cmd) {
  if (cmd.length > 50) {
    return `${cmd.substring(0, 47)}...`;
  }
  return cmd;
}

// Create the alias command
const aliasCmd = new Command('alias')
  .description('Manage command aliases and shortcuts')
  .configureHelp({ showGlobalOptions: false });

// List all aliases
aliasCmd
  .command('list')
  .alias('ls')
  .description('List all aliases and shortcuts')
  .option('--json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    await rateLimiter.checkLimit('alias-list', { limit: 30, windowMs: 60000 });

    const data = await loadAliases();

    if (options.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(chalk.bold('\n🐾 MasterClaw Aliases\n'));

    // Command aliases
    console.log(chalk.cyan.bold('Command Aliases:'));
    console.log(chalk.gray('─'.repeat(50)));

    if (Object.keys(data.aliases).length === 0) {
      console.log(chalk.gray('  No aliases defined'));
    } else {
      const sorted = Object.entries(data.aliases).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, command] of sorted) {
        const padding = ' '.repeat(Math.max(1, 12 - name.length));
        console.log(`  ${chalk.yellow(name)}${padding}→ ${chalk.green(formatCommand(command))}`);
      }
    }

    console.log();

    // Shell shortcuts
    console.log(chalk.cyan.bold('Shell Shortcuts:'));
    console.log(chalk.gray('─'.repeat(50)));

    if (Object.keys(data.shortcuts).length === 0) {
      console.log(chalk.gray('  No shortcuts defined'));
    } else {
      const sorted = Object.entries(data.shortcuts).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, command] of sorted) {
        const padding = ' '.repeat(Math.max(1, 20 - name.length));
        console.log(`  ${chalk.yellow(name)}${padding}→ ${chalk.green(formatCommand(command))}`);
      }
    }

    console.log();
    console.log(chalk.gray('Use "mc alias run <name>" to execute an alias'));
    console.log(chalk.gray('Use "mc alias add <name> <command>" to add a new alias'));
  }, 'alias'));

// Run an alias
aliasCmd
  .command('run <name>')
  .alias('exec')
  .description('Execute an alias or shortcut')
  .option('--dry-run', 'Show what would be executed without running')
  .action(wrapCommand(async (name, options) => {
    await rateLimiter.checkLimit('alias-run', { limit: 20, windowMs: 60000 });

    const data = await loadAliases();

    // Check command aliases first
    if (data.aliases[name]) {
      const command = `mc ${data.aliases[name]}`;

      if (options.dryRun) {
        console.log(chalk.cyan('Would execute:'), chalk.yellow(command));
        return;
      }

      logger.info(`Executing alias: ${name} → ${command}`);
      console.log(chalk.gray(`→ Executing: ${command}\n`));

      // Execute the mc command
      execSync(command, { stdio: 'inherit', cwd: process.cwd() });
      return;
    }

    // Check shell shortcuts
    if (data.shortcuts[name]) {
      const command = data.shortcuts[name];

      if (options.dryRun) {
        console.log(chalk.cyan('Would execute:'), chalk.yellow(command));
        return;
      }

      logger.info(`Executing shortcut: ${name} → ${command}`);
      console.log(chalk.gray(`→ Executing: ${command}\n`));

      // Execute the shell command
      execSync(command, { stdio: 'inherit', cwd: process.cwd(), shell: true });
      return;
    }

    console.log(chalk.red(`❌ Alias or shortcut '${name}' not found`));
    console.log(chalk.gray(`Run 'mc alias list' to see available aliases`));
    process.exit(ExitCode.CONFIG_ERROR);
  }, 'alias'));

// Add a new alias
aliasCmd
  .command('add <name> <command...>')
  .alias('set')
  .description('Add a new command alias')
  .option('--shortcut', 'Add as shell shortcut instead of mc alias')
  .option('--force', 'Overwrite existing alias')
  .action(wrapCommand(async (name, commandParts, options) => {
    await rateLimiter.checkLimit('alias-add', { limit: 10, windowMs: 60000 });

    // Validate name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.log(chalk.red('❌ Alias name must be alphanumeric with hyphens/underscores only'));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    if (name.length > 20) {
      console.log(chalk.red('❌ Alias name must be 20 characters or less'));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const command = commandParts.join(' ');

    if (command.length === 0) {
      console.log(chalk.red('❌ Command cannot be empty'));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const data = await loadAliases();

    // Check if exists
    const exists = data.aliases[name] || data.shortcuts[name];
    if (exists && !options.force) {
      console.log(chalk.yellow(`⚠️  Alias '${name}' already exists`));
      console.log(chalk.gray(`Use --force to overwrite`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    // Add the alias
    if (options.shortcut) {
      data.shortcuts[name] = command;
      logger.info(`Added shell shortcut: ${name}`);
      console.log(chalk.green(`✅ Added shell shortcut '${name}'`));
    } else {
      data.aliases[name] = command;
      logger.info(`Added command alias: ${name} → ${command}`);
      console.log(chalk.green(`✅ Added command alias '${name}' → '${formatCommand(command)}'`));
    }

    await saveAliases(data);

    console.log(chalk.gray(`Run 'mc alias run ${name}' to execute`));
  }, 'alias'));

// Remove an alias
aliasCmd
  .command('remove <name>')
  .alias('rm')
  .alias('delete')
  .description('Remove an alias or shortcut')
  .action(wrapCommand(async (name) => {
    await rateLimiter.checkLimit('alias-remove', { limit: 10, windowMs: 60000 });

    const data = await loadAliases();

    let removed = false;

    if (data.aliases[name]) {
      delete data.aliases[name];
      removed = true;
    }

    if (data.shortcuts[name]) {
      delete data.shortcuts[name];
      removed = true;
    }

    if (!removed) {
      console.log(chalk.yellow(`⚠️  Alias '${name}' not found`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    await saveAliases(data);
    logger.info(`Removed alias: ${name}`);
    console.log(chalk.green(`✅ Removed alias '${name}'`));
  }, 'alias'));

// Show alias details
aliasCmd
  .command('show <name>')
  .description('Show alias details')
  .action(wrapCommand(async (name) => {
    await rateLimiter.checkLimit('alias-show', { limit: 30, windowMs: 60000 });

    const data = await loadAliases();

    if (data.aliases[name]) {
      console.log(chalk.bold(`\nAlias: ${chalk.yellow(name)}`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`Type: ${chalk.cyan('Command Alias')}`);
      console.log(`Command: ${chalk.green(`mc ${data.aliases[name]}`)}`);
      console.log();
      console.log(chalk.gray('Execute with:'), chalk.yellow(`mc alias run ${name}`));
      return;
    }

    if (data.shortcuts[name]) {
      console.log(chalk.bold(`\nShortcut: ${chalk.yellow(name)}`));
      console.log(chalk.gray('─'.repeat(40)));
      console.log(`Type: ${chalk.cyan('Shell Shortcut')}`);
      console.log(`Command: ${chalk.green(data.shortcuts[name])}`);
      console.log();
      console.log(chalk.gray('Execute with:'), chalk.yellow(`mc alias run ${name}`));
      return;
    }

    console.log(chalk.red(`❌ Alias '${name}' not found`));
    process.exit(ExitCode.CONFIG_ERROR);
  }, 'alias'));

// Export aliases
aliasCmd
  .command('export [file]')
  .description('Export aliases to JSON file')
  .action(wrapCommand(async (file = 'mc-aliases-export.json') => {
    await rateLimiter.checkLimit('alias-export', { limit: 10, windowMs: 60000 });

    const data = await loadAliases();
    const exportPath = path.resolve(file);

    await fs.writeJson(exportPath, data, { spaces: 2 });
    logger.info(`Exported aliases to: ${exportPath}`);
    console.log(chalk.green(`✅ Aliases exported to ${exportPath}`));
  }, 'alias'));

// Import aliases
aliasCmd
  .command('import <file>')
  .description('Import aliases from JSON file')
  .option('--merge', 'Merge with existing aliases instead of replacing')
  .action(wrapCommand(async (file, options) => {
    await rateLimiter.checkLimit('alias-import', { limit: 10, windowMs: 60000 });

    const importPath = path.resolve(file);

    if (!await fs.pathExists(importPath)) {
      console.log(chalk.red(`❌ File not found: ${importPath}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const imported = await fs.readJson(importPath);

    if (!imported.aliases || !imported.shortcuts) {
      console.log(chalk.red('❌ Invalid aliases file format'));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    let data = await loadAliases();

    if (options.merge) {
      // Merge imported with existing
      data.aliases = { ...data.aliases, ...imported.aliases };
      data.shortcuts = { ...data.shortcuts, ...imported.shortcuts };
      console.log(chalk.green('✅ Aliases merged successfully'));
    } else {
      // Replace existing
      data = imported;
      console.log(chalk.green('✅ Aliases imported successfully (replaced existing)'));
    }

    await saveAliases(data);

    const aliasCount = Object.keys(data.aliases).length;
    const shortcutCount = Object.keys(data.shortcuts).length;
    console.log(chalk.gray(`Now have ${aliasCount} aliases and ${shortcutCount} shortcuts`));
  }, 'alias'));

// Reset to defaults
aliasCmd
  .command('reset')
  .description('Reset aliases to default values')
  .option('--force', 'Skip confirmation')
  .action(wrapCommand(async (options) => {
    await rateLimiter.checkLimit('alias-reset', { limit: 5, windowMs: 300000 });

    if (!options.force) {
      console.log(chalk.yellow('⚠️  This will reset all aliases to defaults'));
      console.log(chalk.gray('Custom aliases will be lost'));
      console.log();
      console.log(chalk.gray('Run with --force to skip this confirmation'));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    await saveAliases(DEFAULT_ALIASES);
    logger.info('Reset aliases to defaults');
    console.log(chalk.green('✅ Aliases reset to defaults'));
  }, 'alias'));

module.exports = {
  aliasCmd,
  loadAliases,
  ensureAliasesFile,
  DEFAULT_ALIASES,
  ALIASES_FILE
};
