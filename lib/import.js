/**
 * import.js - Import data into MasterClaw
 *
 * Complements the export command to enable data portability:
 * - Import configuration from JSON files
 * - Import memories from backup exports
 * - Bulk import from legacy formats
 * - Validation and dry-run support
 *
 * Security Features:
 * - Path traversal protection prevents access to files outside intended directories
 * - File size limits prevent DoS attacks via large files
 * - Import file validation prevents malformed data injection
 * - Rate limiting integration for bulk operations
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');
const axios = require('axios');
const config = require('./config');

// Import security utilities
const { containsPathTraversal, sanitizeFilename } = require('./security');
const { logSecurityViolation } = require('./audit');
const { enforceRateLimit } = require('./rate-limiter');

const importer = new Command('import');

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum import file size (10MB) to prevent DoS */
const MAX_IMPORT_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum number of items to import in a single operation */
const MAX_IMPORT_ITEMS = 10000;

/** Allowed file extensions for import files */
const ALLOWED_EXTENSIONS = new Set(['.json']);

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates an import file path for security issues
 * @param {string} filePath - File path to validate
 * @returns {Object} - Validation result { valid: boolean, error?: string }
 */
function validateImportFilePath(filePath) {
  if (typeof filePath !== 'string') {
    return { valid: false, error: 'File path must be a string' };
  }

  if (filePath.length === 0) {
    return { valid: false, error: 'File path cannot be empty' };
  }

  if (filePath.length > 4096) {
    return { valid: false, error: 'File path too long (max 4096 characters)' };
  }

  // Check for path traversal attempts
  if (containsPathTraversal(filePath)) {
    return { valid: false, error: 'Path traversal detected in file path' };
  }

  // Check for null bytes
  if (filePath.includes('\0')) {
    return { valid: false, error: 'Null bytes not allowed in file path' };
  }

  // Validate file extension
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, error: `Invalid file extension '${ext}'. Only ${Array.from(ALLOWED_EXTENSIONS).join(', ')} allowed` };
  }

  return { valid: true };
}

/**
 * Validates import file size to prevent DoS
 * @param {string} filePath - Path to file
 * @returns {Promise<Object>} - Validation result
 */
async function validateImportFileSize(filePath) {
  try {
    const stats = await fs.stat(filePath);

    if (stats.size > MAX_IMPORT_FILE_SIZE) {
      return {
        valid: false,
        error: `File too large (${formatBytes(stats.size)}). Maximum allowed: ${formatBytes(MAX_IMPORT_FILE_SIZE)}`,
      };
    }

    return { valid: true, size: stats.size };
  } catch (err) {
    return { valid: false, error: `Cannot read file: ${err.message}` };
  }
}

/**
 * Validates import data structure and content
 * @param {Object} data - Import data
 * @param {string} type - Import type
 * @returns {Object} - Validation result
 */
function validateImportFile(data, type) {
  const errors = [];

  if (!data || typeof data !== 'object') {
    errors.push('Invalid JSON: must be an object');
    return errors;
  }

  // Check for prototype pollution attempts
  const hasDangerousKeys = (obj, path = '') => {
    if (obj === null || typeof obj !== 'object') return false;

    for (const key of Object.keys(obj)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return true;
      }
      if (typeof obj[key] === 'object' && hasDangerousKeys(obj[key], `${path}.${key}`)) {
        return true;
      }
    }
    return false;
  };

  if (hasDangerousKeys(data)) {
    errors.push('Security violation: Dangerous keys detected (__proto__, constructor, or prototype)');
    return errors;
  }

  switch (type) {
    case 'config':
      if (!data.config && !data.settings) {
        errors.push('Missing required field: config or settings');
      }
      break;

    case 'memory':
      if (!data.memories && !data.memory) {
        errors.push('Missing required field: memories or memory');
      }
      if (data.memories && !Array.isArray(data.memories)) {
        errors.push('Field "memories" must be an array');
      }
      if (data.memories && data.memories.length > MAX_IMPORT_ITEMS) {
        errors.push(`Too many memories (${data.memories.length}). Maximum: ${MAX_IMPORT_ITEMS}`);
      }
      break;

    case 'full':
      if (!data.version) {
        errors.push('Missing required field: version');
      }
      if (!data.exported_at) {
        errors.push('Missing required field: exported_at');
      }
      if (data.memories && data.memories.length > MAX_IMPORT_ITEMS) {
        errors.push(`Too many memories (${data.memories.length}). Maximum: ${MAX_IMPORT_ITEMS}`);
      }
      break;

    default:
      // Auto-detect validation
      if (!data.version && !data.config && !data.memories) {
        errors.push('Unrecognized import format. Expected: full export, config, or memory backup');
      }
  }

  return errors;
}

