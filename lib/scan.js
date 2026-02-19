/**
 * scan.js - Container Image Security Scanner for MasterClaw CLI
 *
 * Provides local vulnerability scanning for MasterClaw Docker images
 * using Trivy (if available) or fallback to Docker Scout.
 *
 * Features:
 * - Automatic vulnerability scanning of MasterClaw images
 * - Severity-based filtering (CRITICAL, HIGH, MEDIUM, LOW)
 * - Support for both human-readable and JSON output
 * - Integration with CI/CD pipelines
 * - Configurable exit codes based on severity thresholds
 * - Automatic Trivy installation check with helpful guidance
 *
 * @module scan
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs-extra');
const { findInfraDir } = require('./services');
const { logAudit } = require('./audit');
const { wrapCommand } = require('./error-handler');

// =============================================================================
// Configuration
// =============================================================================

/** MasterClaw service images to scan by default */
const DEFAULT_SERVICES = [
  'mc-core',
  'mc-backend',
  'mc-gateway',
  'mc-interface',
  'mc-chroma',
  'mc-redis',
  'mc-traefik',
];

/** Severity levels in order of priority */
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];

/** Default severity threshold (report vulnerabilities at this level and above) */
const DEFAULT_SEVERITY_THRESHOLD = 'HIGH';

/** Default timeout for scan operations (10 minutes) */
const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

/** Trivy minimum version required */
const TRIVY_MIN_VERSION = '0.48.0';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Parse and normalize severity string
 * @param {string} severity - Raw severity string
 * @returns {string|null} - Normalized severity or null if invalid
 */
function parseSeverity(severity) {
  if (!severity || typeof severity !== 'string') {
    return null;
  }
  const normalized = severity.toUpperCase();
  if (SEVERITY_LEVELS.includes(normalized)) {
    return normalized;
  }
  return null;
}

/**
 * Format vulnerability count with comma separators
 * @param {number} count - Number of vulnerabilities
 * @returns {string} - Formatted count
 */
function formatVulnerabilityCount(count) {
  if (!count || typeof count !== 'number') {
    return '0';
  }
  return count.toLocaleString();
}

/**
 * Check if a severity meets the threshold
 * @param {string} severity - Vulnerability severity
 * @param {string} threshold - Minimum severity threshold
 * @returns {boolean} - True if severity meets threshold
 */
function meetsSeverityThreshold(severity, threshold) {
  const sevIndex = SEVERITY_LEVELS.indexOf(parseSeverity(severity));
  const threshIndex = SEVERITY_LEVELS.indexOf(parseSeverity(threshold));
  if (sevIndex === -1 || threshIndex === -1) {
    return false;
  }
  return sevIndex <= threshIndex;
}

/**
 * Generate scan summary from results
 * @param {Array} results - Scan results for each service
 * @returns {Object} - Summary statistics
 */
function generateScanSummary(results) {
  if (!Array.isArray(results)) {
    return {
      totalServices: 0,
      vulnerableServices: 0,
      errors: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      passed: true,
    };
  }

  const summary = {
    totalServices: results.length,
    vulnerableServices: 0,
    errors: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    passed: true,
  };

  for (const result of results) {
    if (result.error) {
      summary.errors++;
      summary.passed = false;
      continue;
    }

    if (result.vulnerabilities && result.vulnerabilities.length > 0) {
      summary.vulnerableServices++;
      for (const vuln of result.vulnerabilities) {
        const severity = parseSeverity(vuln.severity) || 'UNKNOWN';
        summary[severity.toLowerCase()]++;
        if (['CRITICAL', 'HIGH'].includes(severity)) {
          summary.passed = false;
        }
      }
    }
  }

  return summary;
}

// =============================================================================
// Scanner Detection
// =============================================================================

/**
 * Checks if a command exists in PATH
 * @param {string} command - Command to check
 * @returns {Promise<boolean>}
 */
