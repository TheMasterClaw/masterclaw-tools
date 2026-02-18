// env-manager.js - Multi-environment configuration management for MasterClaw
// Allows switching between dev/staging/prod environments with isolated configs

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const { execSync } = require('child_process');

const envCmd = new Command('env');

// Default environments directory
const ENV_DIR_NAME = '.environments';

// Standard environment templates
const ENV_TEMPLATES = {
  dev: {
    name: 'development',
    description: 'Local development environment',
    config: {
      DOMAIN: 'localhost',
      ACME_EMAIL: 'dev@example.com',
      TRAEFIK_LOG_LEVEL: 'DEBUG',
      RETENTION_DAYS: '1',
      DEPENDENCY_CHECK_TIMEOUT: '30',
      LLM_MONTHLY_BUDGET: '10',
    },
    dockerOverride: {
      version: '3.8',
      services: {
        traefik: {
          command: [
            '--api.insecure=true',
            '--api.dashboard=true',
            '--providers.docker=true',
            '--entrypoints.web.address=:80',
            '--log.level=DEBUG',
          ],
          ports: ['80:80', '8080:8080'],
          labels: [],
        },
        core: {
          environment: {
            LOG_LEVEL: 'DEBUG',
          },
        },
      },
    },
  },
  staging: {
    name: 'staging',
    description: 'Staging environment for testing',
    config: {
      DOMAIN: 'staging.mc.example.com',
      ACME_EMAIL: 'staging@example.com',
      TRAEFIK_LOG_LEVEL: 'INFO',
      RETENTION_DAYS: '3',
      DEPENDENCY_CHECK_TIMEOUT: '60',
      LLM_MONTHLY_BUDGET: '50',
    },
    dockerOverride: {
      version: '3.8',
      services: {
        core: {
          deploy: {
            resources: {
              limits: {
                cpus: '1.0',
                memory: '512M',
              },
            },
          },
        },
      },
    },
  },
  prod: {
    name: 'production',
    description: 'Production environment',
    config: {
      DOMAIN: 'mc.example.com',
      ACME_EMAIL: 'admin@example.com',
      TRAEFIK_LOG_LEVEL: 'WARN',
      RETENTION_DAYS: '30',
      DEPENDENCY_CHECK_TIMEOUT: '120',
      LLM_MONTHLY_BUDGET: '500',
    },
    dockerOverride: {
      version: '3.8',
      services: {
        traefik: {
          deploy: {
            resources: {
              limits: {
                cpus: '1.0',
                memory: '512M',
              },
            },
          },
        },
        core: {
          deploy: {
            resources: {
              limits: {
                cpus: '2.0',
                memory: '2G',
              },
            },
          },
          restart: 'always',
        },
      },
    },
  },
};

// Get the infrastructure directory
async function getInfraDir() {
  const { findInfraDir } = require('./services');
  return await findInfraDir() || process.cwd();
}

// Get environments directory
async function getEnvsDir() {
  const infraDir = await getInfraDir();
  return path.join(infraDir, ENV_DIR_NAME);
}

// Get current active environment
async function getCurrentEnv() {
  try {
    const infraDir = await getInfraDir();
    const activeFile = path.join(infraDir, '.env-active');
    
    if (await fs.pathExists(activeFile)) {
      return await fs.readFile(activeFile, 'utf8').then(s => s.trim());
    }
  } catch {
    // Ignore errors
  }
  return null;
}

// Set current active environment
async function setCurrentEnv(envName) {
  const infraDir = await getInfraDir();
  const activeFile = path.join(infraDir, '.env-active');
  await fs.writeFile(activeFile, envName);
}

// Get environment directory
async function getEnvDir(envName) {
  const envsDir = await getEnvsDir();
  return path.join(envsDir, envName);
}

// Check if environment exists
async function envExists(envName) {
  const envDir = await getEnvDir(envName);
  return await fs.pathExists(envDir);
}

// Get environment config
async function getEnvConfig(envName) {
  const envDir = await getEnvDir(envName);
  const configFile = path.join(envDir, 'config.json');
  
  if (await fs.pathExists(configFile)) {
    return await fs.readJson(configFile);
  }
  return null;
}

// List all environments
async function listEnvironments() {
  const envsDir = await getEnvsDir();
  const currentEnv = await getCurrentEnv();
  
  if (!await fs.pathExists(envsDir)) {
    return [];
  }
  
  const entries = await fs.readdir(envsDir);
  const envs = [];
  
  for (const entry of entries) {
    const envDir = path.join(envsDir, entry);
    const stat = await fs.stat(envDir);
    
    if (stat.isDirectory()) {
      const config = await getEnvConfig(entry);
      envs.push({
        name: entry,
        isActive: entry === currentEnv,
        config,
      });
    }
  }
  
  return envs;
}

