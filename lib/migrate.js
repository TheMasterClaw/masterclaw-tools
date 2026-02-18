/**
 * Database Migration Command for MasterClaw CLI
 * 
 * Provides database migration management via the CLI:
 * - Run pending migrations
 * - Check migration status
 * - Dry-run mode for validation
 * - Create new migration files
 * 
 * @module migrate
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { findInfraDir } = require('./services');
const { wrapCommand, ExitCode } = require('./error-handler');
const { logAuditEvent } = require('./audit');
const rateLimiter = require('./rate-limiter');

const MIGRATE_RATE_LIMIT = { limit: 5, window: 60000 }; // 5 per minute

/**
 * Get the infrastructure directory path
 * @returns {Promise<string|null>} Path to infrastructure directory or null
 */
async function getInfraDir() {
  return await findInfraDir();
}

/**
 * Check if SQLite is available
 * @returns {Promise<boolean>}
 */
async function checkSQLite() {
  return new Promise((resolve) => {
    const proc = spawn('sqlite3', ['--version'], { stdio: 'pipe' });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/**
 * Get database path from environment or defaults
 * @param {string} infraDir - Infrastructure directory
 * @returns {Promise<string>} Database path
 */
async function getDatabasePath(infraDir) {
  const envPath = path.join(infraDir, '.env');
  let dbPath = path.join(infraDir, 'data', 'backend', 'mc.db');

  if (await fs.pathExists(envPath)) {
    const envContent = await fs.readFile(envPath, 'utf-8');
    const match = envContent.match(/DATABASE_PATH=(.+)/);
    if (match) {
      dbPath = match[1].trim();
      // Resolve relative paths
      if (!path.isAbsolute(dbPath)) {
        dbPath = path.join(infraDir, dbPath);
      }
    }
  }

  return dbPath;
}

/**
 * Get current database schema version
 * @param {string} dbPath - Path to database
 * @returns {Promise<number>} Schema version (0 if no migrations table)
 */
async function getSchemaVersion(dbPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('sqlite3', [dbPath, 'SELECT MAX(version) FROM schema_migrations;'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let error = '';

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        const version = parseInt(output.trim(), 10);
        resolve(isNaN(version) ? 0 : version);
      } else if (error.includes('no such table')) {
        resolve(0);
      } else {
        reject(new Error(`Failed to get schema version: ${error}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run sqlite3: ${err.message}`));
    });
  });
}

/**
 * List available migration files
 * @param {string} infraDir - Infrastructure directory
 * @returns {Promise<Array<{version: number, name: string, path: string}>>}
 */
async function listMigrations(infraDir) {
  const migrationsDir = path.join(infraDir, 'services', 'backend', 'migrations');
  
  if (!await fs.pathExists(migrationsDir)) {
    return [];
  }

  const files = await fs.readdir(migrationsDir);
  const migrations = [];

  for (const file of files.sort()) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (match) {
      migrations.push({
        version: parseInt(match[1], 10),
        name: match[2].replace(/_/g, ' '),
        path: path.join(migrationsDir, file)
      });
    }
  }

  return migrations;
}

/**
 * Run a single migration
 * @param {string} dbPath - Database path
 * @param {string} migrationPath - Migration file path
 * @param {number} version - Migration version
 * @param {boolean} dryRun - If true, don't actually apply
 * @returns {Promise<boolean>}
 */
async function runMigration(dbPath, migrationPath, version, dryRun = false) {
  const sql = await fs.readFile(migrationPath, 'utf-8');

  if (dryRun) {
    console.log(chalk.gray(`   Would apply: ${path.basename(migrationPath)}`));
    return true;
  }

  return new Promise((resolve, reject) => {
    // Wrap migration in a transaction
    const transactionSql = `
BEGIN TRANSACTION;
${sql}
INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (${version}, datetime('now'));
COMMIT;
`;

    const proc = spawn('sqlite3', [dbPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let error = '';

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`Migration failed: ${error}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run migration: ${err.message}`));
    });

    proc.stdin.write(transactionSql);
    proc.stdin.end();
  });
}

/**
 * Initialize migrations table if it doesn't exist
 * @param {string} dbPath - Database path
 */
