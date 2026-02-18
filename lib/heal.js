/**
 * MasterClaw Auto-Heal Module
 * 
 * Automatically detects and fixes common MasterClaw issues.
 * Provides dry-run capability to preview fixes before applying.
 * 
 * @module lib/heal
 */

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(require('child_process').exec);

const { findInfraDir } = require('./services');
const config = require('./config');
const docker = require('./docker');
const { getAllStatuses } = require('./services');
const logger = require('./logger').child('heal');
const { getAllCircuitStatus, resetCircuit } = require('./circuit-breaker');

// =============================================================================
// Heal Configuration
// =============================================================================

const HEAL_CONFIG = {
  // Disk space thresholds (in GB)
  diskCritical: 1,
  diskWarning: 5,
  
  // Memory thresholds (in GB)
  memoryCritical: 0.5,
  memoryWarning: 2,
  
  // Docker cleanup thresholds
  imageCleanupAge: '7d',
  volumeCleanupUnused: true,
  
  // Service restart configuration
  restartDelayMs: 5000,
  maxRestartAttempts: 3,
};

// =============================================================================
// Issue Types
// =============================================================================

const ISSUE_TYPES = {
  DOCKER_DOWN: 'docker_down',
  SERVICE_DOWN: 'service_down',
  SERVICE_UNHEALTHY: 'service_unhealthy',
  LOW_DISK_SPACE: 'low_disk_space',
  LOW_MEMORY: 'low_memory',
  CONFIG_PERMISSIONS: 'config_permissions',
  CIRCUIT_OPEN: 'circuit_open',
  STALE_CONTAINERS: 'stale_containers',
  UNUSED_IMAGES: 'unused_images',
  DANGLING_VOLUMES: 'dangling_volumes',
  ORPHANED_NETWORKS: 'orphaned_networks',
};

// =============================================================================
// Heal Result
// =============================================================================

class HealResult {
  constructor() {
    this.issuesFound = 0;
    this.issuesFixed = 0;
    this.issuesFailed = 0;
    this.issuesSkipped = 0;
    this.fixes = [];
    this.errors = [];
    this.warnings = [];
    this.startTime = Date.now();
  }

  addFix(issueType, description, action, success, error = null) {
    this.fixes.push({
      issueType,
      description,
      action,
      success,
      error,
      timestamp: new Date().toISOString(),
    });

    if (success) {
      this.issuesFixed++;
    } else if (error) {
      this.issuesFailed++;
      this.errors.push({ issueType, error });
    } else {
      this.issuesSkipped++;
    }
  }

  addWarning(message) {
    this.warnings.push({
      message,
      timestamp: new Date().toISOString(),
    });
  }

  get duration() {
    return Date.now() - this.startTime;
  }

  get summary() {
    return {
      issuesFound: this.issuesFound,
      issuesFixed: this.issuesFixed,
      issuesFailed: this.issuesFailed,
      issuesSkipped: this.issuesSkipped,
      duration: this.duration,
      success: this.issuesFailed === 0,
    };
  }
}

// =============================================================================
// Issue Detectors
// =============================================================================

/**
 * Detect Docker daemon issues
 */
async function detectDockerIssues() {
  const issues = [];
  
  try {
    await execAsync('docker info', { timeout: 5000 });
  } catch (error) {
    issues.push({
      type: ISSUE_TYPES.DOCKER_DOWN,
      severity: 'critical',
      description: 'Docker daemon is not running or not accessible',
      autoFixable: false,
      remediation: 'Start Docker service: sudo systemctl start docker',
    });
  }
  
  return issues;
}

/**
 * Detect service health issues
 */