// Create environment from template
async function createEnvironment(envName, templateName = null, fromEnv = null) {
  const envsDir = await getEnvsDir();
  const envDir = path.join(envsDir, envName);
  
  if (await fs.pathExists(envDir)) {
    throw new Error(`Environment '${envName}' already exists`);
  }
  
  await fs.ensureDir(envDir);
  
  let config = {};
  let dockerOverride = {};
  let description = '';
  
  if (fromEnv && await envExists(fromEnv)) {
    // Copy from existing environment
    const fromDir = await getEnvDir(fromEnv);
    const fromEnvFile = path.join(fromDir, '.env');
    const fromDockerFile = path.join(fromDir, 'docker-compose.override.yml');
    const fromConfig = await getEnvConfig(fromEnv);
    
    if (await fs.pathExists(fromEnvFile)) {
      const envContent = await fs.readFile(fromEnvFile, 'utf8');
      config = parseEnvFile(envContent);
    }
    
    if (await fs.pathExists(fromDockerFile)) {
      dockerOverride = await fs.readYaml(fromDockerFile).catch(() => ({}));
    }
    
    description = `Copied from ${fromEnv}`;
  } else if (templateName && ENV_TEMPLATES[templateName]) {
    // Use template
    const template = ENV_TEMPLATES[templateName];
    config = { ...template.config };
    dockerOverride = { ...template.dockerOverride };
    description = template.description;
  }
  
  // Write environment files
  await fs.writeFile(
    path.join(envDir, '.env'),
    generateEnvFile(config)
  );
  
  await fs.writeYaml(
    path.join(envDir, 'docker-compose.override.yml'),
    dockerOverride
  );
  
  await fs.writeJson(
    path.join(envDir, 'config.json'),
    {
      name: envName,
      description,
      created: new Date().toISOString(),
      template: templateName || (fromEnv ? `from:${fromEnv}` : 'custom'),
    },
    { spaces: 2 }
  );
  
  return envDir;
}

// Parse .env file content to object
function parseEnvFile(content) {
  const config = {};
  for (const line of content.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      config[match[1].trim()] = match[2].trim();
    }
  }
  return config;
}

// Generate .env file content from object
function generateEnvFile(config) {
  const lines = [
    '# ==========================================',
    '# MasterClaw Environment Configuration',
    '# ==========================================',
    '',
  ];
  
  for (const [key, value] of Object.entries(config)) {
    lines.push(`${key}=${value}`);
  }
  
  lines.push('');
  return lines.join('\n');
}

// Switch to environment
async function switchEnvironment(envName) {
  if (!await envExists(envName)) {
    throw new Error(`Environment '${envName}' does not exist`);
  }
  
  const infraDir = await getInfraDir();
  const envDir = await getEnvDir(envName);
  
  // Backup current .env if it exists
  const currentEnvFile = path.join(infraDir, '.env');
  if (await fs.pathExists(currentEnvFile)) {
    const backupFile = path.join(infraDir, '.env.backup');
    await fs.copy(currentEnvFile, backupFile, { overwrite: true });
  }
  
  // Copy environment .env to main .env
  const envFile = path.join(envDir, '.env');
  await fs.copy(envFile, currentEnvFile, { overwrite: true });
  
  // Copy docker-compose override if exists
  const overrideFile = path.join(envDir, 'docker-compose.override.yml');
  const targetOverride = path.join(infraDir, 'docker-compose.override.active.yml');
  if (await fs.pathExists(overrideFile)) {
    await fs.copy(overrideFile, targetOverride, { overwrite: true });
  }
  
  // Set active environment
  await setCurrentEnv(envName);
  
  return { envName, envDir };
}

// Delete environment
async function deleteEnvironment(envName) {
  if (!await envExists(envName)) {
    throw new Error(`Environment '${envName}' does not exist`);
  }
  
  const currentEnv = await getCurrentEnv();
  if (currentEnv === envName) {
    throw new Error(`Cannot delete active environment. Switch to another environment first.`);
  }
  
  const envDir = await getEnvDir(envName);
  await fs.remove(envDir);
}

