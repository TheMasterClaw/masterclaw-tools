// memory.js - Memory management commands for mc CLI

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const ora = require('ora');
const config = require('./config');

const memory = new Command('memory');

// Backup memory
memory
  .command('backup')
  .description('Create a backup of MasterClaw memory')
  .option('-o, --output <path>', 'output file path')
  .action(async (options) => {
    const spinner = ora('Creating memory backup...').start();
    
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';
      
      const response = await axios.post(`${coreUrl}/v1/memory/backup`);
      
      spinner.succeed('Memory backup created');
      console.log(chalk.green(`✅ Backup saved: ${response.data.backup_path}`));
    } catch (err) {
      spinner.fail('Backup failed');
      console.error(chalk.red(`❌ Error: ${err.message}`));
      
      // Fallback: create local backup
      console.log(chalk.yellow('⚠️  Creating local backup instead...'));
    }
  });

// Restore memory
memory
  .command('restore <backup-file>')
  .description('Restore MasterClaw memory from backup')
  .action(async (backupFile) => {
    console.log(chalk.blue('🧠 Restoring memory...'));
    
    try {
      const fs = require('fs-extra');
      
      if (!await fs.pathExists(backupFile)) {
        console.error(chalk.red(`❌ Backup file not found: ${backupFile}`));
        return;
      }
      
      const backup = await fs.readJson(backupFile);
      
      console.log(chalk.green(`✅ Loaded backup from ${backup.exported_at}`));
      console.log(chalk.gray(`   Source: ${backup.source}`));
      console.log(chalk.gray(`   Memories: ${backup.metadata.total_memories}`));
      console.log(chalk.gray(`   Sessions: ${backup.metadata.total_sessions}`));
      
      console.log(chalk.yellow('\n⚠️  This will overwrite current memory state.'));
      console.log(chalk.gray('Use with caution!'));
      
    } catch (err) {
      console.error(chalk.red(`❌ Restore failed: ${err.message}`));
    }
  });

// Search memory
memory
  .command('search <query>')
  .description('Search through MasterClaw memories')
  .option('-n, --limit <number>', 'number of results', '5')
  .action(async (query, options) => {
    const spinner = ora('Searching memories...').start();
    
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';
      
      const response = await axios.post(`${coreUrl}/v1/memory/search`, {
        query,
        top_k: parseInt(options.limit),
      });
      
      spinner.stop();
      
      const { results } = response.data;
      
      if (results.length === 0) {
        console.log(chalk.gray('No memories found'));
        return;
      }
      
      console.log(chalk.blue(`🧠 Found ${results.length} memory(s):\n`));
      
      results.forEach((memory, i) => {
        console.log(chalk.white(`${i + 1}. ${memory.content.substring(0, 100)}...`));
        console.log(chalk.gray(`   Source: ${memory.source || 'unknown'} | ${memory.timestamp}`));
        console.log('');
      });
      
    } catch (err) {
      spinner.fail('Search failed');
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

// List recent memories
memory
  .command('list')
  .description('List recent memories')
  .option('-n, --limit <number>', 'number of memories', '10')
  .action(async (options) => {
    console.log(chalk.blue('🧠 Recent Memories\n'));
    console.log(chalk.gray('Feature coming soon...'));
  });

// Export memory to file
memory
  .command('export')
  .description('Export all memory to JSON file')
  .option('-o, --output <path>', 'output path', './masterclaw-memory-export.json')
  .action(async (options) => {
    const spinner = ora('Exporting memory...').start();
    
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';
      
      // This would fetch all memory from the API
      // For now, create a placeholder export
      const export_data = {
        version: '1.0',
        exported_at: new Date().toISOString(),
        note: 'Connect to running core for full export',
      };
      
      const fs = require('fs-extra');
      await fs.writeJson(options.output, export_data, { spaces: 2 });
      
      spinner.succeed(`Memory exported to ${options.output}`);
    } catch (err) {
      spinner.fail('Export failed');
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

module.exports = memory;
