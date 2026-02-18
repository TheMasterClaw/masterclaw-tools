// completion.js - Shell completion support for mc CLI
// Generates auto-completion scripts for bash, zsh, and fish

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const completion = new Command('completion');

// Service names for completion
const SERVICES = ['traefik', 'interface', 'backend', 'core', 'gateway', 'chroma', 'watchtower', 'all'];

// All mc commands for completion
const COMMANDS = [
  'status', 'logs', 'backup', 'restore', 'config', 'revive', 'update',
  'heal', 'doctor', 'chat', 'export', 'config-audit', 'config-fix',
  'memory', 'task', 'deploy', 'health', 'ssl', 'dashboard', 'completion', 'cleanup',
  'audit', 'audit-verify', 'context'
];

// Command-specific arguments
const COMMAND_ARGS = {
  'logs': SERVICES,
  'backup': ['list', 'stats', 'cleanup', 'export', '--retention-days', '--force', '--dry-run', '-r', '-f', '-d'],
  'deploy': ['rolling', 'canary', 'rollback', 'status', 'history'],
  'health': ['--watch', '--notify', '--compact'],
  'doctor': ['--category', '--fix', '--json', '-c', '-j'],
  'ssl': ['check', 'renew'],
  'dashboard': ['--all', 'open', 'grafana', 'prometheus', 'loki'],
  'memory': ['backup', 'restore', 'search', 'list', 'export'],
  'task': ['list', 'add', 'done', 'delete'],
  'cleanup': ['status', 'schedule', '--days', '--dry-run', '--force'],
  'audit': ['--limit', '-n', '--type', '-t', '--severity', '-s', '--hours', '--summary', '--json', '--search', '--verify'],
  'audit-verify': ['--verbose', '-v', '--hours', '--rotate-key'],
  'context': ['status', 'show', 'export', 'import', 'edit', 'preferences', 'goals', 'projects', 'people', 'knowledge', '--json', '--raw', '--output', '--include-sessions', '--dry-run'],
};

// Generate bash completion script
function generateBashCompletion() {
  return `#!/bin/bash
# MasterClaw CLI (mc) Bash Completion
# Generated automatically - do not edit manually
# Source this file or place it in /etc/bash_completion.d/ or ~/.local/share/bash-completion/completions/

_mc_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    
    # Top-level commands
    local commands="${COMMANDS.join(' ')}"
    
    # Global options
    local global_opts="-v --verbose -i --infra-dir -V --version -h --help"
    
    # Complete based on previous word
    case "\${prev}" in
        mc)
            COMPREPLY=( $(compgen -W "\${commands} \${global_opts}" -- \${cur}) )
            return 0
            ;;
        logs)
            local services="${SERVICES.join(' ')}"
            local logs_opts="-f --follow -n --lines -s --since --tail"
            COMPREPLY=( $(compgen -W "\${services} \${logs_opts}" -- \${cur}) )
            return 0
            ;;
        deploy)
            local deploy_cmds="rolling canary rollback status history"
            local deploy_opts="-f --force --skip-tests"
            COMPREPLY=( $(compgen -W "\${deploy_cmds} \${deploy_opts}" -- \${cur}) )
            return 0
            ;;
        health)
            local health_opts="--watch --notify --compact"
            COMPREPLY=( $(compgen -W "\${health_opts}" -- \${cur}) )
            return 0
            ;;
        ssl)
            local ssl_cmds="check renew"
            COMPREPLY=( $(compgen -W "\${ssl_cmds}" -- \${cur}) )
            return 0
            ;;
        dashboard)
            local dashboard_cmds="open"
            local dashboard_opts="--all"
            COMPREPLY=( $(compgen -W "\${dashboard_cmds} grafana prometheus loki \${dashboard_opts}" -- \${cur}) )
            return 0
            ;;
        memory)
            local memory_cmds="backup restore search list export"
            local memory_opts="-o --output -n --limit"
            COMPREPLY=( $(compgen -W "\${memory_cmds} \${memory_opts}" -- \${cur}) )
            return 0
            ;;
        task)
            local task_cmds="list add done delete"
            COMPREPLY=( $(compgen -W "\${task_cmds}" -- \${cur}) )
            return 0
            ;;
        audit)
            local audit_opts="-n --limit -t --type -s --severity --hours --summary --json --search --verify"
            COMPREPLY=( $(compgen -W "\${audit_opts}" -- \${cur}) )
            return 0
            ;;
        audit-verify)
            local audit_verify_opts="-v --verbose --hours --rotate-key"
            COMPREPLY=( $(compgen -W "\${audit_verify_opts}" -- \${cur}) )
            return 0
            ;;
        context)
            local context_cmds="status show export import edit"
            local context_topics="preferences goals projects people knowledge"
            local context_opts="--json --raw --output --include-sessions --dry-run"
            COMPREPLY=( $(compgen -W "\${context_cmds} \${context_topics} \${context_opts}" -- \${cur}) )
            return 0
            ;;
        completion)
            local shells="bash zsh fish"
            local comp_opts="--install --print"
            COMPREPLY=( $(compgen -W "\${shells} \${comp_opts}" -- \${cur}) )
            return 0
            ;;
        -i|--infra-dir)
            # Complete directories for infra-dir
            COMPREPLY=( $(compgen -d -- \${cur}) )
            return 0
            ;;
        restore)
            # Complete JSON files for restore
            COMPREPLY=( $(compgen -f -X '!*.json' -- \${cur}) )
            return 0
            ;;
        search)
            # No specific completions for search query
            return 0
            ;;
    esac
    
    # Default: offer commands and global options
    COMPREPLY=( $(compgen -W "\${commands} \${global_opts}" -- \${cur}) )
}

complete -F _mc_completion mc
`;
}

