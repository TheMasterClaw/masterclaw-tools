#!/usr/bin/env node
/**
 * mc k8s - Kubernetes deployment management for MasterClaw
 * 
 * Provides CLI commands to deploy, manage, and monitor MasterClaw
 * on Kubernetes clusters using kubectl, kustomize, or Helm.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { execSync, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');

const { findInfraDir } = require('./services');
const { wrapCommand, ExitCode } = require('./error-handler');
const logger = require('./logger').child('k8s');

// =============================================================================
// Security Constants
// =============================================================================

/** Valid Kubernetes component names (whitelist) */
const VALID_COMPONENTS = ['core', 'backend', 'gateway', 'interface', 'chroma', 'traefik', 'watchtower'];

/** Valid Kubernetes service names (whitelist) */
const VALID_SERVICES = ['core', 'backend', 'gateway', 'interface', 'chroma', 'traefik', 'watchtower'];

/** Maximum namespace length per DNS RFC 1123 */
const MAX_NAMESPACE_LENGTH = 63;

/** Minimum namespace length */
const MIN_NAMESPACE_LENGTH = 1;

/** Maximum replica count (prevent resource exhaustion) */
const MAX_REPLICAS = 100;

/** Minimum replica count */
const MIN_REPLICAS = 0;

/** Minimum port number (privileged ports require root) */
const MIN_PORT = 1024;

/** Maximum port number */
const MAX_PORT = 65535;

