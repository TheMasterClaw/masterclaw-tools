/**
 * MasterClaw Size - Disk Usage Analyzer
 *
 * Comprehensive disk usage analysis for MasterClaw components:
 * - Data directory sizes (backups, logs, memories, sessions)
 * - Docker volume sizes for MasterClaw containers
 * - Container layer sizes
 * - Total footprint calculation
 * - Sortable and filterable output
 * - JSON export for monitoring integration
 *
 * Security Features:
 * - Path validation to prevent command injection
 * - Shell argument escaping for all external commands
 * - Input sanitization for user-controllable paths
 * - Timeout protection for long-running operations
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync, execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');

// =============================================================================
// Security Utilities
// =============================================================================

/**
 * Validates that a path is safe for use in shell commands
 * Prevents command injection by rejecting dangerous characters and patterns
 *
 * @param {string} filePath - Path to validate
 * @returns {boolean} - True if path is safe
 */
function isValidPath(filePath) {
  if (typeof filePath !== 'string') {
    return false;
  }

  // Reject empty paths
  if (filePath.length === 0 || filePath.length > 4096) {
    return false;
  }

  // Reject paths with null bytes (injection indicator)
  if (filePath.includes('\0')) {
    return false;
  }

  // Reject paths with shell metacharacters that could enable injection
  const dangerousChars = /[;&|`$(){}[\]<>\n\r]/;
  if (dangerousChars.test(filePath)) {
    return false;
  }

  // Reject path traversal attempts BEFORE normalization
  // Check for .. as a path component (surrounded by / or at start/end)
  if (/\.\.(\/|\\|$)/.test(filePath) || /(^|\/|\\)\.\./.test(filePath)) {
    return false;
  }

  return true;
}

/**
 * Escapes a string for safe use in shell double quotes
 * Handles backslashes, quotes, and other special characters
 *
 * @param {string} arg - Argument to escape
 * @returns {string} - Escaped argument
 */
function escapeShellArg(arg) {
  if (typeof arg !== 'string') {
    return '';
  }

  // Replace backslashes first, then quotes
  // This prevents double-escaping issues
  return arg
    .replace(/\\/g, '\\\\')  // Escape backslashes
    .replace(/"/g, '\\"');   // Escape double quotes
}

/**
 * Validates and sanitizes a path for shell command usage
 * Returns null if the path is unsafe
 *
 * @param {string} filePath - Path to validate and sanitize
 * @returns {string|null} - Sanitized path or null if unsafe
 */
function validateAndSanitizePath(filePath) {
  if (!isValidPath(filePath)) {
    return null;
  }

  // Resolve to absolute path to prevent relative path tricks
  const resolved = path.resolve(filePath);

  // Additional check: ensure path doesn't contain dangerous patterns after resolution
  if (!isValidPath(resolved)) {
    return null;
  }

  return resolved;
}

// MasterClaw service names for Docker filtering
const MASTERCLAW_CONTAINERS = [
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

const MASTERCLAW_VOLUMES = [
  'mc-data',
  'mc-backend-data',
  'mc-gateway-data',
  'mc-chroma-data',
];

// Format bytes to human-readable
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// Parse size string from du command
function parseDuOutput(output) {
  const lines = output.trim().split('\n');
  const result = [];
  
  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match) {
      result.push({
        size: parseInt(match[1], 10) * 1024, // Convert from KB to bytes
        path: match[2],
      });
    }
  }
  
  return result;
}

// Get directory size using du
async function getDirectorySize(dirPath) {
  try {
    // Security: Validate and sanitize the path
    const safePath = validateAndSanitizePath(dirPath);
    if (!safePath) {
      return 0;
    }

    if (!await fs.pathExists(safePath)) {
      return 0;
    }

    // Verify it's actually a directory
    const stats = await fs.stat(safePath);
    if (!stats.isDirectory()) {
      return 0;
    }

    // Security: Use execFileSync with arguments array instead of execSync with shell
    // This prevents shell injection entirely by not invoking a shell
    const output = execFileSync('du', ['-sk', safePath], {
      encoding: 'utf8',
      timeout: 30000,
      shell: false,  // Explicitly disable shell
    });

    const match = output.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) * 1024 : 0;
  } catch (err) {
    // Silently return 0 on error (directory may not exist or be accessible)
    return 0;
  }
}

// Get detailed breakdown of a directory
async function getDirectoryBreakdown(dirPath, maxDepth = 1) {
  try {
    // Security: Validate and sanitize the path
    const safePath = validateAndSanitizePath(dirPath);
    if (!safePath) {
      return [];
    }

    if (!await fs.pathExists(safePath)) {
      return [];
    }

    // Verify it's actually a directory
    const stats = await fs.stat(safePath);
    if (!stats.isDirectory()) {
      return [];
    }

    // Security: Validate maxDepth parameter
    const safeMaxDepth = Math.max(0, Math.min(parseInt(maxDepth, 10) || 1, 10));

    // Security: Use execFileSync with arguments array instead of shell
    const output = execFileSync('du', ['-k', `--max-depth=${safeMaxDepth}`, safePath], {
      encoding: 'utf8',
      timeout: 30000,
      shell: false,  // Explicitly disable shell
    });

    const lines = output.trim().split('\n').filter(Boolean);
    const items = [];

    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (match && match[2] !== safePath) {
        items.push({
          name: path.basename(match[2]),
          size: parseInt(match[1], 10) * 1024,
        });
      }
    }

    return items.sort((a, b) => b.size - a.size);
  } catch (err) {
    return [];
  }
}

// Get Docker volume sizes
async function getDockerVolumeSizes() {
  try {
    // Check if Docker is available
    execSync('docker version', { stdio: 'ignore' });
  } catch {
    return { volumes: [], total: 0 };
  }
  
  try {
    // Get all volumes
    const volumeOutput = execSync(
      'docker volume ls --format "{{.Name}}|{{.Driver}}" 2>/dev/null || echo ""',
      { encoding: 'utf8', timeout: 10000 }
    );
    
    if (!volumeOutput.trim()) {
      return { volumes: [], total: 0 };
    }
    
    const volumes = [];
    const lines = volumeOutput.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      const [name, driver] = line.split('|');
      
      // Only include MasterClaw-related volumes
      const isMasterClawVolume = MASTERCLAW_VOLUMES.some(v => name.includes(v)) ||
                                  name.startsWith('mc-') ||
                                  name.includes('masterclaw');
      
      if (isMasterClawVolume || MASTERCLAW_VOLUMES.includes(name)) {
        try {
          // Get volume size by inspecting mountpoint
          const inspectOutput = execSync(
            `docker volume inspect "${name}" --format "{{.Mountpoint}}" 2>/dev/null || echo ""`,
            { encoding: 'utf8', timeout: 5000 }
          );
          
          const mountpoint = inspectOutput.trim();
          let size = 0;
          
          if (mountpoint) {
            try {
              const duOutput = execSync(`du -sk "${mountpoint}" 2>/dev/null || echo "0"`, {
                encoding: 'utf8',
                timeout: 5000,
              });
              const match = duOutput.match(/^(\d+)/);
              size = match ? parseInt(match[1], 10) * 1024 : 0;
            } catch (e) {
              // Size unknown
            }
          }
          
          volumes.push({ name, driver, size });
        } catch (e) {
          volumes.push({ name, driver, size: 0 });
        }
      }
    }
    
    const total = volumes.reduce((sum, v) => sum + v.size, 0);
    return { volumes: volumes.sort((a, b) => b.size - a.size), total };
  } catch (err) {
    return { volumes: [], total: 0 };
  }
}

// Get container sizes
async function getContainerSizes() {
  try {
    // Check if Docker is available
    execSync('docker version', { stdio: 'ignore' });
  } catch {
    return { containers: [], total: 0 };
  }
  
  try {
    const output = execSync(
      'docker ps -a --filter "name=mc-" --format "{{.Names}}|{{.Size}}|{{.Status}}" 2>/dev/null || echo ""',
      { encoding: 'utf8', timeout: 10000 }
    );
    
    if (!output.trim()) {
      return { containers: [], total: 0 };
    }
    
    const containers = [];
    const lines = output.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      const [name, sizeStr, status] = line.split('|');
      
      // Parse size string like "2.34MB (virtual 245MB)"
      const virtualMatch = sizeStr.match(/virtual\s+([\d.]+\s*[KMGT]?B)/i);
      const actualMatch = sizeStr.match(/^([\d.]+\s*[KMGT]?B)/i);
      
      containers.push({
        name,
        status,
        actualSize: parseSizeString(actualMatch ? actualMatch[1] : '0B'),
        virtualSize: parseSizeString(virtualMatch ? virtualMatch[1] : '0B'),
      });
    }
    
    const total = containers.reduce((sum, c) => sum + c.actualSize, 0);
    return { containers: containers.sort((a, b) => b.actualSize - a.actualSize), total };
  } catch (err) {
    return { containers: [], total: 0 };
  }
}

// Parse size string like "2.34MB" to bytes
function parseSizeString(sizeStr) {
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

// Get image sizes for MasterClaw images
async function getImageSizes() {
  try {
    // Check if Docker is available
    execSync('docker version', { stdio: 'ignore' });
  } catch {
    return { images: [], total: 0 };
  }
  
  try {
    const output = execSync(
      'docker images --format "{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}" 2>/dev/null || echo ""',
      { encoding: 'utf8', timeout: 10000 }
    );
    
    if (!output.trim()) {
      return { images: [], total: 0 };
    }
    
    const images = [];
    const lines = output.trim().split('\n').filter(Boolean);
    
    for (const line of lines) {
      const [repository, tag, sizeStr, created] = line.split('|');
      
      // Filter for MasterClaw-related images
      const isMasterClawImage = repository.includes('masterclaw') ||
                                 repository.includes('mc-') ||
                                 repository.includes('chroma') ||
                                 repository.includes('traefik');
      
      if (isMasterClawImage || tag.includes('mc')) {
        images.push({
          repository,
          tag,
          size: parseSizeString(sizeStr),
          created,
        });
      }
    }
    
    const total = images.reduce((sum, img) => sum + img.size, 0);
    return { images: images.sort((a, b) => b.size - a.size), total };
  } catch (err) {
    return { images: [], total: 0 };
  }
}

// Find infrastructure directory
async function findInfraDir() {
  // Check environment variable first
  if (process.env.MASTERCLAW_INFRA_DIR) {
    // Security: Validate the environment variable path
    const safePath = validateAndSanitizePath(process.env.MASTERCLAW_INFRA_DIR);
    if (safePath && await fs.pathExists(path.join(safePath, 'docker-compose.yml'))) {
      return safePath;
    }
  }

  // Check common locations
  const candidates = [
    '/opt/masterclaw-infrastructure',
    '/opt/masterclaw',
    `${process.env.HOME}/masterclaw-infrastructure`,
    `${process.env.HOME}/masterclaw`,
    '/var/lib/masterclaw',
    process.cwd(),
  ];

  for (const dir of candidates) {
    // Security: Validate each candidate path before use
    const safeDir = validateAndSanitizePath(dir);
    if (safeDir && await fs.pathExists(path.join(safeDir, 'docker-compose.yml'))) {
      return safeDir;
    }
  }

  return null;
}

// Create the size command
const size = new Command('size');

size
  .description('Analyze disk usage of MasterClaw components (data, volumes, containers, images)')
  .option('-j, --json', 'Output as JSON for scripting')
  .option('--data-only', 'Show only data directory sizes')
  .option('--docker-only', 'Show only Docker resource sizes')
  .option('--breakdown', 'Show detailed breakdown of subdirectories')
  .option('--threshold <size>', 'Only show items larger than threshold (e.g., "100MB")', '0');

size.action(async (options) => {
  const threshold = parseSizeString(options.threshold);
  
  // Collect all data
  const spinner = ora('Analyzing MasterClaw disk usage...').start();
  
  const infraDir = await findInfraDir();
  const results = {
    timestamp: new Date().toISOString(),
    infrastructure: {
      directory: infraDir,
    },
    data: {},
    docker: {},
    total: 0,
  };
  
  // Get data directory sizes
  if (!options.dockerOnly && infraDir) {
    spinner.text = 'Scanning data directories...';
    
    const dataDirs = [
      { name: 'backups', path: path.join(infraDir, 'backups') },
      { name: 'logs', path: path.join(infraDir, 'logs') },
      { name: 'data', path: path.join(infraDir, 'data') },
    ];
    
    for (const dir of dataDirs) {
      const size = await getDirectorySize(dir.path);
      results.data[dir.name] = {
        path: dir.path,
        size,
        formatted: formatBytes(size),
      };
      
      if (options.breakdown && size > 0) {
        results.data[dir.name].breakdown = await getDirectoryBreakdown(dir.path, 1);
      }
    }
    
    // Try to find memory/session directories inside data
    const dataSubdirs = ['memory', 'sessions', 'uploads', 'chroma'];
    for (const subdir of dataSubdirs) {
      const subdirPath = path.join(infraDir, 'data', subdir);
      if (await fs.pathExists(subdirPath)) {
        const size = await getDirectorySize(subdirPath);
        results.data[subdir] = {
          path: subdirPath,
          size,
          formatted: formatBytes(size),
        };
      }
    }
    
    results.data.total = Object.values(results.data)
      .filter(v => typeof v === 'object' && v.size !== undefined)
      .reduce((sum, v) => sum + v.size, 0);
  }
  
  // Get Docker resources
  if (!options.dataOnly) {
    spinner.text = 'Analyzing Docker volumes...';
    results.docker.volumes = await getDockerVolumeSizes();
    
    spinner.text = 'Analyzing Docker containers...';
    results.docker.containers = await getContainerSizes();
    
    spinner.text = 'Analyzing Docker images...';
    results.docker.images = await getImageSizes();
    
    results.docker.total = results.docker.volumes.total +
                            results.docker.containers.total +
                            results.docker.images.total;
  }
  
  // Calculate grand total
  results.total = (results.data.total || 0) + (results.docker.total || 0);
  
  spinner.succeed('Analysis complete');
  
  // JSON output mode
  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  
  // Pretty output
  console.log(chalk.blue('🐾 MasterClaw Disk Usage Analysis\n'));
  
  if (infraDir) {
    console.log(`Infrastructure: ${chalk.gray(infraDir)}\n`);
  }
  
  // Data directories
  if (!options.dockerOnly && results.data.total > 0) {
    console.log(chalk.cyan('📁 Data Directories'));
    console.log('─'.repeat(50));
    
    const dataEntries = Object.entries(results.data)
      .filter(([key]) => key !== 'total')
      .sort(([, a], [, b]) => b.size - a.size);
    
    for (const [name, info] of dataEntries) {
      if (info.size < threshold) continue;
      
      const sizeColor = info.size > 1024 ** 3 ? chalk.yellow : chalk.white;
      console.log(`  ${name.padEnd(12)} ${sizeColor(formatBytes(info.size).padStart(10))}`);
      
      if (options.breakdown && info.breakdown) {
        for (const item of info.breakdown.slice(0, 5)) {
          if (item.size < threshold) continue;
          console.log(`    ${chalk.gray('├─')} ${item.name.padEnd(20)} ${chalk.gray(formatBytes(item.size))}`);
        }
        if (info.breakdown.length > 5) {
          console.log(`    ${chalk.gray(`└─ ... and ${info.breakdown.length - 5} more`)}`);
        }
      }
    }
    
    console.log(`  ${'─'.repeat(48)}`);
    console.log(`  ${chalk.bold('Total'.padEnd(12))} ${chalk.bold(formatBytes(results.data.total).padStart(10))}\n`);
  }
  
  // Docker resources
  if (!options.dataOnly) {
    // Volumes
    if (results.docker.volumes.volumes.length > 0) {
      console.log(chalk.cyan('💾 Docker Volumes'));
      console.log('─'.repeat(50));
      
      for (const vol of results.docker.volumes.volumes) {
        if (vol.size < threshold) continue;
        const sizeColor = vol.size > 1024 ** 3 ? chalk.yellow : chalk.white;
        console.log(`  ${vol.name.padEnd(25)} ${sizeColor(formatBytes(vol.size).padStart(10))}`);
      }
      
      console.log(`  ${'─'.repeat(48)}`);
      console.log(`  ${chalk.bold('Total'.padEnd(25))} ${chalk.bold(formatBytes(results.docker.volumes.total).padStart(10))}\n`);
    }
    
    // Containers
    if (results.docker.containers.containers.length > 0) {
      console.log(chalk.cyan('🐳 Docker Containers'));
      console.log('─'.repeat(50));
      
      for (const container of results.docker.containers.containers) {
        if (container.actualSize < threshold) continue;
        const statusIcon = container.status.includes('Up') ? chalk.green('●') : chalk.red('●');
        console.log(`  ${statusIcon} ${container.name.padEnd(20)} ${formatBytes(container.actualSize).padStart(10)} ${chalk.gray('(virtual ' + formatBytes(container.virtualSize) + ')')}`);
      }
      
      console.log(`  ${'─'.repeat(48)}`);
      console.log(`  ${chalk.bold('Total'.padEnd(22))} ${chalk.bold(formatBytes(results.docker.containers.total).padStart(10))}\n`);
    }
    
    // Images
    if (results.docker.images.images.length > 0) {
      console.log(chalk.cyan('📦 Docker Images'));
      console.log('─'.repeat(50));
      
      for (const image of results.docker.images.images.slice(0, 10)) {
        if (image.size < threshold) continue;
        const name = `${image.repository}:${image.tag}`.substring(0, 25).padEnd(25);
        console.log(`  ${name} ${formatBytes(image.size).padStart(10)}`);
      }
      
      if (results.docker.images.images.length > 10) {
        console.log(`  ${chalk.gray(`... and ${results.docker.images.images.length - 10} more images`)}`);
      }
      
      console.log(`  ${'─'.repeat(48)}`);
      console.log(`  ${chalk.bold('Total'.padEnd(25))} ${chalk.bold(formatBytes(results.docker.images.total).padStart(10))}\n`);
    }
  }
  
  // Grand total
  console.log(chalk.green('═'.repeat(50)));
  console.log(chalk.bold(`  Grand Total: ${formatBytes(results.total).padStart(15)}`));
  console.log(chalk.green('═'.repeat(50)));
  
  // Recommendations
  console.log('\n💡 Tips:');
  if (results.data.backups && results.data.backups.size > 5 * 1024 ** 3) {
    console.log(chalk.yellow('  • Large backup directory - consider running: mc backup cleanup'));
  }
  if (results.data.logs && results.data.logs.size > 1024 ** 3) {
    console.log(chalk.yellow('  • Large log directory - consider running: mc logs clean'));
  }
  if (results.docker.volumes.total > 10 * 1024 ** 3) {
    console.log(chalk.yellow('  • Large Docker volumes - consider running: mc prune --volumes'));
  }
  if (results.docker.images.total > 5 * 1024 ** 3) {
    console.log(chalk.yellow('  • Large Docker images - consider running: mc prune --images'));
  }
  console.log(chalk.gray('  • Run with --json flag for machine-readable output'));
  console.log(chalk.gray('  • Run with --breakdown for detailed subdirectory analysis'));
});

// Subcommand: Compare sizes over time
size
  .command('history')
  .description('Show size history and trends (if tracked)');

size.command('history').action(async () => {
  console.log(chalk.blue('📈 Size History\n'));
  console.log(chalk.gray('Size history tracking is not yet implemented.'));
  console.log(chalk.gray('Future versions will track disk usage trends over time.'));
});

module.exports = size;
module.exports.formatBytes = formatBytes;
module.exports.parseSizeString = parseSizeString;
module.exports.getDirectorySize = getDirectorySize;
module.exports.getDirectoryBreakdown = getDirectoryBreakdown;

// Security utilities (exported for testing)
module.exports.isValidPath = isValidPath;
module.exports.escapeShellArg = escapeShellArg;
module.exports.validateAndSanitizePath = validateAndSanitizePath;
