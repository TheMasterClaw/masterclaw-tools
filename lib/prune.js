/**
 * MasterClaw Prune - Docker System Resource Management
 * 
 * Comprehensive Docker resource cleanup with safety features:
 * - Disk usage overview before/after pruning
 * - Selective pruning (images, containers, volumes, networks, build cache)
 * - Dry-run mode to preview what would be removed
 * - Safety confirmations for destructive operations
 * - Filtering options (unused, dangling, all)
 * - Integration with MasterClaw service protection
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const ora = require('ora');
const inquirer = require('inquirer');

// MasterClaw services that should never be pruned
const PROTECTED_CONTAINERS = [
  'mc-core',
  'mc-backend',
  'mc-gateway',
  'mc-interface',
  'mc-traefik',
  'mc-chroma',
  'mc-grafana',
  'mc-prometheus',
  'mc-loki',
  'mc-watchtower',
];

// Parse Docker size string to bytes
function parseSize(sizeStr) {
  if (!sizeStr || sizeStr === '0B') return 0;
  
  const units = {
    'B': 1,
    'KB': 1024,
    'MB': 1024 ** 2,
    'GB': 1024 ** 3,
    'TB': 1024 ** 4,
  };
  
  const match = sizeStr.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  return Math.round(value * (units[unit] || 1));
}

// Format bytes to human-readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// Run Docker command with timeout and error handling
function runDockerCommand(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    let timeout;
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1000);
      reject(new Error(`Docker command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Docker command failed with code ${code}`));
      }
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Get Docker disk usage breakdown
async function getDiskUsage() {
  try {
    const output = await runDockerCommand([
      'system', 'df', '--format', '{{.Type}}|{{.Size}}|{{.Reclaimable}}'
    ], 30000);
    
    const lines = output.trim().split('\n');
    const usage = {
      images: { size: 0, reclaimable: 0 },
      containers: { size: 0, reclaimable: 0 },
      volumes: { size: 0, reclaimable: 0 },
      buildCache: { size: 0, reclaimable: 0 },
    };
    
    for (const line of lines) {
      const [type, size, reclaimable] = line.split('|');
      const sizeBytes = parseSize(size);
      const reclaimableBytes = parseSize(reclaimable);
      
      switch (type.toLowerCase()) {
        case 'images':
          usage.images = { size: sizeBytes, reclaimable: reclaimableBytes };
          break;
        case 'containers':
          usage.containers = { size: sizeBytes, reclaimable: reclaimableBytes };
          break;
        case 'volumes':
          usage.volumes = { size: sizeBytes, reclaimable: reclaimableBytes };
          break;
        case 'build cache':
          usage.buildCache = { size: sizeBytes, reclaimable: reclaimableBytes };
          break;
      }
    }
    
    usage.total = {
      size: usage.images.size + usage.containers.size + usage.volumes.size + usage.buildCache.size,
      reclaimable: usage.images.reclaimable + usage.containers.reclaimable + 
                   usage.volumes.reclaimable + usage.buildCache.reclaimable,
    };
    
    return usage;
  } catch (err) {
    throw new Error(`Failed to get disk usage: ${err.message}`);
  }
}

// Get detailed image list that can be pruned
async function getPrunableImages(all = false) {
  try {
    const args = ['images', '--format', '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}'];
    if (!all) {
      args.push('--filter', 'dangling=true');
    }
    
    const output = await runDockerCommand(args, 30000);
    if (!output.trim()) return [];
    
    return output.trim().split('\n').map(line => {
      const [id, repo, tag, size, created] = line.split('|');
      return {
        id: id.substring(0, 12),
        repository: repo || '<none>',
        tag: tag || '<none>',
        size: parseSize(size),
        sizeFormatted: size,
        created,
        dangling: repo === '<none>',
      };
    });
  } catch (err) {
    return [];
  }
}

// Get stopped containers that can be removed
async function getPrunableContainers() {
  try {
    const output = await runDockerCommand([
      'ps', '-a', '--filter', 'status=exited', '--filter', 'status=dead',
      '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Size}}'
    ], 30000);
    
    if (!output.trim()) return [];
    
    return output.trim().split('\n').map(line => {
      const [id, name, image, status, size] = line.split('|');
      return {
        id: id.substring(0, 12),
        name,
        image,
        status,
        size: parseSize(size),
        protected: PROTECTED_CONTAINERS.some(pc => name.includes(pc)),
      };
    });
  } catch (err) {
    return [];
  }
}

// Get unused volumes
async function getPrunableVolumes() {
  try {
    // Get all volumes
    const allVolumesOutput = await runDockerCommand([
      'volume', 'ls', '--format', '{{.Name}}|{{.Driver}}|{{.Scope}}'
    ], 30000);
    
    if (!allVolumesOutput.trim()) return [];
    
    const allVolumes = allVolumesOutput.trim().split('\n').map(line => {
      const [name, driver, scope] = line.split('|');
      return { name, driver, scope, used: false };
    });
    
    // Check which volumes are in use
    const usedOutput = await runDockerCommand([
      'ps', '-a', '--format', '{{.Mounts}}'
    ], 30000).catch(() => '');
    
    const usedVolumes = new Set();
    usedOutput.split('\n').forEach(line => {
      if (line.includes('volume:')) {
        const match = line.match(/volume:([^,\s]+)/g);
        if (match) {
          match.forEach(m => usedVolumes.add(m.replace('volume:', '')));
        }
      }
    });
    
    // Mark used volumes and get sizes
    const unusedVolumes = [];
    for (const vol of allVolumes) {
      if (!usedVolumes.has(vol.name) && !vol.name.startsWith('mc-')) {
        try {
          const inspectOutput = await runDockerCommand([
            'volume', 'inspect', vol.name, '--format', '{{.Mountpoint}}'
          ], 10000);
          // Note: Getting actual volume size requires du on the mountpoint
          // which may not be accessible, so we estimate
          unusedVolumes.push({
            name: vol.name,
            driver: vol.driver,
            scope: vol.scope,
          });
        } catch (e) {
          // Skip volumes we can't inspect
        }
      }
    }
    
    return unusedVolumes;
  } catch (err) {
    return [];
  }
}

// Display disk usage table
function displayDiskUsage(usage) {
  console.log(chalk.blue('📊 Docker Disk Usage\n'));
  
  const rows = [
    ['Type', 'Total Size', 'Reclaimable', '% Savings'],
    ['─'.repeat(12), '─'.repeat(12), '─'.repeat(12), '─'.repeat(10)],
    [
      'Images',
      formatBytes(usage.images.size),
      chalk.yellow(formatBytes(usage.images.reclaimable)),
      usage.images.size > 0 
        ? `${Math.round((usage.images.reclaimable / usage.images.size) * 100)}%`
        : '0%',
    ],
    [
      'Containers',
      formatBytes(usage.containers.size),
      chalk.yellow(formatBytes(usage.containers.reclaimable)),
      usage.containers.size > 0
        ? `${Math.round((usage.containers.reclaimable / usage.containers.size) * 100)}%`
        : '0%',
    ],
    [
      'Volumes',
      formatBytes(usage.volumes.size),
      chalk.yellow(formatBytes(usage.volumes.reclaimable)),
      usage.volumes.size > 0
        ? `${Math.round((usage.volumes.reclaimable / usage.volumes.size) * 100)}%`
        : '0%',
    ],
    [
      'Build Cache',
      formatBytes(usage.buildCache.size),
      chalk.yellow(formatBytes(usage.buildCache.reclaimable)),
      usage.buildCache.size > 0
        ? `${Math.round((usage.buildCache.reclaimable / usage.buildCache.size) * 100)}%`
        : '0%',
    ],
    ['─'.repeat(12), '─'.repeat(12), '─'.repeat(12), '─'.repeat(10)],
    [
      chalk.bold('Total'),
      chalk.bold(formatBytes(usage.total.size)),
      chalk.bold.yellow(formatBytes(usage.total.reclaimable)),
      usage.total.size > 0
        ? chalk.bold(`${Math.round((usage.total.reclaimable / usage.total.size) * 100)}%`)
        : '0%',
    ],
  ];
  
  for (const row of rows) {
    console.log(`  ${row[0].padEnd(12)} ${row[1].padEnd(12)} ${row[2].padEnd(12)} ${row[3]}`);
  }
  
  console.log('');
  
  // Recommendations
  if (usage.total.reclaimable > 1024 ** 3) { // > 1GB
    console.log(chalk.green(`💡 You can free up ${formatBytes(usage.total.reclaimable)} with 'mc prune all'`));
  }
  
  if (usage.images.reclaimable > usage.images.size * 0.5) {
    console.log(chalk.yellow(`⚠️  Over 50% of image space is reclaimable. Consider pruning unused images.`));
  }
  
  console.log('');
}

// Create the prune command
const prune = new Command('prune');

prune
  .description('Docker system resource management - prune unused images, containers, volumes, and cache')
  .option('-d, --dry-run', 'Show what would be pruned without removing anything', false)
  .option('-f, --force', 'Skip confirmation prompts', false)
  .option('--images', 'Prune unused images only', false)
  .option('--containers', 'Prune stopped containers only', false)
  .option('--volumes', 'Prune unused volumes only', false)
  .option('--cache', 'Prune build cache only', false)
  .option('--networks', 'Prune unused networks only', false)
  .option('--all', 'Prune everything (images, containers, volumes, networks, cache)', false)
  .option('--dangling-only', 'Only remove dangling images (not all unused)', false);

prune.action(async (options) => {
  try {
    // Check if Docker is available
    try {
      execSync('docker version', { stdio: 'ignore' });
    } catch {
      console.log(chalk.red('❌ Docker is not available'));
      console.log(chalk.gray('   Make sure Docker is installed and running'));
      process.exit(1);
    }
    
    // Default to showing usage if no specific prune target
    const hasSpecificTarget = options.images || options.containers || options.volumes || 
                              options.cache || options.networks || options.all;
    
    if (!hasSpecificTarget) {
      const spinner = ora('Analyzing Docker disk usage...').start();
      const usage = await getDiskUsage();
      spinner.succeed('Analysis complete');
      displayDiskUsage(usage);
      
      console.log(chalk.gray('Run with a target to prune:'));
      console.log('  mc prune --images       Prune unused images');
      console.log('  mc prune --containers   Prune stopped containers');
      console.log('  mc prune --volumes      Prune unused volumes');
      console.log('  mc prune --cache        Prune build cache');
      console.log('  mc prune --all          Prune everything');
      console.log('  mc prune --dry-run      Preview what would be pruned');
      return;
    }
    
    // Get usage before pruning
    const usageBefore = await getDiskUsage();
    let totalFreed = 0;
    
    // Determine what to prune
    const pruneImages = options.all || options.images;
    const pruneContainers = options.all || options.containers;
    const pruneVolumes = options.all || options.volumes;
    const pruneCache = options.all || options.cache;
    const pruneNetworks = options.all || options.networks;
    
    // Preview mode
    if (options.dryRun) {
      console.log(chalk.blue('🔍 Dry Run - Preview of what would be pruned\n'));
      
      if (pruneImages) {
        const images = await getPrunableImages(!options.danglingOnly);
        const dangling = images.filter(i => i.dangling);
        const unused = images.filter(i => !i.dangling);
        
        console.log(chalk.cyan(`Images (${dangling.length} dangling, ${unused.length} unused):`));
        if (images.length === 0) {
          console.log(chalk.gray('  No images to prune'));
        } else {
          images.slice(0, 10).forEach(img => {
            console.log(`  ${img.id}  ${img.repository}:${img.tag}  ${img.sizeFormatted}`);
          });
          if (images.length > 10) {
            console.log(chalk.gray(`  ... and ${images.length - 10} more`));
          }
        }
        console.log('');
      }
      
      if (pruneContainers) {
        const containers = await getPrunableContainers();
        const safeContainers = containers.filter(c => !c.protected);
        
        console.log(chalk.cyan(`Stopped Containers (${safeContainers.length} safe to remove):`));
        if (safeContainers.length === 0) {
          console.log(chalk.gray('  No stopped containers to prune'));
        } else {
          safeContainers.slice(0, 10).forEach(c => {
            console.log(`  ${c.id}  ${c.name}  (${c.image})`);
          });
          if (safeContainers.length > 10) {
            console.log(chalk.gray(`  ... and ${safeContainers.length - 10} more`));
          }
        }
        
        const protectedContainers = containers.filter(c => c.protected);
        if (protectedContainers.length > 0) {
          console.log(chalk.green(`\n  ${protectedContainers.length} MasterClaw containers protected`));
        }
        console.log('');
      }
      
      if (pruneVolumes) {
        const volumes = await getPrunableVolumes();
        console.log(chalk.cyan(`Unused Volumes (${volumes.length}):`));
        if (volumes.length === 0) {
          console.log(chalk.gray('  No unused volumes to prune'));
        } else {
          volumes.slice(0, 10).forEach(v => {
            console.log(`  ${v.name}  (${v.driver})`);
          });
          if (volumes.length > 10) {
            console.log(chalk.gray(`  ... and ${volumes.length - 10} more`));
          }
        }
        console.log('');
      }
      
      if (pruneCache) {
        console.log(chalk.cyan('Build Cache:'));
        if (usageBefore.buildCache.reclaimable === 0) {
          console.log(chalk.gray('  No build cache to prune'));
        } else {
          console.log(`  Would free ${formatBytes(usageBefore.buildCache.reclaimable)}`);
        }
        console.log('');
      }
      
      console.log(chalk.green(`💡 Estimated space to reclaim: ${formatBytes(usageBefore.total.reclaimable)}`));
      console.log(chalk.gray('   Run without --dry-run to actually prune'));
      return;
    }
    
    // Actual pruning
    console.log(chalk.blue('🧹 Docker System Prune\n'));
    
    // Confirmation unless --force
    if (!options.force) {
      const targets = [];
      if (pruneImages) targets.push('images');
      if (pruneContainers) targets.push('containers');
      if (pruneVolumes) targets.push('volumes');
      if (pruneCache) targets.push('build cache');
      if (pruneNetworks) targets.push('networks');
      
      const { confirmed } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirmed',
        message: `Prune ${targets.join(', ')}? This cannot be undone.`,
        default: false,
      }]);
      
      if (!confirmed) {
        console.log(chalk.yellow('⚠️  Prune cancelled'));
        return;
      }
    }
    
    // Prune containers
    if (pruneContainers) {
      const spinner = ora('Pruning stopped containers...').start();
      try {
        const containers = await getPrunableContainers();
        const safeContainers = containers.filter(c => !c.protected);
        
        for (const container of safeContainers) {
          await runDockerCommand(['rm', '-f', container.id], 30000);
        }
        
        spinner.succeed(`Removed ${safeContainers.length} stopped containers`);
        if (containers.some(c => c.protected)) {
          console.log(chalk.gray(`  Skipped ${containers.filter(c => c.protected).length} protected MasterClaw containers`));
        }
      } catch (err) {
        spinner.fail(`Failed to prune containers: ${err.message}`);
      }
    }
    
    // Prune images
    if (pruneImages) {
      const spinner = ora('Pruning images...').start();
      try {
        const filterFlag = options.danglingOnly ? '--filter=dangling=true' : '-a';
        const output = await runDockerCommand(
          ['image', 'prune', filterFlag, '-f'],
          120000
        );
        
        const lines = output.trim().split('\n');
        const freedLine = lines.find(l => l.includes('reclaimed'));
        
        spinner.succeed('Images pruned');
        if (freedLine) {
          console.log(chalk.gray(`  ${freedLine}`));
          const match = freedLine.match(/([\d.]+\s*[BKMGTP]B)/);
          if (match) totalFreed += parseSize(match[1]);
        }
      } catch (err) {
        spinner.fail(`Failed to prune images: ${err.message}`);
      }
    }
    
    // Prune networks
    if (pruneNetworks) {
      const spinner = ora('Pruning unused networks...').start();
      try {
        const output = await runDockerCommand(['network', 'prune', '-f'], 30000);
        const lines = output.trim().split('\n');
        const count = lines.filter(l => l.includes('Deleted:')).length;
        spinner.succeed(`Removed ${count} unused networks`);
      } catch (err) {
        spinner.fail(`Failed to prune networks: ${err.message}`);
      }
    }
    
    // Prune volumes
    if (pruneVolumes) {
      const spinner = ora('Pruning unused volumes...').start();
      try {
        const output = await runDockerCommand(['volume', 'prune', '-f'], 60000);
        const lines = output.trim().split('\n');
        const freedLine = lines.find(l => l.includes('reclaimed'));
        
        spinner.succeed('Volumes pruned');
        if (freedLine) {
          console.log(chalk.gray(`  ${freedLine}`));
          const match = freedLine.match(/([\d.]+\s*[BKMGTP]B)/);
          if (match) totalFreed += parseSize(match[1]);
        }
      } catch (err) {
        spinner.fail(`Failed to prune volumes: ${err.message}`);
      }
    }
    
    // Prune build cache
    if (pruneCache) {
      const spinner = ora('Pruning build cache...').start();
      try {
        const output = await runDockerCommand(['builder', 'prune', '-f'], 120000);
        const lines = output.trim().split('\n');
        const freedLine = lines.find(l => l.includes('reclaimed'));
        
        spinner.succeed('Build cache pruned');
        if (freedLine) {
          console.log(chalk.gray(`  ${freedLine}`));
          const match = freedLine.match(/([\d.]+\s*[BKMGTP]B)/);
          if (match) totalFreed += parseSize(match[1]);
        }
      } catch (err) {
        spinner.fail(`Failed to prune build cache: ${err.message}`);
      }
    }
    
    // Show results
    console.log('');
    console.log(chalk.green('✅ Prune complete!'));
    
    // Get usage after
    const usageAfter = await getDiskUsage();
    const actuallyFreed = usageBefore.total.size - usageAfter.total.size;
    
    if (actuallyFreed > 0) {
      console.log(chalk.green(`💾 Freed ${formatBytes(actuallyFreed)} of disk space`));
    }
    
    console.log(chalk.gray(`   Before: ${formatBytes(usageBefore.total.size)}`));
    console.log(chalk.gray(`   After:  ${formatBytes(usageAfter.total.size)}`));
    
  } catch (err) {
    console.error(chalk.red(`\n❌ Error: ${err.message}`));
    process.exit(1);
  }
});

// Subcommand: Show detailed breakdown
prune
  .command('detail')
  .description('Show detailed breakdown of Docker resources')
  .option('--images', 'Show detailed image list', false)
  .option('--containers', 'Show detailed container list', false)
  .option('--volumes', 'Show detailed volume list', false);

prune.command('detail').action(async (options) => {
  try {
    const showAll = !options.images && !options.containers && !options.volumes;
    
    if (showAll || options.images) {
      console.log(chalk.blue('\n📦 Docker Images\n'));
      const images = await getPrunableImages(true);
      const dangling = images.filter(i => i.dangling);
      const unused = images.filter(i => !i.dangling);
      
      console.log(chalk.cyan(`Dangling Images (${dangling.length}):`));
      if (dangling.length === 0) {
        console.log(chalk.gray('  None'));
      } else {
        dangling.forEach(img => {
          console.log(`  ${img.id}  ${img.sizeFormatted.padEnd(10)}  ${img.created}`);
        });
      }
      
      console.log(chalk.cyan(`\nOther Images (${unused.length}):`));
      if (unused.length === 0) {
        console.log(chalk.gray('  None'));
      } else {
        unused.slice(0, 20).forEach(img => {
          console.log(`  ${img.id}  ${img.repository}:${img.tag}  ${img.sizeFormatted}`);
        });
        if (unused.length > 20) {
          console.log(chalk.gray(`  ... and ${unused.length - 20} more`));
        }
      }
    }
    
    if (showAll || options.containers) {
      console.log(chalk.blue('\n🗂️  Containers\n'));
      const running = await runDockerCommand(['ps', '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}'])
        .then(o => o.trim().split('\n').filter(Boolean).map(l => {
          const [id, name, image, status] = l.split('|');
          return { id: id.substring(0, 12), name, image, status, running: true };
        }))
        .catch(() => []);
      
      const stopped = await getPrunableContainers();
      
      console.log(chalk.cyan(`Running (${running.length}):`));
      if (running.length === 0) {
        console.log(chalk.gray('  None'));
      } else {
        running.forEach(c => {
          const isProtected = c.name && PROTECTED_CONTAINERS.some(pc => c.name.includes(pc));
          const icon = isProtected ? '🔒' : '  ';
          console.log(`${icon} ${c.id}  ${c.name}  (${c.status})`);
        });
      }
      
      console.log(chalk.cyan(`\nStopped (${stopped.length}):`));
      if (stopped.length === 0) {
        console.log(chalk.gray('  None'));
      } else {
        stopped.slice(0, 10).forEach(c => {
          const icon = c.protected ? '🔒' : '  ';
          console.log(`${icon} ${c.id}  ${c.name}  (${c.status})`);
        });
        if (stopped.length > 10) {
          console.log(chalk.gray(`  ... and ${stopped.length - 10} more`));
        }
      }
    }
    
    if (showAll || options.volumes) {
      console.log(chalk.blue('\n💾 Volumes\n'));
      const volumes = await getPrunableVolumes();
      
      // Get all volumes
      const allOutput = await runDockerCommand(['volume', 'ls', '--format', '{{.Name}}|{{.Driver}}']);
      const allVolumes = allOutput.trim().split('\n').filter(Boolean).map(l => {
        const [name, driver] = l.split('|');
        return { name, driver, unused: volumes.some(v => v.name === name) };
      });
      
      console.log(chalk.cyan(`All Volumes (${allVolumes.length}):`));
      allVolumes.forEach(v => {
        const status = v.unused ? chalk.yellow('[unused]') : chalk.green('[in use]');
        console.log(`  ${v.name}  (${v.driver})  ${status}`);
      });
    }
    
    console.log('');
  } catch (err) {
    console.error(chalk.red(`\n❌ Error: ${err.message}`));
    process.exit(1);
  }
});

// Subcommand: Quick prune with safe defaults
prune
  .command('quick')
  .description('Quick prune with safe defaults (dangling images, stopped containers, unused networks)')
  .option('-f, --force', 'Skip confirmation', false);

prune.command('quick').action(async (options) => {
  console.log(chalk.blue('🧹 Quick Prune (Safe Mode)\n'));
  console.log(chalk.gray('This will remove:'));
  console.log('  • Dangling images (untagged, not referenced)');
  console.log('  • Stopped containers (except MasterClaw services)');
  console.log('  • Unused networks');
  console.log('');
  
  // Reuse main prune logic with specific flags
  options.images = true;
  options.containers = true;
  options.networks = true;
  options.volumes = false;
  options.cache = false;
  options.all = false;
  options.danglingOnly = true;
  options.dryRun = false;
  
  await prune.action(options);
});

module.exports = prune;
module.exports.getDiskUsage = getDiskUsage;
module.exports.parseSize = parseSize;
module.exports.formatBytes = formatBytes;
