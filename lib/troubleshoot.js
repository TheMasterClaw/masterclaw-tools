/**
 * Troubleshooting Guide and Diagnostic Assistant for MasterClaw CLI
 *
 * Provides interactive troubleshooting for common MasterClaw issues.
 * Offers guided diagnostics, solutions, and preventive recommendations.
 *
 * Features:
 * - Interactive troubleshooting wizard
 * - Common issue database with solutions
 * - Diagnostic command suggestions
 * - Integration with existing mc commands
 */

const { Command } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { spawn } = require('child_process');

const { wrapCommand, ExitCode } = require('./error-handler');

const troubleshootCmd = new Command('troubleshoot').alias('fix');

// =============================================================================
// Issue Database
// =============================================================================

const ISSUES = {
  'services-down': {
    title: 'Services Not Starting',
    symptoms: [
      'Docker containers keep restarting',
      'mc status shows services as down',
      'Cannot access the web interface',
      'Connection refused errors'
    ],
    severity: 'critical',
    category: 'docker',
    diagnosis: [
      'Check Docker daemon: docker ps',
      'View service logs: mc logs <service>',
      'Check port conflicts: lsof -i :80, :443',
      'Verify environment variables: mc env check'
    ],
    solutions: [
      {
        title: 'Restart Docker daemon',
        command: 'sudo systemctl restart docker',
        description: 'Docker daemon may be unresponsive'
      },
      {
        title: 'Restart all services',
        command: 'mc revive',
        description: 'Restart MasterClaw services'
      },
      {
        title: 'Check for port conflicts',
        command: 'sudo lsof -i :80 && sudo lsof -i :443',
        description: 'Other services may be using required ports'
      },
      {
        title: 'Validate environment',
        command: 'mc validate',
        description: 'Check for configuration issues'
      }
    ],
    prevention: [
      'Set up automated health checks with mc health --watch',
      'Configure notifications with mc notify',
      'Regular backups with mc backup'
    ]
  },

  'ssl-cert-issues': {
    title: 'SSL Certificate Problems',
    symptoms: [
      'Browser shows certificate warning',
      'HTTPS not working',
      'Traefik shows certificate errors',
      'LetsEncrypt validation failed'
    ],
    severity: 'high',
    category: 'ssl',
    diagnosis: [
      'Check certificate status: mc ssl check',
      'Verify domain DNS: nslookup <domain>',
      'Check Traefik logs: mc logs traefik',
      'Verify DOMAIN environment variable'
    ],
    solutions: [
      {
        title: 'Force SSL renewal',
        command: 'mc ssl renew',
        description: 'Force certificate renewal'
      },
      {
        title: 'Check DNS configuration',
        command: 'nslookup $(grep DOMAIN .env | cut -d= -f2)',
        description: 'Ensure domain points to this server'
      },
      {
        title: 'Verify port 80 is open',
        command: 'sudo ufw status && sudo ufw allow 80/tcp',
        description: 'LetsEncrypt requires port 80 for validation'
      }
    ],
    prevention: [
      'Enable SSL monitoring: mc ssl monitor --install',
      'Set up expiration alerts',
      'Test SSL regularly with mc ssl check'
    ]
  },

  'high-memory-usage': {
    title: 'High Memory Usage',
    symptoms: [
      'System running slow',
      'Out of memory errors',
      'Services being killed by OOM',
      'High memory usage in mc top'
    ],
    severity: 'high',
    category: 'performance',
    diagnosis: [
      'Check resource usage: mc top',
      'Analyze memory by service: docker stats',
      'Check for memory leaks in logs',
      'Review session counts: mc session stats'
    ],
    solutions: [
      {
        title: 'Clean up old sessions',
        command: 'mc cleanup --days 30',
        description: 'Remove old sessions to free memory'
      },
      {
        title: 'Restart memory-intensive services',
        command: 'mc restart core',
        description: 'Restart AI Core to free memory'
      },
      {
        title: 'Run maintenance',
        command: 'mc maintenance',
        description: 'Comprehensive cleanup and optimization'
      },
      {
        title: 'Prune Docker resources',
        command: 'mc prune --volumes --images',
        description: 'Remove unused Docker resources'
      }
    ],
    prevention: [
      'Schedule regular cleanup: mc maintenance',
      'Set up memory alerts',
      'Monitor trends with mc metrics --watch'
    ]
  },

  'database-issues': {
    title: 'Database Connection Problems',
    symptoms: [
      'Cannot save memories',
      'Session data not persisting',
      'SQLite/ChromaDB errors in logs',
      'Disk full errors'
    ],
    severity: 'critical',
    category: 'database',
    diagnosis: [
      'Check disk space: df -h',
      'View database logs: mc logs core',
      'Check file permissions: ls -la data/',
      'Verify ChromaDB health'
    ],
    solutions: [
      {
        title: 'Check disk space',
        command: 'df -h && mc size',
        description: 'Ensure sufficient disk space'
      },
      {
        title: 'Fix permissions',
        command: 'sudo chown -R $(whoami):$(whoami) data/',
        description: 'Fix data directory permissions'
      },
      {
        title: 'Restart database service',
        command: 'mc restart core',
        description: 'Restart ChromaDB/Core'
      },
      {
        title: 'Run database maintenance',
        command: 'mc migrate',
        description: 'Run pending migrations'
      }
    ],
    prevention: [
      'Monitor disk usage with alerts',
      'Regular backups: mc backup',
      'Clean up old data: mc cleanup'
    ]
  },

  'llm-api-errors': {
    title: 'LLM API Connection Errors',
    symptoms: [
      'AI not responding',
      'OpenAI/Anthropic errors in logs',
      'Rate limit exceeded messages',
      'High error rates in mc analyze'
    ],
    severity: 'high',
    category: 'api',
    diagnosis: [
      'Check API key validity: mc secrets validate OPENAI_API_KEY',
      'View cost status: mc cost',
      'Check rate limits in logs',
      'Test API connectivity'
    ],
    solutions: [
      {
        title: 'Validate API keys',
        command: 'mc secrets validate OPENAI_API_KEY && mc secrets validate ANTHROPIC_API_KEY',
        description: 'Verify API keys are valid'
      },
      {
        title: 'Check cost limits',
        command: 'mc cost',
        description: 'Check if budget exceeded'
      },
      {
        title: 'Rotate API keys',
        command: 'mc secrets rotate OPENAI_API_KEY',
        description: 'Rotate to fresh API key'
      },
      {
        title: 'Check service logs',
        command: 'mc logs core --follow',
        description: 'View detailed error messages'
      }
    ],
    prevention: [
      'Set up cost alerts: mc cost budget-monitor --enable',
      'Monitor API errors with mc analyze',
      'Keep backup API keys in mc secrets'
    ]
  },

  'backup-failures': {
    title: 'Backup Not Working',
    symptoms: [
      'mc backup fails',
      'Cloud backup not uploading',
      'Backup files corrupted',
      'Out of disk space during backup'
    ],
    severity: 'medium',
    category: 'backup',
    diagnosis: [
      'Check disk space: df -h',
      'Verify cloud credentials: mc backup cloud test',
      'Check backup logs',
      'Verify backup directory permissions'
    ],
    solutions: [
      {
        title: 'Test cloud connection',
        command: 'mc backup cloud test',
        description: 'Verify cloud credentials'
      },
      {
        title: 'Clean up old backups',
        command: 'mc backup cleanup',
        description: 'Free up space'
      },
      {
        title: 'Verify backup integrity',
        command: 'mc backup-verify',
        description: 'Check backup files are valid'
      },
      {
        title: 'Check disk space',
        command: 'mc size',
        description: 'Ensure enough space for backup'
      }
    ],
    prevention: [
      'Schedule automated backups',
      'Set up backup verification: mc backup-verify schedule install',
      'Monitor backup status regularly'
    ]
  },

  'slow-performance': {
    title: 'Slow Response Times',
    symptoms: [
      'AI responses taking too long',
      'Web interface loading slowly',
      'High latency in mc performance',
      'Timeouts during requests'
    ],
    severity: 'medium',
    category: 'performance',
    diagnosis: [
      'Check performance metrics: mc performance',
      'View slowest endpoints: mc performance --slowest 10',
      'Check resource usage: mc top',
      'Run benchmarks: mc benchmark'
    ],
    solutions: [
      {
        title: 'Check performance metrics',
        command: 'mc performance --stats',
        description: 'Identify slow endpoints'
      },
      {
        title: 'Run diagnostics',
        command: 'mc doctor --category performance',
        description: 'Performance-specific diagnostics'
      },
      {
        title: 'Restart services',
        command: 'mc restart',
        description: 'Clear any stuck processes'
      },
      {
        title: 'Check for resource limits',
        command: 'mc top',
        description: 'Verify CPU/memory availability'
      }
    ],
    prevention: [
      'Regular benchmarking: mc benchmark',
      'Performance monitoring: mc performance --watch',
      'Capacity planning based on metrics'
    ]
  },

  'notification-issues': {
    title: 'Notifications Not Working',
    symptoms: [
      'Alerts not being sent',
      'Webhook not receiving events',
      'Discord/Slack not receiving messages',
      'Test notifications fail'
    ],
    severity: 'low',
    category: 'notifications',
    diagnosis: [
      'Test notifications: mc notify test',
      'Check webhook status: mc notify status',
      'Verify configuration in .env',
      'Check network connectivity'
    ],
    solutions: [
      {
        title: 'Test all channels',
        command: 'mc notify test',
        description: 'Test notification channels'
      },
      {
        title: 'Check configuration',
        command: 'mc notify status',
        description: 'Verify notification settings'
      },
      {
        title: 'Restart webhook server',
        command: 'mc notify restart',
        description: 'Restart notification service'
      }
    ],
    prevention: [
      'Test notifications after configuration changes',
      'Monitor webhook logs',
      'Set up redundant notification channels'
    ]
  }
};

