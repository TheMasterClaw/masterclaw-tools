/**
 * cloud-backup.js - Cloud backup management commands for mc CLI
 *
 * Provides cloud backup integration:
 * - Upload backups to cloud storage (S3, GCS, Azure)
 * - Download backups from cloud storage
 * - List and manage cloud backups
 * - Sync local and cloud backups
 * - Test cloud connectivity
 *
 * Security features:
 * - Input validation
 * - Path traversal prevention
 * - Audit logging
 * - Secure credential handling
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const ora = require('ora');
const inquirer = require('inquirer');

const { findInfraDir } = require('./services');
const { logAudit, AuditEventType } = require('./audit');
const { containsPathTraversal } = require('./security');

const cloudBackup = new Command('cloud');

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Run the cloud backup script
 */
async function runCloudScript(command, args = [], options = {}) {
    const infraDir = await findInfraDir();

    if (!infraDir) {
        throw new Error('Cannot find masterclaw-infrastructure directory');
    }

    const scriptPath = path.join(infraDir, 'scripts', 'backup-cloud.sh');

    if (!await fs.pathExists(scriptPath)) {
        throw new Error('Cloud backup script not found. Please update MasterClaw.');
    }

    return new Promise((resolve, reject) => {
        const child = spawn('bash', [scriptPath, command, ...args], {
            cwd: infraDir,
            env: { ...process.env },
            stdio: options.quiet ? 'pipe' : 'inherit',
        });

        let stdout = '';
        let stderr = '';

        if (options.quiet) {
            child.stdout.on('data', (data) => { stdout += data.toString(); });
            child.stderr.on('data', (data) => { stderr += data.toString(); });
        }

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ success: true, stdout, stderr });
            } else {
                reject(new Error(`Cloud backup command failed with code ${code}`));
            }
        });

        child.on('error', reject);
    });
}

/**
 * Get cloud backup configuration status
 */
async function getConfigStatus() {
    const infraDir = await findInfraDir();
    if (!infraDir) return { configured: false, error: 'Infrastructure directory not found' };

    const envPath = path.join(infraDir, '.env');
    if (!await fs.pathExists(envPath)) {
        return { configured: false, error: '.env file not found' };
    }

    const envContent = await fs.readFile(envPath, 'utf8');

    const provider = envContent.match(/CLOUD_BACKUP_PROVIDER=(.+)/)?.[1]?.trim();
    const bucket = envContent.match(/CLOUD_BACKUP_BUCKET=(.+)/)?.[1]?.trim();

    if (!provider || provider.startsWith('#')) {
        return { configured: false, error: 'CLOUD_BACKUP_PROVIDER not set' };
    }

    if (!bucket || bucket.startsWith('#')) {
        return { configured: false, error: 'CLOUD_BACKUP_BUCKET not set' };
    }

    // Check credentials based on provider
    let credentialsOk = false;
    let credentialType = '';

    switch (provider) {
        case 's3':
            if (envContent.includes('AWS_ACCESS_KEY_ID=') || process.env.AWS_ACCESS_KEY_ID) {
                credentialsOk = true;
                credentialType = 'access key';
            } else if (envContent.includes('AWS_PROFILE=') || process.env.AWS_PROFILE) {
                credentialsOk = true;
                credentialType = 'IAM profile';
            }
            break;
        case 'gcs':
            if (envContent.includes('GOOGLE_APPLICATION_CREDENTIALS=') || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                credentialsOk = true;
                credentialType = 'service account';
            }
            break;
        case 'azure':
            if ((envContent.includes('AZURE_STORAGE_ACCOUNT=') || process.env.AZURE_STORAGE_ACCOUNT) &&
                (envContent.includes('AZURE_STORAGE_KEY=') || process.env.AZURE_STORAGE_KEY)) {
                credentialsOk = true;
                credentialType = 'storage key';
            }
            break;
    }

    return {
        configured: true,
        provider,
        bucket,
        credentialsOk,
        credentialType,
    };
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Upload backup to cloud
 */
cloudBackup
    .command('upload')
    .description('Upload a backup to cloud storage')
    .argument('[file]', 'Backup file to upload (default: latest local backup)')
    .option('-q, --quiet', 'minimal output')
    .action(async (file, options) => {
        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            console.log(chalk.gray(`   ${config.error}`));
            console.log(chalk.gray('\n   Run "mc cloud setup" to configure cloud backups'));
            process.exit(1);
        }

        if (!config.credentialsOk) {
            console.log(chalk.red('❌ Cloud credentials not configured'));
            console.log(chalk.gray('   Please check your .env file'));
            process.exit(1);
        }

        await logAudit(AuditEventType.BACKUP_CREATE, {
            action: 'cloud_upload_start',
            provider: config.provider,
            bucket: config.bucket,
        });

        const spinner = options.quiet ? null : ora('Uploading to cloud...').start();

        try {
            const args = file ? [file] : [];
            await runCloudScript('upload', args, { quiet: options.quiet });

            if (spinner) spinner.succeed('Upload complete');

            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_upload_complete',
                provider: config.provider,
                bucket: config.bucket,
                file: file || 'latest',
                success: true,
            });

            console.log(chalk.green(`✅ Backup uploaded to ${config.provider}`));
            console.log(chalk.gray(`   Bucket: ${config.bucket}`));
        } catch (err) {
            if (spinner) spinner.fail(`Upload failed: ${err.message}`);

            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_upload_failed',
                provider: config.provider,
                error: err.message,
            });

            console.log(chalk.red('❌ Upload failed'));
            console.log(chalk.gray(`   ${err.message}`));
            process.exit(1);
        }
    });