/**
 * Format bytes to human-readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))  } ${  sizes[i]}`;
}

/**
 * Detect import file type from content
 */
function detectImportType(data) {
  if (data.memories || data.memory) return 'memory';
  if (data.config || data.settings) return 'config';
  if (data.version && data.exported_at) return 'full';
  return 'unknown';
}

/**
 * Import configuration settings
 */
async function importConfig(data, options) {
  const settings = data.config || data.settings || data;
  const results = { imported: 0, skipped: 0, errors: [] };

  for (const [key, value] of Object.entries(settings)) {
    // Skip dangerous keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      results.errors.push({ key, error: 'Dangerous key rejected' });
      continue;
    }

    // Skip internal or sensitive keys in dry-run
    if (options.dryRun) {
      results.imported++;
      continue;
    }

    try {
      // Don't overwrite existing unless --force is used
      if (!options.force) {
        const existing = await config.get(key);
        if (existing !== undefined) {
          results.skipped++;
          continue;
        }
      }

      await config.set(key, value);
      results.imported++;
    } catch (err) {
      results.errors.push({ key, error: err.message });
    }
  }

  return results;
}

/**
 * Import memories via API
 */
async function importMemories(data, options) {
  const memories = data.memories || data.memory || [];
  const results = { imported: 0, skipped: 0, errors: [] };

  if (options.dryRun) {
    return { imported: memories.length, skipped: 0, errors: [] };
  }

  const coreUrl = await config.get('core.url') || 'http://localhost:8000';

  for (const memory of memories) {
    try {
      const content = memory.content || memory.text || memory.message;
      if (!content) {
        results.errors.push({ id: memory.id || 'unknown', error: 'Missing content' });
        continue;
      }

      await axios.post(`${coreUrl}/v1/memory/add`, {
        content,
        metadata: memory.metadata || {},
        source: memory.source || 'import',
      }, { timeout: 10000 });

      results.imported++;

      // Small delay to avoid overwhelming the API
      if (!options.noDelay) {
        await new Promise(r => setTimeout(r, 50));
      }
    } catch (err) {
      results.errors.push({
        id: memory.id || 'unknown',
        error: err.response?.data?.detail || err.message
      });
    }
  }

  return results;
}

/**
 * Perform full import (config + memories + sessions)
 */
async function importFull(data, options) {
  const results = {
    config: { imported: 0, skipped: 0, errors: [] },
    memories: { imported: 0, skipped: 0, errors: [] },
    sessions: { imported: 0, skipped: 0, errors: [] },
  };

  // Import config if present
  if (data.config) {
    results.config = await importConfig(data.config, options);
  }

  // Import memories if present
  if (data.memories) {
    results.memories = await importMemories({ memories: data.memories }, options);
  }

  // Import sessions if present (sessions are stored as memories with session_id)
  if (data.sessions) {
    const sessionMemories = [];
    for (const session of data.sessions) {
      if (session.messages) {
        sessionMemories.push(...session.messages);
      }
    }
    if (sessionMemories.length > 0) {
      results.sessions = await importMemories({ memories: sessionMemories }, options);
    }
  }

  return results;
}

// =============================================================================
// Import Commands
// =============================================================================