/** Shell metacharacters that could enable command injection */
const SHELL_METACHARACTERS = /[;|&`$(){}[\]\\<>*?!~\n\r]/;

/** Extended blocked commands for exec validation */
const BLOCKED_EXEC_COMMANDS = [
  'rm', 'dd', 'mkfs', 'fdisk', 'format', 'del', 'erase',
  'shutdown', 'reboot', 'halt', 'poweroff', 'init',
  'mount', 'umount', 'fsck', 'parted', 'gparted',
  'wget', 'curl', 'nc', 'netcat', 'ncat',
  'bash', 'sh', 'zsh', 'fish', 'csh', 'tcsh',
  'python', 'python2', 'python3', 'perl', 'ruby', 'php', 'node', 'nodejs',
];

/** Valid environment names */
const VALID_ENV_NAMES = ['dev', 'development', 'staging', 'prod', 'production', 'test'];

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates a Kubernetes namespace name
 * Prevents command injection and ensures DNS compliance
 * @param {string} namespace - Namespace to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateNamespace(namespace) {
  if (namespace === null || namespace === undefined) {
    return { valid: false, error: 'Namespace is required' };
  }

  if (typeof namespace !== 'string') {
    return { valid: false, error: `Namespace must be a string, got ${typeof namespace}` };
  }

  // Don't trim - spaces should make it invalid per tests
  if (namespace.length === 0) {
    return { valid: false, error: 'Namespace is required' };
  }

  // Check for shell metacharacters first (command injection prevention)
  if (SHELL_METACHARACTERS.test(namespace)) {
    return { valid: false, error: 'Namespace contains invalid characters (metacharacters)' };
  }

  // Check length constraints
  if (namespace.length < MIN_NAMESPACE_LENGTH) {
    return { valid: false, error: 'Namespace is required' };
  }

  if (namespace.length > MAX_NAMESPACE_LENGTH) {
    return { valid: false, error: `Namespace exceeds maximum length of ${MAX_NAMESPACE_LENGTH} characters` };
  }

  // Check for valid DNS label pattern (RFC 1123)
  // Must start/end with alphanumeric, contain only alphanumeric or hyphen, lowercase only
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace)) {
    return { valid: false, error: 'Namespace must be a valid DNS label (alphanumeric and hyphens only, cannot start/end with hyphen)' };
  }

  return { valid: true };
}

/**
 * Validates a component name against whitelist (case-insensitive)
 * @param {string} component - Component name to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateComponent(component) {
  if (!component || typeof component !== 'string') {
    return { valid: false, error: 'Component name is required' };
  }

  const trimmed = component.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Component name is required' };
  }

  // Check whitelist (case-insensitive)
  if (!VALID_COMPONENTS.includes(trimmed)) {
    return { valid: false, error: `Invalid component '${trimmed}'. Valid: ${VALID_COMPONENTS.join(', ')}` };
  }

  return { valid: true };
}

/**
 * Validates a service name against whitelist (case-insensitive)
 * @param {string} service - Service name to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateService(service) {
  if (!service || typeof service !== 'string') {
    return { valid: false, error: 'Service name is required' };
  }

  const trimmed = service.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Service name is required' };
  }

  // Check whitelist (case-insensitive)
  if (!VALID_SERVICES.includes(trimmed)) {
    return { valid: false, error: `Invalid service '${trimmed}'. Valid: ${VALID_SERVICES.join(', ')}` };
  }

  return { valid: true };
}

/**
 * Validates a port number (rejects privileged ports)
 * @param {number|string} port - Port to validate
 * @returns {Object} - { valid: boolean, port?: number, error?: string }
 */
function validatePort(port) {
  if (port === null || port === undefined || port === '') {
    return { valid: false, error: 'Port is required' };
  }

  const portNum = parseInt(port, 10);

  if (isNaN(portNum)) {
    return { valid: false, error: `Port must be a number, got: ${port}` };
  }

  if (portNum < 1 || portNum > 65535) {
    return { valid: false, error: `Port must be between 1 and 65535, got: ${portNum}` };
  }

  if (portNum < MIN_PORT) {
    return { valid: false, error: `Privileged ports (1-1023) are not allowed, got: ${portNum}` };
  }

  return { valid: true, port: portNum };
}

/**
 * Validates an exec command for security
 * Prevents command injection and blocks dangerous commands
 * @param {string} command - Command to validate
 * @returns {Object} - { valid: boolean, args?: string[], error?: string }
 */
function validateExecCommand(command) {
  if (!command || typeof command !== 'string') {
    return { valid: false, error: 'Command is required' };
  }

  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Command cannot be empty' };
  }

  // Split command into args for further validation and return
  const args = trimmed.split(/\s+/).filter(arg => arg.length > 0);
  const cmdName = args[0];

  // Check for shell metacharacters (more comprehensive check)
  const shellMetacharacters = /[;|&`$(){}[\]<>*?!~\n\r\\'"]/;
  if (shellMetacharacters.test(trimmed)) {
    return { valid: false, error: 'Command contains shell metacharacters' };
  }

  // Check for absolute paths (traversal prevention)
  if (cmdName.startsWith('/') || cmdName.startsWith('..')) {
    return { valid: false, error: 'Absolute paths are not allowed in commands' };
  }

  // Check for blocked commands (including dotted commands like mkfs.ext4)
  const cmdLower = cmdName.toLowerCase();
  for (const blocked of BLOCKED_EXEC_COMMANDS) {
    // Exact match or starts with blocked command followed by dot
    if (cmdLower === blocked || cmdLower.startsWith(`${blocked}.`)) {
      return { valid: false, error: `Command '${blocked}' is not allowed` };
    }
  }

  return { valid: true, args };
}

/**
 * Validates environment name (string-based)
 * @param {string} env - Environment name to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateEnvironment(env) {
  if (!env || typeof env !== 'string') {
    return { valid: false, error: 'Environment name is required' };
  }

  const trimmed = env.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, error: 'Environment name is required' };
  }

  // Check for shell metacharacters
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { valid: false, error: 'Environment contains invalid characters' };
  }

  // Check against valid environment names (case-insensitive)
  const validEnv = VALID_ENV_NAMES.find(e => e.toLowerCase() === trimmed);
  if (!validEnv) {
    return { valid: false, error: `Invalid environment '${trimmed}'. Valid: ${VALID_ENV_NAMES.join(', ')}` };
  }

  return { valid: true };
}

/**
 * Validates replica count
 * @param {number|string} replicas - Replica count
 * @returns {Object} - { valid: boolean, replicas?: number, error?: string }
 */