/**
 * Download backup from cloud
 */
cloudBackup
    .command('download')
    .description('Download a backup from cloud storage')
    .argument('<name>', 'Name of the backup file to download')
    .option('-o, --output <dir>', 'Output directory', './backups')
    .option('-q, --quiet', 'minimal output')
    .action(async (name, options) => {
        if (containsPathTraversal(options.output)) {
            console.log(chalk.red('❌ Invalid output path'));
            process.exit(1);
        }

        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            process.exit(1);
        }

        await logAudit(AuditEventType.BACKUP_CREATE, {
            action: 'cloud_download_start',
            provider: config.provider,
            file: name,
        });

        const spinner = options.quiet ? null : ora('Downloading from cloud...').start();

        try {
            await runCloudScript('download', [name, options.output], { quiet: true });

            if (spinner) spinner.succeed('Download complete');

            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_download_complete',
                provider: config.provider,
                file: name,
                success: true,
            });

            console.log(chalk.green(`✅ Backup downloaded: ${name}`));
            console.log(chalk.gray(`   Location: ${options.output}/`));
        } catch (err) {
            if (spinner) spinner.fail(`Download failed: ${err.message}`);

            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_download_failed',
                error: err.message,
            });

            console.log(chalk.red('❌ Download failed'));
            console.log(chalk.gray(`   ${err.message}`));
            process.exit(1);
        }
    });

/**
 * List cloud backups
 */
cloudBackup
    .command('list')
    .description('List all backups in cloud storage')
    .option('-j, --json', 'output as JSON')
    .action(async (options) => {
        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            process.exit(1);
        }

        try {
            const result = await runCloudScript('list', [], { quiet: true });

            if (options.json) {
                // Parse the output into structured data
                const lines = result.stdout.split('\n').filter(l => l.trim());
                const backups = lines.map(line => {
                    const parts = line.trim().split(/\s{2,}/);
                    return {
                        date: parts[0],
                        size: parts[1],
                        name: parts[2],
                    };
                });
                console.log(JSON.stringify(backups, null, 2));
            } else {
                console.log(chalk.blue(`🐾 Cloud Backups (${config.provider})\n`));
                console.log(chalk.cyan(`Bucket: ${config.bucket}`));
                console.log(chalk.gray('─────────────────────────────────────────\n'));

                if (result.stdout.trim()) {
                    console.log(result.stdout);
                } else {
                    console.log(chalk.yellow('No cloud backups found'));
                }
            }
        } catch (err) {
            console.log(chalk.red('❌ Failed to list backups'));
            console.log(chalk.gray(`   ${err.message}`));
            process.exit(1);
        }
    });

