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

module.exports = program;
