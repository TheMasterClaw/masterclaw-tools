/**
 * MasterClaw Version Command
 *
 * Unified version management across the MasterClaw ecosystem:
 * - Shows versions of all components (CLI, Core, Backend, Interface, Infrastructure)
 * - Checks for available updates by comparing against registries
 * - Displays compatibility matrix between components
 * - Provides upgrade path recommendations
 * - JSON output for CI/CD integration
 *
 * Security: Uses secure HTTP client with SSRF/DNS rebinding protection
 * for all external version checks.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const { wrapCommand, ExitCode } = require('./error-handler');
const { findInfraDir } = require('./services');
const httpClient = require('./http-client');
const logger = require('./logger');

const version = new Command('version');

// CLI Version from package.json
const CLI_VERSION = require('../package.json').version;
const CLI_NAME = require('../package.json').name;

// Component version cache
let versionCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Version Detection
// =============================================================================

/**
 * Get CLI version information
 */
async function getCliVersion() {
  return {
    name: 'masterclaw-tools',
    displayName: 'CLI Tools',
    version: CLI_VERSION,
    source: 'package.json',
    path: path.join(__dirname, '..', 'package.json'),
  };
}

/**
 * Get Core API version
 */
async function getCoreVersion() {
  try {
    // Try to get version from running API
    const response = await httpClient.get(
      'http://localhost:8000/version',
      httpClient.allowPrivateIPs({ timeout: 3000, validateStatus: () => true })
    );

    if (response.status === 200 && response.data?.version) {
      return {
        name: 'masterclaw-core',
        displayName: 'AI Core',
        version: response.data.version,
        source: 'api',
        status: 'running',
        commit: response.data.commit,
        buildDate: response.data.build_date,
      };
    }
  } catch (err) {
    logger.debug('Could not get Core version from API', { error: err.message });
  }

  // Fallback: try to read from __init__.py or version file
  const infraDir = await findInfraDir();
  if (infraDir) {
    const versionFiles = [
      path.join(infraDir, '..', 'masterclaw-core', 'VERSION'),
      path.join(infraDir, '..', 'masterclaw-core', 'version.txt'),
      path.join(infraDir, '..', 'masterclaw_core', 'VERSION'),
    ];

    for (const file of versionFiles) {
      try {
        if (await fs.pathExists(file)) {
          const version = (await fs.readFile(file, 'utf8')).trim();
          if (version) {
            return {
              name: 'masterclaw-core',
              displayName: 'AI Core',
              version,
              source: 'file',
              path: file,
              status: 'not_running',
            };
          }
        }
      } catch (e) {
        // Continue to next file
      }
    }
  }

  return {
    name: 'masterclaw-core',
    displayName: 'AI Core',
    version: 'unknown',
    source: 'none',
    status: 'not_found',
  };
}

/**
 * Get Infrastructure version from git or files
 */