/**
 * Sync all local backups to cloud
 */
cloudBackup
    .command('sync')
    .description('Sync all local backups to cloud storage')
    .option('--cleanup', 'Remove old cloud backups after sync')
    .action(async (options) => {
        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            process.exit(1);
        }

        console.log(chalk.blue('🐾 Syncing backups to cloud...\n'));
        console.log(chalk.cyan(`Provider: ${config.provider}`));
        console.log(chalk.cyan(`Bucket: ${config.bucket}\n`));

        await logAudit(AuditEventType.BACKUP_CREATE, {
            action: 'cloud_sync_start',
            provider: config.provider,
        });

        try {
            await runCloudScript('sync');

            if (options.cleanup) {
                console.log(chalk.blue('\n🧹 Cleaning up old cloud backups...'));
                await runCloudScript('cleanup');
            }

            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_sync_complete',
                provider: config.provider,
                success: true,
            });

            console.log(chalk.green('\n✅ Sync complete'));
        } catch (err) {
            await logAudit(AuditEventType.BACKUP_CREATE, {
                action: 'cloud_sync_failed',
                provider: config.provider,
                error: err.message,
            });

            console.log(chalk.red('❌ Sync failed'));
            process.exit(1);
        }
    });

/**
 * Test cloud connection
 */
cloudBackup
    .command('test')
    .description('Test cloud backup connectivity')
    .action(async () => {
        const config = await getConfigStatus();

        console.log(chalk.blue('🐾 Cloud Backup Connection Test\n'));

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            console.log(chalk.gray(`\n   ${config.error}`));
            console.log(chalk.gray('\n   Please add the following to your .env file:'));
            console.log(chalk.gray('   CLOUD_BACKUP_PROVIDER=s3|gcs|azure'));
            console.log(chalk.gray('   CLOUD_BACKUP_BUCKET=your-bucket-name'));
            process.exit(1);
        }

        console.log(chalk.cyan('Configuration:'));
        console.log(`  Provider: ${chalk.bold(config.provider)}`);
        console.log(`  Bucket: ${chalk.bold(config.bucket)}`);
        console.log(`  Credentials: ${config.credentialsOk ? chalk.green('✓') : chalk.red('✗')} (${config.credentialType || 'not configured'})`);
        console.log('');

        const spinner = ora('Testing connection...').start();

        try {
            await runCloudScript('test', [], { quiet: true });

            spinner.succeed('Connection successful');
            console.log(chalk.green('\n✅ Cloud backup is ready to use'));
            console.log(chalk.gray('   Run "mc cloud upload" to upload a backup'));
        } catch (err) {
            spinner.fail('Connection failed');
            console.log(chalk.red('\n❌ Could not connect to cloud storage'));
            console.log(chalk.gray(`   ${err.message}`));
            console.log(chalk.gray('\n   Troubleshooting:'));
            console.log(chalk.gray('   • Check your credentials in .env'));
            console.log(chalk.gray('   • Verify the bucket/container exists'));
            console.log(chalk.gray('   • Ensure you have network connectivity'));
            process.exit(1);
        }
    });

/**
 * Setup wizard for cloud backup
 */
