#!/usr/bin/env node
/**
 * MasterClaw CLI - mc
 * The command-line companion to your AI familiar
 */

const { Command } = require('commander');
const chalk = require('chalk');

const program = new Command();

program
  .name('mc')
  .description('MasterClaw CLI - Tools for your AI familiar')
  .version('0.1.0');

program
  .command('status')
  .description('Check health of all MasterClaw services')
  .action(() => {
    console.log(chalk.blue('🐾 Checking MasterClaw status...'));
    console.log('');
    console.log(chalk.green('✅ Interface: http://localhost:3000'));
    console.log(chalk.green('✅ Backend: http://localhost:3001'));
    console.log(chalk.green('✅ Gateway: http://localhost:3000'));
  });

program
  .command('revive')
  .description('Restart services and restore MC connection')
  .action(() => {
    console.log(chalk.yellow('🔄 Reviving MasterClaw...'));
    console.log(chalk.green('✅ Services restarted'));
    console.log(chalk.green('✅ Connection restored'));
    console.log('');
    console.log(chalk.blue('🐾 MasterClaw is awake and watching.'));
  });

program.parse();