// Generate zsh completion script
function generateZshCompletion() {
  return `#compdef mc
# MasterClaw CLI (mc) Zsh Completion
# Generated automatically - do not edit manually
# Place this file in a directory in your \$fpath (e.g., /usr/local/share/zsh/site-functions/)

_mc() {
    local curcontext="$curcontext" state line
    typeset -A opt_args
    
    _arguments -C \\
        '(-v --verbose)'{-v,--verbose}'[Enable verbose output]' \\
        '(-i --infra-dir)'{-i,--infra-dir}'[Path to infrastructure directory]:directory:_directories' \\
        '(-V --version)'{-V,--version}'[Show version]' \\
        '(-h --help)'{-h,--help}'[Show help]' \\
        '1: :_mc_commands' \\
        '*:: :->args'
    
    case "$state" in
        args)
            case "$line[1]" in
                logs)
                    _arguments \\
                        '(-f --follow)'{-f,--follow}'[Follow log output]' \\
                        '(-n --lines)'{-n,--lines}'[Number of lines to show]:lines:' \\
                        '(-s --since)'{-s,--since}'[Show logs since duration]:duration:' \\
                        '--tail[Alias for --lines]:lines:' \\
                        '1: :_mc_services'
                    ;;
                deploy)
                    _arguments \\
                        '(-f --force)'{-f,--force}'[Force deployment]' \\
                        '--skip-tests[Skip pre-deployment tests]' \\
                        '1: :_mc_deploy_commands' \\
                        '2:: :_mc_deploy_args'
                    ;;
                health)
                    _arguments \\
                        '--watch[Continuous monitoring]' \\
                        '--notify[Desktop notifications]' \\
                        '--compact[Cron-friendly output]'
                    ;;
                ssl)
                    _arguments '1: :_mc_ssl_commands'
                    ;;
                dashboard)
                    _arguments \\
                        '--all[Open all dashboards]' \\
                        '1: :_mc_dashboard_commands'
                    ;;
                memory)
                    _arguments \\
                        '(-o --output)'{-o,--output}'[Output path]:file:_files' \\
                        '(-n --limit)'{-n,--limit}'[Number of results]:number:' \\
                        '1: :_mc_memory_commands'
                    ;;
                task)
                    _arguments '1: :_mc_task_commands'
                    ;;
                cleanup)
                    _arguments \
                        '(-d --days)'{-d,--days}'[Retention period in days]:days:' \
                        '--dry-run[Preview without deleting]' \
                        '(-f --force)'{-f,--force}'[Skip confirmation]' \
                        '1: :_mc_cleanup_commands'
                    ;;
                completion)
                    _arguments \\
                        '--install[Install completion to shell config]' \\
                        '--print[Print completion script]' \\
                        '1: :_mc_shells'
                    ;;
                restore)
                    _arguments '1:file:_files -g "*.json"'
                    ;;
                context)
                    _arguments \
                        '--json[Output as JSON]' \
                        '--raw[Show raw markdown content]' \
                        '--output[Output file path]:file:_files' \
                        '--include-sessions[Include session backups]' \
                        '--dry-run[Preview without making changes]' \
                        '1: :_mc_context_commands' \
                        '2:: :_mc_context_topics'
                    ;;
            esac
            ;;
    esac
}

_mc_commands() {
    local commands=(
        ${COMMANDS.map(c => `"${c}:${getCommandDescription(c)}"`).join('\n        ')}
    )
    _describe -t commands 'mc commands' commands
}

_mc_services() {
    local services=(
        ${SERVICES.map(s => `"${s}:${getServiceDescription(s)}"`).join('\n        ')}
    )
    _describe -t services 'services' services
}

_mc_deploy_commands() {
    local commands=(
        'rolling:Zero-downtime blue-green deployment'
        'canary:Canary deployment with traffic percentage'
        'rollback:Rollback to previous version'
        'status:Show deployment status'
        'history:Show deployment history'
    )
    _describe -t commands 'deploy commands' commands
}

_mc_ssl_commands() {
    local commands=(
        'check:Check SSL certificate expiration'
        'renew:Force SSL certificate renewal'
    )
    _describe -t commands 'ssl commands' commands
}

_mc_dashboard_commands() {
    local commands=(
        'open:Open a specific dashboard'
        'grafana:Open Grafana'
        'prometheus:Open Prometheus'
        'loki:Open Loki'
    )
    _describe -t commands 'dashboard commands' commands
}

_mc_memory_commands() {
    local commands=(
        'backup:Create memory backup'
        'restore:Restore from backup'
        'search:Search memories'
        'list:List recent memories'
        'export:Export memory to JSON'
    )
    _describe -t commands 'memory commands' commands
}

_mc_task_commands() {
    local commands=(
        'list:List tasks'
        'add:Add a task'
        'done:Complete a task'
        'delete:Delete a task'
    )
    _describe -t commands 'task commands' commands
}

_mc_cleanup_commands() {
    local commands=(
        'status:Show cleanup status and recommendations'
        'schedule:Show cron scheduling examples'
    )
    _describe -t commands 'cleanup commands' commands
}

_mc_context_commands() {
    local commands=(
        'status:Show context status and summary'
        'show:Display context details'
        'export:Export rex-deus context for backup'
        'import:Import rex-deus context from backup'
        'edit:Edit a context file in default editor'
    )
    _describe -t commands 'context commands' commands
}

_mc_context_topics() {
    local topics=(
        'preferences:Rex\'s preferences and communication style'
        'goals:Short, medium, and long-term goals'
        'projects:Current and side projects'
        'people:People and relationships'
        'knowledge:Domain knowledge base'
    )
    _describe -t topics 'context topics' topics
}

_mc_shells() {
    local shells=(
        'bash:Bourne Again Shell'
        'zsh:Z Shell'
        'fish:Friendly Interactive Shell'
    )
    _describe -t shells 'shells' shells
}

_mc "$@"
`;
}

