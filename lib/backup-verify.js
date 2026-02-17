/**
 * backup-verify.js - Backup verification commands for mc CLI
 * 
 * Verifies backup integrity and restorability:
 * - Check archive integrity
 * - Test restore capability
 * - Report verification status
 * - Prometheus metrics export
 * 
 * Security features:
 * - Path traversal prevention
 * - Input validation
 * - Command injection prevention
 * - Secure file permissions checking
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn } = require('child_process');
const ora = require('ora');
const fs = require('fs-extra');
const path = require('path');

// Import security utilities
const { containsPathTraversal, sanitizeFilename } = require('./security');
const { validateWorkingDirectory, DockerSecurityError } = require('./docker');
const { logAuditEvent, logSecurityViolation } = require('./audit');

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum allowed file path length */
const MAX_FILE_PATH_LENGTH = 4096;

/** Allowed backup file extensions */
const ALLOWED_BACKUP_EXTENSIONS = new Set(['.tar', '.tar.gz', '.tgz', '.zip', '.sql', '.dump']);

/** Default timeout for backup verification (10 minutes) */
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum timeout allowed (1 hour) */
const MAX_VERIFY_TIMEOUT_MS = 60 * 60 * 1000;

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Validates a backup file path for security
 * - Prevents path traversal attacks
 * - Validates file extension
 * - Checks path length
 * 
 * @param {string} filePath - File path to validate
 * @returns {Object} - Validation result { valid: boolean, error?: string, sanitizedPath?: string }
 */
function validateBackupFilePath(filePath) {
  if (typeof filePath !== 'string') {
    return { valid: false, error: 'File path must be a string' };
  }

  if (filePath.length === 0) {
    return { valid: false, error: 'File path cannot be empty' };
  }

  if (filePath.length > MAX_FILE_PATH_LENGTH) {
    return { valid: false, error: `File path exceeds maximum length of ${MAX_FILE_PATH_LENGTH} characters` };
  }

  // Check for null bytes first (security critical)
  if (filePath.includes('\0')) {
    return { valid: false, error: 'File path contains null bytes', securityViolation: true };
  }

  // Check for path traversal attempts
  if (containsPathTraversal(filePath)) {
    return { valid: false, error: 'File path contains path traversal sequences', securityViolation: true };
  }

  // Validate file extension
  const ext = path.extname(filePath).toLowerCase();
  const hasAllowedExt = Array.from(ALLOWED_BACKUP_EXTENSIONS).some(allowed => 
    filePath.toLowerCase().endsWith(allowed)
  );
  
  if (!hasAllowedExt && ext !== '') {
    // Allow if the file exists (might be a custom backup name)
    // But warn about unusual extensions
    console.warn(chalk.yellow(`⚠️  Unusual file extension: ${ext}`));
  }

  // Sanitize the filename component
  const sanitized = sanitizeFilename(path.basename(filePath));
  const sanitizedPath = path.join(path.dirname(filePath), sanitized);

  return { valid: true, sanitizedPath };
}

/**
 * Validates verification options for security
 * 
 * @param {Object} options - Command options
 * @returns {Object} - Validation result { valid: boolean, error?: string }
 */
function validateVerifyOptions(options) {
  // Only one of --file, --latest, --all should be specified
  const modes = [
    options.file ? 'file' : null,
    options.latest ? 'latest' : null,
    options.all ? 'all' : null,
  ].filter(Boolean);

  if (modes.length > 1) {
    return { valid: false, error: `Conflicting options: --${modes.join(', --')}. Use only one mode.` };
  }

  // Validate file path if provided
  if (options.file) {
    const fileValidation = validateBackupFilePath(options.file);
    if (!fileValidation.valid) {
      return { valid: false, error: fileValidation.error, securityViolation: fileValidation.securityViolation };
    }
  }

  return { valid: true };
}

// =============================================================================
// Infrastructure Directory Discovery
// =============================================================================

/**
 * Find infrastructure directory with security validation
 * @returns {Promise<string|null>} - Path to infrastructure directory or null
 */
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
    
    // Security: Validate path before using
    try {
      validateWorkingDirectory(dir);
    } catch (err) {
      continue; // Skip invalid paths
    }
    
    const scriptPath = path.join(dir, 'scripts', 'backup-verify.sh');
    if (await fs.pathExists(scriptPath)) {
      // Additional security: Check script permissions
      try {
        const stats = await fs.stat(scriptPath);
        // Warn if script is writable by others
        if (stats.mode & 0o022) {
          console.warn(chalk.yellow(`⚠️  Backup script may be writable by others: ${scriptPath}`));
        }
      } catch {
        // Ignore stat errors
      }
      return dir;
    }
  }
  
  return null;
}

// =============================================================================
// Backup Verification
// =============================================================================

/**
 * Execute backup verification with security hardening
 * 
 * @param {Object} options - Verification options
 * @returns {Promise<Object>} - Verification result
 */