async function detectServiceIssues() {
  const issues = [];
  
  try {
    const statuses = await getAllStatuses();
    
    for (const service of statuses) {
      if (service.status === 'down') {
        issues.push({
          type: ISSUE_TYPES.SERVICE_DOWN,
          severity: 'high',
          description: `Service ${service.name} is down`,
          autoFixable: true,
          service: service.name,
          remediation: `Restart service: mc restart ${service.name}`,
        });
      } else if (service.status === 'unhealthy') {
        issues.push({
          type: ISSUE_TYPES.SERVICE_UNHEALTHY,
          severity: 'medium',
          description: `Service ${service.name} is unhealthy`,
          autoFixable: true,
          service: service.name,
          remediation: `Check logs and restart: mc logs ${service.name} && mc restart ${service.name}`,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to detect service issues', { error: error.message });
  }
  
  return issues;
}

/**
 * Detect disk space issues
 */
async function detectDiskIssues() {
  const issues = [];
  
  try {
    const df = await execAsync("df -BG / | tail -1 | awk '{print $4}' | tr -d 'G'", { timeout: 5000 });
    const freeGB = parseInt(df.stdout.trim(), 10);
    
    if (isNaN(freeGB)) {
      return issues;
    }
    
    if (freeGB < HEAL_CONFIG.diskCritical) {
      issues.push({
        type: ISSUE_TYPES.LOW_DISK_SPACE,
        severity: 'critical',
        description: `Critical disk space: ${freeGB}GB free`,
        autoFixable: true,
        freeGB,
        remediation: 'Clean Docker artifacts: mc heal --fix (will clean images, volumes, logs)',
      });
    } else if (freeGB < HEAL_CONFIG.diskWarning) {
      issues.push({
        type: ISSUE_TYPES.LOW_DISK_SPACE,
        severity: 'warning',
        description: `Low disk space: ${freeGB}GB free`,
        autoFixable: true,
        freeGB,
        remediation: 'Consider cleaning up: mc heal --fix',
      });
    }
  } catch (error) {
    logger.warn('Failed to detect disk issues', { error: error.message });
  }
  
  return issues;
}

/**
 * Detect memory issues
 */
async function detectMemoryIssues() {
  const issues = [];
  
  try {
    const freeMemGB = os.freemem() / (1024 * 1024 * 1024);
    
    if (freeMemGB < HEAL_CONFIG.memoryCritical) {
      issues.push({
        type: ISSUE_TYPES.LOW_MEMORY,
        severity: 'critical',
        description: `Critical memory: ${freeMemGB.toFixed(2)}GB free`,
        autoFixable: false,
        freeGB: freeMemGB,
        remediation: 'Free up system memory or restart services',
      });
    } else if (freeMemGB < HEAL_CONFIG.memoryWarning) {
      issues.push({
        type: ISSUE_TYPES.LOW_MEMORY,
        severity: 'warning',
        description: `Low memory: ${freeMemGB.toFixed(2)}GB free`,
        autoFixable: false,
        freeGB: freeMemGB,
        remediation: 'Monitor memory usage with mc top',
      });
    }
  } catch (error) {
    logger.warn('Failed to detect memory issues', { error: error.message });
  }
  
  return issues;
}

/**
 * Detect config permission issues
 */
async function detectConfigIssues() {
  const issues = [];
  
  try {
    const infraDir = await findInfraDir();
    if (!infraDir) return issues;
    
    const envPath = path.join(infraDir, '.env');
    
    if (await fs.pathExists(envPath)) {
      const stats = await fs.stat(envPath);
      const mode = stats.mode & 0o777;
      
      if (mode !== 0o600) {
        issues.push({
          type: ISSUE_TYPES.CONFIG_PERMISSIONS,
          severity: 'medium',
          description: `.env file has permissions ${mode.toString(8)}, should be 600`,
          autoFixable: true,
          file: envPath,
          remediation: 'Fix permissions: mc heal --fix',
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to detect config issues', { error: error.message });
  }
  
  return issues;
}

/**
 * Detect circuit breaker issues
 */
async function detectCircuitIssues() {
  const issues = [];
  
  try {
    const circuits = getAllCircuitStatus();
    
    for (const [service, circuit] of Object.entries(circuits)) {
      if (circuit.state === 'OPEN') {
        issues.push({
          type: ISSUE_TYPES.CIRCUIT_OPEN,
          severity: 'medium',
          description: `Circuit breaker is OPEN for ${service}`,
          autoFixable: true,
          service,
          remediation: `Reset circuit: mc circuits --reset ${service}`,
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to detect circuit issues', { error: error.message });
  }
  
  return issues;
}

/**
 * Detect stale Docker artifacts
 */
async function detectDockerArtifacts() {
  const issues = [];
  
  try {
    // Check for exited containers
    const exited = await execAsync('docker ps -aq -f status=exited 2>/dev/null | wc -l', { timeout: 10000 });
    const exitedCount = parseInt(exited.stdout.trim(), 10) || 0;
    
    if (exitedCount > 0) {
      issues.push({
        type: ISSUE_TYPES.STALE_CONTAINERS,
        severity: 'low',
        description: `${exitedCount} exited container(s) found`,
        autoFixable: true,
        count: exitedCount,
        remediation: 'Clean up: mc heal --fix',
      });
    }
    
    // Check for dangling images
    const dangling = await execAsync('docker images -q -f dangling=true 2>/dev/null | wc -l', { timeout: 10000 });
    const danglingCount = parseInt(dangling.stdout.trim(), 10) || 0;
    
    if (danglingCount > 5) {
      issues.push({
        type: ISSUE_TYPES.UNUSED_IMAGES,
        severity: 'low',
        description: `${danglingCount} dangling image(s) found`,
        autoFixable: true,
        count: danglingCount,
        remediation: 'Clean up: mc heal --fix',
      });
    }
    
    // Check for unused volumes
    const volumes = await execAsync('docker volume ls -q -f dangling=true 2>/dev/null | wc -l', { timeout: 10000 });
    const volumeCount = parseInt(volumes.stdout.trim(), 10) || 0;
    
    if (volumeCount > 0) {
      issues.push({
        type: ISSUE_TYPES.DANGLING_VOLUMES,
        severity: 'low',
        description: `${volumeCount} unused volume(s) found`,
        autoFixable: true,
        count: volumeCount,
        remediation: 'Clean up: mc heal --fix',
      });
    }
  } catch (error) {
    logger.warn('Failed to detect Docker artifacts', { error: error.message });
  }
  
  return issues;
}

// =============================================================================
// Fix Functions
// =============================================================================

/**
 * Fix service issues by restarting services
 */
async function fixServiceIssues(issues, result, dryRun = false) {
  for (const issue of issues.filter(i => i.type === ISSUE_TYPES.SERVICE_DOWN || i.type === ISSUE_TYPES.SERVICE_UNHEALTHY)) {
    if (dryRun) {
      result.addFix(issue.type, issue.description, `Restart service: ${issue.service}`, null);
      continue;
    }
    
    try {
      logger.info(`Restarting service: ${issue.service}`);
      await execAsync(`docker restart mc-${issue.service}`, { timeout: 30000 });
      await new Promise(r => setTimeout(r, HEAL_CONFIG.restartDelayMs));
      
      // Verify fix
      const statuses = await getAllStatuses();
      const service = statuses.find(s => s.name === issue.service);
      
      if (service && service.status === 'healthy') {
        result.addFix(issue.type, issue.description, `Restarted service: ${issue.service}`, true);
      } else {
        result.addFix(issue.type, issue.description, `Restarted service: ${issue.service}`, false, 'Service still unhealthy after restart');
      }
    } catch (error) {
      result.addFix(issue.type, issue.description, `Restart service: ${issue.service}`, false, error.message);
    }
  }
}

/**
 * Fix config permission issues
 */
async function fixConfigIssues(issues, result, dryRun = false) {
  for (const issue of issues.filter(i => i.type === ISSUE_TYPES.CONFIG_PERMISSIONS)) {
    if (dryRun) {
      result.addFix(issue.type, issue.description, `Fix permissions: chmod 600 ${issue.file}`, null);
      continue;
    }
    
    try {
      await fs.chmod(issue.file, 0o600);
      result.addFix(issue.type, issue.description, `Fixed permissions: ${issue.file}`, true);
    } catch (error) {
      result.addFix(issue.type, issue.description, `Fix permissions: ${issue.file}`, false, error.message);
    }
  }
}

/**
 * Fix circuit breaker issues
 */
async function fixCircuitIssues(issues, result, dryRun = false) {
  for (const issue of issues.filter(i => i.type === ISSUE_TYPES.CIRCUIT_OPEN)) {
    if (dryRun) {
      result.addFix(issue.type, issue.description, `Reset circuit: ${issue.service}`, null);
      continue;
    }
    
    try {
      resetCircuit(issue.service);
      result.addFix(issue.type, issue.description, `Reset circuit: ${issue.service}`, true);
    } catch (error) {
      result.addFix(issue.type, issue.description, `Reset circuit: ${issue.service}`, false, error.message);
    }
  }
}

/**
 * Fix Docker artifact issues
 */
async function fixDockerArtifacts(issues, result, dryRun = false) {
  const staleContainers = issues.find(i => i.type === ISSUE_TYPES.STALE_CONTAINERS);
  const unusedImages = issues.find(i => i.type === ISSUE_TYPES.UNUSED_IMAGES);
  const danglingVolumes = issues.find(i => i.type === ISSUE_TYPES.DANGLING_VOLUMES);
  
  // Fix stale containers
  if (staleContainers) {
    if (dryRun) {
      result.addFix(staleContainers.type, staleContainers.description, 'Remove exited containers', null);
    } else {
      try {
        await execAsync('docker container prune -f', { timeout: 30000 });
        result.addFix(staleContainers.type, staleContainers.description, 'Removed exited containers', true);
      } catch (error) {
        result.addFix(staleContainers.type, staleContainers.description, 'Remove exited containers', false, error.message);
      }
    }
  }
  
  // Fix dangling images
  if (unusedImages) {
    if (dryRun) {
      result.addFix(unusedImages.type, unusedImages.description, 'Remove dangling images', null);
    } else {
      try {
        await execAsync('docker image prune -f', { timeout: 60000 });
        result.addFix(unusedImages.type, unusedImages.description, 'Removed dangling images', true);
      } catch (error) {
        result.addFix(unusedImages.type, unusedImages.description, 'Remove dangling images', false, error.message);
      }
    }
  }
  
  // Fix dangling volumes
  if (danglingVolumes) {
    if (dryRun) {
      result.addFix(danglingVolumes.type, danglingVolumes.description, 'Remove unused volumes', null);
    } else {
      try {
        await execAsync('docker volume prune -f', { timeout: 30000 });
        result.addFix(danglingVolumes.type, danglingVolumes.description, 'Removed unused volumes', true);
      } catch (error) {
        result.addFix(danglingVolumes.type, danglingVolumes.description, 'Remove unused volumes', false, error.message);
      }
    }
  }
}

/**
 * Fix disk space issues with aggressive cleanup
 */
async function fixDiskIssues(issues, result, dryRun = false) {
  const diskIssue = issues.find(i => i.type === ISSUE_TYPES.LOW_DISK_SPACE);
  if (!diskIssue) return;
  
  if (dryRun) {
    result.addFix(diskIssue.type, diskIssue.description, 'Aggressive cleanup: containers, images, volumes, build cache', null);
    return;
  }
  
  try {
    // Aggressive cleanup
    await execAsync('docker system prune -af --volumes', { timeout: 120000 });
    await execAsync('docker buildx prune -f', { timeout: 60000 }).catch(() => {});
    
    result.addFix(diskIssue.type, diskIssue.description, 'Aggressive Docker cleanup completed', true);
    result.addWarning('All unused Docker resources have been removed. Some services may need to re-pull images.');
  } catch (error) {
    result.addFix(diskIssue.type, diskIssue.description, 'Aggressive cleanup', false, error.message);
  }
}

// =============================================================================
// Main Heal Function
// =============================================================================

/**
 * Run auto-heal detection and optionally fix issues
 * 
 * @param {Object} options - Heal options
 * @param {boolean} options.fix - Actually fix issues (default: false, dry-run)
 * @param {boolean} options.json - Output as JSON
 * @param {string[]} options.categories - Categories to check (default: all)
 * @returns {Promise<HealResult>} Heal result
 */
async function runHeal(options = {}) {
  const { fix = false, json = false, categories = [] } = options;
  const result = new HealResult();
  
  if (!json) {
    console.log(chalk.blue('🩹 MasterClaw Auto-Heal'));
    console.log(chalk.gray(fix ? 'Mode: FIX - Will attempt to fix issues\n' : 'Mode: DRY-RUN - Showing issues without fixing\n'));
  }
  
  // Collect all issues
  const allIssues = [];
  
  const detectors = [
    { name: 'Docker', fn: detectDockerIssues, category: 'docker' },
    { name: 'Services', fn: detectServiceIssues, category: 'services' },
    { name: 'Disk Space', fn: detectDiskIssues, category: 'system' },
    { name: 'Memory', fn: detectMemoryIssues, category: 'system' },
    { name: 'Config', fn: detectConfigIssues, category: 'config' },
    { name: 'Circuits', fn: detectCircuitIssues, category: 'services' },
    { name: 'Docker Artifacts', fn: detectDockerArtifacts, category: 'docker' },
  ];
  
  for (const detector of detectors) {
    if (categories.length > 0 && !categories.includes(detector.category)) {
      continue;
    }
    
    if (!json) {
      process.stdout.write(`Checking ${detector.name}... `);
    }
    
    try {
      const issues = await detector.fn();
      allIssues.push(...issues);
      
      if (!json) {
        if (issues.length === 0) {
          console.log(chalk.green('✅'));
        } else {
          const critical = issues.filter(i => i.severity === 'critical').length;
          const high = issues.filter(i => i.severity === 'high').length;
          const warning = issues.filter(i => i.severity === 'warning').length;
          const low = issues.filter(i => i.severity === 'low').length;
          
          const parts = [];
          if (critical > 0) parts.push(chalk.red(`${critical} critical`));
          if (high > 0) parts.push(chalk.yellow(`${high} high`));
          if (warning > 0) parts.push(chalk.yellow(`${warning} warning`));
          if (low > 0) parts.push(chalk.gray(`${low} low`));
          
          console.log(parts.join(', ') || chalk.green('✅'));
        }
      }
    } catch (error) {
      if (!json) {
        console.log(chalk.red('❌'));
      }
      logger.error(`Detector ${detector.name} failed`, { error: error.message });
    }
  }
  
  result.issuesFound = allIssues.length;
  
  // Separate auto-fixable and non-fixable issues
  const autoFixable = allIssues.filter(i => i.autoFixable);
  const nonFixable = allIssues.filter(i => !i.autoFixable);
  
  // Apply fixes if requested
  if (fix && autoFixable.length > 0) {
    if (!json) {
      console.log(chalk.cyan('\n🔧 Applying fixes...\n'));
    }
    
    await fixServiceIssues(autoFixable, result, false);
    await fixConfigIssues(autoFixable, result, false);
    await fixCircuitIssues(autoFixable, result, false);
    await fixDockerArtifacts(autoFixable, result, false);
    await fixDiskIssues(autoFixable, result, false);
  } else if (!fix && autoFixable.length > 0) {
    // Dry-run: show what would be fixed
    for (const issue of autoFixable) {
      result.addFix(issue.type, issue.description, issue.remediation, null);
    }
  }
  
  // Output results
  if (json) {
    return {
      summary: result.summary,
      fixes: result.fixes,
      warnings: result.warnings,
      nonFixableIssues: nonFixable.map(i => ({
        type: i.type,
        severity: i.severity,
        description: i.description,
        remediation: i.remediation,
      })),
    };
  }
  
  // Print summary
  console.log(chalk.cyan('\n📊 Summary'));
  console.log('═'.repeat(50));
  
  if (allIssues.length === 0) {
    console.log(chalk.green('✅ No issues found - MasterClaw is healthy!'));
  } else {
    console.log(`Issues found: ${allIssues.length}`);
    console.log(`  Auto-fixable: ${autoFixable.length}`);
    console.log(`  Manual fix required: ${nonFixable.length}`);
    
    if (fix) {
      console.log(`\nFixes applied: ${result.issuesFixed}`);
      if (result.issuesFailed > 0) {
        console.log(chalk.red(`Fixes failed: ${result.issuesFailed}`));
      }
    }
  }
  
  // Print non-fixable issues
  if (nonFixable.length > 0) {
    console.log(chalk.yellow('\n⚠️  Issues requiring manual intervention:'));
    for (const issue of nonFixable) {
      const icon = issue.severity === 'critical' ? '🔴' : issue.severity === 'high' ? '🟡' : '⚪';
      console.log(`\n  ${icon} ${issue.description}`);
      console.log(chalk.gray(`     Fix: ${issue.remediation}`));
    }
  }
  
  // Print warnings
  if (result.warnings.length > 0) {
    console.log(chalk.yellow('\n⚠️  Warnings:'));
    for (const warning of result.warnings) {
      console.log(`  • ${warning.message}`);
    }
  }
  
  console.log(chalk.gray(`\nDuration: ${result.duration}ms`));
  
  if (!fix && autoFixable.length > 0) {
    console.log(chalk.cyan(`\n💡 Run with --fix to automatically fix ${autoFixable.length} issue(s)`));
  }
  
  return result;
}

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  runHeal,
  HealResult,
  ISSUE_TYPES,
  HEAL_CONFIG,
  // Export detectors for testing
  detectDockerIssues,
  detectServiceIssues,
  detectDiskIssues,
  detectMemoryIssues,
  detectConfigIssues,
  detectCircuitIssues,
  detectDockerArtifacts,
};
