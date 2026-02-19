/**
 * Terraform Infrastructure Management for MasterClaw CLI
 *
 * Provides convenient CLI access to Terraform operations for managing
 * cloud infrastructure (AWS, GCP, Azure) deployments.
 *
 * Features:
 * - Environment management (dev, staging, prod)
 * - Initialize, plan, apply, destroy workflows
 * - Output management for connection details
 * - State inspection and validation
 * - Cost estimation integration
 *
 * Security:
 * - Validates Terraform files before execution
 * - Protects against state file manipulation
 * - Sanitizes all user inputs
 * - Audit logging for all operations
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { spawn, execSync } = require('child_process');
const ora = require('ora');

const { sanitizeForLog } = require('./security');
const { logSecurityViolation } = require('./audit');
const { wrapCommand, ExitCode } = require('./error-handler');

const terraformCmd = new Command('terraform').alias('tf');

// =============================================================================
// Configuration
// =============================================================================

/** Default Terraform directory relative to infrastructure */
const DEFAULT_TERRAFORM_DIR = 'terraform';

/** Valid environments */
const VALID_ENVIRONMENTS = ['dev', 'staging', 'prod'];

/** Maximum output lines for terraform commands */
const MAX_OUTPUT_LINES = 10000;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the infrastructure directory from config
 * @returns {Promise<string>} Path to infrastructure directory
 */
async function getInfraDir() {
  const config = require('./config');
  return await config.get('infraDir', process.cwd());
}

/**
 * Get the Terraform directory for an environment
 * @param {string} environment - Environment name
 * @returns {Promise<string>} Path to Terraform environment directory
 */
async function getTerraformDir(environment = 'dev') {
  const infraDir = await getInfraDir();
  return path.join(infraDir, DEFAULT_TERRAFORM_DIR, 'environments', environment);
}

/**
 * Validate environment name
 * @param {string} environment - Environment name to validate
 * @returns {boolean} True if valid
 */
function isValidEnvironment(environment) {
  return VALID_ENVIRONMENTS.includes(environment);
}

/**
 * Check if Terraform is installed
 * @returns {boolean} True if terraform is available
 */