async function executeBackupVerify(options = {}) {
  const infraDir = await findInfraDir();
  
  if (!infraDir) {
    const error = new Error('MasterClaw infrastructure directory not found. Set MASTERCLAW_INFRA environment variable or run from infrastructure directory.');
    error.code = 'INFRA_NOT_FOUND';
    throw error;
  }

  const scriptPath = path.join(infraDir, 'scripts', 'backup-verify.sh');
  
  // Verify script exists
  if (!await fs.pathExists(scriptPath)) {
    const error = new Error(`Backup verification script not found: ${scriptPath}`);
    error.code = 'SCRIPT_NOT_FOUND';
    throw error;
  }

  // Build arguments with security validation
  const args = [];
  
  if (options.file) {
    const validation = validateBackupFilePath(options.file);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.code = 'INVALID_FILE_PATH';
      if (validation.securityViolation) {
        error.securityViolation = true;
      }
      throw error;
    }
    args.push('--file', validation.sanitizedPath);
  }
  
  if (options.latest) args.push('--latest');
  if (options.all) args.push('--all');
  if (options.metrics) args.push('--metrics');
  if (options.quiet) args.push('--quiet');

  // Log audit event
  await logAuditEvent('backup_verify_start', {
    mode: options.file ? 'file' : options.latest ? 'latest' : options.all ? 'all' : 'default',
    file: options.file ? sanitizeFilename(path.basename(options.file)) : null,
    infraDir,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, args, {
      cwd: infraDir,
      stdio: options.quiet ? 'pipe' : 'inherit',
      timeout: DEFAULT_VERIFY_TIMEOUT_MS,
    });
    
    let stdout = '';
    let stderr = '';
    
    if (options.quiet || options.metrics) {
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', async (code) => {
      if (options.metrics || options.quiet) {
        console.log(stdout);
      }
      
      // Log result
      await logAuditEvent('backup_verify_complete', {
        exitCode: code,
        mode: options.file ? 'file' : options.latest ? 'latest' : options.all ? 'all' : 'default',
      });
      
      if (code === 0) {
        resolve({
          success: true,
          message: 'Backup verification complete',
          stdout: options.quiet || options.metrics ? stdout : null,
        });
      } else if (code === 2) {
        const error = new Error('No backups found to verify');
        error.code = 'NO_BACKUPS';
        error.exitCode = code;
        reject(error);
      } else {
        const error = new Error(`Backup verification failed (exit code: ${code})`);
        error.code = 'VERIFY_FAILED';
        error.exitCode = code;
        error.stderr = stderr;
        reject(error);
      }
    });
    
    child.on('error', async (err) => {
      await logAuditEvent('backup_verify_error', {
        error: err.message,
        mode: options.file ? 'file' : options.latest ? 'latest' : options.all ? 'all' : 'default',
      });
      reject(err);
    });

    // Handle timeout
    child.on('timeout', async () => {
      child.kill('SIGTERM');
      await logSecurityViolation('BACKUP_VERIFY_TIMEOUT', {
        timeout: DEFAULT_VERIFY_TIMEOUT_MS,
        mode: options.file ? 'file' : options.latest ? 'latest' : options.all ? 'all' : 'default',
      });
      const error = new Error(`Backup verification timed out after ${DEFAULT_VERIFY_TIMEOUT_MS}ms`);
      error.code = 'VERIFY_TIMEOUT';
      reject(error);
    });
  });
}

// =============================================================================
// CLI Command Setup
// =============================================================================

const backupVerify = new Command('backup-verify');

backupVerify
  .description('Verify backup integrity and restorability')
  .option('-f, --file <path>', 'verify specific backup file')
  .option('-l, --latest', 'verify the most recent backup (default)')
  .option('-a, --all', 'verify all backups within retention period')
  .option('-m, --metrics', 'output Prometheus metrics format')
  .option('-q, --quiet', 'minimal output (exit code only)')
  .action(async (options) => {
    // Validate options first
    const validation = validateVerifyOptions(options);
    if (!validation.valid) {
      console.error(chalk.red(`❌ ${validation.error}`));
      
      // Log security violations
      if (validation.securityViolation) {
        await logSecurityViolation('BACKUP_VERIFY_VALIDATION_FAILED', {
          error: validation.error,
          file: options.file,
        });
      }
      
      process.exit(1);
    }

    if (!options.metrics && !options.quiet) {
      console.log(chalk.blue('🔍 MasterClaw Backup Verification\n'));
    }
    
    const spinner = !options.metrics && !options.quiet ? ora('Running backup verification...').start() : null;
    
    try {
      const result = await executeBackupVerify(options);
      
      if (spinner) {
        spinner.succeed('Backup verification complete');
      }
      
      if (!options.metrics && !options.quiet) {
        console.log(chalk.green('\n✅ Backup verification successful'));
      }
    } catch (err) {
      if (spinner) {
        spinner.fail('Backup verification failed');
      }
      
      if (!options.quiet && !options.metrics) {
        if (err.code === 'NO_BACKUPS') {
          console.log(chalk.yellow('\n⚠️  No backups found to verify'));
        } else if (err.code === 'INFRA_NOT_FOUND') {
          console.error(chalk.red(`❌ ${err.message}`));
          console.error(chalk.gray('   Set MASTERCLAW_INFRA environment variable or run from infrastructure directory'));
        } else if (err.code === 'INVALID_FILE_PATH') {
          console.error(chalk.red(`❌ Invalid file path: ${err.message}`));
          if (err.securityViolation) {
            console.error(chalk.red('   Security violation detected!'));
          }
        } else if (err.code === 'VERIFY_TIMEOUT') {
          console.error(chalk.red(`❌ ${err.message}`));
        } else {
          console.error(chalk.red(`\n❌ Backup verification failed: ${err.message}`));
        }
      }
      
      process.exit(1);
    }
  });

// =============================================================================
// Module Exports
// =============================================================================

module.exports = backupVerify;
module.exports.executeBackupVerify = executeBackupVerify;
module.exports.validateBackupFilePath = validateBackupFilePath;
module.exports.validateVerifyOptions = validateVerifyOptions;
module.exports.findInfraDir = findInfraDir;
module.exports.ALLOWED_BACKUP_EXTENSIONS = ALLOWED_BACKUP_EXTENSIONS;
module.exports.MAX_FILE_PATH_LENGTH = MAX_FILE_PATH_LENGTH;
module.exports.DEFAULT_VERIFY_TIMEOUT = DEFAULT_VERIFY_TIMEOUT_MS;
