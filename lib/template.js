/**
 * Configuration Template Generator for MasterClaw CLI
 *
 * Generates starter configuration files for various MasterClaw components.
 * Useful for new users setting up their environment or creating new services.
 *
 * Templates:
 * - .env (environment configuration)
 * - docker-compose.override.yml (local development)
 * - terraform.tfvars (infrastructure deployment)
 * - service config (custom service definition)
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');

const { wrapCommand, ExitCode } = require('./error-handler');

const templateCmd = new Command('template');

// =============================================================================
// Template Definitions
// =============================================================================

const TEMPLATES = {
  env: {
    name: 'Environment Configuration (.env)',
    description: 'Complete .env file for MasterClaw deployment',
    filename: '.env',
    generate: generateEnvTemplate,
  },
  'docker-override': {
    name: 'Docker Compose Override',
    description: 'Local development overrides for Docker Compose',
    filename: 'docker-compose.override.yml',
    generate: generateDockerOverrideTemplate,
  },
  'terraform-vars': {
    name: 'Terraform Variables',
    description: 'terraform.tfvars for AWS infrastructure deployment',
    filename: 'terraform.tfvars',
    generate: generateTerraformVarsTemplate,
  },
  service: {
    name: 'Custom Service Definition',
    description: 'Template for adding a new service to MasterClaw',
    filename: 'service-definition.yml',
    generate: generateServiceTemplate,
  },
  monitoring: {
    name: 'Monitoring Configuration',
    description: 'Prometheus/Grafana alert rules and dashboards',
    filename: 'monitoring-config.yml',
    generate: generateMonitoringTemplate,
  },
  backup: {
    name: 'Backup Configuration',
    description: 'Cloud backup and retention configuration',
    filename: 'backup-config.yml',
    generate: generateBackupTemplate,
  },
};

// =============================================================================
// Template Generators
// =============================================================================

function generateEnvTemplate(options) {
  const domain = options.domain || 'mc.example.com';
  const email = options.email || 'admin@example.com';
  
  return `# MasterClaw Environment Configuration
# Generated: ${new Date().toISOString()}
# ==========================================

# Required: Your domain name
DOMAIN=${domain}

# Required: Admin email for SSL certificates
ACME_EMAIL=${email}

# Required: OpenClaw Gateway token
# Get this from your OpenClaw instance
GATEWAY_TOKEN=${generateRandomToken(32)}

# Optional: API Keys for AI services
# At least one provider is recommended
OPENAI_API_KEY=${options.openaiKey || 'sk-...'}
ANTHROPIC_API_KEY=${options.anthropicKey || ''}

# ==========================================
# Optional Configuration
# ==========================================

# Log level (DEBUG, INFO, WARN, ERROR)
TRAEFIK_LOG_LEVEL=INFO

# Backup retention in days
RETENTION_DAYS=7

# Backup directory
BACKUP_DIR=./backups

# Service dependency check timeout (seconds)
DEPENDENCY_CHECK_TIMEOUT=120

# ==========================================
# LLM Cost Management
# ==========================================

# Monthly budget for LLM API costs in USD
LLM_MONTHLY_BUDGET=100

# Daily cost thresholds for alerts
LLM_DAILY_COST_THRESHOLD=10
LLM_DAILY_COST_CRITICAL=25

# ==========================================
# Alerting & Notifications
# ==========================================

ALERT_WEBHOOK_PORT=8080

# Uncomment to enable notifications:
# ALERT_NOTIFY_DISCORD=https://discord.com/api/webhooks/...
# ALERT_NOTIFY_SLACK=https://hooks.slack.com/services/...
# ALERT_NOTIFY_WHATSAPP=+1234567890

# ==========================================
# Cloud Backup (Optional)
# ==========================================

# CLOUD_BACKUP_PROVIDER=s3
# CLOUD_BACKUP_BUCKET=masterclaw-backups
# CLOUD_BACKUP_PREFIX=masterclaw
# CLOUD_BACKUP_REGION=us-east-1
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
`;
}

function generateDockerOverrideTemplate(options) {
  return `# Docker Compose Override for Local Development
# Generated: ${new Date().toISOString()}
#
# This file overrides settings from docker-compose.yml for local development.
# It is automatically loaded by Docker Compose.

version: '3.8'

services:
  # Development overrides for Core
  core:
    # Mount local code for hot reload during development
    volumes:
      - ./masterclaw-core/masterclaw_core:/app/masterclaw_core:ro
    # Enable debug mode
    environment:
      - LOG_LEVEL=debug
      - DEBUG=true
    # Expose port directly for debugging
    ports:
      - "8000:8000"

  # Development overrides for Backend
  backend:
    # Mount local code for hot reload
    volumes:
      - ./masterclaw-backend/src:/app/src:ro
    environment:
      - NODE_ENV=development
      - LOG_LEVEL=debug
    ports:
      - "3001:3001"

  # Disable some services in dev
  watchtower:
    deploy:
      replicas: 0

  # Add development tools
  # mailhog:
  #   image: mailhog/mailhog
  #   ports:
  #     - "1025:1025"
  #     - "8025:8025"
`;
}

function generateTerraformVarsTemplate(options) {
  const domain = options.domain || 'mc.example.com';
  
  return `# Terraform Variables for MasterClaw Infrastructure
# Generated: ${new Date().toISOString()}
# ==========================================

# Required: Domain name for MasterClaw
domain_name = "${domain}"

# Required: Email for SSL certificates
acme_email = "${options.email || 'admin@' + domain}"

# Required: OpenClaw Gateway token
gateway_token = "${generateRandomToken(32)}"

# Optional: API Keys (leave empty if not using)
openai_api_key = "${options.openaiKey || ''}"
anthropic_api_key = "${options.anthropicKey || ''}"

# ==========================================
# AWS Configuration
# ==========================================

# AWS Region
aws_region = "${options.awsRegion || 'us-east-1'}"

# Environment (dev, staging, prod)
environment = "${options.environment || 'dev'}"

# ==========================================
# Cluster Configuration
# ==========================================

# EKS cluster name
cluster_name = "masterclaw-${options.environment || 'dev'}"

# Instance types for node groups
node_instance_types = ["t3.medium"]

# Number of nodes
node_desired_size = 2
node_min_size = 1
node_max_size = 4

# Enable spot instances for cost savings
use_spot_instances = ${options.environment === 'dev' ? 'true' : 'false'}

# ==========================================
# Database Configuration
# ==========================================

# RDS instance class
db_instance_class = "${options.environment === 'prod' ? 'db.t3.medium' : 'db.t3.micro'}"

# Database username
db_username = "masterclaw"

# Enable Multi-AZ for production
db_multi_az = ${options.environment === 'prod' ? 'true' : 'false'}

# ==========================================
# Cost Management
# ==========================================

# Monthly LLM budget in USD
llm_monthly_budget = 100

# Daily cost alert thresholds
llm_daily_cost_threshold = 10
llm_daily_cost_critical = 25
`;
}

function generateServiceTemplate(options) {
  const serviceName = options.serviceName || 'my-service';
  
  return `# Custom Service Definition for MasterClaw
# Generated: ${new Date().toISOString()}
#
# Add this to your docker-compose.yml or create a separate file
# and include it with: docker-compose -f docker-compose.yml -f service-definition.yml up

version: '3.8'

services:
  ${serviceName}:
    # Option 1: Build from local Dockerfile
    build:
      context: ./services/${serviceName}
      dockerfile: Dockerfile
    
    # Option 2: Use pre-built image
    # image: myregistry/${serviceName}:latest
    
    container_name: mc-${serviceName}
    restart: unless-stopped
    
    # Security hardening
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    
    # Resource limits
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M
        reservations:
          cpus: '0.25'
          memory: 128M
    
    # Environment variables
    environment:
      - NODE_ENV=production
      - LOG_LEVEL=info
    
    # Networks
    networks:
      - masterclaw-network
    
    # Health check
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    
    # Traefik labels for routing
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.${serviceName}.rule=Host(\`${serviceName}.\${DOMAIN}\`)"
      - "traefik.http.routers.${serviceName}.tls.certresolver=letsencrypt"
      - "traefik.http.services.${serviceName}.loadbalancer.server.port=8080"

# Use existing network
networks:
  masterclaw-network:
    external: true
`;
}

function generateMonitoringTemplate(options) {
  return `# Monitoring Configuration for MasterClaw
# Generated: ${new Date().toISOString()}
#
# Add these rules to monitoring/alert_rules.yml

groups:
  - name: masterclaw-custom
    rules:
      # Custom alert: High memory usage
      - alert: MasterClawHighMemoryUsage
        expr: container_memory_usage_bytes{name="mc-core"} / container_spec_memory_limit_bytes > 0.85
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "MasterClaw Core high memory usage"
          description: "Memory usage is above 85% for more than 5 minutes"
      
      # Custom alert: API latency
      - alert: MasterClawHighLatency
        expr: histogram_quantile(0.95, rate(masterclaw_http_request_duration_seconds_bucket[5m])) > 1
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "MasterClaw API high latency"
          description: "95th percentile latency is above 1 second"
      
      # Custom alert: Session count
      - alert: MasterClawTooManySessions
        expr: masterclaw_active_sessions > 1000
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "High number of active sessions"
          description: "Active sessions exceed 1000"

# Dashboard configuration (for Grafana)
dashboards:
  - name: "MasterClaw Custom"
    panels:
      - title: "Custom Metric"
        targets:
          - expr: "up{job=\"masterclaw\"}"
`;
}

function generateBackupTemplate(options) {
  return `# Backup Configuration for MasterClaw
# Generated: ${new Date().toISOString()}
#
# Add these settings to your .env file or use as standalone config

# ==========================================
# Local Backup Settings
# ==========================================

# Retention period in days
RETENTION_DAYS=14

# Backup schedule (cron format)
BACKUP_SCHEDULE="0 2 * * *"

# Backup directory
BACKUP_DIR=/opt/masterclaw/backups

# ==========================================
# Cloud Backup Settings
# ==========================================

# Cloud provider: s3, gcs, or azure
CLOUD_BACKUP_PROVIDER=s3

# Bucket name
CLOUD_BACKUP_BUCKET=masterclaw-backups

# Path prefix within bucket
CLOUD_BACKUP_PREFIX=production

# Region
CLOUD_BACKUP_REGION=us-east-1

# Retention in cloud (days)
CLOUD_BACKUP_RETENTION_DAYS=90

# Enable encryption
CLOUD_BACKUP_ENCRYPTION=true

# ==========================================
# AWS S3 Credentials (if using S3)
# ==========================================
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
AWS_DEFAULT_REGION=us-east-1

# Or use IAM role/instance profile:
# AWS_PROFILE=default

# ==========================================
# Google Cloud Storage (if using GCS)
# ==========================================
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
# GOOGLE_CLOUD_PROJECT=your-project-id

# ==========================================
# Azure Blob Storage (if using Azure)
# ==========================================
# AZURE_STORAGE_ACCOUNT=masterclawstorage
# AZURE_STORAGE_KEY=your-storage-key

# ==========================================
# Notification Settings
# ==========================================

# Notify on backup success/failure
BACKUP_NOTIFY_ON_SUCCESS=false
BACKUP_NOTIFY_ON_FAILURE=true

# Notification channels (comma-separated)
# BACKUP_NOTIFY_CHANNELS=discord,slack,email
`;
}

// =============================================================================
// Utility Functions
// =============================================================================

function generateRandomToken(length = 32) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = 'mc_';
  for (let i = 0; i < length - 3; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function getTemplateChoices() {
  return Object.entries(TEMPLATES).map(([key, template]) => ({
    name: `${template.name} - ${template.description}`,
    value: key,
  }));
}

// =============================================================================
// Commands
// =============================================================================

/**
 * List available templates
 */
