// update.js - Update management commands for mc CLI
// Handles Docker image updates, CLI self-updates, and version checks
// Security-hardened version with input validation, rate limiting, and audit logging

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const { logAudit } = require('./audit');
const rateLimiter = require('./rate-limiter');
const {
  containsPathTraversal,
  sanitizeForLog,
  isSafeString
} = require('./security');

const update = new Command('update');

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum path length for infrastructure directory */
const MAX_PATH_LENGTH = 4096;

/** Valid image name pattern (alphanumeric, hyphens, underscores, dots, slashes, colons) */
const VALID_IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.\-\/:@]*$/;

/** Maximum image name length */
const MAX_IMAGE_NAME_LENGTH = 256;

/** Allowed characters in version strings */
const VALID_VERSION_PATTERN = /^[0-9a-zA-Z._\-+]+$/;

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Validates infrastructure directory path for security
 * @param {string} dirPath - Path to validate
 * @returns {boolean} - True if valid
 * @throws {Error} - If path contains traversal or is invalid
 */
function validateInfraDirPath(dirPath) {
  if (typeof dirPath !== 'string') {
    throw new Error('Infrastructure directory path must be a string');
  }

  if (dirPath.length === 0) {
    throw new Error('Infrastructure directory path cannot be empty');
  }

  if (dirPath.length > MAX_PATH_LENGTH) {
    throw new Error(`Infrastructure directory path too long (max ${MAX_PATH_LENGTH} characters)`);
  }

  // Check for path traversal attempts
  if (containsPathTraversal(dirPath)) {
    throw new Error('Infrastructure directory path contains invalid characters');
  }

  // Check for null bytes
  if (dirPath.includes('\0')) {
    throw new Error('Infrastructure directory path contains null bytes');
  }

  return true;
}

/**
 * Validates Docker image name for security
 * @param {string} imageName - Image name to validate
 * @returns {boolean} - True if valid
 * @throws {Error} - If image name is invalid
 */
function validateImageName(imageName) {
  if (typeof imageName !== 'string') {
    throw new Error('Image name must be a string');
  }

  if (imageName.length === 0) {
    throw new Error('Image name cannot be empty');
  }

  if (imageName.length > MAX_IMAGE_NAME_LENGTH) {
    throw new Error(`Image name too long (max ${MAX_IMAGE_NAME_LENGTH} characters)`);
  }

  // Check for shell injection characters
  if (!VALID_IMAGE_NAME.test(imageName)) {
    throw new Error('Image name contains invalid characters');
  }

  return true;
}

/**
 * Validates version string for security
 * @param {string} version - Version string to validate
 * @returns {boolean} - True if valid
 */
function validateVersionString(version) {
  if (typeof version !== 'string') {
    return false;
  }

  if (version.length === 0 || version.length > 50) {
    return false;
  }

  // Allow 'unknown' and 'latest' as special cases
  if (version === 'unknown' || version === 'latest') {
    return true;
  }

  // Clean 'v' prefix
  const cleanVersion = version.replace(/^v/, '');

  return VALID_VERSION_PATTERN.test(cleanVersion);
}

// =============================================================================
// Infrastructure Directory Resolution
// =============================================================================

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
    if (!dir) continue;

    try {
      // Validate path before using it
      validateInfraDirPath(dir);

      if (await fs.pathExists(path.join(dir, 'docker-compose.yml'))) {
        return dir;
      }
    } catch (err) {
      // Log security violations but continue to next candidate
      if (process.env.MC_VERBOSE) {
        console.warn(chalk.yellow(`Warning: Invalid infrastructure path: ${sanitizeForLog(err.message)}`));
      }
    }
  }

  return null;
}

// =============================================================================
// Docker Operations
// =============================================================================

// Check if Docker is available
async function isDockerAvailable() {
  try {
    execSync('docker info', {
      stdio: 'ignore',
      timeout: 10000, // 10 second timeout
    });
    return true;
  } catch {
    return false;
  }
}