function validateReplicas(replicas) {
  if (replicas === null || replicas === undefined || replicas === '') {
    return { valid: false, error: 'Replica count is required' };
  }

  const count = parseInt(replicas, 10);

  if (isNaN(count)) {
    return { valid: false, error: `Replicas must be a number, got: ${replicas}` };
  }

  if (count < MIN_REPLICAS) {
    return { valid: false, error: 'Replicas must be non-negative' };
  }

  if (count > MAX_REPLICAS) {
    return { valid: false, error: `Maximum 100 replicas allowed, got ${count}` };
  }

  return { valid: true, replicas: count };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if a command exists in PATH
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a shell command with proper error handling
 */
async function execCommand(cmd, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });

    let stdout = '';
    let stderr = '';

    if (options.silent) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (code) => {
      if (code === 0 || options.ignoreError) {
        resolve({ code, stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Check prerequisites for k8s operations
 */
async function checkPrerequisites() {
  const checks = [
    { cmd: 'kubectl', name: 'kubectl', install: 'https://kubernetes.io/docs/tasks/tools/' },
  ];

  const missing = [];
  for (const check of checks) {
    if (!commandExists(check.cmd)) {
      missing.push(check);
    }
  }

  if (missing.length > 0) {
    console.log(chalk.red('❌ Missing required tools:'));
    for (const m of missing) {
      console.log(`   ${m.name}: ${m.install}`);
    }
    throw new Error('Prerequisites not met');
  }

  // Check cluster connectivity
  try {
    await execCommand('kubectl', ['cluster-info'], { silent: true });
  } catch {
    throw new Error('Cannot connect to Kubernetes cluster. Check your kubeconfig.');
  }
}

/**
 * Find k8s directory in infrastructure
 */
async function findK8sDir() {
  const infraDir = await findInfraDir();
  if (!infraDir) {
    throw new Error('MasterClaw infrastructure directory not found. Run from within the infrastructure directory.');
  }

  const k8sDir = path.join(infraDir, 'k8s');
  if (!await fs.pathExists(k8sDir)) {
    throw new Error(`Kubernetes directory not found: ${k8sDir}`);
  }

  return k8sDir;
}

/**
 * Get available environments from overlays
 */
async function getEnvironments(k8sDir) {
  const overlaysDir = path.join(k8sDir, 'overlays');
  if (!await fs.pathExists(overlaysDir)) {
    return ['base'];
  }

  const entries = await fs.readdir(overlaysDir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

/**
 * Check if Helm is available and charts exist
 */
async function hasHelmCharts(k8sDir) {
  const helmDir = path.join(k8sDir, 'helm', 'masterclaw');
  return await fs.pathExists(helmDir);
}

// =============================================================================
// Command Implementations
// =============================================================================

/**
 * Deploy MasterClaw to Kubernetes
 */
async function deploy(options) {
  await checkPrerequisites();
  const k8sDir = await findK8sDir();

  const environments = await getEnvironments(k8sDir);
  let { env, method, namespace } = options;

  // Validate namespace before use
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Interactive selection if not provided
  if (!env) {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'env',
      message: 'Select environment:',
      choices: environments,
      default: 'dev',
    }]);
    env = answer.env;
  }

  if (!method) {
    const hasHelm = await hasHelmCharts(k8sDir);
    const choices = hasHelm ? ['kustomize', 'helm'] : ['kustomize'];
    
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'method',
      message: 'Select deployment method:',
      choices,
      default: 'kustomize',
    }]);
    method = answer.method;
  }

  console.log(chalk.blue(`🚀 Deploying MasterClaw to ${env} using ${method}...`));
  console.log(chalk.gray(`   Namespace: ${namespace}`));
  console.log();

  // Create namespace if it doesn't exist
  console.log(chalk.gray('Creating namespace...'));
  await execCommand('kubectl', [
    'create', 'namespace', namespace,
    '--dry-run=client', '-o', 'yaml'
  ], { silent: true }).then(({ stdout }) => {
    return execCommand('kubectl', ['apply', '-f', '-'], {
      input: stdout,
      silent: true,
    });
  });

  if (method === 'helm') {
    await deployHelm(k8sDir, env, namespace, options);
  } else {
    await deployKustomize(k8sDir, env, namespace, options);
  }

  console.log();
  console.log(chalk.green('✅ Deployment complete!'));
  console.log();
  console.log(chalk.blue('📊 Checking rollout status...'));
  
  try {
    await execCommand('kubectl', [
      'rollout', 'status', 'deployment',
      '-n', namespace,
      '-l', 'app.kubernetes.io/name=masterclaw',
      '--timeout', '300s',
    ]);
  } catch {
    console.log(chalk.yellow('⚠️  Some deployments may still be starting...'));
  }

  console.log();
  console.log(chalk.blue('🐾 MasterClaw is deployed!'));
  console.log();
  console.log('Services:');
  await execCommand('kubectl', [
    'get', 'services',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
  ]);
  
  console.log();
  console.log(chalk.gray('Useful commands:'));
  console.log(`  kubectl get pods -n ${namespace}`);
  console.log(`  kubectl logs -n ${namespace} -l app.kubernetes.io/component=core`);
  console.log(`  kubectl port-forward -n ${namespace} svc/core 8000:8000`);
}

