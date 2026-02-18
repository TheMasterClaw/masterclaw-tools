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
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');
const ora = require('ora');

const workflowCmd = new Command('workflow');

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

  const content = await fs.readFile(workflowPath, 'utf8');
  
  if (workflowPath.endsWith('.json')) {
    return JSON.parse(content);
  } else {
    return yaml.load(content);
  }
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
  const { verbose, dryRun } = options;
  
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
  .action(async (name) => {
    try {
      const workflow = await loadWorkflow(name);
      
      const issues = [];
      
      if (!workflow.steps || workflow.steps.length === 0) {
        issues.push('No steps defined');
      } else {
        workflow.steps.forEach((step, i) => {
          if (!step.name) issues.push(`Step ${i + 1} missing 'name'`);
          if (!step.run) issues.push(`Step ${i + 1} missing 'run'`);
        });
      }

      if (issues.length === 0) {
        console.log(chalk.green(`✅ Workflow '${name}' is valid`));
      } else {
        console.log(chalk.yellow(`⚠️  Workflow '${name}' has issues:`));
        issues.forEach(issue => console.log(chalk.gray(`  • ${issue}`)));
        process.exit(1);
      }
    } catch (err) {
      console.log(chalk.red(`❌ Validation failed: ${err.message}`));
      process.exit(1);
    }
  });

module.exports = {
  workflowCmd,
  loadWorkflow,
  saveWorkflow,
  listWorkflows,
  executeWorkflow,
  getWorkflowDir,
};