// Get Docker image versions with security validation
async function getImageVersions() {
  try {
    const output = execSync(
      'docker ps --format "{{.Image}}" --filter "name=mc-"',
      {
        encoding: 'utf8',
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024, // 1MB max buffer
      }
    );

    const images = output.trim().split('\n').filter(Boolean);
    const versions = {};

    for (const image of images) {
      try {
        // Validate image name before using in command
        validateImageName(image);

        // Use safer command construction with proper escaping
        const inspect = execSync(
          'docker',
          [
            'inspect',
            '--format={{.Config.Image}}|{{.Id}}|{{.Created}}',
            image
          ],
          {
            encoding: 'utf8',
            timeout: 10000,
          }
        );
        const [img, id, created] = inspect.trim().split('|');
        versions[img] = { id: id.slice(0, 12), created };
      } catch {
        // Sanitize image name for logging
        versions[sanitizeForLog(image).substring(0, 100)] = {
          id: 'unknown',
          created: 'unknown'
        };
      }
    }

    return versions;
  } catch {
    return {};
  }
}

// =============================================================================
// Version Operations with Retry Logic
// =============================================================================

/**
 * Sleeps for the specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Gets latest CLI version from npm/registry with retry logic
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<string|null>} - Latest version or null
 */
async function getLatestCliVersion(maxRetries = 2) {
  const axiosConfig = {
    timeout: 10000, // 10 second timeout
    headers: {
      'User-Agent': 'MasterClaw-CLI/0.20.0',
    },
  };

  // Try npm registry with retries
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get(
        'https://registry.npmjs.org/masterclaw-tools/latest',
        axiosConfig
      );

      const version = response.data.version;

      // Validate version string before returning
      if (!validateVersionString(version)) {
        console.warn(chalk.yellow(`Warning: Invalid version received from registry: ${sanitizeForLog(version)}`));
        return null;
      }

      return version;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff
        await sleep(delay);
      }
    }
  }

  // Fallback: try GitHub releases with retries
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios.get(
        'https://api.github.com/repos/TheMasterClaw/masterclaw-tools/releases/latest',
        {
          ...axiosConfig,
          timeout: 15000, // 15 second timeout for GitHub
        }
      );

      const tagName = response.data.tag_name;

      if (!isSafeString(tagName, { maxLength: 100 })) {
        console.warn(chalk.yellow('Warning: Invalid tag name received from GitHub'));
        return null;
      }

      const version = tagName.replace(/^v/, '');

      if (!validateVersionString(version)) {
        console.warn(chalk.yellow(`Warning: Invalid version parsed from GitHub tag: ${sanitizeForLog(version)}`));
        return null;
      }

      return version;
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
        await sleep(delay);
      }
    }
  }

  return null;
}

// Get current CLI version
function getCliVersion() {
  try {
    const packageJson = require('../package.json');
    const version = packageJson.version;

    if (!validateVersionString(version)) {
      return 'unknown';
    }

    return version;
  } catch {
    return 'unknown';
  }
}

// =============================================================================
// Audit Logging
// =============================================================================

/**
 * Logs update-related events to the audit log
 * @param {string} event - Event type
 * @param {Object} details - Event details
 */