async function initMigrationsTable(dbPath) {
  const sql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

  return new Promise((resolve, reject) => {
    const proc = spawn('sqlite3', [dbPath, sql], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let error = '';

    proc.stderr.on('data', (data) => {
      error += data.toString();
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        reject(new Error(`Failed to init migrations table: ${error}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to run sqlite3: ${err.message}`));
    });
  });
}

/**
 * Run pending migrations
 * @param {Object} options - Command options
 * @returns {Promise<boolean>}
 */
async function runMigrations(options = {}) {
  const infraDir = await getInfraDir();
  if (!infraDir) {
    console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
    console.log(chalk.gray('   Run this command from within the masterclaw-infrastructure directory'));
    return false;
  }

  // Check rate limit
  const rateCheck = rateLimiter.checkRateLimit('migrate', MIGRATE_RATE_LIMIT);
  if (!rateCheck.allowed) {
    console.log(chalk.yellow('⚠️  Rate limit exceeded'));
    console.log(chalk.gray(`   Try again in ${Math.ceil(rateCheck.retryAfter / 1000)}s`));
    return false;
  }

  // Check SQLite availability
  if (!await checkSQLite()) {
    console.log(chalk.red('❌ SQLite3 is not installed'));
    console.log(chalk.gray('   Install SQLite3 to run migrations'));
    return false;
  }

  const dbPath = await getDatabasePath(infraDir);
  const migrations = await listMigrations(infraDir);

  if (migrations.length === 0) {
    console.log(chalk.yellow('⚠️  No migration files found'));
    console.log(chalk.gray(`   Expected migrations in: services/backend/migrations/`));
    return true;
  }

  // Ensure database directory exists
  await fs.ensureDir(path.dirname(dbPath));

  // Initialize migrations table
  await initMigrationsTable(dbPath);

  // Get current version
  const currentVersion = await getSchemaVersion(dbPath);
  
  // Filter pending migrations
  const pending = migrations.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    console.log(chalk.green('✅ Database is up to date'));
    console.log(chalk.gray(`   Schema version: ${currentVersion}`));
    return true;
  }

  console.log(chalk.blue('🗄️  Database Migrations'));
  console.log(chalk.gray(`   Database: ${dbPath}`));
  console.log(chalk.gray(`   Current version: ${currentVersion}`));
  console.log(chalk.gray(`   Pending: ${pending.length} migration(s)`));
  console.log('');

  if (options.dryRun) {
    console.log(chalk.cyan('📋 Dry run mode - no changes will be made'));
    console.log('');
  }

  let applied = 0;
  let failed = 0;

  for (const migration of pending) {
    const prefix = options.dryRun ? chalk.gray('  [DRY]') : '  ';
    process.stdout.write(`${prefix} Applying ${migration.version}: ${migration.name}... `);

    try {
      await runMigration(dbPath, migration.path, migration.version, options.dryRun);
      
      if (!options.dryRun) {
        console.log(chalk.green('✓'));
        logAuditEvent('MIGRATION_APPLY', 'info', {
          version: migration.version,
          name: migration.name,
          dryRun: false
        });
      } else {
        console.log(chalk.gray('(would apply)'));
      }
      applied++;
    } catch (err) {
      console.log(chalk.red('✗'));
      console.log(chalk.red(`   Error: ${err.message}`));
      logAuditEvent('MIGRATION_FAILED', 'error', {
        version: migration.version,
        name: migration.name,
        error: err.message
      });
      failed++;
      
      if (!options.continueOnError) {
        console.log('');
        console.log(chalk.yellow('⚠️  Migration failed. Database may be in an inconsistent state.'));
        return false;
      }
    }
  }

  console.log('');
  
  if (options.dryRun) {
    console.log(chalk.cyan(`📋 Dry run complete: ${applied} migration(s) would be applied`));
  } else if (failed === 0) {
    console.log(chalk.green(`✅ Successfully applied ${applied} migration(s)`));
    const newVersion = await getSchemaVersion(dbPath);
    console.log(chalk.gray(`   New schema version: ${newVersion}`));
  } else {
    console.log(chalk.yellow(`⚠️  Applied ${applied}, failed ${failed} migration(s)`));
  }

  return failed === 0;
}

/**
 * Show migration status
 * @returns {Promise<boolean>}
 */
