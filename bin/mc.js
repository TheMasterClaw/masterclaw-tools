#!/usr/bin/env node
/**
 * MasterClaw CLI - mc
 * The command-line companion to your AI familiar
 * 
 * Usage: mc [command] [options]
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');

const { getAllStatuses, checkDockerContainers, findInfraDir, SERVICES } = require('../lib/services');
const config = require('../lib/config');
const docker = require('../lib/docker');

const program = new Command();

program
  .name('mc')
  .description('MasterClaw CLI - Command your AI familiar from the terminal')
  .version('0.2.0')
  .option('-v, --verbose', 'verbose output')
  .option('-i, --infra-dir <path>', 'path to infrastructure directory');

// Status command
program
  .command('status')
  .description('Check health of all MasterClaw services')
  .option('-w, --watch', 'watch mode - continuous monitoring')
  .action(async (options) => {
    console.log(chalk.blue('🐾 MasterClaw Status Check'));
    console.log('');
    
    if (options.watch) {
      console.log(chalk.gray('Press Ctrl+C to exit watch mode\n'));
      
      const check = async () => {
        console.clear();
        console.log(chalk.blue('🐾 MasterClaw Status Check'));
        console.log(chalk.gray(new Date().toLocaleString()));
        console.log('');
        
        const statuses = await getAllStatuses();
        const containers = await checkDockerContainers();
        
        // Print HTTP endpoints
        console.log(chalk.bold('🌐 HTTP Endpoints:'));
        for (const status of statuses) {
          const icon = status.status === 'healthy' ? chalk.green('✅') :
                       status.status === 'unhealthy' ? chalk.yellow('⚠️') :
                       chalk.red('❌');
          console.log(`  ${icon} ${status.name}: ${status.url} (${status.status})`);
        }
        
        // Print Docker containers
        if (containers.length > 0) {
          console.log('');
          console.log(chalk.bold('🐳 Docker Containers:'));
          for (const container of containers) {
            console.log(`  ${chalk.green('●')} ${container.name}: ${container.status}`);
          }
        }
        
        console.log('');
        console.log(chalk.gray('─────────────────────────────'));
      };
      
      await check();
      setInterval(check, 5000);
    } else {
      const spinner = ora('Checking services...').start();
      
      const statuses = await getAllStatuses();
      const containers = await checkDockerContainers();
      
      spinner.stop();
      
      // Print HTTP endpoints
      console.log(chalk.bold('🌐 HTTP Endpoints:'));
      for (const status of statuses) {
        const icon = status.status === 'healthy' ? chalk.green('✅') :
                     status.status === 'unhealthy' ? chalk.yellow('⚠️') :
                     chalk.red('❌');
        const error = status.error ? chalk.gray(` (${status.error})`) : '';
        console.log(`  ${icon} ${status.name}: ${status.url} (${status.status})${error}`);
      }
      
      // Print Docker containers
      if (containers.length > 0) {
        console.log('');
        console.log(chalk.bold('🐳 Docker Containers:'));
        for (const container of containers) {
          console.log(`  ${chalk.green('●')} ${container.name}: ${container.status}`);
        }
      } else {
        console.log('');
        console.log(chalk.gray('  No Docker containers running'));
      }
      
      console.log('');
      const allHealthy = statuses.every(s => s.status === 'healthy');
      if (allHealthy) {
        console.log(chalk.green('🐾 MasterClaw is healthy and watching.'));
      } else {
        console.log(chalk.yellow('⚠️  Some services need attention.'));
      }
    }
  });

// Logs command
program
  .command('logs [service]')
  .description('View service logs')
  .option('-f, --follow', 'follow log output')
  .option('-t, --tail <lines>', 'number of lines to show', '100')
  .action(async (service, options) => {
    const infraDir = program.opts().infraDir || await findInfraDir() || process.cwd();
    
    if (!service) {
      console.log(chalk.blue('🐾 Available services:'));
      console.log('  mc-traefik, mc-interface, mc-backend, mc-core, mc-gateway, mc-chroma');
      console.log('');
      console.log(chalk.gray('Usage: mc logs mc-backend --follow'));
      return;
    }
    
    const containerName = service.startsWith('mc-') ? service : `mc-${service}`;
    
    if (options.follow) {
      console.log(chalk.blue(`🐾 Following logs for ${containerName}...`));
      console.log(chalk.gray('Press Ctrl+C to exit\n'));
      await docker.logs(containerName, { follow: true, tail: parseInt(options.tail) });
    } else {
      const spinner = ora(`Fetching logs for ${containerName}...`).start();
      const logs = await docker.logs(containerName, { tail: parseInt(options.tail) });
      spinner.stop();
      console.log(logs);
    }
  });

// Backup command
program
  .command('backup')
  .description('Trigger a manual backup')
  .option('-f, --full', 'full backup including all data')
  .action(async (options) => {
    const infraDir = program.opts().infraDir || await findInfraDir();
    
    if (!infraDir) {
      console.log(chalk.red('❌ Could not find infrastructure directory.'));
      console.log(chalk.gray('Set it with: mc config set infraDir /path/to/infrastructure'));
      return;
    }
    
    console.log(chalk.blue('🐾 Starting backup...'));
    const backupScript = require('path').join(infraDir, 'scripts', 'backup.sh');
    
    const { spawn } = require('child_process');
    const backup = spawn('bash', [backupScript], {
      cwd: infraDir,
      stdio: 'inherit',
    });
    
    backup.on('close', (code) => {
      if (code === 0) {
        console.log('');
        console.log(chalk.green('✅ Backup completed successfully.'));
      } else {
        console.log('');
        console.log(chalk.red('❌ Backup failed.'));
      }
    });
  });

// Config command
program
  .command('config')
  .description('Manage MasterClaw configuration')
  .addCommand(
    new Command('get')
      .argument('<key>', 'config key (e.g., gateway.url)')
      .description('get a config value')
      .action(async (key) => {
        const value = await config.get(key);
        if (value !== undefined) {
          console.log(value);
        } else {
          console.log(chalk.gray('(not set)'));
        }
      })
  )
  .addCommand(
    new Command('set')
      .argument('<key>', 'config key')
      .argument('<value>', 'config value')
      .description('set a config value')
      .action(async (key, value) => {
        await config.set(key, value);
        console.log(chalk.green(`✅ Set ${key} = ${value}`));
      })
  )
  .addCommand(
    new Command('list')
      .description('list all config')
      .action(async () => {
        const cfg = await config.list();
        console.log(JSON.stringify(cfg, null, 2));
      })
  )
  .addCommand(
    new Command('reset')
      .description('reset config to defaults')
      .action(async () => {
        await config.reset();
        console.log(chalk.green('✅ Config reset to defaults.'));
      })
  );

// Revive command
program
  .command('revive')
  .description('Restart all services and restore MC connection')
  .option('-p, --pull', 'pull latest images before restarting')
  .action(async (options) => {
    const infraDir = program.opts().infraDir || await findInfraDir();
    
    if (!infraDir) {
      console.log(chalk.red('❌ Could not find infrastructure directory.'));
      console.log(chalk.gray('Set it with: mc config set infraDir /path/to/infrastructure'));
      return;
    }
    
    console.log(chalk.yellow('🔄 Reviving MasterClaw...'));
    console.log('');
    
    if (options.pull) {
      console.log(chalk.blue('📥 Pulling latest images...'));
      const spinner = ora('Pulling...').start();
      try {
        await docker.pull({ cwd: infraDir });
        spinner.succeed('Images pulled');
      } catch (err) {
        spinner.fail(`Pull failed: ${err.message}`);
      }
      console.log('');
    }
    
    console.log(chalk.blue('🔄 Restarting services...'));
    const spinner = ora('Restarting...').start();
    
    try {
      await docker.restart([], { cwd: infraDir });
      spinner.succeed('Services restarted');
      
      console.log('');
      console.log(chalk.green('✅ MasterClaw connection restored.'));
      console.log('');
      console.log(chalk.blue('🐾 MasterClaw is awake and watching.'));
    } catch (err) {
      spinner.fail(`Restart failed: ${err.message}`);
    }
  });

// Update command
program
  .command('update')
  .description('Check for updates and pull latest changes')
  .option('-a, --apply', 'apply updates automatically')
  .action(async (options) => {
    const infraDir = program.opts().infraDir || await findInfraDir();
    
    if (!infraDir) {
      console.log(chalk.red('❌ Could not find infrastructure directory.'));
      return;
    }
    
    console.log(chalk.blue('🐾 Checking for updates...'));
    
    const { spawn } = require('child_process');
    
    // Check git status
    const gitFetch = spawn('git', ['fetch', '--dry-run'], { cwd: infraDir });
    let hasUpdates = false;
    
    gitFetch.stderr.on('data', (data) => {
      if (data.toString().includes('->')) {
        hasUpdates = true;
      }
    });
    
    gitFetch.on('close', async () => {
      if (hasUpdates) {
        console.log(chalk.yellow('📦 Updates available!'));
        
        if (options.apply) {
          console.log(chalk.blue('🔄 Applying updates...'));
          const pull = spawn('git', ['pull'], { cwd: infraDir, stdio: 'inherit' });
          
          pull.on('close', async (code) => {
            if (code === 0) {
              console.log('');
              console.log(chalk.green('✅ Updates applied.'));
              console.log(chalk.blue('🔄 Restarting services...'));
              await docker.restart([], { cwd: infraDir });
              console.log(chalk.green('✅ Services restarted.'));
            }
          });
        } else {
          console.log(chalk.gray('Run with --apply to update automatically.'));
        }
      } else {
        console.log(chalk.green('✅ MasterClaw is up to date!'));
      }
    });
  });

// Parse arguments
program.parse();

// Show help if no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