async function logUpdateEvent(event, details = {}) {
  try {
    await logAudit(`UPDATE_${event}`, {
      ...details,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Audit logging failures shouldn't break the update process
    if (process.env.MC_VERBOSE) {
      console.warn(chalk.yellow(`[Warn] Failed to write audit log: ${err.message}`));
    }
  }
}

// =============================================================================
// Commands
// =============================================================================

// Main update command
update
  .description('Update MasterClaw services and CLI')
  .option('-c, --check', 'Check for available updates without applying')
  .option('-d, --dry-run', 'Show what would be updated without making changes')
  .option('-s, --services', 'Update Docker services only (skip CLI)')
  .option('-f, --force', 'Force update even if no changes detected')
  .option('--cli-only', 'Update CLI only (skip Docker services)')
  .action(async (options) => {
    const ora = require('ora');
    const isCheckMode = options.check;
    const isDryRun = options.dryRun;

    // Rate limiting for update command
    try {
      await rateLimiter.enforceRateLimit('update', {
        command: 'update',
        dryRun: isDryRun,
        checkMode: isCheckMode,
      });
    } catch (err) {
      console.log(chalk.yellow('⚠️  Update rate limit exceeded. Please wait before checking for updates again.'));
      process.exit(6); // Security violation exit code
    }

    console.log(chalk.blue('🐾 MasterClaw Update'));
    console.log('====================\n');

    if (isCheckMode) {
      console.log(chalk.cyan('📋 Checking for available updates...\n'));
    } else if (isDryRun) {
      console.log(chalk.cyan('📋 Dry run mode - showing what would be updated:\n'));
    }

    // Log update attempt
    await logUpdateEvent('STARTED', {
      dryRun: isDryRun,
      checkMode: isCheckMode,
      cliOnly: options.cliOnly,
      force: options.force,
    });

    // CLI Version Check
    const cliSpinner = ora('Checking CLI version...').start();
    const currentVersion = getCliVersion();
    const latestVersion = await getLatestCliVersion();
    cliSpinner.stop();

    console.log(chalk.cyan('CLI:'));
    console.log(`  Current:  ${currentVersion}`);

    if (latestVersion) {
      console.log(`  Latest:   ${latestVersion}`);
      const needsCliUpdate = options.force || latestVersion !== currentVersion;

      if (needsCliUpdate && latestVersion !== currentVersion) {
        console.log(`  Status:   ${chalk.yellow('⚠️  Update available')}`);
      } else {
        console.log(`  Status:   ${chalk.green('✅ Up to date')}`);
      }
    } else {
      console.log(`  Status:   ${chalk.gray('⚠️  Could not check for updates')}`);
    }
    console.log();

    // Skip service checks if CLI-only
    if (options.cliOnly) {
      if (!isCheckMode && !isDryRun && latestVersion && latestVersion !== currentVersion) {
        console.log(chalk.cyan('Updating CLI...'));
        console.log(chalk.gray('  Run: npm install -g masterclaw-tools'));
      }

      await logUpdateEvent('COMPLETED', {
        result: 'cli-only',
        currentVersion,
        latestVersion,
      });

      return;
    }

    // Docker Services Check
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.log(chalk.yellow('⚠️  Docker is not available - skipping service checks'));
      await logUpdateEvent('COMPLETED', {
        result: 'docker-unavailable',
      });
      return;
    }

    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.yellow('⚠️  Infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA or run from infrastructure directory'));
      await logUpdateEvent('FAILED', {
        reason: 'infra-dir-not-found',
      });
      return;
    }

    // Log infrastructure directory (sanitized)
    await logUpdateEvent('INFRA_DIR_FOUND', {
      infraDir: infraDir.replace(/\\/g, '/'),
    });

    const serviceSpinner = ora('Checking service images...').start();
    let imageVersions;
    try {
      imageVersions = await getImageVersions();
      serviceSpinner.stop();
    } catch (err) {
      serviceSpinner.fail('Failed to check service images');
      await logUpdateEvent('FAILED', {
        reason: 'image-check-failed',
        error: sanitizeForLog(err.message),
      });
      return;
    }

    console.log(chalk.cyan('Docker Services:'));

    if (Object.keys(imageVersions).length === 0) {
      console.log(`  ${chalk.gray('ℹ️  No MasterClaw services running')}`);
    } else {
      for (const [image, info] of Object.entries(imageVersions)) {
        const shortImage = image.split('/').pop() || image;
        console.log(`  ${chalk.gray('•')} ${shortImage} ${chalk.gray(`(${info.id})`)}`);
      }
    }
    console.log();

    // Check mode - exit after showing status
    if (isCheckMode) {
      console.log(chalk.gray('Use without --check to apply updates'));
      await logUpdateEvent('COMPLETED', {
        result: 'check-mode',
      });
      return;
    }

    // Dry run mode - exit after showing what would happen
    if (isDryRun) {
      console.log(chalk.cyan('Would execute:'));
      console.log(`  cd ${infraDir}`);
      console.log('  docker-compose pull');
      console.log('  docker-compose up -d');

      if (latestVersion && latestVersion !== currentVersion) {
        console.log('  npm install -g masterclaw-tools');
      }

      await logUpdateEvent('COMPLETED', {
        result: 'dry-run',
      });
      return;
    }

    // Apply updates
    if (options.services || !options.cliOnly) {
      console.log(chalk.blue('📥 Updating Docker images...\n'));

      await logUpdateEvent('DOCKER_PULL_STARTED', {
        images: Object.keys(imageVersions),
      });

      const pullSpinner = ora('Pulling latest images...').start();

      try {
        await new Promise((resolve, reject) => {
          const pull = spawn('docker-compose', ['pull'], {
            cwd: infraDir,
            stdio: 'pipe',
            timeout: 300000, // 5 minute timeout
          });

          let output = '';
          let errorOutput = '';
          pull.stdout.on('data', (data) => { output += data.toString(); });
          pull.stderr.on('data', (data) => { errorOutput += data.toString(); });

          pull.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Pull failed with code ${code}: ${errorOutput.substring(0, 200)}`));
            }
          });

          pull.on('error', (err) => {
            reject(new Error(`Pull process error: ${err.message}`));
          });
        });

        pullSpinner.succeed('Images pulled successfully');
        await logUpdateEvent('DOCKER_PULL_COMPLETED');
      } catch (err) {
        pullSpinner.fail(`Failed to pull images: ${sanitizeForLog(err.message)}`);
        await logUpdateEvent('DOCKER_PULL_FAILED', {
          error: sanitizeForLog(err.message),
        });
        process.exit(1);
      }

      // Restart services with new images
      const upSpinner = ora('Restarting services...').start();

      await logUpdateEvent('DOCKER_RESTART_STARTED');

      try {
        await new Promise((resolve, reject) => {
          const up = spawn('docker-compose', ['up', '-d', '--remove-orphans'], {
            cwd: infraDir,
            stdio: 'pipe',
            timeout: 300000, // 5 minute timeout
          });

          up.on('close', (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Restart failed with code ${code}`));
            }
          });

          up.on('error', (err) => {
            reject(new Error(`Restart process error: ${err.message}`));
          });
        });

        upSpinner.succeed('Services restarted successfully');
        await logUpdateEvent('DOCKER_RESTART_COMPLETED');
      } catch (err) {
        upSpinner.fail(`Failed to restart services: ${sanitizeForLog(err.message)}`);
        await logUpdateEvent('DOCKER_RESTART_FAILED', {
          error: sanitizeForLog(err.message),
        });
        process.exit(1);
      }
    }

    console.log();
    console.log(chalk.green('✅ Update complete!'));

    await logUpdateEvent('COMPLETED', {
      result: 'success',
      currentVersion,
      latestVersion,
      imagesUpdated: Object.keys(imageVersions).length,
    });

    if (latestVersion && latestVersion !== currentVersion) {
      console.log();
      console.log(chalk.yellow('⚠️  CLI update available:'));
      console.log(chalk.gray('   Run: npm install -g masterclaw-tools'));
    }

    console.log();
    console.log(chalk.gray('Run "mc status" to verify services are healthy'));
  });

