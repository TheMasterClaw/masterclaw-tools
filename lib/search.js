// search.js - Search functionality for mc CLI

const { Command } = require('commander');
const chalk = require('chalk');
const config = require('./config');

const search = new Command('search');

// Search memories
search
  .command('memory <query>')
  .description('Search through memories')
  .option('-n, --limit <number>', 'number of results', '5')
  .action(async (query, options) => {
    console.log(chalk.blue(`🔍 Searching memories for "${query}"...\n`));
    
    try {
      const coreUrl = await config.get('core.url') || 'http://localhost:8000';
      const axios = require('axios');
      
      const response = await axios.post(`${coreUrl}/v1/memory/search`, {
        query,
        top_k: parseInt(options.limit),
      });
      
      const { results } = response.data;
      
      if (results.length === 0) {
        console.log(chalk.gray('No memories found'));
        return;
      }
      
      console.log(chalk.green(`Found ${results.length} memory(s):\n`));
      
      results.forEach((mem, i) => {
        console.log(chalk.white(`${i + 1}. ${mem.content.substring(0, 100)}...`));
        console.log(chalk.gray(`   Source: ${mem.source || 'unknown'}`));
        console.log('');
      });
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

// Search tasks
search
  .command('task <query>')
  .description('Search through tasks')
  .action(async (query) => {
    console.log(chalk.blue(`🔍 Searching tasks for "${query}"...\n`));
    
    try {
      const apiUrl = await config.get('api.url') || 'http://localhost:3001';
      const axios = require('axios');
      
      const response = await axios.get(`${apiUrl}/tasks`);
      const tasks = response.data.filter(t => 
        t.title.toLowerCase().includes(query.toLowerCase()) ||
        (t.description && t.description.toLowerCase().includes(query.toLowerCase()))
      );
      
      if (tasks.length === 0) {
        console.log(chalk.gray('No tasks found'));
        return;
      }
      
      console.log(chalk.green(`Found ${tasks.length} task(s):\n`));
      
      tasks.forEach(t => {
        const status = t.status === 'done' ? chalk.green('✅') : chalk.gray('⭕');
        console.log(`${status} ${t.title}`);
      });
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

module.exports = search;
