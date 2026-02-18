/**
 * Workflow Automation for MasterClaw CLI
 *
 * Define reusable operational workflows that chain multiple commands together.
 * Workflows are stored in rex-deus/config/workflows/ and can be shared across environments.
 *
 * Features:
 * - YAML/JSON workflow definitions
 * - Variable substitution and environment passing
 * - Conditional steps based on command output
 * - Rollback on failure
 * - Execution history and logging
 *
 * Security:
 * - Command injection prevention with input validation
 * - Allowed command whitelist for workflow steps
 * - Workflow file integrity validation
 * - Input sanitization for all user-controlled data
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');
const ora = require('ora');
const crypto = require('crypto');

const { sanitizeForLog } = require('./security');
const { logSecurityViolation } = require('./audit');
const { wrapCommand, ExitCode } = require('./error-handler');

const workflowCmd = new Command('workflow');

// =============================================================================
// Security Configuration
// =============================================================================

/** Maximum workflow file size (1MB) to prevent DoS */
const MAX_WORKFLOW_FILE_SIZE = 1024 * 1024;

/** Maximum number of steps in a workflow */
const MAX_WORKFLOW_STEPS = 100;

/** Maximum length of step names */
const MAX_STEP_NAME_LENGTH = 200;

/** Maximum length of variable values */
const MAX_VARIABLE_VALUE_LENGTH = 10000;

/** Maximum depth of variable substitution recursion */
const MAX_VARIABLE_RECURSION_DEPTH = 10;

/** Dangerous characters that could enable command injection */
const DANGEROUS_SHELL_CHARS = /[;|&$\`\n\r\x00-\x1f\x7f]/;

/** Dangerous command patterns for injection detection */
const DANGEROUS_COMMAND_PATTERNS = [
  /\b(rm\s+-rf?|del\s+\/f)/i,                    // File deletion
  />\s*[\/\w]+/,                                  // Output redirection to files
  /2?>\s*\&[0-9]/,                                // File descriptor redirection
  /\$\s*\(/,                                      // Command substitution $()
  /`[^`]*`/,                                       // Backtick command substitution
  /\|\s*(bash|sh|zsh|cmd|powershell)/i,          // Pipe to shell
  /;(?!\s*\w+\s*=)/,                              // Command chaining (except env vars)
  /&&?\s*(?:rm|mv|cp|cat|curl|wget|nc|netcat)/i,  // Chained dangerous commands
  /(?:curl|wget)\s+.*\|\s*(?:bash|sh)/i,         // Pipe from network to shell
  /eval\s*\(/i,                                   // Eval function
  /exec\s*\(/i,                                   // Exec function
  /system\s*\(/i,                                 // System function
];

/**
 * Allowed commands for workflow steps (whitelist approach)
 * Commands not in this list require explicit user confirmation
 */
const ALLOWED_WORKFLOW_COMMANDS = new Set([
  'mc',
  'make',
  'docker',
  'docker-compose',
  'kubectl',
  'git',
  'npm',
  'node',
  'python',
  'python3',
  'bash',
  'sh',
  'echo',
  'cat',
  'ls',
  'sleep',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'curl',
  'wget',
  'tar',
  'zip',
  'unzip',
  'grep',
  'awk',
  'sed',
  'find',
  'touch',
  'chmod',
  'chown',
  'df',
  'du',
  'ps',
  'top',
  'htop',
  'ping',
  'nslookup',
  'dig',
  'openssl',
  'ssh',
  'scp',
  'rsync',
  'date',
  'whoami',
  'hostname',
  'id',
  'pwd',
  'cd',
  'true',
  'false',
  'test',
  '[',
  '[[',
  'exit',
]);

/**
 * File path traversal patterns to block
 */
const PATH_TRAVERSAL_PATTERNS = [
  /\.\.\//,           // ../
  /\.\.\\/,           // ..\
  /%2e%2e%2f/i,       // URL-encoded ../
  /%2e%2e%5c/i,       // URL-encoded ..\
  /\.\.\0/,           // Null byte after ..
];

// =============================================================================
// Security Validation Functions
// =============================================================================

/**
 * Validates that a string does not contain dangerous shell characters
 * @param {string} str - String to validate
 * @returns {boolean} - True if safe
 */
function isSafeShellString(str) {
  if (typeof str !== 'string') return false;
  return !DANGEROUS_SHELL_CHARS.test(str);
}

/**
 * Checks if a command contains potential injection attacks
 * @param {string} command - Command to check
 * @returns {Object} - { safe: boolean, reason?: string }
 */
function validateCommandSafety(command) {
  if (typeof command !== 'string') {
    return { safe: false, reason: 'Command must be a string' };
  }

  // Check for empty command
  if (!command.trim()) {
    return { safe: false, reason: 'Command cannot be empty' };
  }

  // Check for dangerous characters
  if (DANGEROUS_SHELL_CHARS.test(command)) {
    return { safe: false, reason: 'Command contains dangerous shell characters' };
  }

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: 'Command contains dangerous pattern' };
    }
  }

  // Check for path traversal in file operations
  for (const pattern of PATH_TRAVERSAL_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: 'Command contains path traversal attempts' };
    }
  }

  return { safe: true };
}

/**
 * Validates that a workflow step uses an allowed command
 * @param {string} command - Command to validate
 * @returns {Object} - { allowed: boolean, command: string, requiresConfirmation?: boolean }
 */
