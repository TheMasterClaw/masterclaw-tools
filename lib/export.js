/**
 * export.js - Export data from MasterClaw
 *
 * Complements the import command to enable data portability:
 * - Export configuration to JSON files
 * - Export memories for backup
 * - Export sessions for migration
 * - Full system export (config + memories + sessions)
 *
 * Security Features:
 * - Sensitive values are masked by default (tokens, passwords)
 * - Path traversal protection prevents writing outside intended directories
 * - File size validation for exported data
 * - Security audit logging for all export operations
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const ora = require('ora');
const axios = require('axios');
const config = require('./config');
const { logAudit, AuditEventType, logSecurityViolation } = require('./audit');

// Import security utilities
const { containsPathTraversal } = require('./security');

const exporter = new Command('export');

// =============================================================================
// Export Utilities
// =============================================================================

/**
 * Mask sensitive values in exported data
 * @param {any} value - Value to mask
 * @param {string} key - Key name
 * @returns {any} - Masked value
 */
function maskSensitiveValue(value, key) {
  const sensitiveKeys = [
    'token', 'api_key', 'apikey', 'password', 'secret', 'auth',
    'gateway_token', 'openai_api_key', 'anthropic_api_key'
  ];

  const keyLower = key.toLowerCase();
  const isSensitive = sensitiveKeys.some(sk => keyLower.includes(sk));

  if (isSensitive && typeof value === 'string' && value.length > 8) {
    return `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
  }

  return value;
}

/**
 * Deep mask sensitive values in an object
 * @param {Object} obj - Object to process
 * @returns {Object} - Processed object with masked values
 */
function deepMaskSensitive(obj) {
  if (Array.isArray(obj)) {
    return obj.map(item => deepMaskSensitive(item));
  }

  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value && typeof value === 'object') {
        result[key] = deepMaskSensitive(value);
      } else {
        result[key] = maskSensitiveValue(value, key);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Bytes to format
 * @returns {string} - Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))  } ${  sizes[i]}`;
}

/**
 * Get API client with authentication
 * @returns {Object} - Axios instance
 */
function getApiClient() {
  const gatewayUrl = config.get('gateway.url', 'http://localhost:3000');
  const gatewayToken = config.get('gateway.token');

  const headers = {};
  if (gatewayToken) {
    headers['Authorization'] = `Bearer ${gatewayToken}`;
  }

  return axios.create({
    baseURL: gatewayUrl,
    headers,
    timeout: 30000,
  });
}

// =============================================================================
// Security Constants
// =============================================================================

/** Maximum export file size (100MB) to prevent disk exhaustion */
const MAX_EXPORT_FILE_SIZE = 100 * 1024 * 1024;

/** Allowed file extensions for export files */
const ALLOWED_EXTENSIONS = new Set(['.json']);

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates an export file path for security issues
 * Prevents path traversal attacks that could write to arbitrary locations
 *
 * @param {string} filePath - File path to validate
 * @returns {Object} - Validation result { valid: boolean, error?: string }
 */
function validateExportFilePath(filePath) {
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
 * Validates export data size to prevent disk exhaustion
 *
 * @param {Object} data - Data to be exported
 * @returns {Object} - Validation result
 */
function validateExportDataSize(data) {
  try {
    const jsonSize = JSON.stringify(data).length;

    if (jsonSize > MAX_EXPORT_FILE_SIZE) {
      return {
        valid: false,
        error: `Export data too large (${formatBytes(jsonSize)}). Maximum: ${formatBytes(MAX_EXPORT_FILE_SIZE)}`,
      };
    }

    return { valid: true, size: jsonSize };
  } catch (err) {
    return { valid: false, error: `Failed to calculate export size: ${err.message}` };
  }
}

// =============================================================================
// Export Functions
// =============================================================================

/**
 * Export configuration
 * @param {Object} options - Export options
 * @returns {Promise<Object>} - Export result
 */
async function exportConfig(options = {}) {
  const spinner = ora('Reading configuration...').start();

  try {
    // Get all config values
    const allConfig = config.list();

    // Mask sensitive values unless explicitly requested
    const exportData = options.noMask ? allConfig : deepMaskSensitive(allConfig);

    spinner.succeed('Configuration loaded');

    return {
      success: true,
      data: exportData,
      count: Object.keys(exportData).length,
    };
  } catch (error) {
    spinner.fail(`Failed to export config: ${error.message}`);
    throw error;
  }
}

/**
 * Export memories from the API
 * @param {Object} options - Export options
 * @returns {Promise<Object>} - Export result
 */
async function exportMemories(options = {}) {
  const spinner = ora('Fetching memories from API...').start();

  try {
    const api = getApiClient();

    // Try to get memories via API
    let memories = [];

    try {
      // First try the memory search endpoint
      const response = await api.post('/v1/memory/search', {
        query: '',
        top_k: options.limit || 1000,
      });

      memories = response.data.results || [];
    } catch (apiError) {
      // If API fails, try to get from local memory if available
      spinner.text = 'API unavailable, checking local storage...';

      const memoryPath = path.join(process.cwd(), 'data', 'memories.json');
      if (await fs.pathExists(memoryPath)) {
        const localData = await fs.readJson(memoryPath);
        memories = localData.memories || localData || [];
      } else {
        throw new Error('Memory API unavailable and no local storage found');
      }
    }

    spinner.succeed(`Fetched ${memories.length} memories`);

    return {
      success: true,
      data: memories,
      count: memories.length,
    };
  } catch (error) {
    spinner.fail(`Failed to export memories: ${error.message}`);
    throw error;
  }
}

/**
 * Export sessions from the API
 * @param {Object} options - Export options
 * @returns {Promise<Object>} - Export result
 */
async function exportSessions(options = {}) {
  const spinner = ora('Fetching sessions from API...').start();

  try {
    const api = getApiClient();

    let sessions = [];

    try {
      // Get session list
      const response = await api.get('/v1/sessions', {
        params: { limit: options.limit || 500 },
      });

      const sessionList = response.data.sessions || [];

      // For each session, get full history if requested
      if (options.includeMessages) {
        spinner.text = `Fetching details for ${sessionList.length} sessions...`;

        for (const session of sessionList) {
          try {
            const historyResponse = await api.get(`/v1/sessions/${session.session_id}`);
            sessions.push({
              ...session,
              messages: historyResponse.data.messages || [],
            });
          } catch (e) {
            // If we can't get history, just include basic info
            sessions.push(session);
          }
        }
      } else {
        sessions = sessionList;
      }
    } catch (apiError) {
      spinner.text = 'API unavailable, checking local storage...';

      // Try to get from local storage
      const sessionsPath = path.join(process.cwd(), 'data', 'sessions.json');
      if (await fs.pathExists(sessionsPath)) {
        const localData = await fs.readJson(sessionsPath);
        sessions = localData.sessions || localData || [];
      } else {
        throw new Error('Session API unavailable and no local storage found');
      }
    }

    spinner.succeed(`Fetched ${sessions.length} sessions`);

    return {
      success: true,
      data: sessions,
      count: sessions.length,
    };
  } catch (error) {
    spinner.fail(`Failed to export sessions: ${error.message}`);
    throw error;
  }
}

/**
 * Perform full system export
 * @param {Object} options - Export options
 * @returns {Promise<Object>} - Export result
 */
async function exportFull(options = {}) {
  const results = {
    version: '1.0',
    exported_at: new Date().toISOString(),
    system: {
      hostname: require('os').hostname(),
      platform: process.platform,
      node_version: process.version,
    },
  };

  // Export config
  console.log(chalk.blue('\n📋 Exporting configuration...'));
  const configResult = await exportConfig(options);
  if (configResult.success) {
    results.config = configResult.data;
    console.log(chalk.green(`  ✓ ${configResult.count} config values`));
  }

  // Export memories
  console.log(chalk.blue('\n🧠 Exporting memories...'));
  const memoryResult = await exportMemories(options);
  if (memoryResult.success) {
    results.memories = memoryResult.data;
    console.log(chalk.green(`  ✓ ${memoryResult.count} memories`));
  }

  // Export sessions
  console.log(chalk.blue('\n💬 Exporting sessions...'));
  const sessionResult = await exportSessions(options);
  if (sessionResult.success) {
    results.sessions = sessionResult.data;
    console.log(chalk.green(`  ✓ ${sessionResult.count} sessions`));
  }

  return {
    success: true,
    data: results,
    summary: {
      config_count: configResult.count || 0,
      memory_count: memoryResult.count || 0,
      session_count: sessionResult.count || 0,
    },
  };
}

/**
 * Write export to file
 * @param {Object} data - Data to write
 * @param {string} outputPath - Output file path
 * @param {Object} options - Write options
 * @returns {Promise<Object>} - Write result
 */
async function writeExportFile(data, outputPath, options = {}) {
  const spinner = ora(`Writing to ${outputPath}...`).start();

  try {
    // Security: Validate file path for path traversal
    const pathValidation = validateExportFilePath(outputPath);
    if (!pathValidation.valid) {
      spinner.fail(`Security validation failed: ${pathValidation.error}`);
      await logSecurityViolation('EXPORT_PATH_TRAVERSAL_ATTEMPT', {
        file: outputPath,
        error: pathValidation.error,
      });
      throw new Error(`Invalid export path: ${pathValidation.error}`);
    }

    // Security: Validate data size to prevent disk exhaustion
    const sizeValidation = validateExportDataSize(data);
    if (!sizeValidation.valid) {
      spinner.fail(sizeValidation.error);
      throw new Error(sizeValidation.error);
    }

    // Ensure directory exists
    await fs.ensureDir(path.dirname(outputPath));

    // Write with proper formatting
    const json = options.compact
      ? JSON.stringify(data)
      : JSON.stringify(data, null, 2);

    await fs.writeFile(outputPath, json, 'utf8');

    // Get file stats
    const stats = await fs.stat(outputPath);

    spinner.succeed(`Export written to ${outputPath}`);

    return {
      success: true,
      path: outputPath,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
    };
  } catch (error) {
    spinner.fail(`Failed to write export: ${error.message}`);
    throw error;
  }
}

// =============================================================================
// Export Commands
// =============================================================================

// Config export command
exporter
  .command('config [output]')
  .description('Export configuration to JSON file')
  .option('-m, --no-mask', 'Do not mask sensitive values (security risk)')
  .option('-p, --pretty', 'Pretty-print JSON output', true)
  .action(async (output, options) => {
    console.log(chalk.blue('📤 Exporting Configuration\n'));

    try {
      const result = await exportConfig(options);

      if (output) {
        const writeResult = await writeExportFile(result.data, output, { compact: !options.pretty });

        console.log(chalk.green('\n✅ Export complete:'));
        console.log(`  File: ${writeResult.path}`);
        console.log(`  Size: ${writeResult.sizeFormatted}`);
        console.log(`  Config values: ${result.count}`);

        if (!options.noMask) {
          console.log(chalk.gray('\n  (Sensitive values have been masked)'));
        }

        await logAudit(AuditEventType.CONFIG_READ, {
          action: 'export',
          output: writeResult.path,
          masked: !options.noMask,
        });
      } else {
        // Output to stdout
        const json = options.pretty
          ? JSON.stringify(result.data, null, 2)
          : JSON.stringify(result.data);
        console.log(json);
      }
    } catch (error) {
      console.error(chalk.red(`\n❌ Export failed: ${error.message}`));
      process.exit(1);
    }
  });

// Memory export command
exporter
  .command('memory [output]')
  .description('Export memories to JSON file')
  .option('-l, --limit <n>', 'Maximum memories to export', '1000')
  .option('-p, --pretty', 'Pretty-print JSON output', true)
  .action(async (output, options) => {
    console.log(chalk.blue('🧠 Exporting Memories\n'));

    try {
      options.limit = parseInt(options.limit, 10);
      const result = await exportMemories(options);

      if (output) {
        const writeResult = await writeExportFile(result.data, output, { compact: !options.pretty });

        console.log(chalk.green('\n✅ Export complete:'));
        console.log(`  File: ${writeResult.path}`);
        console.log(`  Size: ${writeResult.sizeFormatted}`);
        console.log(`  Memories: ${result.count}`);

        await logAudit(AuditEventType.BACKUP_CREATE, {
          action: 'export_memories',
          output: writeResult.path,
          count: result.count,
        });
      } else {
        const json = options.pretty
          ? JSON.stringify(result.data, null, 2)
          : JSON.stringify(result.data);
        console.log(json);
      }
    } catch (error) {
      console.error(chalk.red(`\n❌ Export failed: ${error.message}`));
      process.exit(1);
    }
  });

// Sessions export command
exporter
  .command('sessions [output]')
  .description('Export sessions to JSON file')
  .option('-l, --limit <n>', 'Maximum sessions to export', '500')
  .option('--include-messages', 'Include full message history for each session')
  .option('-p, --pretty', 'Pretty-print JSON output', true)
  .action(async (output, options) => {
    console.log(chalk.blue('💬 Exporting Sessions\n'));

    try {
      options.limit = parseInt(options.limit, 10);
      const result = await exportSessions(options);

      if (output) {
        const writeResult = await writeExportFile(result.data, output, { compact: !options.pretty });

        console.log(chalk.green('\n✅ Export complete:'));
        console.log(`  File: ${writeResult.path}`);
        console.log(`  Size: ${writeResult.sizeFormatted}`);
        console.log(`  Sessions: ${result.count}`);

        await logAudit(AuditEventType.BACKUP_CREATE, {
          action: 'export_sessions',
          output: writeResult.path,
          count: result.count,
          include_messages: options.includeMessages,
        });
      } else {
        const json = options.pretty
          ? JSON.stringify(result.data, null, 2)
          : JSON.stringify(result.data);
        console.log(json);
      }
    } catch (error) {
      console.error(chalk.red(`\n❌ Export failed: ${error.message}`));
      process.exit(1);
    }
  });

// Full export command
exporter
  .command('all [output]')
  .description('Export everything (config + memories + sessions)')
  .option('-m, --no-mask', 'Do not mask sensitive values (security risk)')
  .option('-l, --limit <n>', 'Maximum items to export per category', '1000')
  .option('--include-messages', 'Include full message history for sessions')
  .option('-p, --pretty', 'Pretty-print JSON output', true)
  .action(async (output, options) => {
    console.log(chalk.blue('📦 Full System Export\n'));
    console.log(chalk.gray('This will export config, memories, and sessions.\n'));

    try {
      options.limit = parseInt(options.limit, 10);
      const result = await exportFull(options);

      // Generate default filename if not provided
      if (!output) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        output = `masterclaw-export-${timestamp}.json`;
      }

      const writeResult = await writeExportFile(result.data, output, { compact: !options.pretty });

      console.log(chalk.green('\n✅ Full export complete!'));
      console.log(chalk.cyan('\n📊 Summary:'));
      console.log(`  File: ${chalk.bold(writeResult.path)}`);
      console.log(`  Size: ${writeResult.sizeFormatted}`);
      console.log(`  Config values: ${result.summary.config_count}`);
      console.log(`  Memories: ${result.summary.memory_count}`);
      console.log(`  Sessions: ${result.summary.session_count}`);

      if (!options.noMask) {
        console.log(chalk.gray('\n  (Sensitive values have been masked)'));
      }

      console.log(chalk.gray(`\n  Import with: mc import all ${writeResult.path}`));

      await logAudit(AuditEventType.BACKUP_CREATE, {
        action: 'export_full',
        output: writeResult.path,
        summary: result.summary,
        masked: !options.noMask,
      });
    } catch (error) {
      console.error(chalk.red(`\n❌ Export failed: ${error.message}`));
      process.exit(1);
    }
  });

// Default action (show help)
exporter.action(() => {
  exporter.help();
});

module.exports = exporter;

// Export security functions for testing
module.exports.validateExportFilePath = validateExportFilePath;
module.exports.validateExportDataSize = validateExportDataSize;
module.exports.MAX_EXPORT_FILE_SIZE = MAX_EXPORT_FILE_SIZE;
module.exports.ALLOWED_EXTENSIONS = ALLOWED_EXTENSIONS;