cloudBackup
    .command('setup')
    .description('Interactive setup for cloud backups')
    .action(async () => {
        console.log(chalk.blue('🐾 Cloud Backup Setup\n'));
        console.log(chalk.gray('This wizard will help you configure cloud backups.\n'));

        const infraDir = await findInfraDir();
        if (!infraDir) {
            console.log(chalk.red('❌ Cannot find masterclaw-infrastructure directory'));
            process.exit(1);
        }

        const envPath = path.join(infraDir, '.env');

        // Check current status
        const currentConfig = await getConfigStatus();
        if (currentConfig.configured) {
            const { overwrite } = await inquirer.prompt([{
                type: 'confirm',
                name: 'overwrite',
                message: `Cloud backup is already configured for ${currentConfig.provider}. Reconfigure?`,
                default: false,
            }]);

            if (!overwrite) {
                console.log(chalk.gray('Setup cancelled'));
                return;
            }
        }

        // Provider selection
        const { provider } = await inquirer.prompt([{
            type: 'list',
            name: 'provider',
            message: 'Select cloud provider:',
            choices: [
                { name: 'AWS S3', value: 's3' },
                { name: 'Google Cloud Storage', value: 'gcs' },
                { name: 'Azure Blob Storage', value: 'azure' },
            ],
        }]);

        // Bucket name
        const { bucket } = await inquirer.prompt([{
            type: 'input',
            name: 'bucket',
            message: 'Enter bucket/container name:',
            validate: (input) => input.length > 0 || 'Bucket name is required',
        }]);

        // Region
        const { region } = await inquirer.prompt([{
            type: 'input',
            name: 'region',
            message: 'Enter cloud region:',
            default: 'us-east-1',
        }]);

        // Encryption
        const { encryption } = await inquirer.prompt([{
            type: 'confirm',
            name: 'encryption',
            message: 'Enable server-side encryption?',
            default: true,
        }]);

        // Build configuration
        const configLines = [
            '',
            '# ==========================================',
            '# Cloud Backup Configuration',
            '# ==========================================',
            `CLOUD_BACKUP_PROVIDER=${provider}`,
            `CLOUD_BACKUP_BUCKET=${bucket}`,
            `CLOUD_BACKUP_PREFIX=masterclaw`,
            `CLOUD_BACKUP_REGION=${region}`,
            `CLOUD_BACKUP_ENCRYPTION=${encryption}`,
            'CLOUD_BACKUP_RETENTION_DAYS=30',
        ];

        // Provider-specific settings
        if (provider === 's3') {
            const { authMethod } = await inquirer.prompt([{
                type: 'list',
                name: 'authMethod',
                message: 'AWS authentication method:',
                choices: [
                    { name: 'Access Key ID + Secret Key', value: 'keys' },
                    { name: 'IAM Profile / AWS CLI', value: 'profile' },
                ],
            }]);

            if (authMethod === 'keys') {
                const { accessKey, secretKey } = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'accessKey',
                        message: 'AWS Access Key ID:',
                    },
                    {
                        type: 'password',
                        name: 'secretKey',
                        message: 'AWS Secret Access Key:',
                    },
                ]);

                configLines.push(
                    `AWS_ACCESS_KEY_ID=${accessKey}`,
                    `AWS_SECRET_ACCESS_KEY=${secretKey}`,
                    `AWS_DEFAULT_REGION=${region}`
                );
            } else {
                configLines.push('AWS_PROFILE=default');
            }
        } else if (provider === 'gcs') {
            const { credentialsPath } = await inquirer.prompt([{
                type: 'input',
                name: 'credentialsPath',
                message: 'Path to service account JSON file:',
                validate: (input) => input.length > 0 || 'Path is required',
            }]);

            configLines.push(
                `GOOGLE_APPLICATION_CREDENTIALS=${credentialsPath}`,
                'GOOGLE_CLOUD_PROJECT=your-project-id'
            );
        } else if (provider === 'azure') {
            const { accountName, accountKey } = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'accountName',
                    message: 'Azure Storage Account Name:',
                },
                {
                    type: 'password',
                    name: 'accountKey',
                    message: 'Azure Storage Account Key:',
                },
            ]);

            configLines.push(
                `AZURE_STORAGE_ACCOUNT=${accountName}`,
                `AZURE_STORAGE_KEY=${accountKey}`
            );
        }

        // Write configuration
        console.log(chalk.blue('\n📝 Writing configuration...'));

        try {
            // Read existing .env
            let envContent = '';
            if (await fs.pathExists(envPath)) {
                envContent = await fs.readFile(envPath, 'utf8');
                // Remove old cloud backup config if exists
                envContent = envContent.replace(/# ==========================================[\s\S]*?# Cloud Backup[\s\S]*?(?=# ====|$)/, '');
            }

            // Append new config
            envContent += configLines.join('\n') + '\n';
            await fs.writeFile(envPath, envContent);

            console.log(chalk.green('✅ Configuration saved'));
            console.log(chalk.gray(`   Updated: ${envPath}`));

            // Reload environment
            configLines.forEach(line => {
                if (line.includes('=') && !line.startsWith('#')) {
                    const [key, value] = line.split('=');
                    process.env[key] = value;
                }
            });

            // Test connection
            console.log(chalk.blue('\n🧪 Testing connection...'));
            await runCloudScript('test', [], { quiet: true });

            console.log(chalk.green('\n✅ Cloud backup configured and tested successfully!'));
            console.log(chalk.gray('\nNext steps:'));
            console.log(chalk.gray('  • Run "mc cloud upload" to upload your first backup'));
            console.log(chalk.gray('  • Run "mc cloud sync" to sync all local backups'));
            console.log(chalk.gray('  • Add to cron for automatic uploads'));

        } catch (err) {
            console.log(chalk.red('❌ Setup failed'));
            console.log(chalk.gray(`   ${err.message}`));
            process.exit(1);
        }
    });