// Version subcommand
update
  .command('version')
  .description('Show current versions of all components')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    // Rate limiting for version command
    try {
      await rateLimiter.enforceRateLimit('update-version', { command: 'update version' });
    } catch (err) {
      console.log(chalk.yellow('⚠️  Rate limit exceeded. Please wait before checking version again.'));
      process.exit(6);
    }

    const cliVersion = getCliVersion();
    const infraDir = await findInfraDir();

    await logUpdateEvent('VERSION_CHECK', {
      cliVersion,
      hasInfraDir: !!infraDir,
    });

    const versions = {
      cli: cliVersion,
      timestamp: new Date().toISOString(),
    };

    if (infraDir) {
      try {
        const composeContent = await fs.readFile(
          path.join(infraDir, 'docker-compose.yml'),
          'utf8'
        );

        // Extract image versions from compose file
        const imageMatches = composeContent.match(/image:\s*(.+)/g) || [];
        versions.services = imageMatches.map(m => {
          const image = m.replace('image:', '').trim();
          return {
            image,
            tag: image.split(':').pop() || 'latest',
          };
        });
      } catch {
        versions.services = [];
      }
    }

    if (options.json) {
      console.log(JSON.stringify(versions, null, 2));
      return;
    }

    console.log(chalk.blue('🐾 MasterClaw Versions'));
    console.log('=====================\n');

    console.log(chalk.cyan('CLI:'));
    console.log(`  Version: ${cliVersion}`);
    console.log();

    if (versions.services && versions.services.length > 0) {
      console.log(chalk.cyan('Configured Services:'));
      for (const svc of versions.services) {
        const name = svc.image.split('/').pop() || svc.image;
        console.log(`  ${name.padEnd(30)} ${chalk.gray(svc.tag)}`);
      }
    }

    console.log();
    console.log(chalk.gray(`Checked at: ${versions.timestamp}`));
  });

// Export functions for testing
module.exports = update;
module.exports.findInfraDir = findInfraDir;
module.exports.isDockerAvailable = isDockerAvailable;
module.exports.getCliVersion = getCliVersion;
module.exports.getLatestCliVersion = getLatestCliVersion;
module.exports.getImageVersions = getImageVersions;
module.exports.validateInfraDirPath = validateInfraDirPath;
module.exports.validateImageName = validateImageName;
module.exports.validateVersionString = validateVersionString;
module.exports.logUpdateEvent = logUpdateEvent;