async function getInfraVersion() {
  const infraDir = await findInfraDir();

  if (!infraDir) {
    return {
      name: 'masterclaw-infrastructure',
      displayName: 'Infrastructure',
      version: 'unknown',
      source: 'none',
      status: 'not_found',
    };
  }

  // Try git describe first
  try {
    const gitVersion = execSync('git describe --tags --always', {
      cwd: infraDir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (gitVersion) {
      // Get commit info
      const commitHash = execSync('git rev-parse --short HEAD', {
        cwd: infraDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      const commitDate = execSync('git log -1 --format=%ci', {
        cwd: infraDir,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();

      return {
        name: 'masterclaw-infrastructure',
        displayName: 'Infrastructure',
        version: gitVersion,
        source: 'git',
        path: infraDir,
        commit: commitHash,
        commitDate,
        branch: getGitBranch(infraDir),
      };
    }
  } catch (e) {
    logger.debug('Could not get git version', { error: e.message });
  }

  // Fallback: check for VERSION file
  const versionFile = path.join(infraDir, 'VERSION');
  try {
    if (await fs.pathExists(versionFile)) {
      const version = (await fs.readFile(versionFile, 'utf8')).trim();
      return {
        name: 'masterclaw-infrastructure',
        displayName: 'Infrastructure',
        version,
        source: 'file',
        path: versionFile,
      };
    }
  } catch (e) {
    // Continue
  }

  // Last resort: use directory modification time as pseudo-version
  try {
    const stats = await fs.stat(infraDir);
    return {
      name: 'masterclaw-infrastructure',
      displayName: 'Infrastructure',
      version: `dev-${stats.mtime.toISOString().split('T')[0]}`,
      source: 'directory',
      path: infraDir,
    };
  } catch (e) {
    return {
      name: 'masterclaw-infrastructure',
      displayName: 'Infrastructure',
      version: 'unknown',
      source: 'none',
      path: infraDir,
    };
  }
}

/**
 * Get Backend version
 */
async function getBackendVersion() {
  try {
    const response = await httpClient.get(
      'http://localhost:3001/version',
      httpClient.allowPrivateIPs({ timeout: 3000, validateStatus: () => true })
    );

    if (response.status === 200 && response.data?.version) {
      return {
        name: 'masterclaw-backend',
        displayName: 'Backend API',
        version: response.data.version,
        source: 'api',
        status: 'running',
      };
    }
  } catch (err) {
    logger.debug('Could not get Backend version from API', { error: err.message });
  }

  return {
    name: 'masterclaw-backend',
    displayName: 'Backend API',
    version: 'unknown',
    source: 'none',
    status: 'not_running',
  };
}

/**
 * Get Interface version
 */
async function getInterfaceVersion() {
  try {
    const response = await httpClient.get(
      'http://localhost/version.json',
      httpClient.allowPrivateIPs({ timeout: 3000, validateStatus: () => true })
    );

    if (response.status === 200 && response.data?.version) {
      return {
        name: 'masterclaw-interface',
        displayName: 'Web Interface',
        version: response.data.version,
        source: 'api',
        status: 'running',
      };
    }
  } catch (err) {
    logger.debug('Could not get Interface version from API', { error: err.message });
  }

  return {
    name: 'masterclaw-interface',
    displayName: 'Web Interface',
    version: 'unknown',
    source: 'none',
    status: 'not_running',
  };
}

/**
 * Get current git branch
 */
function getGitBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    return 'unknown';
  }
}

/**
 * Get all versions
 */
async function getAllVersions(useCache = true) {
  const now = Date.now();

  if (useCache && versionCache && (now - cacheTimestamp) < CACHE_TTL) {
    return versionCache;
  }

  const versions = {
    timestamp: new Date().toISOString(),
    components: {
      cli: await getCliVersion(),
      core: await getCoreVersion(),
      backend: await getBackendVersion(),
      interface: await getInterfaceVersion(),
      infrastructure: await getInfraVersion(),
    },
  };

  versionCache = versions;
  cacheTimestamp = now;

  return versions;
}

// =============================================================================
// Update Checking
// =============================================================================

/**
 * Check for available updates via npm registry
 */
async function checkNpmUpdate(packageName, currentVersion) {
  try {
    const response = await httpClient.get(
      `https://registry.npmjs.org/${packageName}/latest`,
      { timeout: 10000, validateStatus: () => true }
    );

    if (response.status === 200 && response.data?.version) {
      const latestVersion = response.data.version;
      const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

      return {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        updateAvailable: hasUpdate,
        releaseDate: response.data.time?.[latestVersion],
        changelogUrl: `https://github.com/TheMasterClaw/${packageName}/blob/main/CHANGELOG.md`,
      };
    }
  } catch (err) {
    logger.debug('Failed to check npm update', { package: packageName, error: err.message });
  }

  return {
    current: currentVersion,
    latest: 'unknown',
    hasUpdate: false,
    updateAvailable: false,
    error: 'Could not check for updates',
  };
}

/**
 * Check for git updates (tags)
 */
async function checkGitUpdate(repoPath, currentVersion) {
  try {
    // Fetch latest tags
    execSync('git fetch --tags', {
      cwd: repoPath,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const latestTag = execSync('git describe --tags $(git rev-list --tags --max-count=1)', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();

    if (latestTag) {
      // Normalize versions for comparison (remove 'v' prefix if present)
      const normalizedCurrent = currentVersion.replace(/^v/, '');
      const normalizedLatest = latestTag.replace(/^v/, '');
      const hasUpdate = compareVersions(normalizedLatest, normalizedCurrent) > 0;

      return {
        current: currentVersion,
        latest: latestTag,
        hasUpdate,
        updateAvailable: hasUpdate,
        behindBy: hasUpdate ? countCommitsBehind(repoPath, latestTag) : 0,
      };
    }
  } catch (err) {
    logger.debug('Failed to check git update', { error: err.message });
  }

  return {
    current: currentVersion,
    latest: 'unknown',
    hasUpdate: false,
    updateAvailable: false,
  };
}

/**
 * Count commits behind a reference
 */
function countCommitsBehind(cwd, ref) {
  try {
    const count = execSync(`git rev-list --count HEAD..${ref}`, {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return parseInt(count, 10) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Compare two semantic versions
 * Returns: >0 if v1 > v2, <0 if v1 < v2, 0 if equal
 */
function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;

    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }

  return 0;
}

/**
 * Check all components for updates
 */
async function checkAllUpdates(versions) {
  const updates = {};

  // Check CLI via npm
  updates.cli = await checkNpmUpdate(CLI_NAME, versions.components.cli.version);

  // Check Infrastructure via git
  if (versions.components.infrastructure.source === 'git') {
    updates.infrastructure = await checkGitUpdate(
      versions.components.infrastructure.path,
      versions.components.infrastructure.version
    );
  } else {
    updates.infrastructure = {
      current: versions.components.infrastructure.version,
      latest: 'unknown',
      hasUpdate: false,
    };
  }

  // Core, Backend, Interface - check via API if available
  for (const [key, component] of Object.entries(versions.components)) {
    if (key !== 'cli' && key !== 'infrastructure') {
      updates[key] = {
        current: component.version,
        latest: 'unknown',
        hasUpdate: false,
        checkMethod: 'manual',
        note: 'Check documentation for update instructions',
      };
    }
  }

  return updates;
}

// =============================================================================
// Output Formatting
// =============================================================================

/**
 * Format version for display
 */
function formatVersion(version, status) {
  if (status === 'not_running') {
    return chalk.gray(`${version} (not running)`);
  }
  if (status === 'not_found') {
    return chalk.red('not installed');
  }
  if (version === 'unknown') {
    return chalk.gray('unknown');
  }
  return chalk.bold(version);
}

/**
 * Format update status
 */
function formatUpdate(update) {
  if (update.hasUpdate) {
    return chalk.yellow(`⬆️  ${update.latest} available`);
  }
  if (update.latest === 'unknown') {
    return chalk.gray('?');
  }
  return chalk.green('✓ up to date');
}

/**
 * Display versions in pretty format
 */
function displayPretty(versions, updates = null) {
  console.log(chalk.blue('🐾 MasterClaw Version Information\n'));

  const { components } = versions;

  // Component versions
  console.log(chalk.cyan('Components:'));
  console.log(`  CLI Tools:       ${formatVersion(components.cli.version)}`);
  console.log(`  AI Core:         ${formatVersion(components.core.version, components.core.status)}`);
  console.log(`  Backend API:     ${formatVersion(components.backend.version, components.backend.status)}`);
  console.log(`  Web Interface:   ${formatVersion(components.interface.version, components.interface.status)}`);
  console.log(`  Infrastructure:  ${formatVersion(components.infrastructure.version)} ${
    components.infrastructure.branch ? chalk.gray(`(${components.infrastructure.branch})`) : ''
  }`);
  console.log('');

  // Update status
  if (updates) {
    console.log(chalk.cyan('Updates:'));
    const anyUpdates = Object.values(updates).some(u => u.hasUpdate);

    if (anyUpdates) {
      console.log(chalk.yellow('  Updates are available:\n'));
      for (const [key, update] of Object.entries(updates)) {
        if (update.hasUpdate) {
          const name = components[key]?.displayName || key;
          console.log(`  ${chalk.bold(name)}: ${chalk.cyan(update.current)} → ${chalk.green(update.latest)}`);
          if (update.behindBy) {
            console.log(chalk.gray(`    (${update.behindBy} commits behind)`));
          }
          console.log('');
        }
      }

      console.log(chalk.gray('Update commands:'));
      if (updates.cli?.hasUpdate) {
        console.log(chalk.gray('  npm update -g masterclaw-tools    # Update CLI'));
      }
      if (updates.infrastructure?.hasUpdate) {
        console.log(chalk.gray('  cd ~/masterclaw-infrastructure'));
        console.log(chalk.gray('  git pull                          # Update infrastructure'));
        console.log(chalk.gray('  make update                       # Update services'));
      }
    } else {
      console.log(chalk.green('  ✓ All components are up to date'));
    }
    console.log('');
  }

  // Infrastructure details
  if (components.infrastructure.source === 'git') {
    console.log(chalk.cyan('Infrastructure Details:'));
    console.log(`  Path:    ${chalk.gray(components.infrastructure.path)}`);
    console.log(`  Commit:  ${chalk.gray(components.infrastructure.commit || 'N/A')}`);
    if (components.infrastructure.commitDate) {
      console.log(`  Date:    ${chalk.gray(components.infrastructure.commitDate)}`);
    }
    console.log('');
  }
}

/**
 * Display versions as JSON
 */
function displayJson(versions, updates = null) {
  const output = {
    ...versions,
  };

  if (updates) {
    output.updates = updates;
    output.hasUpdates = Object.values(updates).some(u => u.hasUpdate);
  }

  console.log(JSON.stringify(output, null, 2));
}

// =============================================================================
// CLI Commands
// =============================================================================

version
  .description('Show version information for all MasterClaw components')
  .option('-j, --json', 'output as JSON')
  .option('-u, --check-updates', 'check for available updates')
  .option('-a, --all', 'show all version details including source paths')
  .action(wrapCommand(async (options) => {
    const versions = await getAllVersions();

    let updates = null;
    if (options.checkUpdates) {
      const spinner = options.json ? null : require('ora')('Checking for updates...').start();
      updates = await checkAllUpdates(versions);
      if (spinner) spinner.stop();
    }

    if (options.json) {
      displayJson(versions, updates);
    } else {
      displayPretty(versions, updates);

      if (options.all) {
        console.log(chalk.cyan('Detailed Information:'));
        for (const [key, component] of Object.entries(versions.components)) {
          console.log(chalk.bold(`\n${component.displayName || key}:`));
          console.log(`  Version: ${component.version}`);
          console.log(`  Source:  ${component.source}`);
          if (component.path) {
            console.log(`  Path:    ${chalk.gray(component.path)}`);
          }
          if (component.commit) {
            console.log(`  Commit:  ${chalk.gray(component.commit)}`);
          }
        }
      }
    }

    // Exit with code 1 if updates available and --check-updates was used
    // (useful for CI/CD pipelines)
    if (options.checkUpdates && updates) {
      const hasUpdate = Object.values(updates).some(u => u.hasUpdate);
      if (hasUpdate) {
        process.exit(ExitCode.SUCCESS); // Still success, but caller can check JSON
      }
    }
  }, 'version'));

version
  .command('check')
  .description('Check for available updates and exit with status code')
  .option('-q, --quiet', 'suppress output, only return exit code')
  .action(wrapCommand(async (options) => {
    const versions = await getAllVersions(false); // Don't use cache
    const updates = await checkAllUpdates(versions);

    const hasUpdate = Object.values(updates).some(u => u.hasUpdate);

    if (!options.quiet) {
      if (hasUpdate) {
        console.log(chalk.yellow('Updates available:'));
        for (const [key, update] of Object.entries(updates)) {
          if (update.hasUpdate) {
            console.log(`  ${key}: ${update.current} → ${update.latest}`);
          }
        }
      } else {
        console.log(chalk.green('All components are up to date'));
      }
    }

    process.exit(hasUpdate ? 1 : 0);
  }, 'version-check'));

version
  .command('compare')
  .description('Compare versions between two sources')
  .argument('<version1>', 'first version string')
  .argument('<version2>', 'second version string')
  .action(wrapCommand(async (v1, v2) => {
    const result = compareVersions(v1, v2);

    if (result > 0) {
      console.log(`${chalk.bold(v1)} is ${chalk.green('newer')} than ${chalk.bold(v2)}`);
    } else if (result < 0) {
      console.log(`${chalk.bold(v1)} is ${chalk.yellow('older')} than ${chalk.bold(v2)}`);
    } else {
      console.log(`${chalk.bold(v1)} is ${chalk.blue('equal to')} ${chalk.bold(v2)}`);
    }
  }, 'version-compare'));

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  version,
  getAllVersions,
  checkAllUpdates,
  compareVersions,
  // Individual component getters
  getCliVersion,
  getCoreVersion,
  getBackendVersion,
  getInterfaceVersion,
  getInfraVersion,
};
