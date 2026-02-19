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
 * Validates export options (wrapper for validateLines)
 * @param {Object} options - Export options
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If invalid
 */
function validateExportOptions(options) {
  if (options.lines !== undefined) {
    validateLines(options.lines);
  }
  return true;
}

/**
 * Validates search query (wrapper for validateSearchPattern)
 * @param {string} query - Search query
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If invalid
 */
function validateSearchQuery(query) {
  if (typeof query !== 'string') {
    throw new DockerSecurityError(
      `Search query must be a string, got ${typeof query}`,
      'INVALID_QUERY_TYPE',
      { provided: typeof query }
    );
  }

  // Trim whitespace and check if empty
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new DockerSecurityError(
      'Search query cannot be empty',
      'EMPTY_SEARCH_QUERY'
    );
  }
  return validateSearchPattern(query);
}

/**
 * Validates filename for exports
 * @param {string} filename - Filename to validate
 * @returns {boolean} - True if valid
 * @throws {DockerSecurityError} - If invalid
 */
function validateFilename(filename) {
  if (typeof filename !== 'string') {
    throw new DockerSecurityError(
      `Filename must be a string, got ${typeof filename}`,
      'INVALID_FILENAME_TYPE',
      { provided: typeof filename }
    );
  }

  if (filename.length === 0) {
    throw new DockerSecurityError(
      'Filename cannot be empty',
      'EMPTY_FILENAME'
    );
  }

  // Check for path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new DockerSecurityError(
      'Filename cannot contain path traversal sequences',
      'PATH_TRAVERSAL_IN_FILENAME',
      { filename }
    );
  }

  // Check for dangerous characters
  if (DANGEROUS_CHARS.test(filename)) {
    throw new DockerSecurityError(
      'Filename contains potentially dangerous characters',
      'DANGEROUS_CHARS_IN_FILENAME',
      { filename }
    );
  }

  // Validate against filename pattern
  if (!VALID_FILENAME.test(filename)) {
    throw new DockerSecurityError(
      'Filename contains invalid characters. Must start with alphanumeric and contain only alphanumeric characters, hyphens, underscores, and dots.',
      'INVALID_FILENAME_CHARS',
      { filename }
    );
  }

  return true;
}

/**
 * Formats service name to container name
 * @param {string} service - Service name
 * @returns {string|null} - Container name or null for 'all'
 */
function formatServiceName(service) {
  return SERVICES[service] || null;
}

/**
 * Parses --since option and returns ISO timestamp
 * @param {string} since - Duration string (e.g., 5m, 1h)
 * @returns {string|null} - ISO timestamp or null if invalid
 */
