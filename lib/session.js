// session.js - Session management commands for mc CLI
// Connects to MasterClaw Core API session endpoints

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const ora = require('ora');
const config = require('./config');

const session = new Command('session');

// API helper with error handling
async function apiCall(method, endpoint, data = null, params = null) {
  const coreUrl = await config.get('core.url') || 'http://localhost:8000';
  const url = `${coreUrl}${endpoint}`;

  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      timeout: 30000,
    });
    return response.data;
  } catch (err) {
    if (err.response) {
      const { status, data } = err.response;
      if (status === 404) {
        throw new Error(`Session not found`);
      }
      if (status === 500) {
        throw new Error(data.detail || 'Server error');
      }
      throw new Error(data.detail || `HTTP ${status}`);
    }
    if (err.code === 'ECONNREFUSED') {
      throw new Error('Cannot connect to MasterClaw Core. Is it running? (mc revive)');
    }
    throw err;
  }
}

// Format relative time
function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Format duration
function formatDuration(minutes) {
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours}h ${mins}m`;
}

// List sessions
session
  .command('list')
  .description('List all chat sessions')
  .option('-n, --limit <number>', 'maximum sessions to show', '20')
  .option('--active-within <hours>', 'only sessions active within N hours')
  .option('--json', 'output as JSON')
  .action(async (options) => {
    const spinner = ora('Fetching sessions...').start();

    try {
      const params = {
        limit: parseInt(options.limit),
        offset: 0,
      };

      if (options.activeWithin) {
        params.active_since_hours = parseInt(options.activeWithin);
      }

      const data = await apiCall('GET', '/v1/sessions', null, params);
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (!data.sessions || data.sessions.length === 0) {
        console.log(chalk.gray('No sessions found'));
        return;
      }

      console.log(chalk.blue(`💬 Sessions (${data.total} total)\n`));

      // Table header
      console.log(
        chalk.gray(
          `${'ID'.padEnd(24)} ${'Messages'.padStart(8)} ${'Last Active'.padStart(12)} ${'Sources'.padStart(10)}`
        )
      );
      console.log(chalk.gray('─'.repeat(60)));

      data.sessions.forEach(s => {
        const id = s.session_id.substring(0, 22).padEnd(24);
        const msgCount = String(s.message_count).padStart(8);
        const lastActive = formatRelativeTime(s.last_active).padStart(12);
        const sources = (s.metadata?.sources?.join(',') || '-').substring(0, 8).padStart(10);

        console.log(`${id} ${msgCount} ${chalk.cyan(lastActive)} ${chalk.gray(sources)}`);
      });

      if (data.total > data.sessions.length) {
        console.log(chalk.gray(`\n... and ${data.total - data.sessions.length} more`));
      }

    } catch (err) {
      spinner.fail('Failed to fetch sessions');
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

// Show session details
session
  .command('show <session-id>')
  .description('Show session history and details')
  .option('-n, --limit <number>', 'number of messages to show', '50')
  .option('--json', 'output as JSON')
  .action(async (sessionId, options) => {
    const spinner = ora('Fetching session...').start();

    try {
      const data = await apiCall('GET', `/v1/sessions/${sessionId}`, null, {
        limit: parseInt(options.limit),
        offset: 0,
      });
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.blue(`💬 Session: ${sessionId.substring(0, 16)}...\n`));

      if (data.session_duration_minutes) {
        console.log(chalk.gray(`Duration: ${formatDuration(data.session_duration_minutes)}`));
      }
      console.log(chalk.gray(`Messages: ${data.total_messages}`));
      console.log('');

      // Display messages
      data.messages.forEach((msg, i) => {
        const time = new Date(msg.timestamp).toLocaleTimeString();
        const content = msg.content;

        // Try to parse User/Assistant format
        if (content.includes('User:') && content.includes('Assistant:')) {
          const userMatch = content.match(/User:\s*([^\n]+)/);
          const assistantMatch = content.match(/Assistant:\s*([\s\S]+)$/);

          if (userMatch) {
            console.log(chalk.yellow(`${time} 👤 You:`));
            console.log(`  ${userMatch[1].trim()}`);
            console.log('');
          }

          if (assistantMatch) {
            console.log(chalk.cyan(`${time} 🐾 MasterClaw:`));
            const response = assistantMatch[1].trim();
            // Wrap long lines
            const lines = response.split('\n');
            lines.forEach(line => {
              if (line.length > 80) {
                // Simple word wrap
                const words = line.split(' ');
                let currentLine = '  ';
                words.forEach(word => {
                  if (currentLine.length + word.length > 82) {
                    console.log(currentLine);
                    currentLine = `  ${  word  } `;
                  } else {
                    currentLine += `${word  } `;
                  }
                });
                if (currentLine.trim()) console.log(currentLine);
              } else {
                console.log(`  ${line}`);
              }
            });
            console.log('');
          }
        } else {
          // Raw content display
          console.log(chalk.gray(`${time} 📄:`));
          console.log(`  ${content.substring(0, 200)}${content.length > 200 ? '...' : ''}`);
          console.log('');
        }
      });

      if (data.total_messages > parseInt(options.limit)) {
        console.log(chalk.gray(`\n... and ${data.total_messages - parseInt(options.limit)} more messages`));
        console.log(chalk.gray(`Use --limit ${data.total_messages} to see all`));
      }

    } catch (err) {
      spinner.fail('Failed to fetch session');
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

// Delete session
session
  .command('delete <session-id>')
  .description('Delete a session and all its memories')
  .option('--force', 'skip confirmation')
  .action(async (sessionId, options) => {
    if (!options.force) {
      console.log(chalk.yellow('⚠️  This will permanently delete the session and all associated memories.'));
      console.log(chalk.gray(`   Session: ${sessionId}`));

      // Simple confirmation for non-interactive environments
      console.log(chalk.gray('   Use --force to skip this confirmation'));
      console.log('');
    }

    const spinner = ora('Deleting session...').start();

    try {
      const data = await apiCall('DELETE', `/v1/sessions/${sessionId}`);
      spinner.succeed(`Session deleted (${data.memories_deleted} memories removed)`);

    } catch (err) {
      spinner.fail('Failed to delete session');
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

// Session statistics
session
  .command('stats')
  .description('Show session statistics')
  .option('--json', 'output as JSON')
  .action(async (options) => {
    const spinner = ora('Fetching statistics...').start();

    try {
      const data = await apiCall('GET', '/v1/sessions/stats/summary');
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.blue('📊 Session Statistics\n'));

      console.log(`${chalk.white('Total Sessions:')}        ${chalk.cyan(data.total_sessions)}`);
      console.log(`${chalk.white('Total Messages:')}        ${chalk.cyan(data.total_messages)}`);
      console.log(`${chalk.white('Avg Messages/Session:')}  ${chalk.cyan(data.average_messages_per_session)}`);
      console.log('');
      console.log(`${chalk.white('Active (24h):')}          ${chalk.green(data.active_sessions_24h)}`);
      console.log(`${chalk.white('Active (7d):')}           ${chalk.green(data.active_sessions_7d)}`);
      console.log('');
      console.log(chalk.gray(`Last updated: ${new Date(data.timestamp).toLocaleString()}`));

    } catch (err) {
      spinner.fail('Failed to fetch statistics');
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

// Cleanup old sessions
session
  .command('cleanup')
  .description('Delete sessions older than specified days')
  .option('-d, --days <number>', 'delete sessions older than N days', '30')
  .option('--dry-run', 'show what would be deleted without deleting')
  .action(async (options) => {
    const days = parseInt(options.days);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    console.log(chalk.blue('🧹 Session Cleanup\n'));

    if (options.dryRun) {
      console.log(chalk.gray(`Would delete sessions older than ${days} days (before ${cutoffDate.toLocaleDateString()})`));
    } else {
      console.log(chalk.yellow(`Deleting sessions older than ${days} days...`));
    }

    const spinner = ora('Fetching sessions...').start();

    try {
      // Get all sessions
      const data = await apiCall('GET', '/v1/sessions', null, { limit: 500 });
      const oldSessions = data.sessions.filter(s => new Date(s.last_active) < cutoffDate);

      spinner.stop();

      if (oldSessions.length === 0) {
        console.log(chalk.green('✅ No old sessions to clean up'));
        return;
      }

      console.log(chalk.gray(`Found ${oldSessions.length} session(s) older than ${days} days\n`));

      if (options.dryRun) {
        oldSessions.forEach(s => {
          console.log(`  ${s.session_id.substring(0, 16)}... - ${s.message_count} messages, last active ${formatRelativeTime(s.last_active)}`);
        });
        console.log(chalk.gray(`\nUse without --dry-run to delete`));
        return;
      }

      // Delete sessions
      let deletedCount = 0;
      let totalMemories = 0;

      for (const s of oldSessions) {
        try {
          const result = await apiCall('DELETE', `/v1/sessions/${s.session_id}`);
          deletedCount++;
          totalMemories += result.memories_deleted;
          process.stdout.write(chalk.gray('.'));
        } catch (err) {
          process.stdout.write(chalk.red('✗'));
        }
      }

      console.log('');
      console.log(chalk.green(`✅ Deleted ${deletedCount} sessions (${totalMemories} memories removed)`));

    } catch (err) {
      spinner.fail('Cleanup failed');
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

module.exports = session;