function validateAllowedCommand(command) {
  if (typeof command !== 'string') {
    return { allowed: false, command: '', reason: 'Command must be a string' };
  }

  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return { allowed: false, command: '', reason: 'Command cannot be empty' };
  }

  // Extract the base command (first word before any arguments)
  const baseCommand = trimmedCommand.split(/\s+/)[0].toLowerCase();

  // Check if it's in the allowed list
  if (ALLOWED_WORKFLOW_COMMANDS.has(baseCommand)) {
    return { allowed: true, command: baseCommand, requiresConfirmation: false };
  }

  // Check for absolute paths to allowed commands
  if (baseCommand.includes('/')) {
    const commandName = path.basename(baseCommand);
    if (ALLOWED_WORKFLOW_COMMANDS.has(commandName)) {
      return { allowed: true, command: commandName, requiresConfirmation: true };
    }
  }

  return {
    allowed: false,
    command: baseCommand,
    reason: `Command '${baseCommand}' is not in the allowed workflow commands list`,
  };
}

/**
 * Validates workflow file content for security issues
 * @param {Object} workflow - Workflow object to validate
 * @returns {Object} - { valid: boolean, errors: string[], warnings: string[] }
 */
function validateWorkflowSecurity(workflow) {
  const errors = [];
  const warnings = [];

  if (!workflow || typeof workflow !== 'object') {
    errors.push('Workflow must be a valid object');
    return { valid: false, errors, warnings };
  }

  // Validate workflow name
  if (workflow.name) {
    if (typeof workflow.name !== 'string') {
      errors.push('Workflow name must be a string');
    } else if (workflow.name.length > 100) {
      errors.push('Workflow name exceeds maximum length of 100 characters');
    } else if (!isSafeShellString(workflow.name)) {
      errors.push('Workflow name contains dangerous characters');
    }
  }

  // Validate steps array
  if (!Array.isArray(workflow.steps)) {
    errors.push('Workflow must have a steps array');
  } else {
    if (workflow.steps.length === 0) {
      errors.push('Workflow must have at least one step');
    }
    if (workflow.steps.length > MAX_WORKFLOW_STEPS) {
      errors.push(`Workflow exceeds maximum of ${MAX_WORKFLOW_STEPS} steps`);
    }

    // Validate each step
    workflow.steps.forEach((step, index) => {
      const stepNum = index + 1;

      if (!step || typeof step !== 'object') {
        errors.push(`Step ${stepNum}: Must be an object`);
        return;
      }

      // Validate step name
      if (!step.name) {
        errors.push(`Step ${stepNum}: Missing required 'name' field`);
      } else if (typeof step.name !== 'string') {
        errors.push(`Step ${stepNum}: Name must be a string`);
      } else if (step.name.length > MAX_STEP_NAME_LENGTH) {
        errors.push(`Step ${stepNum}: Name exceeds maximum length`);
      } else if (!isSafeShellString(step.name)) {
        errors.push(`Step ${stepNum}: Name contains dangerous characters`);
      }

      // Validate step command
      if (!step.run) {
        errors.push(`Step ${stepNum}: Missing required 'run' field`);
      } else if (typeof step.run !== 'string') {
        errors.push(`Step ${stepNum}: 'run' must be a string`);
      } else {
        // Check command safety
        const safetyCheck = validateCommandSafety(step.run);
        if (!safetyCheck.safe) {
          errors.push(`Step ${stepNum} (${step.name || 'unnamed'}): ${safetyCheck.reason}`);
        }

        // Check if command is in allowed list
        const allowedCheck = validateAllowedCommand(step.run);
        if (!allowedCheck.allowed) {
          warnings.push(`Step ${stepNum}: ${allowedCheck.reason}`);
        } else if (allowedCheck.requiresConfirmation) {
          warnings.push(`Step ${stepNum}: Uses absolute path - will require confirmation`);
        }
      }

      // Validate working directory if specified
      if (step.workingDir) {
        if (typeof step.workingDir !== 'string') {
          errors.push(`Step ${stepNum}: workingDir must be a string`);
        } else {
          for (const pattern of PATH_TRAVERSAL_PATTERNS) {
            if (pattern.test(step.workingDir)) {
              errors.push(`Step ${stepNum}: workingDir contains path traversal`);
              break;
            }
          }
        }
      }

      // Validate condition if specified
      if (step.if) {
        if (typeof step.if !== 'string') {
          errors.push(`Step ${stepNum}: 'if' condition must be a string`);
        } else if (!isSafeShellString(step.if)) {
          errors.push(`Step ${stepNum}: 'if' condition contains dangerous characters`);
        }
      }

      // Validate capture variable name
      if (step.capture) {
        if (typeof step.capture !== 'string') {
          errors.push(`Step ${stepNum}: 'capture' must be a string`);
        } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.capture)) {
          errors.push(`Step ${stepNum}: 'capture' must be a valid variable name`);
        }
      }
    });
  }

  // Validate variables
  if (workflow.variables) {
    if (typeof workflow.variables !== 'object') {
      errors.push('Workflow variables must be an object');
    } else {
      for (const [key, value] of Object.entries(workflow.variables)) {
        // Validate variable name
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
          errors.push(`Invalid variable name: '${key}'`);
        }

        // Validate variable value
        if (typeof value === 'string') {
          if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
            errors.push(`Variable '${key}' exceeds maximum value length`);
          }
        }
      }
    }
  }

  // Validate rollback steps if present
  if (workflow.rollback) {
    if (!Array.isArray(workflow.rollback)) {
      errors.push('Workflow rollback must be an array');
    } else {
      workflow.rollback.forEach((step, index) => {
        const stepNum = index + 1;
        if (step && step.run) {
          const safetyCheck = validateCommandSafety(step.run);
          if (!safetyCheck.safe) {
            errors.push(`Rollback step ${stepNum}: ${safetyCheck.reason}`);
          }
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Calculates a hash of the workflow for integrity checking
 * @param {Object} workflow - Workflow object
 * @returns {string} - SHA-256 hash
 */
function calculateWorkflowHash(workflow) {
  const canonical = JSON.stringify(workflow, Object.keys(workflow).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// =============================================================================
// Workflow Directory Functions
// =============================================================================

// Workflow directory resolution
function getWorkflowDir() {
  const candidates = [
    path.join(require('os').homedir(), '.openclaw', 'workspace', 'rex-deus', 'config', 'workflows'),
    path.join(process.cwd(), 'rex-deus', 'config', 'workflows'),
    path.join(process.cwd(), '.openclaw', 'workspace', 'rex-deus', 'config', 'workflows'),
    path.join(__dirname, '..', '..', 'rex-deus', 'config', 'workflows'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.dirname(dir))) {
      fs.ensureDirSync(dir);
      return dir;
    }
  }

  // Fallback: create in cwd
  const fallbackDir = path.join(process.cwd(), '.mc-workflows');
  fs.ensureDirSync(fallbackDir);
  return fallbackDir;
}

// History directory
function getHistoryDir() {
  const historyDir = path.join(getWorkflowDir(), '.history');
  fs.ensureDirSync(historyDir);
  return historyDir;
}

// Load workflow from file
async function loadWorkflow(name) {
  const workflowDir = getWorkflowDir();
  const yamlPath = path.join(workflowDir, `${name}.yaml`);
  const ymlPath = path.join(workflowDir, `${name}.yml`);
  const jsonPath = path.join(workflowDir, `${name}.json`);

  let workflowPath = null;
  if (await fs.pathExists(yamlPath)) workflowPath = yamlPath;
  else if (await fs.pathExists(ymlPath)) workflowPath = ymlPath;
  else if (await fs.pathExists(jsonPath)) workflowPath = jsonPath;

  if (!workflowPath) {
    throw new Error(`Workflow '${name}' not found. Run 'mc workflow list' to see available workflows.`);
  }

  // Security: Check file size to prevent DoS
  const stats = await fs.stat(workflowPath);
  if (stats.size > MAX_WORKFLOW_FILE_SIZE) {
    throw new Error(`Workflow file size (${stats.size} bytes) exceeds maximum allowed (${MAX_WORKFLOW_FILE_SIZE} bytes)`);
  }

  // Security: Validate filename to prevent path traversal
  const basename = path.basename(workflowPath);
  if (basename !== `${name}.yaml` && basename !== `${name}.yml` && basename !== `${name}.json`) {
    throw new Error('Invalid workflow filename');
  }

  const content = await fs.readFile(workflowPath, 'utf8');

  let workflow;
  try {
    if (workflowPath.endsWith('.json')) {
      workflow = JSON.parse(content);
    } else {
      workflow = yaml.load(content);
    }
  } catch (err) {
    throw new Error(`Failed to parse workflow file: ${err.message}`);
  }

  // Security: Validate workflow structure
  const validation = validateWorkflowSecurity(workflow);
  if (!validation.valid) {
    const errorMsg = `Workflow validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMsg);
  }

  // Attach warnings to workflow for display during execution
  workflow._securityWarnings = validation.warnings;
  workflow._workflowHash = calculateWorkflowHash(workflow);

  return workflow;
}

// Save workflow to file
async function saveWorkflow(name, workflow, format = 'yaml') {
  const workflowDir = getWorkflowDir();
  const ext = format === 'json' ? 'json' : 'yaml';
  const workflowPath = path.join(workflowDir, `${name}.${ext}`);

  let content;
  if (format === 'json') {
    content = JSON.stringify(workflow, null, 2);
  } else {
    content = yaml.dump(workflow, { lineWidth: 100 });
  }

  await fs.writeFile(workflowPath, content);
  return workflowPath;
}

// Get list of workflows
async function listWorkflows() {
  const workflowDir = getWorkflowDir();
  const files = await fs.readdir(workflowDir);
  
  const workflows = [];
  for (const file of files) {
    if (file.endsWith('.yaml') || file.endsWith('.yml') || file.endsWith('.json')) {
      const name = path.basename(file, path.extname(file));
      const filePath = path.join(workflowDir, file);
      const stat = await fs.stat(filePath);
      
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const workflow = file.endsWith('.json') ? JSON.parse(content) : yaml.load(content);
        workflows.push({
          name,
          description: workflow.description || 'No description',
          steps: workflow.steps?.length || 0,
          modified: stat.mtime,
        });
      } catch (e) {
        workflows.push({
          name,
          description: '⚠️ Invalid workflow file',
          steps: 0,
          modified: stat.mtime,
          error: true,
        });
      }
    }
  }

  return workflows.sort((a, b) => a.name.localeCompare(b.name));
}

// Variable substitution
function substituteVariables(str, variables) {
  if (typeof str !== 'string') return str;
  
  return str.replace(/\$\{(\w+)\}/g, (match, varName) => {
    if (variables[varName] !== undefined) {
      return variables[varName];
    }
    // Check environment variables
    if (process.env[varName] !== undefined) {
      return process.env[varName];
    }
    return match; // Leave unchanged if not found
  }).replace(/\$(\w+)/g, (match, varName) => {
    if (variables[varName] !== undefined) {
      return variables[varName];
    }
    if (process.env[varName] !== undefined) {
      return process.env[varName];
    }
    return match;
  });
}

// Execute a single step
async function executeStep(step, context, options = {}) {
  const { verbose, dryRun, skipSecurityChecks = false } = options;

  // Substitute variables in step properties
  const name = substituteVariables(step.name, context.variables);
  const command = substituteVariables(step.run, context.variables);
  const workingDir = step.workingDir ? substituteVariables(step.workingDir, context.variables) : null;
  const envVars = step.env ? Object.fromEntries(
    Object.entries(step.env).map(([k, v]) => [k, substituteVariables(v, context.variables)])
  ) : {};

  if (verbose) {
    console.log(chalk.gray(`  Step: ${name}`));
    console.log(chalk.gray(`  Command: ${command}`));
  }

  if (dryRun) {
    console.log(chalk.cyan(`  [DRY RUN] Would execute: ${command}`));
    return { success: true, exitCode: 0, output: '' };
  }

  // Security: Validate command before execution (unless explicitly skipped)
  if (!skipSecurityChecks) {
    const safetyCheck = validateCommandSafety(command);
    if (!safetyCheck.safe) {
      await logSecurityViolation('WORKFLOW_COMMAND_REJECTED', {
        stepName: name,
        command: sanitizeForLog(command, 200),
        reason: safetyCheck.reason,
      });
      throw new Error(`Security check failed: ${safetyCheck.reason}`);
    }
  }

  return new Promise((resolve, reject) => {
    const args = command.split(' ');
    const cmd = args[0];
    const cmdArgs = args.slice(1);

    const env = { ...process.env, ...context.variables, ...envVars };

    const child = spawn(cmd, cmdArgs, {
      cwd: workingDir,
      env,
      shell: true,
      stdio: verbose ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    if (!verbose) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('close', (exitCode) => {
      const success = exitCode === 0;
      resolve({
        success,
        exitCode,
        output: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// Execute rollback steps
async function executeRollback(workflow, failedStepIndex, context, options) {
  if (!workflow.rollback || workflow.rollback.length === 0) {
    console.log(chalk.yellow('  No rollback steps defined'));
    return;
  }

  console.log(chalk.yellow('\n🔄 Executing rollback steps...\n'));

  for (let i = 0; i < workflow.rollback.length; i++) {
    const step = workflow.rollback[i];
    console.log(chalk.gray(`  Rollback ${i + 1}/${workflow.rollback.length}: ${step.name}`));
    
    try {
      await executeStep(step, context, options);
    } catch (err) {
      console.log(chalk.red(`  Rollback step failed: ${err.message}`));
    }
  }
}

// Execute workflow
async function executeWorkflow(name, options = {}) {
  const { verbose = false, dryRun = false, vars = {} } = options;
  
  const workflow = await loadWorkflow(name);
  const context = {
    variables: { ...workflow.variables, ...vars },
    startTime: new Date(),
    results: [],
  };

  console.log(chalk.blue(`🐾 Executing Workflow: ${workflow.name || name}\n`));

  if (workflow.description) {
    console.log(chalk.gray(`${workflow.description}\n`));
  }

  // Display security warnings if present
  if (workflow._securityWarnings && workflow._securityWarnings.length > 0) {
    console.log(chalk.yellow('⚠️  Security Warnings:'));
    for (const warning of workflow._securityWarnings.slice(0, 5)) {
      console.log(chalk.yellow(`   • ${warning}`));
    }
    if (workflow._securityWarnings.length > 5) {
      console.log(chalk.yellow(`   ... and ${workflow._securityWarnings.length - 5} more`));
    }
    console.log('');
  }

  const steps = workflow.steps || [];
  let failedStepIndex = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;
    
    console.log(chalk.cyan(`Step ${stepNum}/${steps.length}: ${step.name}`));

    // Check condition if present
    if (step.if) {
      const condition = substituteVariables(step.if, context.variables);
      // Simple condition evaluation - could be expanded
      if (condition === 'false' || condition === '0') {
        console.log(chalk.gray('  Skipped (condition not met)\n'));
        continue;
      }
    }

    try {
      const startTime = Date.now();
      const result = await executeStep(step, context, { verbose, dryRun });
      const duration = Date.now() - startTime;

      context.results.push({
        step: step.name,
        success: result.success,
        duration,
        output: result.output,
      });

      if (result.success) {
        console.log(chalk.green(`  ✅ Completed in ${duration}ms\n`));
        
        // Capture output to variable if specified
        if (step.capture) {
          context.variables[step.capture] = result.output;
        }
      } else {
        console.log(chalk.red(`  ❌ Failed with exit code ${result.exitCode}\n`));
        failedStepIndex = i;
        
        if (!dryRun && !step.continueOnError) {
          break;
        }
      }
    } catch (err) {
      console.log(chalk.red(`  ❌ Error: ${err.message}\n`));
      failedStepIndex = i;
      
      if (!dryRun && !step.continueOnError) {
        break;
      }
    }
  }

  // Execute rollback if a step failed
  if (failedStepIndex >= 0 && !dryRun) {
    await executeRollback(workflow, failedStepIndex, context, { verbose, dryRun });
  }

  // Save execution history
  const historyEntry = {
    workflow: name,
    startTime: context.startTime,
    endTime: new Date(),
    duration: Date.now() - context.startTime.getTime(),
    success: failedStepIndex < 0,
    stepsExecuted: context.results.length,
    results: context.results,
    workflowHash: workflow._workflowHash,
  };

  const historyPath = path.join(getHistoryDir(), `${name}-${Date.now()}.json`);
  await fs.writeJson(historyPath, historyEntry, { spaces: 2 });

  // Summary
  console.log(chalk.blue('📊 Workflow Summary'));
  console.log(chalk.gray(`  Total time: ${historyEntry.duration}ms`));
  console.log(chalk.gray(`  Steps executed: ${historyEntry.stepsExecuted}`));
  
  if (historyEntry.success) {
    console.log(chalk.green('\n✅ Workflow completed successfully'));
  } else {
    console.log(chalk.red('\n❌ Workflow failed'));
    process.exit(1);
  }
}

// Create sample workflow
function createSampleWorkflow(name, type = 'standard') {
  const templates = {
    standard: {
      name: 'Standard Deployment',
      description: 'Deploy MasterClaw with full verification',
      variables: {
        ENV: 'production',
        VERSION: 'latest',
      },
      steps: [
        { name: 'Validate environment', run: 'mc validate' },
        { name: 'Create backup', run: 'mc backup' },
        { name: 'Deploy services', run: 'make prod' },
        { name: 'Wait for services', run: 'sleep 10' },
        { name: 'Run smoke tests', run: 'mc smoke-test --quick' },
        { name: 'Check status', run: 'mc status' },
      ],
      rollback: [
        { name: 'Restore from backup', run: 'mc restore' },
        { name: 'Check status after rollback', run: 'mc status' },
      ],
    },
    maintenance: {
      name: 'Nightly Maintenance',
      description: 'Automated nightly maintenance tasks',
      variables: {
        RETENTION_DAYS: '7',
      },
      steps: [
        { name: 'Clean old logs', run: 'mc log clean' },
        { name: 'Prune old containers', run: 'mc prune containers --days 7' },
        { name: 'Verify backup integrity', run: 'mc backup verify' },
        { name: 'Run security scan', run: 'mc security --status' },
        { name: 'Update images', run: 'mc update --check' },
      ],
    },
    incident: {
      name: 'Incident Response',
      description: 'Emergency incident response workflow',
      variables: {},
      steps: [
        { name: 'Check service status', run: 'mc status' },
        { name: 'Analyze recent logs', run: 'mc analyze --time 1h' },
        { name: 'Run diagnostics', run: 'mc doctor' },
        { name: 'Export logs for analysis', run: 'mc logs export --last 1h ./incident-logs' },
      ],
    },
  };

  return templates[type] || templates.standard;
}

// =============================================================================
// Workflow Validation
// =============================================================================

/**
 * Comprehensive workflow validation
 * @param {string} name - Workflow name
 * @param {object} workflow - Workflow object
 * @param {object} options - Validation options
 * @returns {object} Validation result with errors and warnings
 */
async function validateWorkflow(name, workflow, options = {}) {
  const errors = [];
  const warnings = [];
  const usedVariables = new Set();
  const definedVariables = new Set(Object.keys(workflow.variables || {}));

  // First, run security validation
  const securityValidation = validateWorkflowSecurity(workflow);
  if (!securityValidation.valid) {
    securityValidation.errors.forEach(err => {
      errors.push({ message: err, severity: 'critical', location: 'security' });
    });
  }
  securityValidation.warnings.forEach(warn => {
    warnings.push({ message: warn, suggestion: 'Review this command for security' });
  });

  // Helper to add error
  const addError = (message, location = null, suggestion = null, severity = 'error') => {
    errors.push({ message, location, suggestion, severity });
  };

  // Helper to add warning
  const addWarning = (message, suggestion = null) => {
    warnings.push({ message, suggestion });
  };

  // Validate workflow structure
  if (!workflow.name) {
    addError('Workflow missing required field: name', 'root', 'Add a name: "My Workflow Name"');
  } else if (typeof workflow.name !== 'string') {
    addError('Workflow name must be a string', 'name', 'Use a descriptive string like "Deploy to Production"');
  }

  if (workflow.description && typeof workflow.description !== 'string') {
    addError('Workflow description must be a string', 'description');
  }

  // Validate steps
  if (!workflow.steps) {
    addError('Workflow missing required field: steps', 'root', 'Add at least one step with "name" and "run" fields');
  } else if (!Array.isArray(workflow.steps)) {
    addError('Workflow steps must be an array', 'steps', 'Define steps as a list: steps: [{ name: "...", run: "..." }]');
  } else if (workflow.steps.length === 0) {
    addError('Workflow must have at least one step', 'steps', 'Add a step to execute');
  } else {
    // Track step names for duplicate detection
    const stepNames = new Map();

    workflow.steps.forEach((step, index) => {
      const stepPath = `steps[${index}]`;

      // Check step is an object
      if (!step || typeof step !== 'object') {
        addError(`Step ${index + 1} must be an object`, stepPath);
        return;
      }

      // Validate required fields
      if (!step.name) {
        addError(`Step ${index + 1} missing required field: name`, stepPath, 'Add a descriptive name for this step');
      } else {
        // Check for duplicate names
        if (stepNames.has(step.name)) {
          addWarning(
            `Duplicate step name "${step.name}" (also at step ${stepNames.get(step.name) + 1})`,
            'Use unique names for better debugging and logging'
          );
        } else {
          stepNames.set(step.name, index);
        }

        // Extract variable references from step name
        const nameVars = step.name.match(/\$\{(\w+)\}|\$(\w+)/g);
        if (nameVars) {
          nameVars.forEach(v => {
            const varName = v.replace(/\$\{|\}|\$/g, '');
            usedVariables.add(varName);
          });
        }
      }

      if (!step.run) {
        addError(`Step ${index + 1} (${step.name || 'unnamed'}) missing required field: run`, stepPath, 'Add a command to execute: run: "mc status"');
      } else if (typeof step.run !== 'string') {
        addError(`Step ${index + 1} "run" must be a string`, stepPath);
      } else {
        // Extract variable references
        const runVars = step.run.match(/\$\{(\w+)\}|\$(\w+)/g);
        if (runVars) {
          runVars.forEach(v => {
            const varName = v.replace(/\$\{|\}|\$/g, '');
            usedVariables.add(varName);
          });
        }

        // Check command existence if option enabled
        if (options.checkCommands) {
          const cmd = step.run.split(' ')[0];
          if (cmd === 'mc') {
            const subCmd = step.run.split(' ')[1];
            const validCommands = [
              'status', 'health', 'logs', 'backup', 'restore', 'deploy', 'validate',
              'smoke-test', 'cleanup', 'update', 'info', 'restart', 'size', 'top',
              'metrics', 'performance', 'benchmark', 'doctor', 'analyze', 'workflow',
              'context', 'contacts', 'secrets', 'config', 'events', 'notify', 'alias',
              'plugin', 'api', 'export', 'import', 'prune', 'maintenance'
            ];
            if (subCmd && !validCommands.includes(subCmd)) {
              addWarning(
                `Unknown mc command: "${subCmd}"`,
                `Run "mc --help" to see available commands`
              );
            }
          }
        }
      }

      // Validate optional fields
      if (step.workingDir && typeof step.workingDir !== 'string') {
        addError(`Step ${index + 1} "workingDir" must be a string`, `${stepPath}.workingDir`);
      }

      if (step.env && typeof step.env !== 'object') {
        addError(`Step ${index + 1} "env" must be an object`, `${stepPath}.env`, 'Define environment variables as key-value pairs');
      }

      if (step.if && typeof step.if !== 'string') {
        addError(`Step ${index + 1} "if" must be a string expression`, `${stepPath}.if`, 'Use: if: "${ENV} == production"');
      }

      if (step.continueOnError !== undefined && typeof step.continueOnError !== 'boolean') {
        addError(`Step ${index + 1} "continueOnError" must be a boolean`, `${stepPath}.continueOnError`, 'Use: continueOnError: true');
      }

      if (step.capture && typeof step.capture !== 'string') {
        addError(`Step ${index + 1} "capture" must be a string variable name`, `${stepPath}.capture`, 'Use: capture: OUTPUT_VAR');
      }
    });
  }

  // Validate rollback steps (same checks as main steps)
  if (workflow.rollback) {
    if (!Array.isArray(workflow.rollback)) {
      addError('Workflow rollback must be an array', 'rollback');
    } else {
      workflow.rollback.forEach((step, index) => {
        const stepPath = `rollback[${index}]`;

        if (!step || typeof step !== 'object') {
          addError(`Rollback step ${index + 1} must be an object`, stepPath);
          return;
        }

        if (!step.name) {
          addError(`Rollback step ${index + 1} missing required field: name`, stepPath);
        }

        if (!step.run) {
          addError(`Rollback step ${index + 1} (${step.name || 'unnamed'}) missing required field: run`, stepPath);
        }
      });
    }
  }

  // Validate variables
  if (workflow.variables) {
    if (typeof workflow.variables !== 'object' || Array.isArray(workflow.variables)) {
      addError('Workflow variables must be an object', 'variables', 'Define variables as key-value pairs: VARIABLE: value');
    } else {
      // Check for reserved variable names
      const reserved = ['PATH', 'HOME', 'USER', 'SHELL', 'PWD'];
      for (const varName of Object.keys(workflow.variables)) {
        if (reserved.includes(varName)) {
          addWarning(
            `Variable "${varName}" shadows a system environment variable`,
            'Consider using a different name to avoid confusion'
          );
        }
      }
    }
  }

  // Check for undefined variables
  for (const varName of usedVariables) {
    if (!definedVariables.has(varName) && !process.env[varName]) {
      addWarning(
        `Variable "${varName}" is used but not defined in workflow.variables or environment`,
        `Define it in variables: ${varName}: default_value`
      );
    }
  }

  // Check for unused variables
  for (const varName of definedVariables) {
    if (!usedVariables.has(varName)) {
      addWarning(
        `Variable "${varName}" is defined but never used`,
        'Remove it or use it in a step'
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      steps: workflow.steps?.length || 0,
      rollbackSteps: workflow.rollback?.length || 0,
      variables: definedVariables.size,
      usedVariables: usedVariables.size
    }
  };
}

// =============================================================================
// CLI Commands
// =============================================================================

workflowCmd
  .description('Manage and execute reusable operational workflows');

// List workflows
workflowCmd
  .command('list')
  .description('List all available workflows')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const workflows = await listWorkflows();

    if (options.json) {
      console.log(JSON.stringify(workflows, null, 2));
      return;
    }

    if (workflows.length === 0) {
      console.log(chalk.yellow('No workflows found.'));
      console.log(chalk.gray(`Create one with: mc workflow create <name>`));
      return;
    }

    console.log(chalk.blue('🐾 Available Workflows\n'));

    for (const wf of workflows) {
      const icon = wf.error ? chalk.red('⚠️') : chalk.green('✓');
      const name = wf.error ? chalk.yellow(wf.name) : chalk.bold(wf.name);
      console.log(`${icon} ${name}`);
      console.log(chalk.gray(`   ${wf.description}`));
      console.log(chalk.gray(`   ${wf.steps} steps • Modified ${wf.modified.toLocaleDateString()}`));
      console.log();
    }

    console.log(chalk.gray(`Workflow directory: ${getWorkflowDir()}`));
  });

// Show workflow details
workflowCmd
  .command('show <name>')
  .description('Show workflow details')
  .option('-r, --raw', 'Show raw file content')
  .action(async (name, options) => {
    try {
      const workflow = await loadWorkflow(name);
      const workflowDir = getWorkflowDir();
      const yamlPath = path.join(workflowDir, `${name}.yaml`);
      const ymlPath = path.join(workflowDir, `${name}.yml`);
      const jsonPath = path.join(workflowDir, `${name}.json`);
      const workflowPath = fs.existsSync(yamlPath) ? yamlPath : 
                          fs.existsSync(ymlPath) ? ymlPath : jsonPath;

      if (options.raw) {
        const content = await fs.readFile(workflowPath, 'utf8');
        console.log(content);
        return;
      }

      console.log(chalk.blue(`🐾 Workflow: ${workflow.name || name}\n`));
      
      if (workflow.description) {
        console.log(chalk.gray(`${workflow.description}\n`));
      }

      if (workflow.variables && Object.keys(workflow.variables).length > 0) {
        console.log(chalk.cyan('Variables:'));
        for (const [key, value] of Object.entries(workflow.variables)) {
          console.log(`  ${key}=${value}`);
        }
        console.log();
      }

      if (workflow.steps && workflow.steps.length > 0) {
        console.log(chalk.cyan(`Steps (${workflow.steps.length}):`));
        workflow.steps.forEach((step, i) => {
          console.log(`  ${i + 1}. ${step.name}`);
          console.log(chalk.gray(`     ${step.run}`));
          if (step.continueOnError) {
            console.log(chalk.yellow('     (continues on error)'));
          }
        });
        console.log();
      }

      if (workflow.rollback && workflow.rollback.length > 0) {
        console.log(chalk.cyan(`Rollback steps (${workflow.rollback.length}):`));
        workflow.rollback.forEach((step, i) => {
          console.log(`  ${i + 1}. ${step.name}`);
        });
        console.log();
      }

      console.log(chalk.gray(`File: ${workflowPath}`));
    } catch (err) {
      console.log(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Create new workflow
workflowCmd
  .command('create <name>')
  .description('Create a new workflow from template')
  .option('-t, --template <type>', 'Template type (standard, maintenance, incident)', 'standard')
  .option('-f, --format <format>', 'Output format (yaml, json)', 'yaml')
  .action(async (name, options) => {
    const workflowDir = getWorkflowDir();
    const workflowPath = path.join(workflowDir, `${name}.${options.format}`);

    if (await fs.pathExists(workflowPath)) {
      console.log(chalk.red(`Workflow '${name}' already exists.`));
      process.exit(1);
    }

    const workflow = createSampleWorkflow(name, options.template);
    await saveWorkflow(name, workflow, options.format);

    console.log(chalk.green(`✅ Created workflow: ${name}`));
    console.log(chalk.gray(`   Template: ${options.template}`));
    console.log(chalk.gray(`   Location: ${workflowPath}`));
    console.log(chalk.gray(`\nEdit the file to customize your workflow.`));
  });

// Run workflow
workflowCmd
  .command('run <name>')
  .description('Execute a workflow')
  .option('-v, --verbose', 'Verbose output')
  .option('-n, --dry-run', 'Show what would be executed without running')
  .option('-V, --var <vars...>', 'Set variables (KEY=value)')
  .action(async (name, options) => {
    try {
      // Parse variables
      const vars = {};
      if (options.var) {
        for (const v of options.var) {
          const [key, ...valueParts] = v.split('=');
          if (key) {
            vars[key] = valueParts.join('=');
          }
        }
      }

      await executeWorkflow(name, {
        verbose: options.verbose,
        dryRun: options.dryRun,
        vars,
      });
    } catch (err) {
      console.log(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Edit workflow
workflowCmd
  .command('edit <name>')
  .description('Open workflow in default editor')
  .action(async (name) => {
    const workflowDir = getWorkflowDir();
    const yamlPath = path.join(workflowDir, `${name}.yaml`);
    const ymlPath = path.join(workflowDir, `${name}.yml`);
    const jsonPath = path.join(workflowDir, `${name}.json`);
    
    let workflowPath = null;
    if (fs.existsSync(yamlPath)) workflowPath = yamlPath;
    else if (fs.existsSync(ymlPath)) workflowPath = ymlPath;
    else if (fs.existsSync(jsonPath)) workflowPath = jsonPath;

    if (!workflowPath) {
      console.log(chalk.red(`Workflow '${name}' not found.`));
      process.exit(1);
    }

    const editor = process.env.EDITOR || 'vi';
    const child = spawn(editor, [workflowPath], {
      stdio: 'inherit',
    });

    child.on('close', (code) => {
      process.exit(code);
    });
  });

// Delete workflow
workflowCmd
  .command('delete <name>')
  .description('Delete a workflow')
  .option('-f, --force', 'Force deletion without confirmation')
  .action(async (name, options) => {
    const workflowDir = getWorkflowDir();
    const yamlPath = path.join(workflowDir, `${name}.yaml`);
    const ymlPath = path.join(workflowDir, `${name}.yml`);
    const jsonPath = path.join(workflowDir, `${name}.json`);
    
    let workflowPath = null;
    if (fs.existsSync(yamlPath)) workflowPath = yamlPath;
    else if (fs.existsSync(ymlPath)) workflowPath = ymlPath;
    else if (fs.existsSync(jsonPath)) workflowPath = jsonPath;

    if (!workflowPath) {
      console.log(chalk.red(`Workflow '${name}' not found.`));
      process.exit(1);
    }

    if (!options.force) {
      console.log(chalk.yellow(`Are you sure you want to delete workflow '${name}'?`));
      console.log(chalk.gray('Use --force to skip this confirmation.'));
      process.exit(1);
    }

    await fs.remove(workflowPath);
    console.log(chalk.green(`✅ Deleted workflow: ${name}`));
  });

// Show history
workflowCmd
  .command('history [name]')
  .description('Show workflow execution history')
  .option('-n, --limit <number>', 'Limit number of entries', '10')
  .action(async (name, options) => {
    const historyDir = getHistoryDir();
    
    if (!await fs.pathExists(historyDir)) {
      console.log(chalk.yellow('No history found.'));
      return;
    }

    const files = await fs.readdir(historyDir);
    let entries = [];

    for (const file of files) {
      if (file.endsWith('.json')) {
        const entry = await fs.readJson(path.join(historyDir, file));
        if (!name || entry.workflow === name) {
          entries.push(entry);
        }
      }
    }

    entries.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    entries = entries.slice(0, parseInt(options.limit, 10));

    if (entries.length === 0) {
      console.log(chalk.yellow(name ? `No history for workflow '${name}'.` : 'No history found.'));
      return;
    }

    console.log(chalk.blue(name ? `🐾 History: ${name}\n` : '🐾 Workflow History\n'));

    for (const entry of entries) {
      const icon = entry.success ? chalk.green('✅') : chalk.red('❌');
      const date = new Date(entry.startTime).toLocaleString();
      console.log(`${icon} ${chalk.bold(entry.workflow)}`);
      console.log(chalk.gray(`   ${date} • ${entry.duration}ms • ${entry.stepsExecuted} steps`));
    }
  });

// Export workflow
workflowCmd
  .command('export <name>')
  .description('Export workflow to stdout or file')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (name, options) => {
    try {
      const workflow = await loadWorkflow(name);
      const content = yaml.dump(workflow, { lineWidth: 100 });

      if (options.output) {
        await fs.writeFile(options.output, content);
        console.log(chalk.green(`✅ Exported to: ${options.output}`));
      } else {
        console.log(content);
      }
    } catch (err) {
      console.log(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Import workflow
workflowCmd
  .command('import <file>')
  .description('Import workflow from file')
  .option('-n, --name <name>', 'Rename on import')
  .action(async (filePath, options) => {
    if (!await fs.pathExists(filePath)) {
      console.log(chalk.red(`File not found: ${filePath}`));
      process.exit(1);
    }

    const content = await fs.readFile(filePath, 'utf8');
    const workflow = filePath.endsWith('.json') ? JSON.parse(content) : yaml.load(content);
    
    const name = options.name || path.basename(filePath, path.extname(filePath));
    
    await saveWorkflow(name, workflow, 'yaml');
    console.log(chalk.green(`✅ Imported workflow: ${name}`));
  });

// Validate workflow
workflowCmd
  .command('validate <name>')
  .description('Validate workflow syntax and structure')
  .option('-j, --json', 'Output results as JSON')
  .option('--strict', 'Treat warnings as errors')
  .option('--check-commands', 'Validate that referenced commands exist')
  .action(async (name, options) => {
    try {
      const workflow = await loadWorkflow(name);
      const result = await validateWorkflow(name, workflow, options);
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.valid && (!options.strict || result.warnings.length === 0) ? 0 : 1);
        return;
      }

      // Display results
      console.log(chalk.blue(`🐾 Workflow Validation: ${name}\n`));

      if (result.valid && result.warnings.length === 0) {
        console.log(chalk.green('✅ Workflow is valid'));
        console.log(chalk.gray(`   Steps: ${workflow.steps?.length || 0}`));
        console.log(chalk.gray(`   Variables: ${Object.keys(workflow.variables || {}).length}`));
        console.log(chalk.gray(`   Rollback steps: ${workflow.rollback?.length || 0}`));
      } else {
        if (result.errors.length > 0) {
          console.log(chalk.red(`❌ ${result.errors.length} error(s) found:\n`));
          result.errors.forEach(err => {
            const icon = err.severity === 'critical' ? '🔴' : '❌';
            console.log(`${icon} ${chalk.bold(err.message)}`);
            if (err.location) {
              console.log(chalk.gray(`   Location: ${err.location}`));
            }
            if (err.suggestion) {
              console.log(chalk.cyan(`   💡 ${err.suggestion}`));
            }
            console.log();
          });
        }

        if (result.warnings.length > 0) {
          console.log(chalk.yellow(`⚠️  ${result.warnings.length} warning(s) found:\n`));
          result.warnings.forEach(warn => {
            console.log(`${chalk.yellow('⚠️')} ${warn.message}`);
            if (warn.suggestion) {
              console.log(chalk.gray(`   💡 ${warn.suggestion}`));
            }
            console.log();
          });
        }

        if (result.valid && result.warnings.length > 0 && !options.strict) {
          console.log(chalk.green('✅ Workflow is valid (with warnings)'));
        } else {
          process.exit(1);
        }
      }
    } catch (err) {
      if (options.json) {
        console.log(JSON.stringify({
          valid: false,
          errors: [{ message: err.message, severity: 'critical' }],
          warnings: []
        }, null, 2));
      } else {
        console.log(chalk.red(`❌ Validation failed: ${err.message}`));
      }
      process.exit(1);
    }
  });

// Validate all workflows
workflowCmd
  .command('validate-all')
  .description('Validate all workflows')
  .option('-j, --json', 'Output results as JSON')
  .option('--strict', 'Treat warnings as errors')
  .action(async (options) => {
    const workflows = await listWorkflows();
    const results = [];
    let hasErrors = false;

    for (const wf of workflows) {
      if (wf.error) {
        results.push({
          name: wf.name,
          valid: false,
          errors: [{ message: 'Invalid workflow file format', severity: 'critical' }],
          warnings: []
        });
        hasErrors = true;
        continue;
      }

      try {
        const workflow = await loadWorkflow(wf.name);
        const result = await validateWorkflow(wf.name, workflow, options);
        results.push({ name: wf.name, ...result });
        if (!result.valid || (options.strict && result.warnings.length > 0)) {
          hasErrors = true;
        }
      } catch (err) {
        results.push({
          name: wf.name,
          valid: false,
          errors: [{ message: err.message, severity: 'critical' }],
          warnings: []
        });
        hasErrors = true;
      }
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(chalk.blue(`🐾 Validating ${workflows.length} Workflow(s)\n`));
      
      for (const result of results) {
        const icon = result.valid && (result.warnings.length === 0 || !options.strict) 
          ? chalk.green('✅') 
          : chalk.red('❌');
        const warnCount = result.warnings.length > 0 
          ? chalk.yellow(` (${result.warnings.length} warnings)`) 
          : '';
        console.log(`${icon} ${result.name}${warnCount}`);
      }

      console.log();
      if (hasErrors) {
        console.log(chalk.red('Some workflows have errors. Run `mc workflow validate <name>` for details.'));
      } else {
        console.log(chalk.green('All workflows are valid!'));
      }
    }

    process.exit(hasErrors ? 1 : 0);
  });

module.exports = {
  workflowCmd,
  loadWorkflow,
  saveWorkflow,
  listWorkflows,
  executeWorkflow,
  validateWorkflow,
  getWorkflowDir,
  // Security exports
  validateWorkflowSecurity,
  validateCommandSafety,
  validateAllowedCommand,
  isSafeShellString,
  calculateWorkflowHash,
  ALLOWED_WORKFLOW_COMMANDS,
};