// Helper functions for descriptions
function getCommandDescription(cmd) {
  const descriptions = {
    'status': 'Check health of all services',
    'logs': 'View and manage service logs',
    'backup': 'Create backup of data',
    'restore': 'Restore from backup',
    'config': 'Manage configuration',
    'revive': 'Restart all services',
    'update': 'Check for updates',
    'heal': 'Self-heal common issues',
    'doctor': 'Run comprehensive diagnostics',
    'chat': 'Send message to MasterClaw',
    'export': 'Export all data',
    'config-audit': 'Security audit on config',
    'config-fix': 'Fix config permissions',
    'memory': 'Memory management commands',
    'task': 'Task management commands',
    'deploy': 'Deployment management',
    'health': 'Health monitoring',
    'ssl': 'SSL certificate management',
    'dashboard': 'Open monitoring dashboards',
    'completion': 'Generate shell completion',
    'cleanup': 'Clean up old sessions and memories',
    'context': 'Manage rex-deus context and preferences',
  };
  return descriptions[cmd] || 'MasterClaw command';
}

function getServiceDescription(svc) {
  const descriptions = {
    'traefik': 'Reverse proxy and SSL',
    'interface': 'React frontend',
    'backend': 'Node.js API',
    'core': 'AI Core (Python)',
    'gateway': 'OpenClaw Gateway',
    'chroma': 'Vector database',
    'watchtower': 'Auto-updates',
    'all': 'All services',
  };
  return descriptions[svc] || 'Service';
}