// Main import command
importer
  .command('all <file>')
  .description('Import data from an export file (auto-detects format)')
  .option('-d, --dry-run', 'preview changes without applying')
  .option('-f, --force', 'overwrite existing data')
  .option('-t, --type <type>', 'force specific type (config|memory|full)')
  .option('--no-delay', 'skip delays between API calls (faster but riskier)')
  .action(async (file, options) => {
    const spinner = ora('Reading import file...').start();

    try {
      // Enforce rate limiting for import operations
      await enforceRateLimit('import', { command: 'import-all' });

      // Validate file path for security
      const pathValidation = validateImportFilePath(file);
      if (!pathValidation.valid) {
        spinner.fail(`Security validation failed: ${pathValidation.error}`);
        await logSecurityViolation('IMPORT_PATH_TRAVERSAL_ATTEMPT', {
          file,
          error: pathValidation.error,
        });
        process.exit(1);
      }

      // Check file exists
      if (!await fs.pathExists(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      // Validate file size
      const sizeValidation = await validateImportFileSize(file);
      if (!sizeValidation.valid) {
        spinner.fail(sizeValidation.error);
        process.exit(1);
      }

      // Read and parse
      const data = await fs.readJson(file);
      spinner.succeed(`Loaded: ${path.basename(file)} (${formatBytes(sizeValidation.size)})`);

      // Detect or use specified type
      const importType = options.type || detectImportType(data);

      if (importType === 'unknown') {
        console.log(chalk.red('❌ Could not detect import format'));
        console.log(chalk.gray('Use --type to specify: config, memory, or full'));
        process.exit(1);
      }

      console.log(chalk.blue(`\n📥 Import Type: ${importType}`));

      if (options.dryRun) {
        console.log(chalk.yellow('🔍 DRY RUN MODE - No changes will be made\n'));
      }

      // Validate
      const validationErrors = validateImportFile(data, importType);
      if (validationErrors.length > 0) {
        console.log(chalk.red('\n❌ Validation Errors:'));
        validationErrors.forEach(err => console.log(chalk.gray(`  • ${err}`)));
        process.exit(1);
      }

      // Show preview
      console.log(chalk.cyan('\n📋 Import Preview:'));

      switch (importType) {
        case 'config':
          const configKeys = Object.keys(data.config || data.settings || data);
          console.log(`  Config keys: ${configKeys.length}`);
          configKeys.slice(0, 5).forEach(k => console.log(chalk.gray(`    • ${k}`)));
          if (configKeys.length > 5) {
            console.log(chalk.gray(`    ... and ${configKeys.length - 5} more`));
          }
          break;

        case 'memory':
          const memories = data.memories || data.memory || [];
          console.log(`  Memories: ${memories.length}`);
          if (memories[0]) {
            const preview = (memories[0].content || memories[0].text || '').substring(0, 60);
            console.log(chalk.gray(`  Preview: "${preview}..."`));
          }
          break;

        case 'full':
          console.log(`  Version: ${data.version}`);
          console.log(`  Exported: ${data.exported_at}`);
          if (data.config) console.log(`  Config: ${Object.keys(data.config).length} keys`);
          if (data.memories) console.log(`  Memories: ${data.memories.length}`);
          if (data.sessions) console.log(`  Sessions: ${data.sessions.length}`);
          break;
      }

      // Confirm if not dry-run
      if (!options.dryRun && !options.force) {
        console.log(chalk.yellow('\n⚠️  This will import data into MasterClaw.'));
        console.log(chalk.gray('Use --dry-run to preview, --force to skip this warning'));

        // In non-interactive mode, require --force
        if (!process.stdin.isTTY) {
          console.log(chalk.red('\n❌ Non-interactive mode: use --force to import'));
          process.exit(1);
        }

        const readline = require('readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });

        const answer = await new Promise(resolve => {
          rl.question(chalk.cyan('\nProceed with import? [y/N] '), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          console.log(chalk.gray('\nImport cancelled'));
          process.exit(0);
        }
      }

      // Execute import
      console.log(chalk.blue('\n🔄 Importing...'));
      let results;

      switch (importType) {
        case 'config':
          results = await importConfig(data, options);
          console.log(chalk.green(`\n✅ Config import complete:`));
          console.log(`  Imported: ${results.imported}`);
          if (results.skipped > 0) console.log(`  Skipped (existing): ${results.skipped}`);
          if (results.errors.length > 0) console.log(chalk.yellow(`  Errors: ${results.errors.length}`));
          break;

        case 'memory':
          results = await importMemories(data, options);
          console.log(chalk.green(`\n✅ Memory import complete:`));
          console.log(`  Imported: ${results.imported}`);
          if (results.skipped > 0) console.log(`  Skipped: ${results.skipped}`);
          if (results.errors.length > 0) console.log(chalk.yellow(`  Errors: ${results.errors.length}`));
          break;

        case 'full':
          results = await importFull(data, options);
          console.log(chalk.green(`\n✅ Full import complete:`));
          if (results.config.imported > 0) {
            console.log(`  Config: ${results.config.imported} imported`);
          }
          if (results.memories.imported > 0) {
            console.log(`  Memories: ${results.memories.imported} imported`);
          }
          if (results.sessions.imported > 0) {
            console.log(`  Sessions: ${results.sessions.imported} imported`);
          }
          break;
      }

      // Show errors if any
      if (results.errors && results.errors.length > 0) {
        console.log(chalk.yellow(`\n⚠️  ${results.errors.length} error(s):`));
        results.errors.slice(0, 5).forEach(e => {
          console.log(chalk.gray(`  • ${e.id || e.key}: ${e.error}`));
        });
        if (results.errors.length > 5) {
          console.log(chalk.gray(`  ... and ${results.errors.length - 5} more`));
        }
      }

      console.log(chalk.green('\n✨ Import finished'));

    } catch (err) {
      spinner.fail('Import failed');

      if (err.code === 'ENOENT') {
        console.log(chalk.red(`❌ File not found: ${file}`));
      } else if (err.name === 'SyntaxError') {
        console.log(chalk.red(`❌ Invalid JSON in file: ${err.message}`));
      } else {
        console.log(chalk.red(`❌ Error: ${err.message}`));
      }

      process.exit(1);
    }
  });

// Import config specifically
importer
  .command('config <file>')
  .description('Import configuration from JSON file')
  .option('-d, --dry-run', 'preview changes without applying')
  .option('-f, --force', 'overwrite existing values')
  .action(async (file, options) => {
    const spinner = ora('Reading config file...').start();

    try {
      // Enforce rate limiting
      await enforceRateLimit('import', { command: 'import-config' });

      // Validate file path
      const pathValidation = validateImportFilePath(file);
      if (!pathValidation.valid) {
        spinner.fail(`Security validation failed: ${pathValidation.error}`);
        await logSecurityViolation('IMPORT_PATH_TRAVERSAL_ATTEMPT', {
          file,
          error: pathValidation.error,
        });
        process.exit(1);
      }

      if (!await fs.pathExists(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      // Validate file size
      const sizeValidation = await validateImportFileSize(file);
      if (!sizeValidation.valid) {
        spinner.fail(sizeValidation.error);
        process.exit(1);
      }

      const data = await fs.readJson(file);
      spinner.succeed(`Loaded: ${path.basename(file)}`);

      const validationErrors = validateImportFile(data, 'config');
      if (validationErrors.length > 0) {
        console.log(chalk.red('\n❌ Validation Errors:'));
        validationErrors.forEach(err => console.log(chalk.gray(`  • ${err}`)));
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(chalk.yellow('\n🔍 DRY RUN MODE'));
      }

      const results = await importConfig(data, options);

      console.log(chalk.green(`\n✅ Config import complete:`));
      console.log(`  Imported: ${results.imported}`);
      if (results.skipped > 0) console.log(`  Skipped: ${results.skipped}`);

    } catch (err) {
      spinner.fail('Import failed');
      console.log(chalk.red(`❌ Error: ${err.message}`));
      process.exit(1);
    }
  });

// Import memories specifically
importer
  .command('memory <file>')
  .description('Import memories from JSON file')
  .option('-d, --dry-run', 'preview changes')
  .option('--no-delay', 'skip delays between API calls')
  .action(async (file, options) => {
    const spinner = ora('Reading memory file...').start();

    try {
      // Enforce rate limiting
      await enforceRateLimit('import', { command: 'import-memory' });

      // Validate file path
      const pathValidation = validateImportFilePath(file);
      if (!pathValidation.valid) {
        spinner.fail(`Security validation failed: ${pathValidation.error}`);
        await logSecurityViolation('IMPORT_PATH_TRAVERSAL_ATTEMPT', {
          file,
          error: pathValidation.error,
        });
        process.exit(1);
      }

      if (!await fs.pathExists(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      // Validate file size
      const sizeValidation = await validateImportFileSize(file);
      if (!sizeValidation.valid) {
        spinner.fail(sizeValidation.error);
        process.exit(1);
      }

      const data = await fs.readJson(file);
      spinner.succeed(`Loaded: ${path.basename(file)}`);

      const validationErrors = validateImportFile(data, 'memory');
      if (validationErrors.length > 0) {
        console.log(chalk.red('\n❌ Validation Errors:'));
        validationErrors.forEach(err => console.log(chalk.gray(`  • ${err}`)));
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(chalk.yellow('\n🔍 DRY RUN MODE'));
      }

      const memories = data.memories || data.memory || [];
      console.log(chalk.blue(`\n📥 Importing ${memories.length} memories...`));

      const results = await importMemories(data, options);

      console.log(chalk.green(`\n✅ Memory import complete:`));
      console.log(`  Imported: ${results.imported}`);
      if (results.errors.length > 0) {
        console.log(chalk.yellow(`  Errors: ${results.errors.length}`));
      }

    } catch (err) {
      spinner.fail('Import failed');
      console.log(chalk.red(`❌ Error: ${err.message}`));
      process.exit(1);
    }
  });

// Validate import file without importing
importer
  .command('validate <file>')
  .description('Validate an import file without importing')
  .action(async (file) => {
    const spinner = ora('Validating file...').start();

    try {
      // Validate file path
      const pathValidation = validateImportFilePath(file);
      if (!pathValidation.valid) {
        spinner.fail(`Security validation failed: ${pathValidation.error}`);
        await logSecurityViolation('IMPORT_PATH_TRAVERSAL_ATTEMPT', {
          file,
          error: pathValidation.error,
        });
        process.exit(1);
      }

      if (!await fs.pathExists(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      // Validate file size
      const sizeValidation = await validateImportFileSize(file);
      if (!sizeValidation.valid) {
        spinner.fail(sizeValidation.error);
        process.exit(1);
      }

      const data = await fs.readJson(file);
      const importType = detectImportType(data);
      const errors = validateImportFile(data, importType);

      if (errors.length === 0) {
        spinner.succeed(`Valid ${importType} import file`);
        console.log(chalk.cyan('\n📋 File Info:'));
        console.log(`  Type: ${importType}`);
        console.log(`  Size: ${formatBytes(sizeValidation.size)}`);
        if (data.version) console.log(`  Version: ${data.version}`);
        if (data.exported_at) console.log(`  Exported: ${data.exported_at}`);
        if (data.config) console.log(`  Config: ${Object.keys(data.config).length} keys`);
        if (data.memories) console.log(`  Memories: ${data.memories.length}`);
        if (data.sessions) console.log(`  Sessions: ${data.sessions.length}`);
      } else {
        spinner.fail('Validation failed');
        console.log(chalk.red('\n❌ Errors:'));
        errors.forEach(err => console.log(chalk.gray(`  • ${err}`)));
        process.exit(1);
      }

    } catch (err) {
      spinner.fail('Validation failed');
      if (err.name === 'SyntaxError') {
        console.log(chalk.red(`❌ Invalid JSON: ${err.message}`));
      } else {
        console.log(chalk.red(`❌ Error: ${err.message}`));
      }
      process.exit(1);
    }
  });

// =============================================================================
// Module Exports
// =============================================================================

module.exports = importer;

// Export security functions for testing
module.exports.validateImportFilePath = validateImportFilePath;
module.exports.validateImportFileSize = validateImportFileSize;
module.exports.MAX_IMPORT_FILE_SIZE = MAX_IMPORT_FILE_SIZE;
module.exports.MAX_IMPORT_ITEMS = MAX_IMPORT_ITEMS;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