// =============================================================================
// Utility Functions
// =============================================================================

function getIssuesByCategory(category) {
  return Object.entries(ISSUES)
    .filter(([_, issue]) => issue.category === category)
    .map(([key, issue]) => ({ key, ...issue }));
}

function getAllCategories() {
  const categories = new Set(Object.values(ISSUES).map(i => i.category));
  return Array.from(categories);
}

function formatSeverity(severity) {
  const colors = {
    critical: chalk.red.bold,
    high: chalk.red,
    medium: chalk.yellow,
    low: chalk.gray
  };
  return colors[severity] ? colors[severity](severity.toUpperCase()) : severity;
}

async function runCommand(command) {
  return new Promise((resolve) => {
    const parts = command.split(' ');
    const child = spawn(parts[0], parts.slice(1), {
      stdio: 'inherit',
      shell: true
    });
    
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Interactive troubleshooting wizard
 */
troubleshootCmd
  .command('wizard')
  .description('Interactive troubleshooting wizard')
  .action(wrapCommand(async () => {
    console.log(chalk.bold('🐾 MasterClaw Troubleshooting Wizard'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    // Step 1: Choose category
    const categories = getAllCategories();
    const { category } = await inquirer.prompt([
      {
        type: 'list',
        name: 'category',
        message: 'What area are you having issues with?',
        choices: [
          ...categories.map(c => ({ name: c.charAt(0).toUpperCase() + c.slice(1), value: c })),
          { name: 'Not sure / General issue', value: 'all' }
        ]
      }
    ]);

    // Step 2: Show relevant issues
    const relevantIssues = category === 'all' 
      ? Object.entries(ISSUES).map(([key, issue]) => ({ key, ...issue }))
      : getIssuesByCategory(category);

    if (relevantIssues.length === 0) {
      console.log(chalk.yellow('No specific issues found for this category.'));
      console.log(chalk.gray('Try running: mc troubleshoot guide'));
      return;
    }

    const { issueKey } = await inquirer.prompt([
      {
        type: 'list',
        name: 'issueKey',
        message: 'Which issue matches your problem?',
        choices: relevantIssues.map(i => ({
          name: `${i.title} ${formatSeverity(i.severity)}`,
          value: i.key
        }))
      }
    ]);

    const issue = ISSUES[issueKey];

    // Display issue details
    console.log();
    console.log(chalk.bold(issue.title));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    console.log(chalk.bold('Symptoms:'));
    issue.symptoms.forEach(s => console.log(`  • ${s}`));
    console.log();

    console.log(chalk.bold('Diagnosis Steps:'));
    issue.diagnosis.forEach((d, i) => console.log(`  ${i + 1}. ${d}`));
    console.log();

    // Step 3: Offer solutions
    console.log(chalk.bold('Suggested Solutions:'));
    const { solution } = await inquirer.prompt([
      {
        type: 'list',
        name: 'solution',
        message: 'Which solution would you like to try?',
        choices: [
          ...issue.solutions.map((s, i) => ({
            name: `${s.title} - ${s.description}`,
            value: i
          })),
          { name: 'None - show me all options', value: 'all' },
          { name: 'Contact support', value: 'support' }
        ]
      }
    ]);

    if (solution === 'all') {
      console.log();
      issue.solutions.forEach((s, i) => {
        console.log(`${chalk.bold(`${i + 1}. ${s.title}`)}`);
        console.log(`   ${chalk.gray(s.description)}`);
        console.log(`   ${chalk.cyan(s.command)}`);
        console.log();
      });
    } else if (solution === 'support') {
      console.log();
      console.log(chalk.bold('Support Resources:'));
      console.log('  • GitHub Issues: https://github.com/TheMasterClaw/masterclaw-infrastructure/issues');
      console.log('  • Documentation: mc docs');
      console.log('  • Health Check: mc health');
    } else {
      const selected = issue.solutions[solution];
      console.log();
      console.log(chalk.bold(`Running: ${selected.title}`));
      console.log(chalk.gray(selected.description));
      console.log(chalk.cyan(`Command: ${selected.command}`));
      console.log();

      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Execute this command?',
          default: true
        }
      ]);

      if (confirm) {
        console.log();
        await runCommand(selected.command);
      }
    }

    // Show prevention tips
    console.log();
    console.log(chalk.bold('Prevention Tips:'));
    issue.prevention.forEach(p => console.log(`  • ${p}`));
  }));

/**
 * List common issues
 */
troubleshootCmd
  .command('list')
  .description('List all common issues and solutions')
  .option('-c, --category <category>', 'Filter by category')
  .option('-s, --severity <severity>', 'Filter by severity (critical, high, medium, low)')
  .action(wrapCommand(async (options) => {
    console.log(chalk.bold('🐾 Common MasterClaw Issues'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    let issues = Object.entries(ISSUES).map(([key, issue]) => ({ key, ...issue }));

    if (options.category) {
      issues = issues.filter(i => i.category === options.category);
    }

    if (options.severity) {
      issues = issues.filter(i => i.severity === options.severity);
    }

    // Group by severity
    const bySeverity = {};
    issues.forEach(i => {
      if (!bySeverity[i.severity]) bySeverity[i.severity] = [];
      bySeverity[i.severity].push(i);
    });

    ['critical', 'high', 'medium', 'low'].forEach(severity => {
      if (bySeverity[severity]) {
        console.log(formatSeverity(severity));
        bySeverity[severity].forEach(issue => {
          console.log(`  ${chalk.cyan(issue.key.padEnd(20))} ${issue.title}`);
          console.log(`  ${''.padEnd(20)} ${chalk.gray(`Category: ${issue.category}`)}`);
        });
        console.log();
      }
    });

    console.log(chalk.gray(`Total: ${issues.length} issues`));
    console.log(chalk.gray('Run: mc troubleshoot guide <issue-key> for details'));
  }));

/**
 * Show detailed guide for a specific issue
 */
troubleshootCmd
  .command('guide <issue>')
  .description('Show detailed troubleshooting guide for an issue')
  .action(wrapCommand(async (issueKey) => {
    const issue = ISSUES[issueKey];

    if (!issue) {
      console.log(chalk.red(`❌ Unknown issue: ${issueKey}`));
      console.log(chalk.gray('Run: mc troubleshoot list to see available issues'));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    console.log(chalk.bold(`🐾 ${issue.title}`));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    console.log(`Severity: ${formatSeverity(issue.severity)}`);
    console.log(`Category: ${chalk.cyan(issue.category)}`);
    console.log();

    console.log(chalk.bold('Symptoms:'));
    issue.symptoms.forEach(s => console.log(`  • ${s}`));
    console.log();

    console.log(chalk.bold('Diagnosis Steps:'));
    issue.diagnosis.forEach((d, i) => {
      console.log(`  ${i + 1}. ${d}`);
    });
    console.log();

    console.log(chalk.bold('Solutions:'));
    issue.solutions.forEach((s, i) => {
      console.log(`${chalk.bold(`${i + 1}. ${s.title}`)}`);
      console.log(`   ${chalk.gray(s.description)}`);
      console.log(`   ${chalk.cyan(`Command: ${s.command}`)}`);
      console.log();
    });

    console.log(chalk.bold('Prevention:'));
    issue.prevention.forEach(p => console.log(`  • ${p}`));
  }));

/**
 * Quick diagnostic command
 */
troubleshootCmd
  .command('diagnose')
  .description('Run quick diagnostic checks')
  .action(wrapCommand(async () => {
    console.log(chalk.bold('🐾 Running Quick Diagnostics'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    const checks = [
      { name: 'Docker daemon', command: 'docker ps' },
      { name: 'MasterClaw status', command: 'mc status' },
      { name: 'Disk space', command: 'df -h /' },
      { name: 'Memory usage', command: 'free -h' },
    ];

    for (const check of checks) {
      process.stdout.write(`${check.name.padEnd(20)} `);
      try {
        const { execSync } = require('child_process');
        execSync(check.command, { stdio: 'pipe', timeout: 10000 });
        console.log(chalk.green('✅ OK'));
      } catch (error) {
        console.log(chalk.red('❌ Failed'));
      }
    }

    console.log();
    console.log(chalk.gray('Run: mc troubleshoot wizard for guided help'));
  }));

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  troubleshootCmd,
  ISSUES,
  getIssuesByCategory,
  getAllCategories,
  formatSeverity,
};