// Compare two environments
async function diffEnvironments(envA, envB) {
  const [configA, configB] = await Promise.all([
    getEnvConfig(envA),
    getEnvConfig(envB),
  ]);
  
  const envADir = await getEnvDir(envA);
  const envBDir = await getEnvDir(envB);
  
  const [envAContent, envBContent] = await Promise.all([
    fs.readFile(path.join(envADir, '.env'), 'utf8').catch(() => ''),
    fs.readFile(path.join(envBDir, '.env'), 'utf8').catch(() => ''),
  ]);
  
  const configAObj = parseEnvFile(envAContent);
  const configBObj = parseEnvFile(envBContent);
  
  const allKeys = new Set([...Object.keys(configAObj), ...Object.keys(configBObj)]);
  const differences = [];
  
  for (const key of allKeys) {
    const valA = configAObj[key];
    const valB = configBObj[key];
    
    if (valA !== valB) {
      differences.push({
        key,
        valueA: valA || '(not set)',
        valueB: valB || '(not set)',
      });
    }
  }
  
  return differences;
}

// Initialize default environments
async function initializeEnvironments() {
  const envsDir = await getEnvsDir();
  
  if (await fs.pathExists(envsDir)) {
    const existing = await fs.readdir(envsDir);
    if (existing.length > 0) {
      return false; // Already initialized
    }
  }
  
  await fs.ensureDir(envsDir);
  
  // Create default environments
  for (const [templateName, template] of Object.entries(ENV_TEMPLATES)) {
    await createEnvironment(templateName, templateName);
  }
  
  return true;
}

// CLI Commands

envCmd
  .description('Manage MasterClaw environments (dev/staging/prod)');

envCmd
  .command('status')
  .description('Show current environment status')
  .action(async () => {
    const currentEnv = await getCurrentEnv();
    const envs = await listEnvironments();
    
    console.log(chalk.blue('🐾 MasterClaw Environment Status\n'));
    
    if (currentEnv) {
      const config = await getEnvConfig(currentEnv);
      console.log(`Active: ${chalk.green.bold(currentEnv)}`);
      if (config?.description) {
        console.log(chalk.gray(`  ${config.description}`));
      }
      console.log(chalk.gray(`  Created: ${config?.created ? new Date(config.created).toLocaleDateString() : 'unknown'}`));
    } else {
      console.log(chalk.yellow('No active environment set'));
      console.log(chalk.gray('  Use "mc env use <name>" to activate an environment'));
    }
    
    console.log(chalk.gray(`\nEnvironments directory: ${await getEnvsDir()}`));
  });

envCmd
  .command('list')
  .description('List all environments')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const envs = await listEnvironments();
    
    if (options.json) {
      console.log(JSON.stringify(envs, null, 2));
      return;
    }
    
    console.log(chalk.blue('🐾 MasterClaw Environments\n'));
    
    if (envs.length === 0) {
      console.log(chalk.yellow('No environments found.'));
      console.log(chalk.gray('  Run "mc env init" to create default environments'));
      return;
    }
    
    for (const env of envs) {
      const icon = env.isActive ? chalk.green('●') : chalk.gray('○');
      const name = env.isActive ? chalk.green.bold(env.name) : chalk.white(env.name);
      console.log(`${icon} ${name}`);
      
      if (env.config?.description) {
        console.log(chalk.gray(`   ${env.config.description}`));
      }
    }
    
    console.log(chalk.gray(`\n${envs.length} environment(s) total`));
  });

envCmd
  .command('use')
  .description('Switch to an environment')
  .argument('<name>', 'Environment name')
  .option('-f, --force', 'Skip confirmation')
  .action(async (envName, options) => {
    if (!await envExists(envName)) {
      console.log(chalk.red(`❌ Environment '${envName}' does not exist`));
      console.log(chalk.gray(`   Run "mc env list" to see available environments`));
      process.exit(1);
    }
    
    const currentEnv = await getCurrentEnv();
    if (currentEnv === envName && !options.force) {
      console.log(chalk.yellow(`⚠️  Already using '${envName}' environment`));
      return;
    }
    
    // Warn if switching to production
    const config = await getEnvConfig(envName);
    if (envName === 'prod' || envName === 'production') {
      console.log(chalk.yellow('⚠️  You are switching to PRODUCTION environment'));
      
      if (!options.force) {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: 'Are you sure?',
          default: false,
        }]);
        
        if (!confirm) {
          console.log(chalk.gray('Cancelled'));
          return;
        }
      }
    }
    
    await switchEnvironment(envName);
    
    console.log(chalk.green(`✅ Switched to '${envName}' environment`));
    
    if (config?.description) {
      console.log(chalk.gray(`   ${config.description}`));
    }
    
    console.log(chalk.cyan('\nNext steps:'));
    console.log(chalk.gray('  mc status    - Check services'));
    console.log(chalk.gray('  mc revive    - Start services with new config'));
  });

