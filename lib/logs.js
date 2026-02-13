// logs.js - Log management commands for mc CLI
// Provides unified access to container logs across the MasterClaw ecosystem

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const logs = new Command('logs');

// Service name mappings
const SERVICES = {
  'traefik': 'mc-traefik',
  'interface': 'mc-interface',
  'backend': 'mc-backend',
  'core': 'mc-core',
  'gateway': 'mc-gateway',
  'chroma': 'mc-chroma',
  'watchtower': 'mc-watchtower',
  'all': null, // Special case
};

// Find infrastructure directory
async function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];
  
  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'scripts', 'logs.sh'))) {
      return dir;
    }
  }
  
  return null;
}

// Check if Docker is available
async function isDockerAvailable() {
  try {
    execSync('docker ps', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Get container log size in bytes
async function getLogSize(container) {
  try {
    const logPath = execSync(
      `docker inspect --format='{{.LogPath}}' "${container}" 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
    
    if (!logPath) return 0;
    
    const stats = await fs.stat(logPath);
    return stats.size;
  } catch {
    return 0;
  }
}

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

// Get container status
function getContainerStatus(container) {
  try {
    const output = execSync(
      `docker ps --filter "name=${container}" --format "{{.Status}}" 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
    return output || 'stopped';
  } catch {
    return 'stopped';
  }
}

// View logs for a service
logs
  .argument('[service]', 'Service name (traefik, interface, backend, core, gateway, chroma, watchtower, or all)')
  .description('View logs from MasterClaw services')
  .option('-f, --follow', 'Follow log output (tail -f style)')
  .option('-n, --lines <number>', 'Number of lines to show', '100')
  .option('-s, --since <duration>', 'Show logs since duration (e.g., 5m, 1h, 24h)')
  .option('--tail <number>', 'Alias for --lines', '100')
  .action(async (serviceArg, options) => {
    const service = serviceArg || 'all';
    
    if (!SERVICES.hasOwnProperty(service)) {
      console.error(chalk.red(`❌ Unknown service: ${service}`));
      console.log(chalk.gray(`Available services: ${Object.keys(SERVICES).join(', ')}`));
      process.exit(1);
    }
    
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }
    
    const container = SERVICES[service];
    
    // Build docker logs command
    const args = ['logs'];
    
    if (options.follow) {
      args.push('--follow');
    }
    
    const lines = options.lines || options.tail;
    args.push('--tail', lines);
    
    if (options.since) {
      args.push('--since', options.since);
    }
    
    if (service === 'all') {
      // Show logs from all services with prefixes
      console.log(chalk.blue('📜 MasterClaw Logs (all services)\n'));
      
      const serviceNames = Object.keys(SERVICES).filter(s => s !== 'all');
      
      if (options.follow) {
        // In follow mode, we need to show all streams interleaved
        // Use docker-compose logs if available
        const infraDir = await findInfraDir();
        if (infraDir) {
          const composeArgs = ['logs', '-f', '--tail', lines];
          if (options.since) {
            composeArgs.push('--since', options.since);
          }
          
          const proc = spawn('docker-compose', composeArgs, {
            cwd: infraDir,
            stdio: 'inherit',
          });
          
          proc.on('error', (err) => {
            console.error(chalk.red(`❌ Error: ${err.message}`));
          });
          
          return;
        }
      }
      
      // Non-follow mode: show each service's logs
      for (const svc of serviceNames) {
        const svcContainer = SERVICES[svc];
        const status = getContainerStatus(svcContainer);
        
        if (status === 'stopped') {
          console.log(chalk.gray(`[${svc}] (not running)`));
          continue;
        }
        
        console.log(chalk.cyan(`\n━━━ ${svc.toUpperCase()} ━━━`));
        
        try {
          const output = execSync(
            `docker logs --tail ${lines} "${svcContainer}" 2>&1`,
            { encoding: 'utf8', maxBuffer: 1024 * 1024 }
          );
          
          if (output.trim()) {
            // Prefix each line with service name
            const prefixed = output
              .split('\n')
              .map(line => line.trim() ? `[${svc}] ${line}` : line)
              .join('\n');
            console.log(prefixed);
          } else {
            console.log(chalk.gray('(no logs)'));
          }
        } catch (err) {
          console.log(chalk.red(`Error reading logs: ${err.message}`));
        }
      }
      
    } else {
      // Single service
      const status = getContainerStatus(container);
      
      if (status === 'stopped') {
        console.error(chalk.red(`❌ Service '${service}' is not running`));
        console.log(chalk.gray('Run "mc status" to see running services'));
        process.exit(1);
      }
      
      console.log(chalk.blue(`📜 Logs for ${service}\n`));
      
      args.push(container);
      
      const proc = spawn('docker', args, {
        stdio: 'inherit',
      });
      
      proc.on('error', (err) => {
        console.error(chalk.red(`❌ Error: ${err.message}`));
      });
    }
  });

// Show log status
logs
  .command('status')
  .description('Show log sizes and rotation status for all services')
  .action(async () => {
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }
    
    console.log(chalk.blue('📊 MasterClaw Log Status'));
    console.log('========================\n');
    
    console.log(`${chalk.bold('Service')}              ${chalk.bold('Status')}     ${chalk.bold('Log Size')}     ${chalk.bold('Log Config')}`);
    console.log(`${'-'.repeat(20)} ${'-'.repeat(10)} ${'-'.repeat(13)} ${'-'.repeat(15)}`);
    
    let totalBytes = 0;
    
    for (const [name, container] of Object.entries(SERVICES)) {
      if (name === 'all') continue;
      
      const status = getContainerStatus(container);
      const isRunning = status.includes('Up');
      const statusIcon = isRunning ? chalk.green('●') : chalk.red('○');
      
      const size = await getLogSize(container);
      totalBytes += size;
      const sizeHuman = formatBytes(size);
      
      // Get log config
      let config = '-';
      try {
        const driver = execSync(
          `docker inspect --format='{{.HostConfig.LogConfig.Type}}' "${container}" 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();
        
        if (driver === 'json-file') {
          const maxSize = execSync(
            `docker inspect --format='{{.HostConfig.LogConfig.Config.max-size}}' "${container}" 2>/dev/null`,
            { encoding: 'utf8' }
          ).trim() || '10m';
          
          const maxFile = execSync(
            `docker inspect --format='{{.HostConfig.LogConfig.Config.max-file}}' "${container}" 2>/dev/null`,
            { encoding: 'utf8' }
          ).trim() || '3';
          
          config = `${maxSize}/${maxFile}f`;
        } else {
          config = driver;
        }
      } catch {
        // Use default
        config = '10m/3f';
      }
      
      console.log(
        `${name.padEnd(20)} ${statusIcon.padEnd(10)} ${sizeHuman.padEnd(13)} ${config}`
      );
    }
    
    console.log('\n' + '-'.repeat(60));
    console.log(`Total log size: ${chalk.cyan(formatBytes(totalBytes))}`);
    
    // Disk usage warning
    try {
      const dockerRoot = execSync(
        "docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo '/var/lib/docker'",
        { encoding: 'utf8' }
      ).trim();
      
      if (await fs.pathExists(dockerRoot)) {
        const dfOutput = execSync(`df -h "${dockerRoot}" 2>/dev/null`, { encoding: 'utf8' });
        const lines = dfOutput.trim().split('\n');
        
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          const available = parts[3];
          const usagePct = parts[4];
          
          console.log(`\nDocker root: ${chalk.cyan(dockerRoot)}`);
          console.log(`Disk available: ${chalk.cyan(available)} (${usagePct} used)`);
          
          // Warning if disk usage is high
          const usageNum = parseInt(usagePct);
          if (usageNum > 85) {
            console.log(chalk.yellow('\n⚠️  Warning: Disk usage is above 85%'));
            console.log(chalk.yellow('   Consider running: mc logs clean'));
          }
        }
      }
    } catch (err) {
      // Ignore disk check errors
    }
    
    console.log('');
  });

// Clean logs
logs
  .command('clean')
  .description('Clean up container logs to free disk space')
  .option('-a, --all', 'Also prune unused Docker data (images, volumes, etc.)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }
    
    const infraDir = await findInfraDir();
    
    if (options.all) {
      console.log(chalk.yellow('⚠️  This will remove all logs AND prune Docker system data'));
      console.log(chalk.yellow('   (images, containers, networks, build cache)'));
      console.log('');
      
      if (!options.yes) {
        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        
        const answer = await new Promise((resolve) => {
          rl.question('Are you sure? [y/N] ', resolve);
        });
        rl.close();
        
        if (!answer.match(/^y$/i)) {
          console.log('Cancelled.');
          return;
        }
      }
    }
    
    if (infraDir) {
      // Use the infrastructure script if available
      const scriptPath = path.join(infraDir, 'scripts', 'logs.sh');
      const cmd = options.all ? 'clean-all' : 'clean';
      
      const proc = spawn('bash', [scriptPath, cmd], {
        stdio: 'inherit',
      });
      
      proc.on('close', (code) => {
        process.exit(code);
      });
    } else {
      // Fallback: clean logs manually
      console.log(chalk.blue('🧹 Cleaning MasterClaw logs...\n'));
      
      let cleaned = 0;
      
      for (const [name, container] of Object.entries(SERVICES)) {
        if (name === 'all') continue;
        
        try {
          const isRunning = execSync(
            `docker ps -q --filter "name=${container}"`,
            { encoding: 'utf8' }
          ).trim();
          
          if (!isRunning) {
            console.log(chalk.gray(`  ○ ${name} (not running)`));
            continue;
          }
          
          const logPath = execSync(
            `docker inspect --format='{{.LogPath}}' "${container}" 2>/dev/null`,
            { encoding: 'utf8' }
          ).trim();
          
          if (logPath && (await fs.pathExists(logPath))) {
            // Truncate log file
            await fs.writeFile(logPath, '');
            console.log(chalk.green(`  ✅ ${name}`));
            cleaned++;
          } else {
            console.log(chalk.yellow(`  ⚠️  ${name} (no log file)`));
          }
        } catch (err) {
          console.log(chalk.red(`  ❌ ${name}: ${err.message}`));
        }
      }
      
      console.log(`\n${chalk.green(`✅ Cleaned ${cleaned} service log(s)`)}\n`);
      
      if (options.all) {
        console.log(chalk.blue('🗑️  Pruning Docker system...\n'));
        const proc = spawn('docker', ['system', 'prune', '-f', '--volumes'], {
          stdio: 'inherit',
        });
        proc.on('close', () => {
          console.log(chalk.green('\n✅ Cleanup complete\n'));
        });
      }
    }
  });

// Export logs
logs
  .command('export')
  .description('Export logs to a file for troubleshooting')
  .argument('[service]', 'Service to export (default: all)')
  .option('-o, --output <dir>', 'Output directory', './mc-logs-export')
  .option('-s, --since <duration>', 'Export logs since duration (e.g., 1h, 24h)')
  .action(async (serviceArg, options) => {
    const service = serviceArg || 'all';
    
    if (!SERVICES.hasOwnProperty(service)) {
      console.error(chalk.red(`❌ Unknown service: ${service}`));
      process.exit(1);
    }
    
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const exportDir = path.join(options.output, timestamp);
    await fs.ensureDir(exportDir);
    
    console.log(chalk.blue(`📦 Exporting logs to ${exportDir}\n`));
    
    const servicesToExport = service === 'all' 
      ? Object.keys(SERVICES).filter(s => s !== 'all')
      : [service];
    
    let exported = 0;
    
    for (const svc of servicesToExport) {
      const container = SERVICES[svc];
      const isRunning = getContainerStatus(container).includes('Up');
      
      if (!isRunning) {
        console.log(chalk.gray(`  ○ ${svc} (not running)`));
        continue;
      }
      
      try {
        const args = ['logs'];
        
        if (options.since) {
          args.push('--since', options.since);
        }
        
        args.push(container);
        
        const output = execSync(`docker ${args.join(' ')} 2>&1`, {
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024, // 50MB max
        });
        
        const outputPath = path.join(exportDir, `${svc}.log`);
        await fs.writeFile(outputPath, output);
        
        const size = formatBytes(Buffer.byteLength(output, 'utf8'));
        console.log(chalk.green(`  ✅ ${svc} (${size})`));
        exported++;
        
        // Also export container inspect info for debugging
        try {
          const inspect = execSync(
            `docker inspect "${container}" 2>&1`,
            { encoding: 'utf8' }
          );
          await fs.writeFile(
            path.join(exportDir, `${svc}_inspect.json`),
            inspect
          );
        } catch {
          // Ignore inspect errors
        }
        
      } catch (err) {
        console.log(chalk.red(`  ❌ ${svc}: ${err.message}`));
      }
    }
    
    // Create a summary file
    const summary = {
      exportedAt: new Date().toISOString(),
      hostname: require('os').hostname(),
      services: servicesToExport,
      exported: exported,
      outputDir: exportDir,
    };
    
    await fs.writeJson(path.join(exportDir, 'summary.json'), summary, { spaces: 2 });
    
    console.log(`\n${chalk.green(`✅ Exported ${exported} service(s)`)}\n`);
    console.log(chalk.gray(`Files are in: ${exportDir}\n`));
  });

// Search logs
logs
  .command('search')
  .description('Search for patterns in logs')
  .argument('<pattern>', 'Pattern to search for')
  .argument('[service]', 'Service to search (default: all)')
  .option('-i, --ignore-case', 'Case-insensitive search')
  .option('-C, --context <lines>', 'Show N lines of context', '2')
  .action(async (pattern, serviceArg, options) => {
    const service = serviceArg || 'all';
    
    if (!SERVICES.hasOwnProperty(service)) {
      console.error(chalk.red(`❌ Unknown service: ${service}`));
      process.exit(1);
    }
    
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }
    
    console.log(chalk.blue(`🔍 Searching for "${pattern}" in logs...\n`));
    
    const servicesToSearch = service === 'all'
      ? Object.keys(SERVICES).filter(s => s !== 'all')
      : [service];
    
    let totalMatches = 0;
    
    for (const svc of servicesToSearch) {
      const container = SERVICES[svc];
      const isRunning = getContainerStatus(container).includes('Up');
      
      if (!isRunning) continue;
      
      try {
        const logs = execSync(
          `docker logs --tail 10000 "${container}" 2>&1`,
          { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
        );
        
        const lines = logs.split('\n');
        const matches = [];
        
        const searchRegex = options.ignoreCase
          ? new RegExp(pattern, 'i')
          : new RegExp(pattern);
        
        lines.forEach((line, index) => {
          if (searchRegex.test(line)) {
            matches.push({ line: index + 1, content: line });
          }
        });
        
        if (matches.length > 0) {
          console.log(chalk.cyan(`━━━ ${svc.toUpperCase()} (${matches.length} matches) ━━━`));
          
          const contextLines = parseInt(options.context) || 2;
          
          matches.forEach((match) => {
            const start = Math.max(0, match.line - contextLines - 1);
            const end = Math.min(lines.length, match.line + contextLines);
            
            console.log(chalk.gray(`\n--- Line ${match.line} ---`));
            
            for (let i = start; i < end; i++) {
              const lineNum = i + 1;
              const lineContent = lines[i];
              const isMatch = i === match.line - 1;
              
              const prefix = isMatch ? chalk.green('>') : chalk.gray('|');
              const content = isMatch
                ? lineContent.replace(searchRegex, m => chalk.yellow.bold(m))
                : chalk.gray(lineContent);
              
              console.log(`${prefix} ${lineNum.toString().padStart(4)}: ${content}`);
            }
          });
          
          console.log('');
          totalMatches += matches.length;
        }
        
      } catch (err) {
        // Ignore errors for individual services
      }
    }
    
    if (totalMatches === 0) {
      console.log(chalk.gray('No matches found.\n'));
    } else {
      console.log(chalk.green(`Found ${totalMatches} total match(es)\n`));
    }
  });

module.exports = logs;