/**
 * Deploy using Helm
 */
async function deployHelm(k8sDir, env, namespace, options) {
  const helmDir = path.join(k8sDir, 'helm', 'masterclaw');
  const valuesFile = path.join(helmDir, `values.${env}.yaml`);
  
  const args = [
    'upgrade', '--install',
    'masterclaw',
    helmDir,
    '--namespace', namespace,
  ];

  // Use environment-specific values if exists
  if (await fs.pathExists(valuesFile)) {
    args.push('--values', valuesFile);
    console.log(chalk.gray(`Using values: ${valuesFile}`));
  } else {
    args.push('--values', path.join(helmDir, 'values.yaml'));
  }

  // Set environment
  args.push('--set', `config.environment=${env}`);

  if (options.dryRun) {
    args.push('--dry-run');
    console.log(chalk.yellow('📋 Dry run mode - showing what would be deployed:'));
  }

  await execCommand('helm', args);
}

/**
 * Deploy using Kustomize
 */
async function deployKustomize(k8sDir, env, namespace, options) {
  const overlayDir = path.join(k8sDir, 'overlays', env);
  
  // Check if overlay exists
  if (!await fs.pathExists(overlayDir)) {
    throw new Error(`Environment overlay not found: ${overlayDir}`);
  }

  const args = ['apply', '-k', overlayDir];

  if (options.dryRun) {
    console.log(chalk.yellow('📋 Dry run mode - showing what would be deployed:'));
    await execCommand('kubectl', ['kustomize', overlayDir]);
    return;
  }

  await execCommand('kubectl', args);
}

/**
 * Delete MasterClaw from Kubernetes
 */
async function deleteDeployment(options) {
  await checkPrerequisites();
  const k8sDir = await findK8sDir();

  const environments = await getEnvironments(k8sDir);
  let { env, method, namespace } = options;

  // Validate namespace before use
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  if (!env) {
    const answer = await inquirer.prompt([{
      type: 'list',
      name: 'env',
      message: 'Select environment to delete:',
      choices: environments,
    }]);
    env = answer.env;
  }

  // Confirm deletion
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.red(`Are you sure you want to delete MasterClaw from ${env}?`),
    default: false,
  }]);

  if (!confirm) {
    console.log(chalk.yellow('Deletion cancelled.'));
    return;
  }

  console.log(chalk.red(`🗑️  Deleting MasterClaw from ${env}...`));

  if (method === 'helm') {
    await execCommand('helm', [
      'uninstall', 'masterclaw',
      '--namespace', namespace,
    ]).catch(() => {});
  } else {
    const overlayDir = path.join(k8sDir, 'overlays', env);
    await execCommand('kubectl', ['delete', '-k', overlayDir]).catch(() => {});
  }

  console.log(chalk.green('✅ Deployment deleted'));
}

/**
 * Show deployment status
 */