async function showStatus() {
  const infraDir = await getInfraDir();
  if (!infraDir) {
    console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
    return false;
  }

  // Check SQLite availability
  if (!await checkSQLite()) {
    console.log(chalk.red('❌ SQLite3 is not installed'));
    return false;
  }

  const dbPath = await getDatabasePath(infraDir);
  const migrations = await listMigrations(infraDir);

  console.log(chalk.blue('🗄️  Migration Status'));
  console.log(chalk.gray(`   Database: ${dbPath}`));
  console.log(chalk.gray(`   Migrations directory: services/backend/migrations/`));
  console.log('');

  if (migrations.length === 0) {
    console.log(chalk.yellow('   No migration files found'));
    return true;
  }

  // Ensure migrations table exists
  await initMigrationsTable(dbPath);
  const currentVersion = await getSchemaVersion(dbPath);

  console.log(chalk.gray(`   Current schema version: ${currentVersion || 'None'}`));
  console.log('');

  console.log('   ' + chalk.underline('Migration Files:'));
  console.log('');

  for (const migration of migrations) {
    const status = migration.version <= currentVersion
      ? chalk.green('  ✓ Applied')
      : chalk.yellow('  ○ Pending');
    
    const version = migration.version.toString().padStart(3, '0');
    console.log(`   ${version}  ${migration.name.padEnd(30)} ${status}`);
  }

  const pending = migrations.filter(m => m.version > currentVersion).length;
  console.log('');
  
  if (pending === 0) {
    console.log(chalk.green('✅ Database is up to date'));
  } else {
    console.log(chalk.yellow(`⚠️  ${pending} migration(s) pending`));
    console.log(chalk.gray('   Run: mc migrate'));
  }

  return true;
}

/**
 * Create a new migration file
 * @param {string} name - Migration name
 * @returns {Promise<boolean>}
 */
async function createMigration(name) {
  const infraDir = await getInfraDir();
  if (!infraDir) {
    console.log(chalk.red('❌ MasterClaw infrastructure directory not found'));
    return false;
  }

  const migrationsDir = path.join(infraDir, 'services', 'backend', 'migrations');
  await fs.ensureDir(migrationsDir);

  // Get next version number
  const migrations = await listMigrations(infraDir);
  const nextVersion = migrations.length > 0
    ? Math.max(...migrations.map(m => m.version)) + 1
    : 1;

  // Sanitize name
  const sanitizedName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const filename = `${nextVersion.toString().padStart(3, '0')}_${sanitizedName}.sql`;
  const filepath = path.join(migrationsDir, filename);

  const template = `-- Migration ${nextVersion}: ${name}
-- Created: ${new Date().toISOString()}

-- Add your SQL here:

`;

  await fs.writeFile(filepath, template);

  console.log(chalk.green('✅ Created migration file'));
  console.log(chalk.gray(`   ${filepath}`));
  console.log('');
  console.log(chalk.cyan('   Edit the file and run: mc migrate'));

  logAuditEvent('MIGRATION_CREATE', 'info', {
    version: nextVersion,
    name,
    filename
  });

  return true;
}

// Create the commander program
const migrateProgram = new Command('migrate')
  .description('Database migration management')
  .addHelpText('after', `
Examples:
  mc migrate                    Run pending migrations
  mc migrate status             Show migration status
  mc migrate --dry-run          Preview migrations without applying
  mc migrate create "add users" Create a new migration file
`);

migrateProgram
  .command('run', { isDefault: true })
  .description('Run pending database migrations')
  .option('-d, --dry-run', 'Preview migrations without applying', false)
  .option('-c, --continue-on-error', 'Continue on migration failure', false)
  .action(wrapCommand(async (options) => {
    const success = await runMigrations(options);
    if (!success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'migrate'));

migrateProgram
  .command('status')
  .description('Show migration status')
  .action(wrapCommand(async () => {
    const success = await showStatus();
    if (!success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'migrate-status'));

migrateProgram
  .command('create <name>')
  .description('Create a new migration file')
  .action(wrapCommand(async (name) => {
    const success = await createMigration(name);
    if (!success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'migrate-create'));

module.exports = {
  migrateProgram,
  runMigrations,
  showStatus,
  createMigration
};