// Generate fish completion script
function generateFishCompletion() {
  const commandCompletions = COMMANDS.map(cmd =>
    `complete -c mc -n "__fish_use_subcommand" -a "${cmd}" -d "${getCommandDescription(cmd)}"`
  ).join('\n');

  const serviceCompletions = SERVICES.map(svc =>
    `complete -c mc -n "__fish_seen_subcommand_from logs" -a "${svc}" -d "${getServiceDescription(svc)}"`
  ).join('\n');

  return `# MasterClaw CLI (mc) Fish Completion
# Generated automatically - do not edit manually
# Place this file in ~/.config/fish/completions/mc.fish

# Global options
complete -c mc -s v -l verbose -d "Enable verbose output"
complete -c mc -s i -l infra-dir -d "Path to infrastructure directory" -r
complete -c mc -s V -l version -d "Show version"
complete -c mc -s h -l help -d "Show help"

# Commands
${commandCompletions}

# Logs command services
${serviceCompletions}

# Logs options
complete -c mc -n "__fish_seen_subcommand_from logs" -s f -l follow -d "Follow log output"
complete -c mc -n "__fish_seen_subcommand_from logs" -s n -l lines -d "Number of lines" -r
complete -c mc -n "__fish_seen_subcommand_from logs" -s s -l since -d "Show logs since duration" -r
complete -c mc -n "__fish_seen_subcommand_from logs" -l tail -d "Alias for --lines" -r

# Deploy subcommands
complete -c mc -n "__fish_seen_subcommand_from deploy" -a "rolling" -d "Zero-downtime deployment"
complete -c mc -n "__fish_seen_subcommand_from deploy" -a "canary" -d "Canary deployment"
complete -c mc -n "__fish_seen_subcommand_from deploy" -a "rollback" -d "Rollback deployment"
complete -c mc -n "__fish_seen_subcommand_from deploy" -a "status" -d "Show deployment status"
complete -c mc -n "__fish_seen_subcommand_from deploy" -a "history" -d "Show deployment history"
complete -c mc -n "__fish_seen_subcommand_from deploy" -s f -l force -d "Force deployment"
complete -c mc -n "__fish_seen_subcommand_from deploy" -l skip-tests -d "Skip pre-deployment tests"

# Health options
complete -c mc -n "__fish_seen_subcommand_from health" -l watch -d "Continuous monitoring"
complete -c mc -n "__fish_seen_subcommand_from health" -l notify -d "Desktop notifications"
complete -c mc -n "__fish_seen_subcommand_from health" -l compact -d "Cron-friendly output"

# SSL subcommands
complete -c mc -n "__fish_seen_subcommand_from ssl" -a "check" -d "Check SSL expiration"
complete -c mc -n "__fish_seen_subcommand_from ssl" -a "renew" -d "Force SSL renewal"

# Dashboard options
complete -c mc -n "__fish_seen_subcommand_from dashboard" -l all -d "Open all dashboards"
complete -c mc -n "__fish_seen_subcommand_from dashboard" -a "open" -d "Open specific dashboard"
complete -c mc -n "__fish_seen_subcommand_from dashboard" -a "grafana" -d "Open Grafana"
complete -c mc -n "__fish_seen_subcommand_from dashboard" -a "prometheus" -d "Open Prometheus"
complete -c mc -n "__fish_seen_subcommand_from dashboard" -a "loki" -d "Open Loki"

# Memory subcommands
complete -c mc -n "__fish_seen_subcommand_from memory" -a "backup" -d "Create memory backup"
complete -c mc -n "__fish_seen_subcommand_from memory" -a "restore" -d "Restore from backup"
complete -c mc -n "__fish_seen_subcommand_from memory" -a "search" -d "Search memories"
complete -c mc -n "__fish_seen_subcommand_from memory" -a "list" -d "List recent memories"
complete -c mc -n "__fish_seen_subcommand_from memory" -a "export" -d "Export memory to JSON"
complete -c mc -n "__fish_seen_subcommand_from memory" -s o -l output -d "Output path" -r
complete -c mc -n "__fish_seen_subcommand_from memory" -s n -l limit -d "Number of results" -r

# Task subcommands
complete -c mc -n "__fish_seen_subcommand_from task" -a "list" -d "List tasks"
complete -c mc -n "__fish_seen_subcommand_from task" -a "add" -d "Add a task"
complete -c mc -n "__fish_seen_subcommand_from task" -a "done" -d "Complete a task"
complete -c mc -n "__fish_seen_subcommand_from task" -a "delete" -d "Delete a task"

# Cleanup subcommands
complete -c mc -n "__fish_seen_subcommand_from cleanup" -a "status" -d "Show cleanup status"
complete -c mc -n "__fish_seen_subcommand_from cleanup" -a "schedule" -d "Show scheduling info"
complete -c mc -n "__fish_seen_subcommand_from cleanup" -s d -l days -d "Retention period in days" -r
complete -c mc -n "__fish_seen_subcommand_from cleanup" -l dry-run -d "Preview without deleting"
complete -c mc -n "__fish_seen_subcommand_from cleanup" -s f -l force -d "Skip confirmation"

# Completion subcommands
complete -c mc -n "__fish_seen_subcommand_from completion" -a "bash" -d "Bash completion"
complete -c mc -n "__fish_seen_subcommand_from completion" -a "zsh" -d "Zsh completion"
complete -c mc -n "__fish_seen_subcommand_from completion" -a "fish" -d "Fish completion"
complete -c mc -n "__fish_seen_subcommand_from completion" -l install -d "Install to shell config"
complete -c mc -n "__fish_seen_subcommand_from completion" -l print -d "Print completion script"

# Restore file completion
complete -c mc -n "__fish_seen_subcommand_from restore" -a "(ls *.json 2>/dev/null)" -d "Backup file"
`;
}