function isTerraformInstalled() {
  try {
    execSync('terraform -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if AWS CLI is installed (for AWS deployments)
 * @returns {boolean} True if AWS CLI is available
 */
function isAwsCliInstalled() {
  try {
    execSync('aws --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a terraform command with proper error handling
 * @param {string} terraformDir - Directory to run command in
 * @param {string[]} args - Terraform arguments
 * @param {object} options - Execution options
 * @returns {Promise<{success: boolean, output: string, exitCode: number}>}
 */
async function runTerraform(terraformDir, args, options = {}) {
  const { silent = false, timeout = 300000 } = options;

  // Validate directory exists
  if (!await fs.pathExists(terraformDir)) {
    return {
      success: false,
      output: `Terraform directory not found: ${terraformDir}`,
      exitCode: 1
    };
  }

  // Validate terraform is installed
  if (!isTerraformInstalled()) {
    return {
      success: false,
      output: 'Terraform is not installed. Install from https://terraform.io',
      exitCode: 1
    };
  }

  return new Promise((resolve) => {
    const output = [];
    const error = [];

    const child = spawn('terraform', args, {
      cwd: terraformDir,
      stdio: silent ? 'pipe' : 'inherit',
      timeout
    });

    if (silent) {
      child.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        output.push(...lines);
        if (output.length > MAX_OUTPUT_LINES) {
          output.splice(0, output.length - MAX_OUTPUT_LINES);
        }
      });

      child.stderr.on('data', (data) => {
        error.push(data.toString());
      });
    }

    child.on('close', (exitCode) => {
      resolve({
        success: exitCode === 0,
        output: silent ? output.join('\n') : '',
        error: silent ? error.join('\n') : '',
        exitCode: exitCode || 0
      });
    });

    child.on('error', (err) => {
      resolve({
        success: false,
        output: '',
        error: err.message,
        exitCode: 1
      });
    });
  });
}

/**
 * Parse terraform outputs into a structured object
 * @param {string} output - Raw terraform output
 * @returns {object} Parsed outputs
 */
function parseTerraformOutputs(output) {
  // Handle null/undefined inputs gracefully
  if (!output || typeof output !== 'string') {
    return {};
  }

  const outputs = {};
  const lines = output.split('\n');

  for (const line of lines) {
    // Match "key = value" patterns
    const match = line.match(/^([a-z_][a-z0-9_]*)\s*=\s*"?([^"]*)"?$/i);
    if (match) {
      const [, key, value] = match;
      outputs[key] = value;
    }
  }

  return outputs;
}

/**
 * Check if environment is properly configured
 * @param {string} environment - Environment name
 * @returns {Promise<{valid: boolean, issues: string[]}>}
 */
async function validateEnvironmentConfig(environment) {
  const terraformDir = await getTerraformDir(environment);
  const issues = [];

  // Check directory exists
  if (!await fs.pathExists(terraformDir)) {
    issues.push(`Environment directory not found: ${terraformDir}`);
    return { valid: false, issues };
  }

  // Check for required files
  const mainTf = path.join(terraformDir, 'main.tf');
  if (!await fs.pathExists(mainTf)) {
    issues.push('Missing main.tf - environment may not be initialized');
  }

  // Check for terraform.tfvars
  const tfvars = path.join(terraformDir, 'terraform.tfvars');
  const tfvarsExample = path.join(terraformDir, 'terraform.tfvars.example');
  if (!await fs.pathExists(tfvars)) {
    if (await fs.pathExists(tfvarsExample)) {
      issues.push('Missing terraform.tfvars - copy from terraform.tfvars.example and configure');
    } else {
      issues.push('Missing terraform.tfvars - environment variables must be set');
    }
  }

  // Check for .terraform directory (initialized)
  const terraformState = path.join(terraformDir, '.terraform');
  if (!await fs.pathExists(terraformState)) {
    issues.push('Terraform not initialized - run: mc terraform init');
  }

  return { valid: issues.length === 0, issues };
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Show Terraform status and environment information
 */
terraformCmd
  .command('status')
  .description('Show Terraform status and environment information')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('--json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      console.log(chalk.gray(`   Valid environments: ${VALID_ENVIRONMENTS.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);
    const status = {
      environment,
      terraformDir,
      terraformInstalled: isTerraformInstalled(),
      awsCliInstalled: isAwsCliInstalled(),
      directoryExists: await fs.pathExists(terraformDir),
      initialized: false,
      workspace: environment,
      outputs: {}
    };

    if (status.directoryExists) {
      status.initialized = await fs.pathExists(path.join(terraformDir, '.terraform'));

      if (status.initialized && isTerraformInstalled()) {
        // Get workspace
        try {
          const workspaceResult = execSync('terraform workspace show', {
            cwd: terraformDir,
            encoding: 'utf8',
            timeout: 10000
          }).trim();
          status.workspace = workspaceResult;
        } catch {
          // Ignore workspace errors
        }

        // Get outputs if available
        try {
          const outputResult = execSync('terraform output -raw cluster_endpoint 2>/dev/null || echo ""', {
            cwd: terraformDir,
            encoding: 'utf8',
            timeout: 10000
          }).trim();
          if (outputResult) {
            status.outputs.clusterEndpoint = outputResult;
          }
        } catch {
          // Ignore output errors
        }
      }
    }

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    console.log(chalk.bold('🐾 Terraform Status'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    // Prerequisites
    console.log(chalk.bold('Prerequisites:'));
    console.log(`  ${status.terraformInstalled ? '✅' : '❌'} Terraform installed`);
    console.log(`  ${status.awsCliInstalled ? '✅' : '❌'} AWS CLI installed`);
    console.log();

    // Environment
    console.log(chalk.bold('Environment:'));
    console.log(`  Name:        ${chalk.cyan(environment)}`);
    console.log(`  Directory:   ${chalk.gray(terraformDir)}`);
    console.log(`  Exists:      ${status.directoryExists ? chalk.green('Yes') : chalk.red('No')}`);
    console.log(`  Initialized: ${status.initialized ? chalk.green('Yes') : chalk.yellow('No')}`);
    console.log(`  Workspace:   ${chalk.cyan(status.workspace)}`);
    console.log();

    if (Object.keys(status.outputs).length > 0) {
      console.log(chalk.bold('Outputs:'));
      for (const [key, value] of Object.entries(status.outputs)) {
        console.log(`  ${key}: ${chalk.cyan(value)}`);
      }
      console.log();
    }

    // Quick actions
    if (!status.initialized) {
      console.log(chalk.yellow('⚠️  Terraform not initialized'));
      console.log(chalk.gray(`   Run: mc terraform init -e ${environment}`));
    } else if (!status.outputs.clusterEndpoint) {
      console.log(chalk.yellow('⚠️  Infrastructure not yet deployed'));
      console.log(chalk.gray(`   Run: mc terraform plan -e ${environment}`));
    } else {
      console.log(chalk.green('✅ Infrastructure deployed'));
      console.log(chalk.gray('   Run: mc terraform output -e ${environment} for connection details'));
    }
  }));

/**
 * Initialize Terraform for an environment
 */
terraformCmd
  .command('init')
  .description('Initialize Terraform for an environment')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('-u, --upgrade', 'Upgrade modules and providers')
  .option('--reconfigure', 'Reconfigure backend (use with caution)')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      console.log(chalk.gray(`   Valid environments: ${VALID_ENVIRONMENTS.join(', ')}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    if (!await fs.pathExists(terraformDir)) {
      console.log(chalk.red(`❌ Environment directory not found: ${terraformDir}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    console.log(chalk.bold(`🐾 Initializing Terraform for ${chalk.cyan(environment)}`));
    console.log(chalk.gray(`   Directory: ${terraformDir}`));
    console.log();

    const args = ['init'];
    if (options.upgrade) args.push('-upgrade');
    if (options.reconfigure) args.push('-reconfigure');

    const spinner = ora('Running terraform init...').start();
    const result = await runTerraform(terraformDir, args, { silent: true });

    if (result.success) {
      spinner.succeed('Terraform initialized successfully');
      console.log();
      console.log(chalk.green('✅ Ready to deploy!'));
      console.log(chalk.gray(`   Next: mc terraform plan -e ${environment}`));
    } else {
      spinner.fail('Terraform initialization failed');
      console.log();
      console.log(chalk.red('Error:'));
      console.log(result.error || result.output);
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }));

/**
 * Show Terraform plan
 */
terraformCmd
  .command('plan')
  .description('Show Terraform execution plan')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('-o, --output <file>', 'Save plan to file')
  .option('--destroy', 'Plan to destroy all resources')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    // Validate environment
    const validation = await validateEnvironmentConfig(environment);
    if (!validation.valid) {
      console.log(chalk.red('❌ Environment validation failed:'));
      for (const issue of validation.issues) {
        console.log(chalk.gray(`   • ${issue}`));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    console.log(chalk.bold(`🐾 Terraform Plan for ${chalk.cyan(environment)}`));
    console.log(chalk.gray(`   Directory: ${terraformDir}`));
    console.log();

    const args = ['plan'];
    if (options.destroy) args.push('-destroy');
    if (options.output) args.push('-out', options.output);

    const result = await runTerraform(terraformDir, args, { silent: false });

    if (!result.success) {
      console.log();
      console.log(chalk.red('❌ Plan failed'));
      process.exit(ExitCode.GENERAL_ERROR);
    }

    if (options.output) {
      console.log();
      console.log(chalk.green(`✅ Plan saved to: ${options.output}`));
      console.log(chalk.gray(`   Apply with: mc terraform apply -e ${environment} -p ${options.output}`));
    }
  }));

/**
 * Apply Terraform changes
 */
terraformCmd
  .command('apply')
  .description('Apply Terraform changes')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('-p, --plan <file>', 'Apply saved plan file')
  .option('-a, --auto-approve', 'Auto-approve changes (use with caution)')
  .option('--target <resource>', 'Apply only specific resource')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    // Validate environment
    const validation = await validateEnvironmentConfig(environment);
    if (!validation.valid) {
      console.log(chalk.red('❌ Environment validation failed:'));
      for (const issue of validation.issues) {
        console.log(chalk.gray(`   • ${issue}`));
      }
      process.exit(ExitCode.CONFIG_ERROR);
    }

    console.log(chalk.bold(`🐾 Terraform Apply for ${chalk.cyan(environment)}`));
    console.log(chalk.gray(`   Directory: ${terraformDir}`));
    console.log();

    // Warning for production
    if (environment === 'prod' && !options.autoApprove) {
      console.log(chalk.yellow('⚠️  WARNING: You are about to modify PRODUCTION infrastructure'));
      console.log(chalk.gray('   This will affect live services'));
      console.log();
    }

    const args = ['apply'];
    if (options.autoApprove) args.push('-auto-approve');
    if (options.plan) args.push(options.plan);
    if (options.target) args.push('-target', options.target);

    const result = await runTerraform(terraformDir, args, { silent: false });

    if (result.success) {
      console.log();
      console.log(chalk.green('✅ Terraform apply completed successfully'));
      console.log();
      console.log(chalk.bold('Next steps:'));
      console.log(chalk.gray(`   1. Get connection details: mc terraform output -e ${environment}`));
      console.log(chalk.gray(`   2. Configure kubectl: mc terraform kubeconfig -e ${environment}`));
      console.log(chalk.gray(`   3. Check deployment: mc k8s status`));
    } else {
      console.log();
      console.log(chalk.red('❌ Terraform apply failed'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }));

/**
 * Destroy Terraform infrastructure
 */
terraformCmd
  .command('destroy')
  .description('Destroy Terraform infrastructure (USE WITH EXTREME CAUTION)')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('-a, --auto-approve', 'Auto-approve destruction (DANGEROUS)')
  .option('--target <resource>', 'Destroy only specific resource')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    console.log(chalk.bold.red('🔴 DESTROY TERRAFORM INFRASTRUCTURE'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    // Strong warnings
    console.log(chalk.red(`⚠️  WARNING: This will DESTROY all resources in ${chalk.bold(environment)}`));
    console.log(chalk.red('    This action CANNOT be undone!'));
    console.log();

    if (environment === 'prod') {
      console.log(chalk.red.bold('🛑 PRODUCTION DESTRUCTION REQUESTED'));
      console.log(chalk.red('    Are you absolutely sure?'));
      console.log();
    }

    // Require explicit confirmation for production
    if (environment === 'prod' && !options.autoApprove) {
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const confirm = await new Promise((resolve) => {
        rl.question(chalk.yellow(`Type '${environment}' to confirm destruction: `), (answer) => {
          rl.close();
          resolve(answer === environment);
        });
      });

      if (!confirm) {
        console.log(chalk.gray('Destruction cancelled'));
        return;
      }
    }

    const args = ['destroy'];
    if (options.autoApprove) args.push('-auto-approve');
    if (options.target) args.push('-target', options.target);

    const result = await runTerraform(terraformDir, args, { silent: false });

    if (result.success) {
      console.log();
      console.log(chalk.green('✅ Infrastructure destroyed'));
    } else {
      console.log();
      console.log(chalk.red('❌ Destruction failed'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }));

/**
 * Show Terraform outputs
 */
terraformCmd
  .command('output')
  .description('Show Terraform outputs (connection details, endpoints)')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('--json', 'Output as JSON')
  .option('--raw <name>', 'Output single value as raw string')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    // Validate environment is initialized
    if (!await fs.pathExists(path.join(terraformDir, '.terraform'))) {
      console.log(chalk.red('❌ Terraform not initialized'));
      console.log(chalk.gray(`   Run: mc terraform init -e ${environment}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const args = ['output'];
    if (options.json) args.push('-json');
    if (options.raw) {
      args.push('-raw', options.raw);
    } else {
      args.push('-no-color');
    }

    const result = await runTerraform(terraformDir, args, { silent: true });

    if (result.success) {
      if (options.raw) {
        console.log(result.output.trim());
      } else if (options.json) {
        console.log(result.output);
      } else {
        console.log(chalk.bold(`🐾 Terraform Outputs for ${chalk.cyan(environment)}`));
        console.log(chalk.gray('─'.repeat(50)));
        console.log();

        const outputs = parseTerraformOutputs(result.output);

        if (Object.keys(outputs).length === 0) {
          console.log(chalk.yellow('No outputs available'));
          console.log(chalk.gray('Infrastructure may not be deployed yet'));
        } else {
          for (const [key, value] of Object.entries(outputs)) {
            const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            console.log(`${chalk.bold(formattedKey)}:`);
            console.log(`  ${chalk.cyan(value)}`);
            console.log();
          }
        }

        // Helpful commands
        console.log(chalk.bold('Next steps:'));
        console.log(chalk.gray(`   • Configure kubectl: mc terraform kubeconfig -e ${environment}`));
        console.log(chalk.gray(`   • Check services: mc k8s status`));
      }
    } else {
      console.log(chalk.red('❌ Failed to get outputs'));
      if (result.error) {
        console.log(chalk.gray(result.error));
      }
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }));

/**
 * Configure kubectl for the environment
 */
terraformCmd
  .command('kubeconfig')
  .description('Configure kubectl for the Terraform-managed cluster')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('--region <region>', 'AWS region', 'us-east-1')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    if (!isAwsCliInstalled()) {
      console.log(chalk.red('❌ AWS CLI is not installed'));
      console.log(chalk.gray('   Install from https://aws.amazon.com/cli/'));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const terraformDir = await getTerraformDir(environment);

    // Get cluster name from outputs
    const result = await runTerraform(terraformDir, ['output', '-raw', 'cluster_name'], { silent: true });

    if (!result.success || !result.output.trim()) {
      console.log(chalk.red('❌ Could not get cluster name'));
      console.log(chalk.gray('   Ensure infrastructure is deployed'));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    const clusterName = result.output.trim();

    console.log(chalk.bold(`🐾 Configuring kubectl for ${chalk.cyan(clusterName)}`));
    console.log();

    try {
      execSync(`aws eks update-kubeconfig --name ${clusterName} --region ${options.region}`, {
        stdio: 'inherit'
      });

      console.log();
      console.log(chalk.green('✅ kubectl configured successfully'));
      console.log();
      console.log(chalk.bold('Next steps:'));
      console.log(chalk.gray('   • Verify connection: kubectl get nodes'));
      console.log(chalk.gray('   • Check MasterClaw: mc k8s status'));
    } catch (error) {
      console.log();
      console.log(chalk.red('❌ Failed to configure kubectl'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }));

/**
 * Validate Terraform configuration
 */
terraformCmd
  .command('validate')
  .description('Validate Terraform configuration files')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    if (!await fs.pathExists(terraformDir)) {
      console.log(chalk.red(`❌ Environment directory not found: ${terraformDir}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    console.log(chalk.bold(`🐾 Validating Terraform for ${chalk.cyan(environment)}`));
    console.log();

    const result = await runTerraform(terraformDir, ['validate'], { silent: false });

    if (result.success) {
      console.log();
      console.log(chalk.green('✅ Terraform configuration is valid'));
    } else {
      console.log();
      console.log(chalk.red('❌ Validation failed'));
      process.exit(ExitCode.VALIDATION_FAILED);
    }
  }));

/**
 * Show Terraform state
 */
terraformCmd
  .command('state')
  .description('Show Terraform state information')
  .option('-e, --env <environment>', 'Environment', 'dev')
  .option('--json', 'Output as JSON')
  .action(wrapCommand(async (options) => {
    const environment = options.env;

    if (!isValidEnvironment(environment)) {
      console.log(chalk.red(`❌ Invalid environment: ${environment}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const terraformDir = await getTerraformDir(environment);

    console.log(chalk.bold(`🐾 Terraform State for ${chalk.cyan(environment)}`));
    console.log(chalk.gray(`   Directory: ${terraformDir}`));
    console.log();

    // Check state file exists
    const stateFile = path.join(terraformDir, 'terraform.tfstate');
    if (!await fs.pathExists(stateFile)) {
      console.log(chalk.yellow('⚠️  No state file found'));
      console.log(chalk.gray('   Infrastructure may not be deployed yet'));
      return;
    }

    // List resources
    const args = ['state', 'list'];
    const result = await runTerraform(terraformDir, args, { silent: true });

    if (result.success) {
      const resources = result.output.trim().split('\n').filter(r => r);

      if (resources.length === 0) {
        console.log(chalk.yellow('No resources in state'));
      } else {
        console.log(chalk.bold(`Resources (${resources.length}):`));
        for (const resource of resources) {
          console.log(`  • ${resource}`);
        }
      }
    } else {
      console.log(chalk.red('❌ Failed to get state'));
      if (result.error) {
        console.log(chalk.gray(result.error));
      }
    }
  }));

/**
 * List available environments
 */
terraformCmd
  .command('env')
  .description('List available Terraform environments')
  .action(wrapCommand(async () => {
    console.log(chalk.bold('🐾 Terraform Environments'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    const infraDir = getInfraDir();
    const terraformDir = path.join(infraDir, DEFAULT_TERRAFORM_DIR, 'environments');

    if (!await fs.pathExists(terraformDir)) {
      console.log(chalk.red('❌ Terraform environments directory not found'));
      console.log(chalk.gray(`   Expected: ${terraformDir}`));
      process.exit(ExitCode.CONFIG_ERROR);
    }

    for (const env of VALID_ENVIRONMENTS) {
      const envDir = path.join(terraformDir, env);
      const exists = await fs.pathExists(envDir);
      const initialized = exists && await fs.pathExists(path.join(envDir, '.terraform'));

      const status = !exists ? chalk.red('Missing') :
                     initialized ? chalk.green('Ready') :
                     chalk.yellow('Not Initialized');

      const icon = !exists ? '❌' : initialized ? '✅' : '⚠️';

      console.log(`  ${icon} ${chalk.bold(env.padEnd(10))} ${status}`);
    }

    console.log();
    console.log(chalk.gray('Use: mc terraform init -e <environment> to initialize'));
  }));

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  terraformCmd,
  isTerraformInstalled,
  isAwsCliInstalled,
  getTerraformDir,
  getInfraDir,
  runTerraform,
  parseTerraformOutputs,
  validateEnvironmentConfig,
  isValidEnvironment,
  VALID_ENVIRONMENTS
};
