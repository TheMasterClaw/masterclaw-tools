/**
 * Context management for MasterClaw CLI
 * Displays and manages rex-deus context information
 *
 * Features:
 * - Display Rex's preferences, goals, and projects
 * - Quick reference without opening files
 * - Export/import context for backup/migration
 * - Verify context integrity
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const ora = require('ora');

const { findInfraDir, getRepoRoot } = require('./services');

const program = new Command('context');

// Context file mappings
const CONTEXT_FILES = {
  preferences: 'preferences.md',
  projects: 'projects.md',
  goals: 'goals.md',
  people: 'people.md',
  knowledge: 'knowledge.md',
};

/**
 * Find rex-deus directory
 */
async function findRexDeusDir() {
  // First check if we're in the main workspace
  const workspaceDir = path.join(process.env.HOME || '/home/ubuntu', '.openclaw', 'workspace');
  const rexDeusWorkspace = path.join(workspaceDir, 'rex-deus');

  if (await fs.pathExists(rexDeusWorkspace)) {
    return rexDeusWorkspace;
  }

  // Check current directory and parents
  let currentDir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const rexDeusDir = path.join(currentDir, 'rex-deus');
    if (await fs.pathExists(rexDeusDir)) {
      return rexDeusDir;
    }

    // Check if this IS the rex-deus repo
    if (await fs.pathExists(path.join(currentDir, 'context', 'preferences.md'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  // Try to find via git
  try {
    const repoRoot = await getRepoRoot();
    if (repoRoot) {
      const rexDeusDir = path.join(repoRoot, 'rex-deus');
      if (await fs.pathExists(rexDeusDir)) {
        return rexDeusDir;
      }
    }
  } catch {
    // Ignore git errors
  }

  return null;
}

/**
 * Load context file content
 */
async function loadContextFile(rexDeusDir, filename) {
  const filePath = path.join(rexDeusDir, 'context', filename);
  if (await fs.pathExists(filePath)) {
    return fs.readFile(filePath, 'utf-8');
  }
  return null;
}

/**
 * Parse markdown sections
 */
function parseSections(content) {
  const sections = [];
  const lines = content.split('\n');
  let currentSection = null;
  let currentContent = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      if (currentSection) {
        sections.push({
          level: currentSection.level,
          title: currentSection.title,
          content: currentContent.join('\n').trim(),
        });
      }
      currentSection = {
        level: headerMatch[1].length,
        title: headerMatch[2].trim(),
      };
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections.push({
      level: currentSection.level,
      title: currentSection.title,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}

/**
 * Extract preferences as key-value pairs
 */
function extractPreferences(content) {
  const prefs = {};

  // Extract communication style
  const commMatch = content.match(/\*\*Directness:\*\*\s*(.+)/);
  if (commMatch) prefs.directness = commMatch[1].trim();

  const toneMatch = content.match(/\*\*Tone:\*\*\s*(.+)/);
  if (toneMatch) prefs.tone = toneMatch[1].trim();

  // Extract decision making
  const decisionMatch = content.match(/- Presents options with trade-offs/i);
  prefs.presentsOptions = !!decisionMatch;

  // Extract tech stack preferences
  const techStack = {};
  const stackMatch = content.match(/\| Layer \| Preferred \|[\s\S]+?(?=\n##|\n---|$)/);
  if (stackMatch) {
    const lines = stackMatch[0].split('\n').slice(2); // Skip header
    for (const line of lines) {
      const match = line.match(/\|\s*(\w+)\s*\|\s*(.+?)\s*\|/);
      if (match) {
        techStack[match[1].toLowerCase()] = match[2].trim();
      }
    }
  }
  prefs.techStack = techStack;

  // Extract values
  const values = [];
  const valuesMatch = content.match(/\*\*Values\*\*[\s\S]+?(?=\n##|\n---|$)/);
  if (valuesMatch) {
    const valueLines = valuesMatch[0].match(/^\d+\.\s+\*\*(.+?)\*\*/gm);
    if (valueLines) {
      for (const line of valueLines) {
        const match = line.match(/\*\*(.+?)\*\*/);
        if (match) values.push(match[1]);
      }
    }
  }
  prefs.values = values;

  // Extract pet peeves
  const petPeeves = [];
  const petPeeveMatch = content.match(/\*\*Pet Peeves\*\*[\s\S]+?(?=\n##|\n---|$)/);
  if (petPeeveMatch) {
    const lines = petPeeveMatch[0].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s+(.+)/);
      if (match) petPeeves.push(match[1].trim());
    }
  }
  prefs.petPeeves = petPeeves;

  return prefs;
}

/**
 * Extract goals from content
 */
function extractGoals(content) {
  const goals = {
    shortTerm: [],
    mediumTerm: [],
    longTerm: [],
    life: [],
  };

  const sections = parseSections(content);

  for (const section of sections) {
    const title = section.title.toLowerCase();
    const items = section.content.match(/^- \[([ x])\]\s*(.+)$/gm) || [];

    const parsedItems = items.map(item => {
      const match = item.match(/^- \[([ x])\]\s*(.+)$/);
      return {
        text: match[2].trim(),
        completed: match[1] === 'x',
      };
    });

    if (title.includes('short-term')) {
      goals.shortTerm = parsedItems;
    } else if (title.includes('medium-term')) {
      goals.mediumTerm = parsedItems;
    } else if (title.includes('long-term')) {
      goals.longTerm = parsedItems;
    } else if (title.includes('life')) {
      goals.life = parsedItems;
    }
  }

  return goals;
}

/**
 * Extract projects from content
 */
function extractProjects(content) {
  const projects = {
    current: [],
    side: [],
    completed: [],
  };

  const sections = parseSections(content);

  for (const section of sections) {
    const title = section.title.toLowerCase();

    // Parse current project phases
    if (title.includes('current')) {
      const phaseMatches = section.content.match(/###\s+Phase\s+\d+:[\s\S]+?(?=###\s+Phase|\n##|$)/g) || [];
      for (const phase of phaseMatches) {
        const phaseTitle = phase.match(/###\s+(.+)/)?.[1] || 'Unknown Phase';
        const items = phase.match(/^- \[([ x])\]\s*(.+)$/gm) || [];
        const completed = items.filter(i => i.includes('[x]')).length;
        const total = items.length;

        projects.current.push({
          name: phaseTitle,
          completed,
          total,
          percent: total > 0 ? Math.round((completed / total) * 100) : 0,
        });
      }
    }

    // Parse side projects
    if (title.includes('side')) {
      const items = section.content.match(/^- \[([ x])\]\s*(.+)$/gm) || [];
      projects.side = items.map(item => {
        const match = item.match(/^- \[([ x])\]\s*(.+)$/);
        return {
          name: match[2].trim(),
          completed: match[1] === 'x',
        };
      });
    }
  }

  return projects;
}

// =============================================================================
// Commands
// =============================================================================

/**
 * Status command - show context overview
 */
program
  .command('status')
  .description('Show context status and summary')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const rexDeusDir = await findRexDeusDir();

    if (!rexDeusDir) {
      console.log(chalk.yellow('⚠️  rex-deus directory not found'));
      console.log(chalk.gray('   Ensure rex-deus repository is cloned'));
      process.exit(1);
    }

    // Check which context files exist
    const contextStatus = {};
    for (const [name, filename] of Object.entries(CONTEXT_FILES)) {
      const exists = await fs.pathExists(path.join(rexDeusDir, 'context', filename));
      contextStatus[name] = exists;
    }

    // Load preferences for summary
    const prefsContent = await loadContextFile(rexDeusDir, 'preferences.md');
    const prefs = prefsContent ? extractPreferences(prefsContent) : {};

    // Load goals for summary
    const goalsContent = await loadContextFile(rexDeusDir, 'goals.md');
    const goals = goalsContent ? extractGoals(goalsContent) : {};

    if (options.json) {
      console.log(JSON.stringify({
        rexDeusDir,
        contextFiles: contextStatus,
        preferences: prefs,
        goals,
      }, null, 2));
      return;
    }

    console.log(chalk.blue('🐾 MasterClaw Context Status\n'));

    console.log(chalk.cyan('Repository:'));
    console.log(`  ${chalk.gray(rexDeusDir)}\n`);

    console.log(chalk.cyan('Context Files:'));
    for (const [name, exists] of Object.entries(contextStatus)) {
      const icon = exists ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${icon} ${name}`);
    }
    console.log();

    if (prefs.values && prefs.values.length > 0) {
      console.log(chalk.cyan('Core Values:'));
      for (const value of prefs.values) {
        console.log(`  • ${value}`);
      }
      console.log();
    }

    if (goals.shortTerm) {
      const totalShort = goals.shortTerm.length;
      const completedShort = goals.shortTerm.filter(g => g.completed).length;
      const totalMedium = goals.mediumTerm.length;
      const completedMedium = goals.mediumTerm.filter(g => g.completed).length;

      console.log(chalk.cyan('Goal Progress:'));
      console.log(`  Short-term:  ${chalk.green(`${completedShort}/${totalShort}`)}`);
      console.log(`  Medium-term: ${chalk.green(`${completedMedium}/${totalMedium}`)}`);
      console.log();
    }

    console.log(chalk.gray('Run "mc context show" for detailed information'));
  });

/**
 * Show command - display context details
 */
program
  .command('show [topic]')
  .description('Show context details (preferences, goals, projects, people, knowledge)')
  .option('--raw', 'Show raw markdown content')
  .action(async (topic, options) => {
    const rexDeusDir = await findRexDeusDir();

    if (!rexDeusDir) {
      console.log(chalk.yellow('⚠️  rex-deus directory not found'));
      process.exit(1);
    }

    const validTopics = Object.keys(CONTEXT_FILES);

    if (!topic) {
      // Show summary of all topics
      console.log(chalk.blue('🐾 MasterClaw Context Summary\n'));

      for (const name of validTopics) {
        const content = await loadContextFile(rexDeusDir, CONTEXT_FILES[name]);
        if (content) {
          const sections = parseSections(content);
          console.log(chalk.cyan(`${name.charAt(0).toUpperCase() + name.slice(1)}:`));
          for (const section of sections.slice(0, 3)) {
            console.log(`  • ${section.title}`);
          }
          if (sections.length > 3) {
            console.log(chalk.gray(`  ... and ${sections.length - 3} more`));
          }
          console.log();
        }
      }

      console.log(chalk.gray(`Run "mc context show <topic>" for details`));
      console.log(chalk.gray(`Topics: ${validTopics.join(', ')}`));
      return;
    }

    if (!validTopics.includes(topic)) {
      console.log(chalk.red(`❌ Unknown topic: ${topic}`));
      console.log(chalk.gray(`   Valid topics: ${validTopics.join(', ')}`));
      process.exit(1);
    }

    const content = await loadContextFile(rexDeusDir, CONTEXT_FILES[topic]);

    if (!content) {
      console.log(chalk.yellow(`⚠️  No content found for ${topic}`));
      process.exit(1);
    }

    if (options.raw) {
      console.log(content);
      return;
    }

    // Display formatted content
    console.log(chalk.blue(`🐾 ${topic.charAt(0).toUpperCase() + topic.slice(1)}\n`));

    if (topic === 'preferences') {
      const prefs = extractPreferences(content);

      if (prefs.directness) {
        console.log(chalk.cyan('Communication Style:'));
        console.log(`  Directness: ${prefs.directness}`);
        console.log(`  Tone: ${prefs.tone}`);
        console.log();
      }

      if (prefs.techStack && Object.keys(prefs.techStack).length > 0) {
        console.log(chalk.cyan('Preferred Tech Stack:'));
        for (const [layer, tech] of Object.entries(prefs.techStack)) {
          console.log(`  ${layer}: ${chalk.yellow(tech)}`);
        }
        console.log();
      }

      if (prefs.petPeeves && prefs.petPeeves.length > 0) {
        console.log(chalk.cyan('Pet Peeves:'));
        for (const peeve of prefs.petPeeves) {
          console.log(`  ✗ ${peeve}`);
        }
        console.log();
      }
    } else if (topic === 'goals') {
      const goals = extractGoals(content);

      const sections = [
        ['Short-term (3 months)', goals.shortTerm],
        ['Medium-term (1 year)', goals.mediumTerm],
        ['Long-term (5+ years)', goals.longTerm],
        ['Life Goals', goals.life],
      ];

      for (const [title, items] of sections) {
        if (items && items.length > 0) {
          console.log(chalk.cyan(`${title}:`));
          for (const item of items) {
            const icon = item.completed ? chalk.green('✓') : chalk.gray('○');
            console.log(`  ${icon} ${item.text}`);
          }
          console.log();
        }
      }
    } else if (topic === 'projects') {
      const projects = extractProjects(content);

      if (projects.current.length > 0) {
        console.log(chalk.cyan('Current Projects:'));
        for (const proj of projects.current) {
          const percentStr = `${proj.percent}%`.padStart(4);
          const bar = '█'.repeat(Math.round(proj.percent / 10)).padEnd(10);
          console.log(`  ${proj.name}`);
          console.log(`    ${chalk.yellow(bar)} ${percentStr} (${proj.completed}/${proj.total})`);
        }
        console.log();
      }

      if (projects.side.length > 0) {
        console.log(chalk.cyan('Side Projects:'));
        for (const proj of projects.side) {
          const icon = proj.completed ? chalk.green('✓') : chalk.gray('○');
          console.log(`  ${icon} ${proj.name}`);
        }
        console.log();
      }
    } else {
      // Default: show sections
      const sections = parseSections(content);
      for (const section of sections) {
        const headerColor = section.level === 1 ? chalk.cyan.bold :
          section.level === 2 ? chalk.cyan :
            chalk.white;
        console.log(headerColor(section.title));
        if (section.content) {
          console.log(section.content.split('\n').map(l => `  ${l}`).join('\n'));
        }
        console.log();
      }
    }
  });

/**
 * Export command - backup context
 */
program
  .command('export')
  .description('Export rex-deus context for backup')
  .option('-o, --output <path>', 'Output file path', './rex-deus-backup.json')
  .option('--include-sessions', 'Include session backups', false)
  .action(async (options) => {
    const spinner = ora('Exporting context...').start();

    try {
      const rexDeusDir = await findRexDeusDir();

      if (!rexDeusDir) {
        spinner.fail('rex-deus directory not found');
        process.exit(1);
      }

      const exportData = {
        exportedAt: new Date().toISOString(),
        version: '1.0',
        context: {},
      };

      // Export all context files
      for (const [name, filename] of Object.entries(CONTEXT_FILES)) {
        const content = await loadContextFile(rexDeusDir, filename);
        if (content) {
          exportData.context[name] = content;
        }
      }

      // Include sessions if requested
      if (options.includeSessions) {
        const sessionsDir = path.join(rexDeusDir, 'sessions');
        if (await fs.pathExists(sessionsDir)) {
          const sessions = await fs.readdir(sessionsDir);
          exportData.sessions = {};
          for (const session of sessions.filter(f => f.endsWith('.md'))) {
            const content = await fs.readFile(path.join(sessionsDir, session), 'utf-8');
            exportData.sessions[session] = content;
          }
        }
      }

      await fs.writeJson(options.output, exportData, { spaces: 2 });

      spinner.succeed(`Context exported to ${options.output}`);
      console.log(chalk.gray(`   Files: ${Object.keys(exportData.context).length}`));

    } catch (err) {
      spinner.fail(`Export failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * Import command - restore context
 */
program
  .command('import <file>')
  .description('Import rex-deus context from backup')
  .option('--dry-run', 'Show what would be imported without making changes')
  .action(async (file, options) => {
    const spinner = ora('Importing context...').start();

    try {
      if (!await fs.pathExists(file)) {
        spinner.fail(`File not found: ${file}`);
        process.exit(1);
      }

      const importData = await fs.readJson(file);

      if (!importData.context) {
        spinner.fail('Invalid backup file: missing context data');
        process.exit(1);
      }

      const rexDeusDir = await findRexDeusDir();

      if (!rexDeusDir) {
        spinner.fail('rex-deus directory not found');
        process.exit(1);
      }

      if (options.dryRun) {
        spinner.stop();
        console.log(chalk.blue('🐾 Import Preview\n'));
        for (const [name, content] of Object.entries(importData.context)) {
          const lines = content.split('\n').length;
          console.log(`  ${chalk.green('→')} ${name}: ${lines} lines`);
        }
        console.log(chalk.gray('\nDry run - no changes made'));
        return;
      }

      // Import context files
      for (const [name, content] of Object.entries(importData.context)) {
        const filename = CONTEXT_FILES[name];
        if (filename) {
          const filePath = path.join(rexDeusDir, 'context', filename);
          await fs.writeFile(filePath, content);
        }
      }

      spinner.succeed('Context imported successfully');
      console.log(chalk.gray(`   Files: ${Object.keys(importData.context).length}`));

    } catch (err) {
      spinner.fail(`Import failed: ${err.message}`);
      process.exit(1);
    }
  });

/**
 * Edit command - open context file in editor
 */
program
  .command('edit <topic>')
  .description('Edit a context file in your default editor')
  .action(async (topic) => {
    const validTopics = Object.keys(CONTEXT_FILES);

    if (!validTopics.includes(topic)) {
      console.log(chalk.red(`❌ Unknown topic: ${topic}`));
      console.log(chalk.gray(`   Valid topics: ${validTopics.join(', ')}`));
      process.exit(1);
    }

    const rexDeusDir = await findRexDeusDir();

    if (!rexDeusDir) {
      console.log(chalk.yellow('⚠️  rex-deus directory not found'));
      process.exit(1);
    }

    const filePath = path.join(rexDeusDir, 'context', CONTEXT_FILES[topic]);

    // Ensure file exists
    if (!await fs.pathExists(filePath)) {
      await fs.writeFile(filePath, `# ${topic.charAt(0).toUpperCase() + topic.slice(1)}\n\n`);
    }

    // Open in editor
    const editor = process.env.EDITOR || 'nano';
    console.log(chalk.blue(`Opening ${topic} in ${editor}...`));

    try {
      execSync(`${editor} "${filePath}"`, { stdio: 'inherit' });
    } catch (err) {
      console.log(chalk.red(`❌ Failed to open editor: ${err.message}`));
      process.exit(1);
    }
  });

// =============================================================================
// API Commands - Query context via MasterClaw Core API
// =============================================================================

const axios = require('axios');
const crypto = require('crypto');

/**
 * Get Core API URL from config
 */
function getCoreUrl() {
  const cfg = config.loadConfig();
  return cfg.core?.url || process.env.CORE_URL || 'http://localhost:8000';
}

/**
 * API projects command - Get projects from API
 */
program
  .command('api-projects')
  .description('Get projects from rex-deus context via API')
  .option('-s, --status <status>', 'Filter by status (active, paused, completed, archived)')
  .option('-p, --priority <priority>', 'Filter by priority (critical, high, medium, low)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const params = {};
      if (options.status) params.status = options.status;
      if (options.priority) params.priority = options.priority;

      const response = await axios.get(`${coreUrl}/v1/context/projects`, { params });
      const { projects, count } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ projects, count }, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 Projects from rex-deus context\n'));

      if (count === 0) {
        console.log(chalk.gray('No projects found'));
        return;
      }

      for (const p of projects) {
        const statusIcon = p.status === 'active' ? chalk.green('●') :
          p.status === 'paused' ? chalk.yellow('◐') :
            p.status === 'completed' ? chalk.blue('✓') : chalk.gray('○');
        const priorityColor = p.priority === 'critical' ? chalk.red :
          p.priority === 'high' ? chalk.yellow :
            p.priority === 'medium' ? chalk.white : chalk.gray;

        console.log(`  ${statusIcon} ${chalk.bold(p.name)} ${priorityColor(`[${p.priority}]`)}`);
        console.log(`    Status: ${p.status}`);
        if (p.description) {
          const desc = p.description.length > 60 ? p.description.substring(0, 60) + '...' : p.description;
          console.log(`    ${chalk.gray(desc)}`);
        }
        if (p.tags && p.tags.length > 0) {
          console.log(`    Tags: ${p.tags.map(t => chalk.cyan(t)).join(', ')}`);
        }
        console.log();
      }

      console.log(chalk.gray(`Total: ${count} projects`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API goals command - Get goals from API
 */
program
  .command('api-goals')
  .description('Get goals from rex-deus context via API')
  .option('-s, --status <status>', 'Filter by status (active, completed, deferred)')
  .option('-p, --priority <priority>', 'Filter by priority')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const params = {};
      if (options.status) params.status = options.status;
      if (options.priority) params.priority = options.priority;

      const response = await axios.get(`${coreUrl}/v1/context/goals`, { params });
      const { goals, count } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ goals, count }, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 Goals from rex-deus context\n'));

      if (count === 0) {
        console.log(chalk.gray('No goals found'));
        return;
      }

      for (const g of goals) {
        const statusIcon = g.status === 'active' ? chalk.green('●') :
          g.status === 'completed' ? chalk.blue('✓') : chalk.gray('○');
        console.log(`  ${statusIcon} ${chalk.bold(g.title)} ${chalk.gray(`[${g.priority}]`)}`);
        if (g.target_date) {
          console.log(`    Target: ${chalk.yellow(g.target_date)}`);
        }
        if (g.description) {
          const desc = g.description.length > 60 ? g.description.substring(0, 60) + '...' : g.description;
          console.log(`    ${chalk.gray(desc)}`);
        }
        console.log();
      }

      console.log(chalk.gray(`Total: ${count} goals`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API people command - Get people from rex-deus context via API
 */
program
  .command('api-people')
  .description('Get people from rex-deus context via API')
  .option('-r, --role <role>', 'Filter by role (developer, designer, etc.)')
  .option('--relationship <type>', 'Filter by relationship (friend, colleague, client)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const params = {};
      if (options.role) params.role = options.role;
      if (options.relationship) params.relationship = options.relationship;

      const response = await axios.get(`${coreUrl}/v1/context/people`, { params });
      const { people, count } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ people, count }, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 People from rex-deus context\n'));

      if (count === 0) {
        console.log(chalk.gray('No people found'));
        return;
      }

      for (const p of people) {
        const relationshipIcon = p.relationship === 'friend' ? chalk.green('♥') :
          p.relationship === 'colleague' ? chalk.blue('⚙') :
          p.relationship === 'client' ? chalk.yellow('$') : chalk.gray('●');
        console.log(`  ${relationshipIcon} ${chalk.bold(p.name)} ${chalk.gray(`[${p.role}]`)}`);
        console.log(`    Relationship: ${chalk.cyan(p.relationship)}`);
        if (p.contact) {
          console.log(`    Contact: ${chalk.yellow(p.contact)}`);
        }
        if (p.notes) {
          const notes = p.notes.length > 60 ? p.notes.substring(0, 60) + '...' : p.notes;
          console.log(`    ${chalk.gray(notes)}`);
        }
        if (p.tags && p.tags.length > 0) {
          console.log(`    Tags: ${chalk.magenta(p.tags.join(', '))}`);
        }
        console.log();
      }

      console.log(chalk.gray(`Total: ${count} people`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API knowledge command - Get knowledge entries from rex-deus context via API
 */
program
  .command('api-knowledge')
  .description('Get knowledge entries from rex-deus context via API')
  .option('-c, --category <category>', 'Filter by category')
  .option('--confidence <level>', 'Filter by confidence (high, medium, low)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const params = {};
      if (options.category) params.category = options.category;
      if (options.confidence) params.confidence = options.confidence;

      const response = await axios.get(`${coreUrl}/v1/context/knowledge`, { params });
      const { knowledge, count } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ knowledge, count }, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 Knowledge from rex-deus context\n'));

      if (count === 0) {
        console.log(chalk.gray('No knowledge entries found'));
        return;
      }

      // Group by category
      const byCategory = {};
      for (const k of knowledge) {
        if (!byCategory[k.category]) byCategory[k.category] = [];
        byCategory[k.category].push(k);
      }

      for (const [category, entries] of Object.entries(byCategory)) {
        console.log(chalk.cyan(`${category}:`));
        for (const k of entries) {
          const confidenceIcon = k.confidence === 'high' ? chalk.green('●') :
            k.confidence === 'medium' ? chalk.yellow('●') : chalk.gray('○');
          console.log(`  ${confidenceIcon} ${chalk.bold(k.topic)}`);
          if (k.content) {
            const content = k.content.length > 80 ? k.content.substring(0, 80) + '...' : k.content;
            console.log(`    ${chalk.gray(content)}`);
          }
          if (k.source) {
            console.log(`    Source: ${chalk.blue(k.source)}`);
          }
          if (k.updated_at) {
            console.log(`    Updated: ${chalk.gray(k.updated_at)}`);
          }
          console.log();
        }
      }

      console.log(chalk.gray(`Total: ${count} knowledge entries`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API preferences command - Get preferences from rex-deus context via API
 */
program
  .command('api-preferences')
  .description('Get preferences from rex-deus context via API')
  .option('-c, --category <category>', 'Filter by category (Communication, Technical, etc.)')
  .option('-p, --priority <priority>', 'Filter by priority (required, preferred, optional)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const params = {};
      if (options.category) params.category = options.category;
      if (options.priority) params.priority = options.priority;

      const response = await axios.get(`${coreUrl}/v1/context/preferences`, { params });
      const { preferences, count } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ preferences, count }, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 Preferences from rex-deus context\n'));

      if (count === 0) {
        console.log(chalk.gray('No preferences found'));
        return;
      }

      // Group by category
      const byCategory = {};
      for (const p of preferences) {
        if (!byCategory[p.category]) byCategory[p.category] = [];
        byCategory[p.category].push(p);
      }

      for (const [category, entries] of Object.entries(byCategory)) {
        console.log(chalk.cyan(`${category}:`));
        for (const p of entries) {
          const priorityIcon = p.priority === 'required' ? chalk.red('!') :
            p.priority === 'preferred' ? chalk.yellow('●') : chalk.gray('○');
          console.log(`  ${priorityIcon} ${chalk.bold(p.item)}: ${p.value}`);
          console.log(`    Priority: ${chalk.gray(p.priority)}`);
          console.log();
        }
      }

      console.log(chalk.gray(`Total: ${count} preferences`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API search command - Search context via API
 */
program
  .command('api-search <query>')
  .description('Search across all rex-deus context via API')
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    try {
      const coreUrl = getCoreUrl();
      const response = await axios.get(`${coreUrl}/v1/context/search`, {
        params: { query }
      });
      const { results, total_matches } = response.data;

      if (options.json) {
        console.log(JSON.stringify({ query, results, total_matches }, null, 2));
        return;
      }

      console.log(chalk.blue(`🐾 Context search: "${query}"\n`));

      if (total_matches === 0) {
        console.log(chalk.gray('No matches found'));
        return;
      }

      // Display results by category
      const categories = [
        ['projects', 'Projects'],
        ['goals', 'Goals'],
        ['people', 'People'],
        ['knowledge', 'Knowledge'],
        ['preferences', 'Preferences']
      ];

      for (const [key, label] of categories) {
        const items = results[key];
        if (items && items.length > 0) {
          console.log(chalk.cyan(`${label}:`));
          for (const item of items) {
            const name = item.name || item.title || item.topic || item.item;
            console.log(`  • ${name}`);
          }
          console.log();
        }
      }

      console.log(chalk.gray(`Total matches: ${total_matches}`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else if (err.response?.status === 400) {
        console.log(chalk.red(`❌ ${err.response.data.detail || 'Invalid query'}`));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * API summary command - Get context summary via API
 */
program
  .command('api-summary')
  .description('Get summary of rex-deus context via API')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const coreUrl = getCoreUrl();
      const response = await axios.get(`${coreUrl}/v1/context/summary`);
      const summary = response.data;

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(chalk.blue('🐾 rex-deus Context Summary\n'));

      console.log(chalk.cyan('Counts:'));
      console.log(`  Projects: ${summary.counts.projects}`);
      console.log(`  Goals: ${summary.counts.goals}`);
      console.log(`  People: ${summary.counts.people}`);
      console.log(`  Knowledge entries: ${summary.counts.knowledge_entries}`);
      console.log(`  Preferences: ${summary.counts.preferences}`);
      console.log();

      if (summary.projects.active && summary.projects.active.length > 0) {
        console.log(chalk.cyan('Active Projects:'));
        for (const name of summary.projects.active) {
          console.log(`  • ${name}`);
        }
        console.log();
      }

      if (summary.projects.high_priority && summary.projects.high_priority.length > 0) {
        console.log(chalk.cyan('High Priority Projects:'));
        for (const name of summary.projects.high_priority) {
          console.log(`  • ${name}`);
        }
        console.log();
      }

      if (summary.goals.active && summary.goals.active.length > 0) {
        console.log(chalk.cyan('Active Goals:'));
        for (const title of summary.goals.active) {
          console.log(`  • ${title}`);
        }
        console.log();
      }

      console.log(chalk.gray(`Context directory: ${summary.context_dir}`));

    } catch (err) {
      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Context API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running (v0.30.0+ required)'));
      } else {
        console.log(chalk.red(`❌ API error: ${err.message}`));
      }
      process.exit(1);
    }
  });

/**
 * Compute SHA-256 hash of content for change detection
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Section to memory category mapping
 */
const SECTION_TO_CATEGORY = {
  preferences: 'user_preferences',
  projects: 'active_projects',
  goals: 'user_goals',
  knowledge: 'domain_knowledge',
  people: 'relationships',
};

/**
 * Parse context file into structured memory entries
 */
function parseContextForSync(content, sectionName) {
  const entries = [];
  const sections = parseSections(content);

  for (const section of sections) {
    const entry = {
      title: section.title,
      content: section.content,
      category: SECTION_TO_CATEGORY[sectionName] || 'context',
      section: sectionName,
      source: `${sectionName}.md`,
      level: section.level,
    };

    // Add extracted metadata based on section type
    if (sectionName === 'preferences') {
      // Extract key preferences as separate entries
      if (section.title.includes('Communication')) {
        entry.tags = ['communication', 'preferences'];
        entry.priority = 'high';
      } else if (section.title.includes('Technical')) {
        entry.tags = ['tech-stack', 'preferences'];
        entry.priority = 'high';
      } else if (section.title.includes('Values')) {
        entry.tags = ['values', 'preferences'];
        entry.priority = 'medium';
      }
    } else if (sectionName === 'projects') {
      entry.tags = ['projects', 'active'];
      entry.priority = 'high';
      // Extract completion percentage if available
      const percentMatch = section.content.match(/(\d+)%/);
      if (percentMatch) {
        entry.metadata = { completion: parseInt(percentMatch[1], 10) };
      }
    } else if (sectionName === 'goals') {
      entry.tags = ['goals'];
      entry.priority = 'high';
      // Determine timeframe from section title
      if (section.title.toLowerCase().includes('short')) {
        entry.metadata = { timeframe: 'short-term' };
      } else if (section.title.toLowerCase().includes('medium')) {
        entry.metadata = { timeframe: 'medium-term' };
      } else if (section.title.toLowerCase().includes('long')) {
        entry.metadata = { timeframe: 'long-term' };
      }
    } else if (sectionName === 'knowledge') {
      entry.tags = ['knowledge', 'expertise'];
      entry.priority = 'medium';
    } else if (sectionName === 'people') {
      entry.tags = ['people', 'relationships'];
      entry.priority = 'medium';
    }

    entries.push(entry);
  }

  return entries;
}

/**
 * Sync context entries to MasterClaw Core memory
 */
async function syncToMemory(entries, options = {}) {
  const coreUrl = getCoreUrl();
  const results = {
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (const entry of entries) {
    try {
      // Compute content hash for deduplication
      const contentHash = hashContent(entry.content);

      // Check if entry already exists (by title and source)
      const searchResponse = await axios.get(`${coreUrl}/v1/memory/search`, {
        params: { query: entry.title, top_k: 5 },
        timeout: 10000,
      });

      const existing = searchResponse.data.results.find(
        r => r.metadata?.source === entry.source && r.metadata?.title === entry.title
      );

      if (existing && !options.force) {
        // Check if content changed by comparing hash
        if (existing.metadata?.content_hash === contentHash) {
          results.skipped++;
          continue;
        }
        // Content changed - update
        if (!options.dryRun) {
          await axios.post(`${coreUrl}/v1/memory/add`, {
            content: `${entry.title}\n\n${entry.content}`,
            metadata: {
              ...entry.metadata,
              title: entry.title,
              category: entry.category,
              section: entry.section,
              source: entry.source,
              content_hash: contentHash,
              synced_at: new Date().toISOString(),
              tags: [...(entry.tags || []), 'rex-deus', 'context'],
            },
          });
        }
        results.updated++;
      } else {
        // Create new entry
        if (!options.dryRun) {
          await axios.post(`${coreUrl}/v1/memory/add`, {
            content: `${entry.title}\n\n${entry.content}`,
            metadata: {
              ...entry.metadata,
              title: entry.title,
              category: entry.category,
              section: entry.section,
              source: entry.source,
              content_hash: contentHash,
              synced_at: new Date().toISOString(),
              tags: [...(entry.tags || []), 'rex-deus', 'context'],
            },
          });
        }
        results.created++;
      }
    } catch (err) {
      results.errors.push({
        title: entry.title,
        error: err.message,
      });
    }
  }

  return results;
}

// =============================================================================
// Sync Command - Synchronize rex-deus context to AI memory
// =============================================================================

/**
 * Sync command - Synchronize rex-deus context to MasterClaw memory
 */
program
  .command('sync')
  .description('Sync rex-deus context files to AI memory system')
  .option('-s, --sections <list>', 'Comma-separated sections to sync (preferences,projects,goals,knowledge,people)', '')
  .option('-t, --tag <tag>', 'Additional tag to add to all synced memories', '')
  .option('--dry-run', 'Preview changes without syncing', false)
  .option('-f, --force', 'Force re-sync all content (ignore change detection)', false)
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const spinner = ora('Syncing rex-deus context...').start();

    try {
      const rexDeusDir = await findRexDeusDir();

      if (!rexDeusDir) {
        spinner.fail('rex-deus directory not found');
        console.log(chalk.gray('   Ensure rex-deus repository is cloned and accessible'));
        process.exit(1);
      }

      // Determine which sections to sync
      let sectionsToSync = Object.keys(CONTEXT_FILES);
      if (options.sections) {
        const requested = options.sections.split(',').map(s => s.trim().toLowerCase());
        sectionsToSync = sectionsToSync.filter(s => requested.includes(s));
        if (sectionsToSync.length === 0) {
          spinner.fail('No valid sections specified');
          console.log(chalk.gray(`   Valid sections: ${Object.keys(CONTEXT_FILES).join(', ')}`));
          process.exit(1);
        }
      }

      spinner.stop();

      if (!options.json) {
        console.log(chalk.blue('🐾 Syncing rex-deus context to memory...\n'));
      }

      // Collect all entries from context files
      const allEntries = [];
      const fileStats = [];

      for (const sectionName of sectionsToSync) {
        const filename = CONTEXT_FILES[sectionName];
        const content = await loadContextFile(rexDeusDir, filename);

        if (content) {
          const entries = parseContextForSync(content, sectionName);
          allEntries.push(...entries);

          const stats = {
            section: sectionName,
            size: `${(content.length / 1024).toFixed(1)}KB`,
            entries: entries.length,
            hash: hashContent(content),
          };
          fileStats.push(stats);
        }
      }

      if (!options.json) {
        console.log(`Found ${fileStats.length} context files:`);
        for (const stat of fileStats) {
          console.log(`  ✅ ${stat.section}.md (${stat.size}) - ${stat.entries} sections`);
        }
        console.log();
      }

      // Sync to memory
      if (!options.json) {
        console.log('Syncing to MasterClaw Core...');
      }

      const results = await syncToMemory(allEntries, {
        dryRun: options.dryRun,
        force: options.force,
        tag: options.tag,
      });

      if (options.json) {
        console.log(JSON.stringify({
          files: fileStats,
          results,
          dryRun: options.dryRun,
        }, null, 2));
        return;
      }

      // Display results
      if (options.dryRun) {
        console.log(chalk.yellow('  DRY RUN - No changes made'));
        console.log(`  Would create: ${results.created} memories`);
        console.log(`  Would update: ${results.updated} memories`);
        console.log(`  Would skip: ${results.skipped} memories (unchanged)`);
      } else {
        console.log(`  ${chalk.green('Created:')} ${results.created} new memories`);
        console.log(`  ${chalk.blue('Updated:')} ${results.updated} existing`);
        console.log(`  ${chalk.gray('Skipped:')} ${results.skipped} (unchanged)`);
      }

      if (results.errors.length > 0) {
        console.log();
        console.log(chalk.yellow(`  ${results.errors.length} errors:`));
        for (const err of results.errors.slice(0, 5)) {
          console.log(chalk.gray(`    - ${err.title}: ${err.error}`));
        }
      }

      console.log();
      if (options.dryRun) {
        console.log(chalk.gray('Dry run complete. Run without --dry-run to apply changes.'));
      } else {
        console.log(chalk.green('✅ Context sync complete!'));
        console.log(chalk.gray('   Memories are now available to the AI.'));
        console.log();
        console.log(chalk.gray('   Tip: Use `mc memory search "your query"` to search synced context'));
      }

    } catch (err) {
      spinner.stop();

      if (err.code === 'ECONNREFUSED') {
        console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
        console.log(chalk.gray('   Ensure Core is running: mc status'));
        process.exit(1);
      }

      if (err.response?.status === 404) {
        console.log(chalk.yellow('⚠️  Memory API not available'));
        console.log(chalk.gray('   Ensure MasterClaw Core is running with memory support'));
        process.exit(1);
      }

      console.log(chalk.red(`❌ Sync failed: ${err.message}`));
      process.exit(1);
    }
  });

module.exports = program;
