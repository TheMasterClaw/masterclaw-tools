// task.js - Task management commands for mc CLI

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const config = require('./config');

const task = new Command('task');

// List tasks
task
  .command('list')
  .description('List all tasks')
  .option('-s, --status <status>', 'filter by status')
  .option('-p, --priority <priority>', 'filter by priority')
  .action(async (options) => {
    try {
      const apiUrl = await config.get('api.url') || 'http://localhost:3001';
      
      const response = await axios.get(`${apiUrl}/tasks`);
      const tasks = response.data;
      
      if (tasks.length === 0) {
        console.log(chalk.gray('No tasks found'));
        return;
      }
      
      console.log(chalk.blue('📋 Tasks\n'));
      
      tasks.forEach(t => {
        const statusIcon = t.status === 'done' ? chalk.green('✅') :
                          t.status === 'in_progress' ? chalk.yellow('⏳') :
                          chalk.gray('⭕');
        const priority = t.priority === 'high' ? chalk.red('🔴') :
                        t.priority === 'low' ? chalk.blue('🔵') :
                        chalk.gray('⚪');
        
        console.log(`${statusIcon} ${priority} ${t.title}`);
        if (t.description) {
          console.log(chalk.gray(`   ${t.description.substring(0, 60)}...`));
        }
      });
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

// Add task
task
  .command('add <title>')
  .description('Add a new task')
  .option('-d, --description <desc>', 'task description')
  .option('-p, --priority <level>', 'priority (low/normal/high)', 'normal')
  .option('--due <date>', 'due date (YYYY-MM-DD)')
  .action(async (title, options) => {
    try {
      const apiUrl = await config.get('api.url') || 'http://localhost:3001';
      
      const task = {
        title,
        description: options.description,
        priority: options.priority,
        dueDate: options.due,
      };
      
      await axios.post(`${apiUrl}/tasks`, task);
      
      console.log(chalk.green(`✅ Task created: "${title}"`));
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

// Complete task
task
  .command('done <id>')
  .description('Mark task as complete')
  .action(async (id) => {
    try {
      const apiUrl = await config.get('api.url') || 'http://localhost:3001';
      
      await axios.patch(`${apiUrl}/tasks/${id}`, { status: 'done' });
      
      console.log(chalk.green(`✅ Task ${id} marked as done`));
      
    } catch (err) {
      console.error(chalk.red(`❌ Error: ${err.message}`));
    }
  });

module.exports = task;