async function status(options) {
  await checkPrerequisites();
  
  const { namespace } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  console.log(chalk.blue('🐾 MasterClaw Kubernetes Status'));
  console.log(chalk.gray(`Namespace: ${namespace}`));
  console.log();

  // Check if namespace exists
  try {
    await execCommand('kubectl', ['get', 'namespace', namespace], { silent: true });
  } catch {
    console.log(chalk.red(`❌ Namespace ${namespace} not found`));
    return;
  }

  console.log(chalk.blue('📦 Pods:'));
  await execCommand('kubectl', [
    'get', 'pods',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
    '-o', 'wide',
  ]);

  console.log();
  console.log(chalk.blue('🔄 Deployments:'));
  await execCommand('kubectl', [
    'get', 'deployments',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
  ]);

  console.log();
  console.log(chalk.blue('🔧 Services:'));
  await execCommand('kubectl', [
    'get', 'services',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
  ]);

  console.log();
  console.log(chalk.blue('🌐 Ingress:'));
  await execCommand('kubectl', [
    'get', 'ingress',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
  ]).catch(() => {
    console.log(chalk.gray('No ingress found'));
  });

  // Show resource usage if metrics-server is available
  console.log();
  console.log(chalk.blue('📊 Resource Usage:'));
  await execCommand('kubectl', [
    'top', 'pods',
    '-n', namespace,
    '-l', 'app.kubernetes.io/name=masterclaw',
  ]).catch(() => {
    console.log(chalk.gray('Metrics not available (metrics-server not installed?)'));
  });
}

/**
 * View logs from Kubernetes pods
 */