async function commandExists(command) {
  return new Promise((resolve) => {
    const check = spawn('which', [command], { stdio: 'pipe' });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
}

/**
 * Gets Trivy version
 * @returns {Promise<string|null>}
 */
async function getTrivyVersion() {
  return new Promise((resolve) => {
    const proc = spawn('trivy', ['--version'], { stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.on('close', () => {
      const match = output.match(/Version:\s*(\d+\.\d+\.\d+)/);
      resolve(match ? match[1] : null);
    });
    proc.on('error', () => resolve(null));
  });
}

/**
 * Checks if Trivy is installed and meets minimum version
 * @returns {Promise<{installed: boolean, version: string|null, meetsRequirement: boolean}>}
 */
async function checkTrivyInstallation() {
  const exists = await commandExists('trivy');
  if (!exists) {
    return { installed: false, version: null, meetsRequirement: false };
  }

  const version = await getTrivyVersion();
  if (!version) {
    return { installed: true, version: null, meetsRequirement: false };
  }

  // Simple version comparison (assumes semver format)
  const meetsRequirement = version.localeCompare(TRIVY_MIN_VERSION, undefined, { numeric: true, sensitivity: 'base' }) >= 0;

  return { installed: true, version, meetsRequirement };
}

/**
 * Checks if Docker Scout is available
 * @returns {Promise<boolean>}
 */
async function checkDockerScout() {
  return new Promise((resolve) => {
    const proc = spawn('docker', ['scout', '--help'], { stdio: 'pipe' });
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Detects available scanner (Trivy preferred, fallback to Docker Scout)
 * @returns {Promise<{type: string, installed: boolean, version: string|null}>}
 */
async function detectScanner() {
  const trivy = await checkTrivyInstallation();
  if (trivy.installed && trivy.meetsRequirement) {
    return { type: 'trivy', installed: true, version: trivy.version };
  }

  const dockerScout = await checkDockerScout();
  if (dockerScout) {
    return { type: 'docker-scout', installed: true, version: null };
  }

  if (trivy.installed && !trivy.meetsRequirement) {
    return { type: 'trivy', installed: true, version: trivy.version, needsUpgrade: true };
  }

  return { type: 'none', installed: false, version: null };
}

// =============================================================================
// Image Discovery
// =============================================================================

/**
 * Gets list of local MasterClaw Docker images
 * @returns {Promise<Array<{name: string, tag: string, id: string, created: string, size: string}>>}
 */
async function getLocalImages() {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'images',
      '--format', '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}\t{{.Size}}',
    ], { stdio: 'pipe' });

    let output = '';
    let errorOutput = '';

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { errorOutput += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to list images: ${errorOutput}`));
        return;
      }

      const images = output
        .trim()
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const [repository, tag, id, created, size] = line.split('\t');
          return {
            name: repository,
            tag: tag || 'latest',
            id: id,
            created: created,
            size: size,
            fullName: tag && tag !== 'latest' ? `${repository}:${tag}` : repository,
          };
        })
        .filter(img => {
          // Filter for MasterClaw-related images
          const name = img.name.toLowerCase();
          return DEFAULT_SERVICES.some(service => name.includes(service.replace('mc-', ''))) ||
                 name.includes('masterclaw') ||
                 name.includes('openclaw');
        });

      resolve(images);
    });

    proc.on('error', reject);
  });
}

/**
 * Gets image details for a specific image
 * @param {string} imageName - Image name (with optional tag)
 * @returns {Promise<Object|null>}
 */
async function getImageDetails(imageName) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', [
      'inspect',
      '--format', '{{.Id}}\t{{.RepoTags}}\t{{.Size}}\t{{.Config.Image}}',
      imageName,
    ], { stdio: 'pipe' });

    let output = '';
    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const [id, tags, size, baseImage] = output.trim().split('\t');
      resolve({ id, tags, size, baseImage });
    });
    proc.on('error', () => resolve(null));
  });
}

// =============================================================================
// Scanning Implementation
// =============================================================================

/**
 * Runs Trivy vulnerability scan
 * @param {string} imageName - Image to scan
 * @param {Object} options - Scan options
 * @returns {Promise<Object>}
 */
async function runTrivyScan(imageName, options = {}) {
  const {
    severity = DEFAULT_SEVERITY_THRESHOLD,
    json = false,
    timeout = DEFAULT_SCAN_TIMEOUT_MS,
  } = options;

  const severities = SEVERITY_LEVELS.slice(0, SEVERITY_LEVELS.indexOf(severity) + 1).join(',');

  const args = [
    'image',
    '--severity', severities,
    '--scanners', 'vuln,config,secret',
    '--exit-code', '0', // We'll handle exit codes ourselves
  ];

  if (json) {
    args.push('--format', 'json');
  } else {
    args.push('--format', 'table');
  }

  // Add timeout
  args.push('--timeout', `${Math.floor(timeout / 1000)}s`);

  args.push(imageName);

  return new Promise((resolve, reject) => {
    const proc = spawn('trivy', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Scan timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      // Trivy exits with 0 even when vulnerabilities found (due to --exit-code 0)
      // but may exit with error on scan failure
      if (code !== 0 && code !== null) {
        reject(new Error(`Trivy scan failed (exit ${code}): ${stderr}`));
        return;
      }

      let results;
      if (json) {
        try {
          results = JSON.parse(stdout);
        } catch (err) {
          reject(new Error(`Failed to parse Trivy JSON output: ${err.message}`));
          return;
        }
      } else {
        results = { raw: stdout, stderr: stderr || undefined };
      }

      resolve(results);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Runs Docker Scout scan
 * @param {string} imageName - Image to scan
 * @param {Object} options - Scan options
 * @returns {Promise<Object>}
 */
async function runDockerScoutScan(imageName, options = {}) {
  const {
    severity = DEFAULT_SEVERITY_THRESHOLD,
    json = false,
    timeout = DEFAULT_SCAN_TIMEOUT_MS,
  } = options;

  const args = ['scout', 'cves'];

  if (json) {
    args.push('--format', 'sarif');
  }

  // Docker Scout doesn't have severity filtering in the same way
  // but we can filter results post-scan
  args.push('--only-severity', severity.toLowerCase());
  args.push(imageName);

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Scan timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0) {
        reject(new Error(`Docker Scout scan failed (exit ${code}): ${stderr}`));
        return;
      }

      let results;
      if (json) {
        try {
          results = JSON.parse(stdout);
        } catch (err) {
          results = { raw: stdout, parseError: err.message };
        }
      } else {
        results = { raw: stdout, stderr: stderr || undefined };
      }

      resolve(results);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * Analyzes scan results and produces summary
 * @param {Object} results - Raw scan results
 * @param {string} scanner - Scanner type ('trivy' or 'docker-scout')
 * @returns {Object} - Normalized summary
 */
function analyzeResults(results, scanner) {
  // Handle null/undefined input gracefully
  if (!results) {
    return { critical: 0, high: 0, medium: 0, low: 0, unknown: 0, total: 0, vulnerabilities: [] };
  }

  if (scanner === 'trivy' && results.Results) {
    const summary = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      total: 0,
      vulnerabilities: [],
    };

    for (const result of results.Results) {
      if (result.Vulnerabilities) {
        for (const vuln of result.Vulnerabilities) {
          const severity = (vuln.Severity || 'UNKNOWN').toLowerCase();
          if (summary[severity] !== undefined) {
            summary[severity]++;
          }
          summary.total++;
          summary.vulnerabilities.push({
            id: vuln.VulnerabilityID,
            severity: vuln.Severity,
            package: vuln.PkgName,
            version: vuln.InstalledVersion,
            fixedVersion: vuln.FixedVersion,
            title: vuln.Title,
            description: vuln.Description?.substring(0, 200),
          });
        }
      }
    }

    return summary;
  }

  // Docker Scout results (SARIF format)
  if (scanner === 'docker-scout' && results.runs) {
    const summary = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      total: 0,
      vulnerabilities: [],
    };

    for (const run of results.runs) {
      if (run.results) {
        for (const result of run.results) {
          const level = result.level || 'warning';
          const severityMap = { error: 'high', warning: 'medium', note: 'low' };
          const severity = severityMap[level] || 'unknown';
          summary[severity]++;
          summary.total++;
        }
      }
    }

    return summary;
  }

  // Fallback for raw output
  return { raw: true, total: 0 };
}

// =============================================================================
// Display Functions
// =============================================================================

/**
 * Displays scan results in human-readable format
 * @param {string} imageName - Scanned image
 * @param {Object} summary - Results summary
 * @param {Object} options - Display options
 */
function displayResults(imageName, summary, options = {}) {
  const { showDetails = false, maxResults = 20 } = options;

  console.log(chalk.blue(`\n🔒 Security Scan Results: ${chalk.bold(imageName)}`));
  console.log(chalk.gray('═'.repeat(60)));

  // Summary box
  console.log(chalk.cyan('\n📊 Vulnerability Summary:'));
  console.log(`  ${chalk.bgRed.white(' CRITICAL ')} ${summary.critical || 0}`);
  console.log(`  ${chalk.red(' HIGH       ')} ${summary.high || 0}`);
  console.log(`  ${chalk.yellow(' MEDIUM     ')} ${summary.medium || 0}`);
  console.log(`  ${chalk.blue(' LOW        ')} ${summary.low || 0}`);
  if (summary.unknown > 0) {
    console.log(`  ${chalk.gray(' UNKNOWN    ')} ${summary.unknown || 0}`);
  }
  console.log(chalk.gray('  ─────────────────────────'));
  console.log(`  ${chalk.bold(' TOTAL      ')} ${summary.total || 0}`);

  // Risk assessment
  if (summary.critical > 0) {
    console.log(chalk.red('\n  ⚠️  CRITICAL vulnerabilities detected!'));
    console.log(chalk.red('     Immediate action required.'));
  } else if (summary.high > 0) {
    console.log(chalk.yellow('\n  ⚠️  HIGH severity vulnerabilities found.'));
    console.log(chalk.yellow('     Review and remediate soon.'));
  } else if (summary.total === 0) {
    console.log(chalk.green('\n  ✅ No vulnerabilities found!'));
  } else {
    console.log(chalk.green('\n  ✅ No critical or high severity issues.'));
  }

  // Show vulnerability details
  if (showDetails && summary.vulnerabilities && summary.vulnerabilities.length > 0) {
    console.log(chalk.cyan('\n📋 Vulnerability Details:'));
    console.log(chalk.gray('─'.repeat(60)));

    const displayVulns = summary.vulnerabilities.slice(0, maxResults);

    for (const vuln of displayVulns) {
      const severityColor = {
        'CRITICAL': chalk.bgRed.white,
        'HIGH': chalk.red,
        'MEDIUM': chalk.yellow,
        'LOW': chalk.blue,
        'UNKNOWN': chalk.gray,
      }[vuln.severity] || chalk.white;

      console.log(`\n  ${severityColor(vuln.severity.padEnd(8))} ${chalk.bold(vuln.id)}`);
      console.log(`     Package: ${vuln.package} (${vuln.version})`);
      if (vuln.fixedVersion) {
        console.log(chalk.green(`     Fixed in: ${vuln.fixedVersion}`));
      }
      if (vuln.title) {
        console.log(`     ${vuln.title}`);
      }
    }

    if (summary.vulnerabilities.length > maxResults) {
      console.log(chalk.gray(`\n  ... and ${summary.vulnerabilities.length - maxResults} more vulnerabilities`));
    }
  }

  console.log('');
}

/**
 * Displays installation instructions for Trivy
 */
function displayTrivyInstallInstructions() {
  console.log(chalk.yellow('\n⚠️  Trivy not found'));
  console.log(chalk.cyan('\n📦 Installation Instructions:\n'));

  console.log(chalk.bold('Linux (via apt):'));
  console.log(chalk.gray('  sudo apt-get install -y wget apt-transport-https gnupg lsb-release'));
  console.log(chalk.gray('  wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key | sudo apt-key add -'));
  console.log(chalk.gray('  echo "deb https://aquasecurity.github.io/trivy-repo/deb $(lsb_release -sc) main" | sudo tee -a /etc/apt/sources.list.d/trivy.list'));
  console.log(chalk.gray('  sudo apt-get update && sudo apt-get install -y trivy\n'));

  console.log(chalk.bold('macOS (via Homebrew):'));
  console.log(chalk.gray('  brew install trivy\n'));

  console.log(chalk.bold('Docker (alternative):'));
  console.log(chalk.gray('  docker pull aquasec/trivy:latest\n'));

  console.log(chalk.cyan('For more options, visit: https://aquasecurity.github.io/trivy/latest/getting-started/installation/'));
}

// =============================================================================
// Main Commands
// =============================================================================

/**
 * Scan a single image
 * @param {string} imageName - Image name to scan
 * @param {Object} options - Scan options
 */
async function scanImage(imageName, options = {}) {
  const {
    severity = DEFAULT_SEVERITY_THRESHOLD,
    json = false,
    details = false,
    timeout = DEFAULT_SCAN_TIMEOUT_MS,
    fix = false,
  } = options;

  // Detect scanner
  const scanner = await detectScanner();

  if (!scanner.installed) {
    if (!json) {
      displayTrivyInstallInstructions();
    }
    throw new Error('No vulnerability scanner found. Please install Trivy: https://aquasecurity.github.io/trivy/latest/getting-started/installation/');
  }

  if (scanner.needsUpgrade) {
    console.log(chalk.yellow(`⚠️  Trivy version ${scanner.version} is outdated. Minimum required: ${TRIVY_MIN_VERSION}`));
  }

  // Log scan start
  await logAudit('SECURITY_SCAN_START', {
    image: imageName,
    scanner: scanner.type,
    severity,
  });

  // Run scan
  let results;
  const scanOptions = { severity, json, timeout };

  if (scanner.type === 'trivy') {
    if (!json) {
      console.log(chalk.blue(`🔍 Scanning ${chalk.bold(imageName)} with Trivy...`));
      console.log(chalk.gray('   This may take a few minutes for large images...\n'));
    }
    results = await runTrivyScan(imageName, scanOptions);
  } else {
    if (!json) {
      console.log(chalk.blue(`🔍 Scanning ${chalk.bold(imageName)} with Docker Scout...`));
    }
    results = await runDockerScoutScan(imageName, scanOptions);
  }

  // Analyze results
  const summary = analyzeResults(results, scanner.type);

  // Display results
  if (json) {
    console.log(JSON.stringify({
      image: imageName,
      scanner: scanner.type,
      summary,
      raw: results,
    }, null, 2));
  } else {
    displayResults(imageName, summary, { showDetails: details });
  }

  // Log scan completion
  await logAudit('SECURITY_SCAN_COMPLETE', {
    image: imageName,
    scanner: scanner.type,
    criticalCount: summary.critical,
    highCount: summary.high,
    totalCount: summary.total,
  });

  // Return summary for programmatic use
  return {
    image: imageName,
    scanner: scanner.type,
    summary,
    passed: summary.critical === 0 && summary.high === 0,
  };
}

/**
 * Scan all MasterClaw images
 * @param {Object} options - Scan options
 */
async function scanAll(options = {}) {
  const {
    severity = DEFAULT_SEVERITY_THRESHOLD,
    json = false,
    details = false,
    timeout = DEFAULT_SCAN_TIMEOUT_MS,
  } = options;

  // Get local images
  const images = await getLocalImages();

  if (images.length === 0) {
    if (json) {
      console.log(JSON.stringify({ error: 'No MasterClaw images found locally' }));
    } else {
      console.log(chalk.yellow('\n⚠️  No MasterClaw images found locally'));
      console.log(chalk.gray('   Run "mc revive" to build and start services first.'));
    }
    return { scanned: 0, results: [] };
  }

  if (!json) {
    console.log(chalk.blue(`\n🔒 MasterClaw Container Security Scanner`));
    console.log(chalk.gray(`   Found ${images.length} image(s) to scan\n`));
  }

  const results = [];
  let passed = true;

  for (const image of images) {
    try {
      const result = await scanImage(image.fullName, { severity, json, details, timeout });
      results.push(result);
      if (!result.passed) {
        passed = false;
      }
    } catch (err) {
      if (json) {
        results.push({
          image: image.fullName,
          error: err.message,
          passed: false,
        });
      } else {
        console.log(chalk.red(`\n❌ Failed to scan ${image.fullName}: ${err.message}`));
      }
      passed = false;
    }
  }

  // Summary
  if (!json) {
    console.log(chalk.blue('\n📊 Scan Summary'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(`  Images scanned: ${results.length}`);
    console.log(`  Passed: ${passed ? chalk.green('✅ Yes') : chalk.red('❌ No')}`);

    const totalCritical = results.reduce((sum, r) => sum + (r.summary?.critical || 0), 0);
    const totalHigh = results.reduce((sum, r) => sum + (r.summary?.high || 0), 0);

    if (totalCritical > 0) {
      console.log(chalk.red(`  Total CRITICAL: ${totalCritical}`));
    }
    if (totalHigh > 0) {
      console.log(chalk.yellow(`  Total HIGH: ${totalHigh}`));
    }
    console.log('');
  }

  return { scanned: results.length, results, passed };
}

/**
 * Check scanner installation status
 */
async function checkStatus() {
  const scanner = await detectScanner();

  console.log(chalk.blue('\n🔒 Security Scanner Status\n'));

  if (scanner.installed) {
    console.log(chalk.green(`✅ ${scanner.type === 'trivy' ? 'Trivy' : 'Docker Scout'} is installed`));
    if (scanner.version) {
      console.log(chalk.gray(`   Version: ${scanner.version}`));
    }
    if (scanner.needsUpgrade) {
      console.log(chalk.yellow(`   ⚠️  Upgrade recommended (minimum: ${TRIVY_MIN_VERSION})`));
    }
  } else {
    console.log(chalk.red('❌ No security scanner found'));
    displayTrivyInstallInstructions();
  }

  // Check local images
  const images = await getLocalImages();
  console.log(chalk.cyan(`\n📦 Local MasterClaw Images: ${images.length}`));
  for (const img of images) {
    console.log(chalk.gray(`   • ${img.fullName} (${img.size})`));
  }
  console.log('');
}

// =============================================================================
// CLI Command Definition
// =============================================================================

const program = new Command();

program
  .name('scan')
  .description('Scan MasterClaw container images for security vulnerabilities')
  .option('-s, --severity <level>', 'Minimum severity to report (CRITICAL, HIGH, MEDIUM, LOW)', 'HIGH')
  .option('-d, --details', 'Show detailed vulnerability information', false)
  .option('-j, --json', 'Output results as JSON', false)
  .option('-t, --timeout <seconds>', 'Scan timeout in seconds', '600')
  .option('--fix', 'Suggest fixes for vulnerabilities (when available)', false);

program
  .command('all')
  .description('Scan all local MasterClaw images')
  .action(wrapCommand(async (options) => {
    const result = await scanAll({
      severity: options.severity.toUpperCase(),
      json: options.json,
      details: options.details,
      timeout: parseInt(options.timeout, 10) * 1000,
      fix: options.fix,
    });

    // Exit with error if vulnerabilities found
    if (!result.passed) {
      process.exit(1);
    }
  }, 'scan all'));

program
  .command('image <image-name>')
  .description('Scan a specific Docker image')
  .action(wrapCommand(async (imageName, options) => {
    const result = await scanImage(imageName, {
      severity: options.severity.toUpperCase(),
      json: options.json,
      details: options.details,
      timeout: parseInt(options.timeout, 10) * 1000,
      fix: options.fix,
    });

    if (!result.passed) {
      process.exit(1);
    }
  }, 'scan image'));

program
  .command('status')
  .description('Check scanner installation and available images')
  .action(wrapCommand(async () => {
    await checkStatus();
  }, 'scan status'));

// Default action (scan all)
program.action(wrapCommand(async (options) => {
  const result = await scanAll({
    severity: options.severity.toUpperCase(),
    json: options.json,
    details: options.details,
    timeout: parseInt(options.timeout, 10) * 1000,
    fix: options.fix,
  });

  if (!result.passed) {
    process.exit(1);
  }
}, 'scan'));

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  program,
  scanImage,
  scanAll,
  checkStatus,
  getLocalImages,
  detectScanner,
  analyzeResults,
  // Helper functions for testing
  parseSeverity,
  formatVulnerabilityCount,
  meetsSeverityThreshold,
  generateScanSummary,
  // Constants for testing
  DEFAULT_SERVICES,
  SEVERITY_LEVELS,
  DEFAULT_SEVERITY_THRESHOLD,
  DEFAULT_SCAN_TIMEOUT_MS,
  TRIVY_MIN_VERSION,
};