envCmd
  .command('create')
  .description('Create a new environment')
  .argument('<name>', 'Environment name')
  .option('-t, --template <name>', 'Use template (dev, staging, prod)')
  .option('--from <env>', 'Copy from existing environment')
  .action(async (envName, options) => {
    if (await envExists(envName)) {
      console.log(chalk.red(`❌ Environment '${envName}' already exists`));
      process.exit(1);
    }
    
    try {
      const envDir = await createEnvironment(envName, options.template, options.from);
      console.log(chalk.green(`✅ Created environment '${envName}'`));
      console.log(chalk.gray(`   Location: ${envDir}`));
      
      if (options.template) {
        console.log(chalk.gray(`   Template: ${options.template}`));
      } else if (options.from) {
        console.log(chalk.gray(`   Copied from: ${options.from}`));
      }
      
      console.log(chalk.cyan('\nNext steps:'));
      console.log(chalk.gray(`  mc env use ${envName}    - Activate environment`));
      console.log(chalk.gray(`  Edit .environments/${envName}/.env to customize`));
    } catch (err) {
      console.log(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

envCmd
  .command('delete')
  .description('Delete an environment')
  .argument('<name>', 'Environment name')
  .option('-f, --force', 'Skip confirmation')
  .action(async (envName, options) => {
    if (!await envExists(envName)) {
      console.log(chalk.red(`❌ Environment '${envName}' does not exist`));
      process.exit(1);
    }
    
    if (!options.force) {
      const { confirm } = await inquirer.prompt([{
        type: 'confirm',
        name: 'confirm',
        message: `Delete environment '${envName}'? This cannot be undone.`,
        default: false,
      }]);
      
      if (!confirm) {
        console.log(chalk.gray('Cancelled'));
        return;
      }
    }
    
    try {
      await deleteEnvironment(envName);
      console.log(chalk.green(`✅ Deleted environment '${envName}'`));
    } catch (err) {
      console.log(chalk.red(`❌ ${err.message}`));
      process.exit(1);
    }
  });

envCmd
  .command('diff')
  .description('Compare two environments')
  .argument('<a>', 'First environment')
  .argument('<b>', 'Second environment')
  .action(async (envA, envB) => {
    if (!await envExists(envA)) {
      console.log(chalk.red(`❌ Environment '${envA}' does not exist`));
      process.exit(1);
    }
    
    if (!await envExists(envB)) {
      console.log(chalk.red(`❌ Environment '${envB}' does not exist`));
      process.exit(1);
    }
    
    const differences = await diffEnvironments(envA, envB);
    
    console.log(chalk.blue(`🐾 Comparing ${envA} vs ${envB}\n`));
    
    if (differences.length === 0) {
      console.log(chalk.green('✅ No differences found'));
      return;
    }
    
    console.log(chalk.yellow(`Found ${differences.length} difference(s):\n`));
    
    for (const diff of differences) {
      console.log(`${chalk.cyan(diff.key)}:`);
      console.log(`  ${chalk.gray(envA)}: ${diff.valueA}`);
      console.log(`  ${chalk.gray(envB)}: ${diff.valueB}`);
      console.log('');
    }
  });

envCmd
  .command('init')
  .description('Initialize default environments (dev, staging, prod)')
  .option('-f, --force', 'Overwrite existing environments')
  .action(async (options) => {
    const envsDir = await getEnvsDir();
    
    if (await fs.pathExists(envsDir) && !options.force) {
      const existing = await fs.readdir(envsDir);
      if (existing.length > 0) {
        console.log(chalk.yellow('⚠️  Environments already initialized'));
        console.log(chalk.gray(`   Found: ${existing.join(', ')}`));
        console.log(chalk.gray('   Use --force to recreate'));
        return;
      }
    }
    
    await fs.ensureDir(envsDir);
    
    console.log(chalk.blue('🐾 Initializing default environments...\n'));
    
    for (const [templateName, template] of Object.entries(ENV_TEMPLATES)) {
      const envDir = path.join(envsDir, templateName);
      
      if (await fs.pathExists(envDir)) {
        if (options.force) {
          await fs.remove(envDir);
        } else {
          console.log(chalk.gray(`  ${templateName}: already exists, skipping`));
          continue;
        }
      }
      
      await createEnvironment(templateName, templateName);
      console.log(chalk.green(`  ✓ ${templateName}`));
      console.log(chalk.gray(`    ${template.description}`));
    }
    
    console.log(chalk.cyan('\nNext steps:'));
    console.log(chalk.gray('  mc env use dev     - Start with development'));
    console.log(chalk.gray('  mc env list        - See all environments'));
  });

// Export functions for use in other modules
module.exports = {
  envCmd,
  getCurrentEnv,
  listEnvironments,
  createEnvironment,
  switchEnvironment,
  deleteEnvironment,
  diffEnvironments,
  initializeEnvironments,
  getEnvConfig,
  ENV_TEMPLATES,
};