async function logs(options) {
  await checkPrerequisites();
  
  const { namespace, component, follow, since, tail } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate component if provided
  if (component) {
    const compValidation = validateComponent(component);
    if (!compValidation.valid) {
      console.log(chalk.red(`❌ Invalid component: ${compValidation.error}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
  }

  const args = [
    'logs',
    '-n', namespace,
    '-l', component 
      ? `app.kubernetes.io/component=${component}`
      : 'app.kubernetes.io/name=masterclaw',
  ];

  if (follow) args.push('-f');
  if (since) args.push(`--since=${since}`);
  if (tail) args.push(`--tail=${tail}`);

  console.log(chalk.blue(`📜 Logs from ${component || 'all'} pods`));
  
  await execCommand('kubectl', args);
}

/**
 * Execute command in a pod
 */
async function exec(options) {
  await checkPrerequisites();
  
  const { namespace, component, command } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate component
  const compValidation = validateComponent(component);
  if (!compValidation.valid) {
    console.log(chalk.red(`❌ Invalid component: ${compValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate command
  const cmdValidation = validateExecCommand(command);
  if (!cmdValidation.valid) {
    console.log(chalk.red(`❌ Invalid command: ${cmdValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Find a pod for the component
  const { stdout } = await execCommand('kubectl', [
    'get', 'pods',
    '-n', namespace,
    '-l', `app.kubernetes.io/component=${component}`,
    '-o', 'jsonpath={.items[0].metadata.name}',
  ], { silent: true });

  const podName = stdout.trim();
  if (!podName) {
    throw new Error(`No pod found for component: ${component}`);
  }

  console.log(chalk.blue(`🔧 Executing in ${podName}:`));
  console.log(chalk.gray(`$ ${command}`));
  console.log();

  await execCommand('kubectl', [
    'exec',
    '-n', namespace,
    podName,
    '-it',
    '--',
    ...command.split(' '),
  ]);
}

/**
 * Port forward to a service
 */
async function portForward(options) {
  await checkPrerequisites();
  
  const { namespace, service, localPort, remotePort } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate service
  const svcValidation = validateService(service);
  if (!svcValidation.valid) {
    console.log(chalk.red(`❌ Invalid service: ${svcValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate ports
  const localPortValidation = validatePort(localPort);
  if (!localPortValidation.valid) {
    console.log(chalk.red(`❌ Invalid local port: ${localPortValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  const remotePortValidation = validatePort(remotePort);
  if (!remotePortValidation.valid) {
    console.log(chalk.red(`❌ Invalid remote port: ${remotePortValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  console.log(chalk.blue(`🔌 Port forwarding ${service}:${remotePort} to localhost:${localPort}`));
  console.log(chalk.gray('Press Ctrl+C to stop'));
  console.log();

  await execCommand('kubectl', [
    'port-forward',
    '-n', namespace,
    `svc/${service}`,
    `${localPort}:${remotePort}`,
  ]);
}

/**
 * Scale deployments
 */
async function scale(options) {
  await checkPrerequisites();
  
  const { namespace, component, replicas } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate component if provided
  if (component) {
    const compValidation = validateComponent(component);
    if (!compValidation.valid) {
      console.log(chalk.red(`❌ Invalid component: ${compValidation.error}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
  }

  // Validate replicas
  const replicasValidation = validateReplicas(replicas);
  if (!replicasValidation.valid) {
    console.log(chalk.red(`❌ Invalid replica count: ${replicasValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  const deploymentName = component ? `mc-${component}` : 'masterclaw';

  console.log(chalk.blue(`📏 Scaling ${deploymentName} to ${replicas} replicas...`));

  await execCommand('kubectl', [
    'scale',
    'deployment',
    deploymentName,
    '-n', namespace,
    `--replicas=${replicas}`,
  ]);

  console.log(chalk.green('✅ Scaled successfully'));

  // Show new status
  await execCommand('kubectl', [
    'get', 'deployment',
    deploymentName,
    '-n', namespace,
  ]);
}

/**
 * Update images (rolling restart)
 */
async function updateImages(options) {
  await checkPrerequisites();
  
  const { namespace, component } = options;

  // Validate namespace
  const nsValidation = validateNamespace(namespace);
  if (!nsValidation.valid) {
    console.log(chalk.red(`❌ Invalid namespace: ${nsValidation.error}`));
    process.exit(ExitCode.INVALID_ARGUMENTS);
  }

  // Validate component if provided
  if (component) {
    const compValidation = validateComponent(component);
    if (!compValidation.valid) {
      console.log(chalk.red(`❌ Invalid component: ${compValidation.error}`));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
  }

  console.log(chalk.blue('🔄 Updating images...'));

  const args = [
    'rollout', 'restart',
    'deployment',
    '-n', namespace,
  ];

  if (component) {
    args.push(`mc-${component}`);
  } else {
    args.push('-l', 'app.kubernetes.io/name=masterclaw');
  }

  await execCommand('kubectl', args);

  console.log(chalk.green('✅ Rollout started'));
  console.log(chalk.gray('Monitor with: kubectl rollout status deployment -n ' + namespace));
}

/**
 * Show K8s cluster info
 */
async function clusterInfo() {
  await checkPrerequisites();

  console.log(chalk.blue('☸️  Kubernetes Cluster Info'));
  console.log();

  console.log(chalk.blue('Cluster:'));
  await execCommand('kubectl', ['cluster-info']);

  console.log();
  console.log(chalk.blue('Nodes:'));
  await execCommand('kubectl', ['get', 'nodes', '-o', 'wide']);

  console.log();
  console.log(chalk.blue('Storage Classes:'));
  await execCommand('kubectl', ['get', 'storageclass']).catch(() => {
    console.log(chalk.gray('No storage classes found'));
  });

  console.log();
  console.log(chalk.blue('Ingress Controllers:'));
  await execCommand('kubectl', [
    'get', 'pods',
    '--all-namespaces',
    '-l', 'app.kubernetes.io/name in (traefik, nginx-ingress, ingress-nginx)',
  ]).catch(() => {
    console.log(chalk.gray('No common ingress controllers found'));
  });
}

/**
 * Validate Helm values against schema
 */
async function validateValues(options) {
  const k8sDir = await findK8sDir();
  const helmDir = path.join(k8sDir, 'helm', 'masterclaw');
  const schemaFile = path.join(helmDir, 'values.schema.json');
  
  // Check if Helm chart exists
  if (!await fs.pathExists(helmDir)) {
    throw new Error(`Helm chart not found at: ${helmDir}`);
  }

  // Check if schema exists
  if (!await fs.pathExists(schemaFile)) {
    console.log(chalk.yellow('⚠️  values.schema.json not found. Validation requires the schema file.'));
    console.log(chalk.gray('   Schema file should be at: ') + schemaFile);
    return;
  }

  const { valuesFile } = options;
  const filesToValidate = [];

  // Determine which files to validate
  if (valuesFile) {
    // Validate specific file
    if (!await fs.pathExists(valuesFile)) {
      throw new Error(`Values file not found: ${valuesFile}`);
    }
    filesToValidate.push(valuesFile);
  } else {
    // Auto-detect values files
    const entries = await fs.readdir(helmDir);
    for (const entry of entries) {
      if (entry.startsWith('values') && entry.endsWith('.yaml')) {
        filesToValidate.push(path.join(helmDir, entry));
      }
    }
  }

  if (filesToValidate.length === 0) {
    console.log(chalk.yellow('⚠️  No values files found to validate'));
    return;
  }

  console.log(chalk.blue('🔍 Validating Helm values against schema...'));
  console.log(chalk.gray(`Schema: ${schemaFile}`));
  console.log();

  let hasErrors = false;

  for (const file of filesToValidate) {
    const fileName = path.basename(file);
    console.log(chalk.blue(`📋 ${fileName}`));

    try {
      // Use helm lint for basic validation
      const { code, stdout, stderr } = await execCommand('helm', [
        'lint',
        helmDir,
        '--values', file,
        '--strict',
      ], { silent: true, ignoreError: true });

      if (code === 0) {
        console.log(chalk.green('  ✅ Helm lint passed'));
      } else {
        console.log(chalk.yellow('  ⚠️  Helm lint warnings:'));
        console.log(chalk.gray(stdout || stderr));
        hasErrors = true;
      }

      // Additional YAML validation
      const yamlContent = await fs.readFile(file, 'utf8');
      
      // Check for common issues
      const issues = [];
      
      // Check for empty required secrets
      if (yamlContent.includes('openaiApiKey: ""') || 
          yamlContent.match(/openaiApiKey:\s*$/m)) {
        issues.push('  ⚠️  OpenAI API key is empty (secrets.openaiApiKey)');
      }
      
      if (yamlContent.includes('anthropicApiKey: ""') || 
          yamlContent.match(/anthropicApiKey:\s*$/m)) {
        issues.push('  ⚠️  Anthropic API key is empty (secrets.anthropicApiKey)');
      }
      
      if (yamlContent.includes('gatewayToken: ""') || 
          yamlContent.match(/gatewayToken:\s*$/m)) {
        issues.push('  ⚠️  Gateway token is empty (secrets.gatewayToken)');
      }

      // Check resource limits
      if (!yamlContent.includes('limits:') || 
          yamlContent.match(/limits:\s*$/m)) {
        issues.push('  ⚠️  Resource limits not properly configured');
      }

      // Check persistence
      if (!yamlContent.includes('persistence:')) {
        issues.push('  ⚠️  Persistence configuration missing');
      }

      // Check ingress hosts
      const hostMatches = yamlContent.match(/hosts:\s*\n((?:\s+\w+:\s*\S+\n)+)/);
      if (hostMatches) {
        const hostsSection = hostMatches[1];
        if (hostsSection.includes('.local') || hostsSection.includes('example.com')) {
          issues.push('  ⚠️  Ingress hosts use default/example values');
        }
      }

      if (issues.length > 0) {
        console.log(chalk.yellow('  Configuration issues found:'));
        issues.forEach(issue => console.log(chalk.gray(issue)));
        hasErrors = true;
      } else {
        console.log(chalk.green('  ✅ No common configuration issues found'));
      }

      // Try to render templates to catch rendering errors
      const { code: templateCode, stderr: templateErr } = await execCommand('helm', [
        'template',
        'masterclaw',
        helmDir,
        '--values', file,
        '--skip-tests',
      ], { silent: true, ignoreError: true });

      if (templateCode === 0) {
        console.log(chalk.green('  ✅ Template rendering passed'));
      } else {
        console.log(chalk.red('  ❌ Template rendering failed:'));
        console.log(chalk.gray(templateErr || 'Unknown error'));
        hasErrors = true;
      }

    } catch (error) {
      console.log(chalk.red(`  ❌ Validation error: ${error.message}`));
      hasErrors = true;
    }

    console.log();
  }

  // Summary
  console.log(chalk.blue('📊 Validation Summary'));
  console.log(`Files checked: ${filesToValidate.length}`);
  
  if (hasErrors) {
    console.log(chalk.yellow('⚠️  Issues found. Review warnings above.'));
    console.log();
    console.log(chalk.gray('Fix suggestions:'));
    console.log(chalk.gray('  - Set proper API keys in secrets section'));
    console.log(chalk.gray('  - Configure resource limits for all services'));
    console.log(chalk.gray('  - Update ingress hosts to your domain'));
    console.log(chalk.gray('  - Review persistence storage settings'));
    process.exit(1);
  } else {
    console.log(chalk.green('✅ All validations passed!'));
  }
}

// =============================================================================
// CLI Setup
// =============================================================================

const program = new Command();

program
  .name('k8s')
  .description('Manage MasterClaw Kubernetes deployments')
  .option('-n, --namespace <name>', 'Kubernetes namespace', 'masterclaw');

// Deploy command
program
  .command('deploy')
  .description('Deploy MasterClaw to Kubernetes')
  .option('-e, --env <environment>', 'Environment (dev, staging, prod)')
  .option('-m, --method <method>', 'Deployment method (kustomize, helm)', 'kustomize')
  .option('--dry-run', 'Show what would be deployed without applying')
  .action(wrapCommand(deploy, 'k8s deploy'));

// Delete command
program
  .command('delete')
  .description('Delete MasterClaw from Kubernetes')
  .option('-e, --env <environment>', 'Environment to delete')
  .option('-m, --method <method>', 'Deployment method (kustomize, helm)', 'kustomize')
  .action(wrapCommand(deleteDeployment, 'k8s delete'));

// Status command
program
  .command('status')
  .description('Show deployment status')
  .action(wrapCommand(status, 'k8s status'));

// Logs command
program
  .command('logs')
  .description('View pod logs')
  .option('-c, --component <name>', 'Component name (core, backend, gateway, interface)')
  .option('-f, --follow', 'Follow log output', false)
  .option('--since <duration>', 'Show logs since duration (e.g., 1h, 30m)')
  .option('--tail <lines>', 'Number of lines to show from the end', '100')
  .action(wrapCommand(logs, 'k8s logs'));

// Exec command
program
  .command('exec')
  .description('Execute command in a pod')
  .requiredOption('-c, --component <name>', 'Component name')
  .option('--command <cmd>', 'Command to execute', 'sh')
  .action(wrapCommand(exec, 'k8s exec'));

// Port-forward command
program
  .command('port-forward')
  .description('Forward local port to service')
  .requiredOption('-s, --service <name>', 'Service name')
  .option('-l, --local-port <port>', 'Local port', '8080')
  .option('-r, --remote-port <port>', 'Remote port', '80')
  .action(wrapCommand(portForward, 'k8s port-forward'));

// Scale command
program
  .command('scale')
  .description('Scale deployment replicas')
  .option('-c, --component <name>', 'Component to scale (core, backend, etc.)')
  .requiredOption('-r, --replicas <n>', 'Number of replicas')
  .action(wrapCommand(scale, 'k8s scale'));

// Update command
program
  .command('update')
  .description('Update/rollout deployments (rolling restart)')
  .option('-c, --component <name>', 'Component to update')
  .action(wrapCommand(updateImages, 'k8s update'));

// Cluster info command
program
  .command('cluster-info')
  .description('Show Kubernetes cluster information')
  .action(wrapCommand(clusterInfo, 'k8s cluster-info'));

// Validate command
program
  .command('validate')
  .description('Validate Helm values files against schema')
  .option('-f, --values-file <path>', 'Specific values file to validate')
  .action(wrapCommand(validateValues, 'k8s validate'));

module.exports = program;
module.exports.validateNamespace = validateNamespace;
module.exports.validateComponent = validateComponent;
module.exports.validateService = validateService;
module.exports.validatePort = validatePort;
module.exports.validateExecCommand = validateExecCommand;
module.exports.validateEnvironment = validateEnvironment;
module.exports.validateReplicas = validateReplicas;
module.exports.VALID_COMPONENTS = VALID_COMPONENTS;
module.exports.VALID_SERVICES = VALID_SERVICES;
module.exports.MAX_NAMESPACE_LENGTH = MAX_NAMESPACE_LENGTH;