function parseSinceOption(since) {
  if (typeof since !== 'string') {
    return null;
  }

  if (!VALID_DURATION.test(since)) {
    return null;
  }

  const value = parseInt(since, 10);
  const unit = since.slice(-1);
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
  const ms = value * multipliers[unit];
  const date = new Date(Date.now() - ms);
  return date.toISOString();
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
  return `'${  str.replace(/'/g, "'\"'\"'")  }'`;
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

    console.log(`\n${  '-'.repeat(60)}`);
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

// Rotate logs - Force log rotation on all containers
logs
  .command('rotate')
  .description('Force log rotation on all containers to free disk space')
  .option('-s, --service <name>', 'Rotate logs for specific service only')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (options) => {
    if (!await isDockerAvailable()) {
      console.error(chalk.red('❌ Docker is not available'));
      process.exit(1);
    }

    // Validate service name if provided
    if (options.service) {
      try {
        validateServiceName(options.service);
      } catch (err) {
        console.error(chalk.red(`❌ ${err.message}`));
        process.exit(1);
      }
    }

    const infraDir = await findInfraDir();

    // Use infrastructure script if available
    if (infraDir && !options.service) {
      const scriptPath = path.join(infraDir, 'scripts', 'logs.sh');

      if (await fs.pathExists(scriptPath)) {
        console.log(chalk.blue('🔄 Rotating MasterClaw logs...\n'));

        const proc = spawn('bash', [scriptPath, 'rotate'], {
          stdio: 'inherit',
        });

        proc.on('close', (code) => {
          if (code === 0) {
            console.log(chalk.green('\n✅ Log rotation complete\n'));
          }
          process.exit(code);
        });
        return;
      }
    }

    // Manual rotation fallback
    const targetServices = options.service
      ? { [options.service]: SERVICES[options.service] }
      : SERVICES;

    const serviceNames = Object.keys(targetServices).filter(n => n !== 'all');

    if (!options.yes) {
      console.log(chalk.blue('🔄 Log Rotation'));
      console.log('===============\n');
      console.log(chalk.yellow('This will send SIGUSR1 to container processes to trigger log rotation.\n'));
      console.log('Services to rotate:');
      serviceNames.forEach(name => console.log(`  • ${name}`));
      console.log('');

      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise((resolve) => {
        rl.question('Proceed with rotation? [y/N] ', resolve);
      });
      rl.close();

      if (!answer.match(/^y$/i)) {
        console.log('Cancelled.');
        return;
      }
      console.log('');
    }

    console.log(chalk.blue('🔄 Rotating logs...\n'));

    let rotated = 0;
    let failed = 0;
    let skipped = 0;

    for (const [name, container] of Object.entries(targetServices)) {
      if (name === 'all') continue;

      try {
        // Check if container is running
        const isRunning = execSync(
          `docker ps -q --filter "name=${container}"`,
          { encoding: 'utf8' }
        ).trim();

        if (!isRunning) {
          console.log(chalk.gray(`  ○ ${name} (not running)`));
          skipped++;
          continue;
        }

        // Get main process PID for SIGUSR1 signal
        // SIGUSR1 is commonly used to trigger log rotation
        const pid = execSync(
          `docker inspect --format='{{.State.Pid}}' "${container}" 2>/dev/null`,
          { encoding: 'utf8' }
        ).trim();

        if (!pid || pid === '0') {
          console.log(chalk.yellow(`  ⚠️  ${name} (cannot get PID)`));
          skipped++;
          continue;
        }

        // Try to send SIGUSR1 to trigger rotation
        // Note: This requires the container process to handle SIGUSR1 for log rotation
        try {
          execSync(`docker kill --signal SIGUSR1 "${container}" 2>/dev/null || true`, {
            encoding: 'utf8',
          });

          // Also try to use docker's built-in log rotation via copy/truncate
          const logPath = execSync(
            `docker inspect --format='{{.LogPath}}' "${container}" 2>/dev/null`,
            { encoding: 'utf8' }
          ).trim();

          if (logPath && (await fs.pathExists(logPath))) {
            // Get current log size before rotation
            const stats = await fs.stat(logPath);
            const sizeBefore = stats.size;

            if (sizeBefore > 0) {
              // Rotate by copying current log to .1 and truncating
              const rotatedPath = `${logPath}.1`;
              await fs.copy(logPath, rotatedPath, { overwrite: true });
              await fs.writeFile(logPath, '');

              const sizeHuman = formatBytes(sizeBefore);
              console.log(chalk.green(`  ✅ ${name} (${sizeHuman} rotated)`));
              rotated++;
            } else {
              console.log(chalk.gray(`  ○ ${name} (log empty)`));
              skipped++;
            }
          } else {
            console.log(chalk.yellow(`  ⚠️  ${name} (no log file)`));
            skipped++;
          }
        } catch (signalErr) {
          // Signal might not be supported, try manual rotation
          console.log(chalk.yellow(`  ⚠️  ${name} (signal not supported, trying manual)`));
          skipped++;
        }
      } catch (err) {
        console.log(chalk.red(`  ❌ ${name}: ${err.message}`));
        failed++;
      }
    }

    console.log('');
    console.log(chalk.green(`✅ Rotated: ${rotated}`));
    if (skipped > 0) {
      console.log(chalk.gray(`○ Skipped: ${skipped}`));
    }
    if (failed > 0) {
      console.log(chalk.red(`❌ Failed: ${failed}`));
    }
    console.log('');

    if (failed > 0) {
      process.exit(1);
    }
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

// Query logs via Loki (Log Aggregation)
logs
  .command('query')
  .description('Query aggregated logs from Loki (requires monitoring stack)')
  .argument('[query]', 'LogQL query or service name')
  .option('-s, --service <name>', 'Filter by service name')
  .option('--since <duration>', 'Time range (e.g., 5m, 1h, 24h, 7d)', '1h')
  .option('-l, --limit <n>', 'Maximum results', '100')
  .option('-f, --follow', 'Follow logs in real-time (tail mode)')
  .option('--errors', 'Show only error logs')
  .option('--labels', 'List available Loki labels')
  .action(async (queryArg, options) => {
    const infraDir = await findInfraDir();

    if (!infraDir) {
      console.error(chalk.red('❌ Infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA or run from the infrastructure directory'));
      process.exit(1);
    }

    const scriptPath = path.join(infraDir, 'scripts', 'logs-query.sh');

    if (!await fs.pathExists(scriptPath)) {
      console.error(chalk.red('❌ Loki query script not found'));
      console.log(chalk.gray(`   Expected at: ${scriptPath}`));
      process.exit(1);
    }

    // Validate duration
    try {
      validateDuration(options.since);
    } catch (err) {
      console.error(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }

    // Build command arguments
    const args = [scriptPath];

    if (options.labels) {
      args.push('labels');
    } else if (options.follow) {
      args.push('tail');
      if (options.service) {
        args.push('--service', options.service);
      }
    } else if (options.errors) {
      args.push('errors');
      if (options.service) {
        args.push('--service', options.service);
      }
    } else if (queryArg) {
      // Check if query looks like LogQL (contains { or =)
      if (queryArg.includes('{') || queryArg.includes('=')) {
        args.push('search', queryArg);
      } else {
        // Treat as service name
        args.push('service', queryArg);
      }
    } else if (options.service) {
      args.push('service', options.service);
    } else {
      // Default: show all recent logs
      args.push('tail');
    }

    // Add common options
    args.push('--since', options.since);
    args.push('--limit', options.limit);

    // Execute the query
    const command = options.follow ? 'tail' : (options.errors ? 'errors' : 'query');
    console.log(chalk.blue(`📜 Loki Log ${options.follow ? 'Tail' : 'Query'}`));
    console.log(chalk.gray(`   Since: ${options.since} | Limit: ${options.limit}`));
    if (options.service) {
      console.log(chalk.gray(`   Service: ${options.service}`));
    }
    console.log('');

    const proc = spawn('bash', args, {
      stdio: 'inherit',
      cwd: infraDir,
    });

    proc.on('error', (err) => {
      console.error(chalk.red(`❌ Error running query: ${err.message}`));
      process.exit(1);
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // Loki might not be running
        if (code === 1) {
          console.log('');
          console.log(chalk.yellow('💡 Is the monitoring stack running?'));
          console.log(chalk.gray('   Start it with: make monitor'));
        }
      }
      process.exit(code);
    });
  });

// Stream logs via Core API (SSE)
logs
  .command('stream')
  .description('Stream logs in real-time via Core API (uses Server-Sent Events)')
  .option('-s, --service <name>', 'Filter by service (core, backend, gateway, etc.)')
  .option('-l, --level <level>', 'Minimum log level (DEBUG, INFO, WARNING, ERROR)', 'INFO')
  .option('--search <pattern>', 'Search pattern to filter messages')
  .option('--since <duration>', 'Historical logs to include first (e.g., 1m, 5m, 1h)', '5m')
  .option('--no-follow', 'Exit after sending historical logs (do not stream)')
  .option('--json', 'Output raw JSON instead of formatted logs')
  .action(async (options) => {
    const axios = require('axios');
    const { findInfraDir } = require('./services');

    // Validate level
    const validLevels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];
    if (!validLevels.includes(options.level.toUpperCase())) {
      console.error(chalk.red(`❌ Invalid log level: ${options.level}`));
      console.log(chalk.gray(`   Valid levels: ${validLevels.join(', ')}`));
      process.exit(1);
    }

    // Find Core API URL
    const infraDir = await findInfraDir();
    const coreUrl = process.env.CORE_URL || 'http://localhost:8000';

    console.log(chalk.blue('🐾 MasterClaw Log Stream'));
    console.log(chalk.gray('═══════════════════════'));
    console.log(`   API: ${coreUrl}/v1/logs/stream`);
    if (options.service) console.log(`   Service: ${options.service}`);
    console.log(`   Level: ${options.level}`);
    if (options.search) console.log(`   Search: ${options.search}`);
    console.log(`   Follow: ${options.follow ? 'yes' : 'no'}`);
    console.log('');

    try {
      // Use axios for SSE streaming
      const response = await axios({
        method: 'POST',
        url: `${coreUrl}/v1/logs/stream`,
        data: {
          service: options.service,
          level: options.level.toUpperCase(),
          search: options.search,
          since: options.since,
          follow: options.follow
        },
        responseType: 'stream',
        headers: {
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json'
        },
        timeout: options.follow ? 0 : 30000 // No timeout for streaming
      });

      const stream = response.data;

      stream.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(line.substring(6));

            if (options.json) {
              console.log(JSON.stringify(data));
            } else {
              // Format the log entry
              const timestamp = new Date(data.timestamp).toLocaleTimeString();
              const service = data.service?.padEnd(8) || 'unknown ';
              const level = data.level?.padEnd(8) || 'INFO    ';
              const message = data.message || '';

              // Color by level
              let levelColor = chalk.gray;
              if (data.level === 'ERROR' || data.level === 'CRITICAL') {
                levelColor = chalk.red;
              } else if (data.level === 'WARNING') {
                levelColor = chalk.yellow;
              } else if (data.level === 'INFO') {
                levelColor = chalk.cyan;
              }

              console.log(`${chalk.gray(timestamp)} ${chalk.blue(service)} ${levelColor(level)} ${message}`);

              // Show correlation ID if present
              if (data.correlation_id && !options.json) {
                console.log(chalk.gray(`                    [correlation: ${data.correlation_id}]`));
              }
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      });

      stream.on('error', (err) => {
        console.error(chalk.red(`\n❌ Stream error: ${err.message}`));
        process.exit(1);
      });

      stream.on('end', () => {
        if (!options.follow) {
          console.log(chalk.gray('\n[End of historical logs]'));
        }
        process.exit(0);
      });

      // Handle Ctrl+C gracefully
      process.on('SIGINT', () => {
        console.log(chalk.gray('\n\n[Stream interrupted]'));
        stream.destroy();
        process.exit(0);
      });

    } catch (err) {
      if (err.code === 'ECONNREFUSED') {
        console.error(chalk.red('❌ Cannot connect to MasterClaw Core API'));
        console.log(chalk.gray(`   Tried: ${coreUrl}`));
        console.log(chalk.gray('   Is the core service running?'));
      } else if (err.response?.status === 404) {
        console.error(chalk.red('❌ Log streaming endpoint not found'));
        console.log(chalk.gray('   The Core API may need to be updated.'));
      } else {
        console.error(chalk.red(`❌ Error: ${err.message}`));
      }
      process.exit(1);
    }
  });

module.exports = logs;
module.exports.SERVICES = SERVICES;
module.exports.VALID_SERVICES = VALID_SERVICES;
module.exports.VALID_DURATION = VALID_DURATION;
module.exports.MAX_EXPORT_LINES = MAX_EXPORT_LINES;
module.exports.DANGEROUS_CHARS = DANGEROUS_CHARS;
module.exports.VALID_FILENAME = VALID_FILENAME;
module.exports.validateServiceName = validateServiceName;
module.exports.validateDuration = validateDuration;
module.exports.validateExportOptions = validateExportOptions;
module.exports.validateSearchQuery = validateSearchQuery;
module.exports.validateFilename = validateFilename;
module.exports.formatServiceName = formatServiceName;
module.exports.parseSinceOption = parseSinceOption;
module.exports.DockerSecurityError = DockerSecurityError;