// Install completion for a shell
async function installCompletion(shell, script) {
  const home = os.homedir();
  let installPath = null;
  let instruction = null;

  switch (shell) {
    case 'bash':
      // Try common bash completion directories
      const bashDirs = [
        '/etc/bash_completion.d/',
        '/usr/local/etc/bash_completion.d/',
        path.join(home, '.local/share/bash-completion/completions/'),
        path.join(home, '.bash_completion.d/'),
      ];

      for (const dir of bashDirs) {
        try {
          await fs.ensureDir(dir);
          installPath = path.join(dir, 'mc');
          break;
        } catch {
          continue;
        }
      }

      if (!installPath) {
        // Fall back to .bashrc
        installPath = path.join(home, '.mc-completion.bash');
        instruction = `Add this line to your ~/.bashrc:\n  source "${installPath}"`;
      }
      break;

    case 'zsh':
      const zshDirs = [
        '/usr/local/share/zsh/site-functions/',
        '/usr/share/zsh/site-functions/',
        path.join(home, '.zsh/completions/'),
      ];

      for (const dir of zshDirs) {
        try {
          await fs.ensureDir(dir);
          installPath = path.join(dir, '_mc');
          break;
        } catch {
          continue;
        }
      }

      if (!installPath) {
        installPath = path.join(home, '.mc-completion.zsh');
        instruction = `Add this to your ~/.zshrc:\n  fpath+=("${path.dirname(installPath)}")\n  autoload -U compinit && compinit`;
      }
      break;

    case 'fish':
      const fishDir = path.join(home, '.config/fish/completions/');
      await fs.ensureDir(fishDir);
      installPath = path.join(fishDir, 'mc.fish');
      break;

    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }

  await fs.writeFile(installPath, script, { mode: 0o644 });

  return { installPath, instruction };
}

