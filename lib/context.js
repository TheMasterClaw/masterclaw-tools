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

module.exports = program;
