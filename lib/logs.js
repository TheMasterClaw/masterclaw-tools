// logs.js - Log management commands for mc CLI
// Provides unified access to container logs across the MasterClaw ecosystem

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// Import security validation functions and error classes from docker module
const {
  validateContainerName,
  validateTailOption,
  DockerSecurityError,
  DockerCommandError,
} = require('./docker');

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

// =============================================================================
// Security Constants
// =============================================================================

/** Valid service names */
const VALID_SERVICES = new Set(Object.keys(SERVICES));

/** Valid duration pattern (e.g., 5m, 1h, 24h, 30s) */
const VALID_DURATION = /^\d+[smhdw]$/;

/** Maximum allowed lines for log export/search (prevent DoS) */
const MAX_EXPORT_LINES = 50000;

/** Dangerous characters that could enable command injection */
const DANGEROUS_CHARS = /[;&|`$(){}[\]\\<>\n\r]/;

/** Valid filename pattern for exports */
const VALID_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates service name
 * @param {string} service - Service name to validate
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If service name is invalid
 */
function validateServiceName(service) {
  if (typeof service !== 'string') {
    throw new DockerSecurityError(
      `Service name must be a string, got ${typeof service}`,
      'INVALID_SERVICE_NAME_TYPE',
      { provided: typeof service }
    );
  }

  if (!VALID_SERVICES.has(service)) {
    throw new DockerSecurityError(
      `Unknown service: ${service}. Valid services: ${Array.from(VALID_SERVICES).join(', ')}`,
      'UNKNOWN_SERVICE',
      { validServices: Array.from(VALID_SERVICES) }
    );
  }

  return true;
}

/**
 * Validates duration string (e.g., 5m, 1h, 24h)
 * @param {string} duration - Duration string
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If duration is invalid
 */
function validateDuration(duration) {
  if (typeof duration !== 'string') {
    throw new DockerSecurityError(
      `Duration must be a string, got ${typeof duration}`,
      'INVALID_DURATION_TYPE',
      { provided: typeof duration }
    );
  }

  if (!VALID_DURATION.test(duration)) {
    throw new DockerSecurityError(
      `Invalid duration format: ${duration}. Use format like: 30s, 5m, 1h, 24h, 7d, 2w`,
      'INVALID_DURATION_FORMAT',
      { provided: duration }
    );
  }

  // Prevent excessively large durations that could cause resource issues
  const value = parseInt(duration, 10);
  const unit = duration.slice(-1);
  const maxValues = { s: 86400, m: 1440, h: 168, d: 365, w: 52 }; // reasonable limits

  if (value > maxValues[unit]) {
    throw new DockerSecurityError(
      `Duration too large: ${duration}. Maximum is ${maxValues[unit]}${unit}`,
      'DURATION_TOO_LARGE',
      { provided: duration, max: `${maxValues[unit]}${unit}` }
    );
  }

  return true;
}

/**
 * Validates lines/tail option with upper bound
 * @param {string|number} lines - Number of lines
 * @param {number} maxLines - Maximum allowed (default: MAX_EXPORT_LINES)
 * @returns {number} - Validated line count
 * @throws {DockerSecurityError} - If invalid
 */
function validateLines(lines, maxLines = MAX_EXPORT_LINES) {
  const numLines = parseInt(lines, 10);

  if (isNaN(numLines) || !Number.isInteger(numLines)) {
    throw new DockerSecurityError(
      `Lines must be an integer, got: ${lines}`,
      'INVALID_LINES_TYPE',
      { provided: lines }
    );
  }

  if (numLines < 0) {
    throw new DockerSecurityError(
      `Lines cannot be negative: ${numLines}`,
      'NEGATIVE_LINES',
      { provided: numLines }
    );
  }

  if (numLines > maxLines) {
    throw new DockerSecurityError(
      `Lines exceeds maximum of ${maxLines}: ${numLines}`,
      'LINES_TOO_LARGE',
      { provided: numLines, max: maxLines }
    );
  }

  return numLines;
}

/**
 * Validates search pattern (basic validation to prevent regex DoS and injection)
 * @param {string} pattern - Search pattern
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If pattern is invalid or dangerous
 */
function validateSearchPattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new DockerSecurityError(
      `Pattern must be a string, got ${typeof pattern}`,
      'INVALID_PATTERN_TYPE',
      { provided: typeof pattern }
    );
  }

  if (pattern.length === 0) {
    throw new DockerSecurityError(
      'Search pattern cannot be empty',
      'EMPTY_PATTERN'
    );
  }

  if (pattern.length > 1000) {
    throw new DockerSecurityError(
      'Search pattern too long (max 1000 characters)',
      'PATTERN_TOO_LONG',
      { length: pattern.length, max: 1000 }
    );
  }

  // Check for dangerous shell characters
  if (DANGEROUS_CHARS.test(pattern)) {
    throw new DockerSecurityError(
      'Search pattern contains potentially dangerous characters',
      'DANGEROUS_CHARS_IN_PATTERN',
      { pattern: pattern.substring(0, 50) + (pattern.length > 50 ? '...' : '') }
    );
  }

  // Check for null bytes
  if (pattern.includes('\0')) {
    throw new DockerSecurityError(
      'Search pattern cannot contain null bytes',
      'NULL_BYTE_IN_PATTERN'
    );
  }

  return true;
}

/**
 * Validates output directory path (prevents path traversal)
 * @param {string} dirPath - Directory path
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If path is invalid
 */
function validateOutputDir(dirPath) {
  if (typeof dirPath !== 'string') {
    throw new DockerSecurityError(
      `Output directory must be a string, got ${typeof dirPath}`,
      'INVALID_OUTPUT_DIR_TYPE',
      { provided: typeof dirPath }
    );
  }

  if (dirPath.length === 0) {
    throw new DockerSecurityError(
      'Output directory cannot be empty',
      'EMPTY_OUTPUT_DIR'
    );
  }

  // Check for null bytes
  if (dirPath.includes('\0')) {
    throw new DockerSecurityError(
      'Output directory cannot contain null bytes',
      'NULL_BYTE_IN_OUTPUT_DIR'
    );
  }

  // Normalize and check for path traversal
  const normalized = path.normalize(dirPath);
  if (normalized.startsWith('..') || normalized.includes('../') || normalized.includes('..\\')) {
    throw new DockerSecurityError(
      'Output directory cannot contain path traversal sequences',
      'PATH_TRAVERSAL_IN_OUTPUT_DIR',
      { path: dirPath }
    );
  }

  return true;
}

/**
 * Escapes a string for safe use in shell commands
 * Uses single quote wrapping and proper escaping
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function shellEscape(str) {
  // Wrap in single quotes and escape any single quotes
  // 'test' -> 'test'
  // 'it's' -> 'it'"'"'s'
  return "'" + str.replace(/'/g, "'\"'\"'") + "'";
}

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
    try {
      const service = serviceArg || 'all';

      // Validate service name
      validateServiceName(service);

      if (!await isDockerAvailable()) {
        console.error(chalk.red('❌ Docker is not available'));
        process.exit(1);
      }

      const container = SERVICES[service];

      // Validate lines/tail option
      const linesOption = options.lines || options.tail;
      let validatedLines;
      try {
        validatedLines = validateLines(linesOption, 10000);
      } catch (err) {
        console.error(chalk.red(`❌ ${err.message}`));
        process.exit(1);
      }

      // Validate since option if provided
      if (options.since) {
        try {
          validateDuration(options.since);
        } catch (err) {
          console.error(chalk.red(`❌ ${err.message}`));
          process.exit(1);
        }
      }

      // Build docker logs command
      const args = ['logs'];

      if (options.follow) {
        args.push('--follow');
      }

      args.push('--tail', String(validatedLines));

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
            const composeArgs = ['logs', '-f', '--tail', String(validatedLines)];
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
            // Use spawn with properly validated arguments instead of execSync
            const logOutput = await new Promise((resolve, reject) => {
              const proc = spawn('docker', ['logs', '--tail', String(validatedLines), svcContainer]);
              let stdout = '';
              let stderr = '';

              proc.stdout.on('data', (data) => { stdout += data.toString(); });
              proc.stderr.on('data', (data) => { stderr += data.toString(); });

              proc.on('close', (code) => {
                // Docker logs returns 0 even for stopped containers, check if we got output
                resolve(stdout + stderr);
              });

              proc.on('error', (err) => {
                reject(err);
              });
            });

            if (logOutput.trim()) {
              // Prefix each line with service name
              const prefixed = logOutput
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
    } catch (err) {
      if (err instanceof DockerSecurityError) {
        console.error(chalk.red(`❌ Security error: ${err.message}`));
      } else {
        console.error(chalk.red(`❌ Error: ${err.message}`));
      }
      process.exit(1);
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

    // Validate service name
    try {
      validateServiceName(service);
    } catch (err) {
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }

    // Validate output directory
    try {
      validateOutputDir(options.output);
    } catch (err) {
      console.error(chalk.red(`❌ Invalid output directory: ${err.message}`));
      process.exit(1);
    }

    // Validate since option if provided
    if (options.since) {
      try {
        validateDuration(options.since);
      } catch (err) {
        console.error(chalk.red(`❌ ${err.message}`));
        process.exit(1);
      }
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
        // Build args array properly
        const args = ['logs'];

        if (options.since) {
          args.push('--since', options.since);
        }

        args.push(container);

        // Use spawn instead of execSync with shell string concatenation
        const output = await new Promise((resolve, reject) => {
          const proc = spawn('docker', args);
          let stdout = '';
          let stderr = '';

          proc.stdout.on('data', (data) => { stdout += data.toString(); });
          proc.stderr.on('data', (data) => { stderr += data.toString(); });

          proc.on('close', (code) => {
            // Docker logs exits 0 on success, but may have stderr warnings
            resolve(stdout + stderr);
          });

          proc.on('error', (err) => {
            reject(err);
          });
        });

        const outputPath = path.join(exportDir, `${svc}.log`);
        await fs.writeFile(outputPath, output);

        const size = formatBytes(Buffer.byteLength(output, 'utf8'));
        console.log(chalk.green(`  ✅ ${svc} (${size})`));
        exported++;

        // Also export container inspect info for debugging
        try {
          const inspect = await new Promise((resolve, reject) => {
            const proc = spawn('docker', ['inspect', container]);
            let stdout = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.on('close', () => resolve(stdout));
            proc.on('error', reject);
          });
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
    try {
      const service = serviceArg || 'all';

      // Validate service name
      try {
        validateServiceName(service);
      } catch (err) {
        console.error(chalk.red(`❌ ${err.message}`));
        process.exit(1);
      }

      // Validate search pattern (security check)
      try {
        validateSearchPattern(pattern);
      } catch (err) {
        console.error(chalk.red(`❌ Invalid search pattern: ${err.message}`));
        process.exit(1);
      }

      // Validate context lines
      let contextLines;
      try {
        contextLines = validateLines(options.context, 100);
      } catch (err) {
        console.error(chalk.red(`❌ Invalid context lines: ${err.message}`));
        process.exit(1);
      }

      if (!await isDockerAvailable()) {
        console.error(chalk.red('❌ Docker is not available'));
        process.exit(1);
      }

      // Escape pattern for display (not for regex, that's intentional)
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
          // Use spawn with validated arguments instead of execSync with string interpolation
          const logData = await new Promise((resolve, reject) => {
            const proc = spawn('docker', ['logs', '--tail', '10000', container]);
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
              resolve(stdout + stderr);
            });

            proc.on('error', (err) => {
              reject(err);
            });
          });

          const lines = logData.split('\n');
          const matches = [];

          // Create regex for search - pattern was already validated for dangerous chars
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
    } catch (err) {
      if (err instanceof DockerSecurityError) {
        console.error(chalk.red(`❌ Security error: ${err.message}`));
        if (err.code) {
          console.error(chalk.gray(`   Code: ${err.code}`));
        }
      } else if (err instanceof DockerCommandError) {
        console.error(chalk.red(`❌ Command error: ${err.message}`));
        if (err.exitCode !== undefined) {
          console.error(chalk.gray(`   Exit code: ${err.exitCode}`));
        }
      } else {
        console.error(chalk.red(`❌ Error: ${err.message}`));
      }
      process.exit(1);
    }
  });

module.exports = logs;