// Detect current shell
function detectShell() {
  const shell = process.env.SHELL || '';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('fish')) return 'fish';
  return null;
}

// Main completion command
completion
  .description('Generate shell completion scripts')
  .argument('[shell]', 'Shell to generate completion for (bash, zsh, fish)')
  .option('--install', 'Install completion to shell configuration')
  .option('--print', 'Print completion script to stdout')
  .action(async (shellArg, options) => {
    const shell = shellArg || detectShell();

    if (!shell) {
      console.error(chalk.red('❌ Could not detect shell. Please specify: bash, zsh, or fish'));
      console.log(chalk.gray('Usage: mc completion <shell>'));
      process.exit(1);
    }

    if (!['bash', 'zsh', 'fish'].includes(shell)) {
      console.error(chalk.red(`❌ Unsupported shell: ${shell}`));
      console.log(chalk.gray('Supported shells: bash, zsh, fish'));
      process.exit(1);
    }

    // Generate the appropriate script
    let script;
    switch (shell) {
      case 'bash':
        script = generateBashCompletion();
        break;
      case 'zsh':
        script = generateZshCompletion();
        break;
      case 'fish':
        script = generateFishCompletion();
        break;
    }

    if (options.print || !options.install) {
      // Print the script
      console.log(script);

      if (!options.install) {
        console.error(chalk.gray(`\n# To install, run: mc completion ${shell} --install`));
      }
    }

    if (options.install) {
      try {
        const { installPath, instruction } = await installCompletion(shell, script);

        console.log(chalk.green(`✅ Completion script installed to:`));
        console.log(chalk.cyan(`   ${installPath}`));

        if (instruction) {
          console.log(chalk.yellow('\n⚠️  Additional setup required:'));
          console.log(instruction);
        } else {
          console.log(chalk.green('\n🎉 Shell completion is now active!'));
          console.log(chalk.gray(`   Restart your shell or run: source ${  installPath}`));
        }

        console.log(chalk.gray(`\n# To uninstall, remove: ${installPath}`));

      } catch (err) {
        console.error(chalk.red(`❌ Installation failed: ${err.message}`));
        console.log(chalk.gray('Try running with sudo or use --print to manually install'));
        process.exit(1);
      }
    }
  });

// Helper command to show completion status
completion
  .command('status')
  .description('Check completion installation status')
  .action(async () => {
    console.log(chalk.blue('🐾 Shell Completion Status\n'));

    const shells = ['bash', 'zsh', 'fish'];
    const home = os.homedir();

    for (const shell of shells) {
      let status = chalk.red('❌ Not installed');
      let location = '';

      // Check common locations
      const checkPaths = [];

      switch (shell) {
        case 'bash':
          checkPaths.push(
            '/etc/bash_completion.d/mc',
            '/usr/local/etc/bash_completion.d/mc',
            path.join(home, '.local/share/bash-completion/completions/mc'),
            path.join(home, '.bash_completion.d/mc'),
            path.join(home, '.mc-completion.bash')
          );
          break;
        case 'zsh':
          checkPaths.push(
            '/usr/local/share/zsh/site-functions/_mc',
            '/usr/share/zsh/site-functions/_mc',
            path.join(home, '.zsh/completions/_mc'),
            path.join(home, '.mc-completion.zsh')
          );
          break;
        case 'fish':
          checkPaths.push(
            path.join(home, '.config/fish/completions/mc.fish')
          );
          break;
      }

      for (const checkPath of checkPaths) {
        if (await fs.pathExists(checkPath)) {
          status = chalk.green('✅ Installed');
          location = chalk.gray(`(${checkPath})`);
          break;
        }
      }

      console.log(`${shell.padEnd(8)} ${status} ${location}`);
    }

    console.log(chalk.gray('\nInstall completion with:'));
    console.log(chalk.gray('  mc completion bash --install'));
    console.log(chalk.gray('  mc completion zsh --install'));
    console.log(chalk.gray('  mc completion fish --install'));
  });

module.exports = completion;