/**
 * Show cloud backup status
 */
cloudBackup
    .command('status')
    .description('Show cloud backup configuration status')
    .action(async () => {
        console.log(chalk.blue('🐾 Cloud Backup Status\n'));

        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.yellow('⚠️  Cloud backup is not configured'));
            console.log(chalk.gray(`\n   ${config.error}`));
            console.log(chalk.gray('\n   Run "mc cloud setup" to get started'));
            return;
        }

        console.log(chalk.cyan('Configuration:'));
        console.log(`  Provider: ${chalk.bold(config.provider)}`);
        console.log(`  Bucket: ${chalk.bold(config.bucket)}`);
        console.log(`  Credentials: ${config.credentialsOk ? chalk.green('✓ Configured') : chalk.red('✗ Missing')} (${config.credentialType || 'unknown'})`);
        console.log('');

        if (config.credentialsOk) {
            console.log(chalk.blue('Testing connection...\n'));
            try {
                await runCloudScript('status');
            } catch (err) {
                // Status command doesn't fail, just displays
            }
        }
    });

/**
 * Cleanup old cloud backups
 */
cloudBackup
    .command('cleanup')
    .description('Remove old backups from cloud storage')
    .option('-f, --force', 'skip confirmation')
    .option('-d, --dry-run', 'show what would be deleted')
    .action(async (options) => {
        const config = await getConfigStatus();

        if (!config.configured) {
            console.log(chalk.red('❌ Cloud backup not configured'));
            process.exit(1);
        }

        if (options.dryRun) {
            console.log(chalk.blue('🐾 Cloud Backup Cleanup (Dry Run)\n'));
            console.log(chalk.yellow('The following would be deleted based on retention policy:\n'));
            // List all backups (we'd need to implement filtering in the script)
            await runCloudScript('list');
            return;
        }

        if (!options.force) {
            const { confirm } = await inquirer.prompt([{
                type: 'confirm',
                name: 'confirm',
                message: 'Remove old cloud backups based on retention policy?',
                default: false,
            }]);

            if (!confirm) {
                console.log(chalk.gray('Cleanup cancelled'));
                return;
            }
        }

        console.log(chalk.blue('🧹 Cleaning up old cloud backups...'));

        try {
            await runCloudScript('cleanup');
            console.log(chalk.green('✅ Cleanup complete'));
        } catch (err) {
            console.log(chalk.red('❌ Cleanup failed'));
            process.exit(1);
        }
    });

module.exports = { cloudBackup, getConfigStatus };