templateCmd
  .command('list')
  .description('List all available configuration templates')
  .action(wrapCommand(async () => {
    console.log(chalk.bold('🐾 Available Configuration Templates'));
    console.log(chalk.gray('─'.repeat(60)));
    console.log();

    for (const [key, template] of Object.entries(TEMPLATES)) {
      console.log(`${chalk.cyan(key.padEnd(20))} ${chalk.bold(template.name)}`);
      console.log(`${''.padEnd(20)} ${chalk.gray(template.description)}`);
      console.log(`${''.padEnd(20)} Output: ${chalk.yellow(template.filename)}`);
      console.log();
    }

    console.log(chalk.gray('Use: mc template generate <name> to create a template'));
  }));

/**
 * Generate a template
 */
templateCmd
  .command('generate <template>')
  .description('Generate a configuration template')
  .option('-o, --output <path>', 'Output file path (default: template default)')
  .option('--force', 'Overwrite existing file')
  .option('--interactive', 'Interactive mode with prompts')
  .action(wrapCommand(async (templateName, options) => {
    // Validate template name
    if (!TEMPLATES[templateName]) {
      console.log(chalk.red(`❌ Unknown template: ${templateName}`));
      console.log();
      console.log(chalk.bold('Available templates:'));
      for (const key of Object.keys(TEMPLATES)) {
        console.log(`  • ${chalk.cyan(key)}`);
      }
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const template = TEMPLATES[templateName];
    const answers = {};

    // Interactive mode
    if (options.interactive) {
      console.log(chalk.bold(`🐾 Generating ${template.name}`));
      console.log();

      const questions = [];

      if (['env', 'terraform-vars'].includes(templateName)) {
        questions.push(
          {
            type: 'input',
            name: 'domain',
            message: 'Domain name:',
            default: 'mc.example.com',
          },
          {
            type: 'input',
            name: 'email',
            message: 'Admin email:',
            default: 'admin@example.com',
          }
        );
      }

      if (templateName === 'terraform-vars') {
        questions.push(
          {
            type: 'list',
            name: 'environment',
            message: 'Environment:',
            choices: ['dev', 'staging', 'prod'],
            default: 'dev',
          },
          {
            type: 'input',
            name: 'awsRegion',
            message: 'AWS Region:',
            default: 'us-east-1',
          }
        );
      }

      if (['env', 'terraform-vars'].includes(templateName)) {
        questions.push(
          {
            type: 'input',
            name: 'openaiKey',
            message: 'OpenAI API Key (optional):',
            default: '',
          },
          {
            type: 'input',
            name: 'anthropicKey',
            message: 'Anthropic API Key (optional):',
            default: '',
          }
        );
      }

      if (templateName === 'service') {
        questions.push({
          type: 'input',
          name: 'serviceName',
          message: 'Service name:',
          default: 'my-service',
        });
      }

      const responses = await inquirer.prompt(questions);
      Object.assign(answers, responses);
    }

    // Generate content
    const content = template.generate(answers);

    // Determine output path
    const outputPath = options.output || template.filename;

    // Check if file exists
    if (await fs.pathExists(outputPath) && !options.force) {
      console.log(chalk.yellow(`⚠️  File already exists: ${outputPath}`));
      console.log(chalk.gray('Use --force to overwrite'));
      process.exit(ExitCode.GENERAL_ERROR);
    }

    // Write file
    await fs.writeFile(outputPath, content, 'utf8');

    console.log(chalk.green(`✅ Generated ${template.name}`));
    console.log(chalk.gray(`   File: ${outputPath}`));
    console.log();
    console.log(chalk.bold('Next steps:'));
    
    if (templateName === 'env') {
      console.log(chalk.gray('   1. Edit the file and fill in your API keys'));
      console.log(chalk.gray('   2. Run: mc validate to verify configuration'));
    } else if (templateName === 'terraform-vars') {
      console.log(chalk.gray('   1. Review and customize the variables'));
      console.log(chalk.gray('   2. Run: mc terraform init -e dev'));
    } else if (templateName === 'docker-override') {
      console.log(chalk.gray('   1. Customize for your development needs'));
      console.log(chalk.gray('   2. Docker Compose will auto-load this file'));
    }
  }));

/**
 * Interactive template wizard
 */
templateCmd
  .command('wizard')
  .description('Interactive wizard for generating configurations')
  .action(wrapCommand(async () => {
    console.log(chalk.bold('🐾 MasterClaw Configuration Wizard'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'template',
        message: 'What would you like to generate?',
        choices: getTemplateChoices(),
      },
      {
        type: 'confirm',
        name: 'interactive',
        message: 'Use interactive mode with prompts?',
        default: true,
      },
    ]);

    // Call generate with the selected template
    const generateCmd = templateCmd.commands.find(cmd => cmd.name() === 'generate');
    if (generateCmd) {
      process.argv = ['node', 'mc', 'template', 'generate', answers.template];
      if (answers.interactive) {
        process.argv.push('--interactive');
      }
      await templateCmd.parseAsync(process.argv);
    }
  }));

/**
 * Show template details
 */
templateCmd
  .command('show <template>')
  .description('Show template details and example output')
  .action(wrapCommand(async (templateName) => {
    if (!TEMPLATES[templateName]) {
      console.log(chalk.red(`❌ Unknown template: ${templateName}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }

    const template = TEMPLATES[templateName];
    
    console.log(chalk.bold(`🐾 ${template.name}`));
    console.log(chalk.gray('─'.repeat(50)));
    console.log();
    console.log(`Description: ${template.description}`);
    console.log(`Output file: ${chalk.yellow(template.filename)}`);
    console.log();
    console.log(chalk.bold('Example output:'));
    console.log(chalk.gray('─'.repeat(50)));
    
    const example = template.generate({});
    // Show first 50 lines
    const lines = example.split('\n').slice(0, 50);
    console.log(lines.join('\n'));
    
    if (example.split('\n').length > 50) {
      console.log(chalk.gray('\n... (truncated, use generate to see full output)'));
    }
  }));

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  templateCmd,
  TEMPLATES,
};
