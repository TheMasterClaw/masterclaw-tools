/**
 * Changelog viewer for MasterClaw CLI
 * Displays changelogs from across the ecosystem (core, tools, infrastructure)
 * 
 * Features:
 * - View changelogs for specific components or all at once
 * - Filter by version or recent changes
 * - JSON output for scripting
 * - Colorized markdown rendering in terminal
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');

const { findInfraDir } = require('./services');
const config = require('./config');
const rateLimiter = require('./rate-limiter');
const { sanitizeForLog, isSafeString } = require('./security');

const changelog = new Command('changelog');

// =============================================================================
// Configuration
// =============================================================================

/** Maximum number of entries to display by default */
const DEFAULT_ENTRY_LIMIT = 20;

/** Maximum allowed entry limit (DoS protection) */
const MAX_ENTRY_LIMIT = 1000;

/** Valid component names */
const VALID_COMPONENTS = ['core', 'tools', 'infrastructure', 'interface', 'all'];

/** Changelog file paths relative to component directories */
const CHANGELOG_PATHS = {
  core: 'masterclaw-core/CHANGELOG.md',
  tools: 'masterclaw-tools/CHANGELOG.md',
  infrastructure: 'masterclaw-infrastructure/CHANGELOG.md',
  interface: 'MasterClawInterface/CHANGELOG.md',
};

// =============================================================================
// Input Validation
// =============================================================================

/**
 * Validates component name
 * @param {string} component - Component name to validate
 * @returns {boolean} - True if valid
 * @throws {Error} - If component name is invalid
 */
function validateComponent(component) {
  if (typeof component !== 'string') {
    throw new Error('Component must be a string');
  }
  
  if (!VALID_COMPONENTS.includes(component.toLowerCase())) {
    throw new Error(`Invalid component: ${component}. Valid: ${VALID_COMPONENTS.join(', ')}`);
  }
  
  return true;
}

/**
 * Validates entry limit
 * @param {number} limit - Limit to validate
 * @returns {number} - Validated limit
 * @throws {Error} - If limit is invalid
 */
function validateLimit(limit) {
  const num = parseInt(limit, 10);
  
  if (isNaN(num) || num < 1) {
    throw new Error('Limit must be a positive number');
  }
  
  if (num > MAX_ENTRY_LIMIT) {
    throw new Error(`Limit cannot exceed ${MAX_ENTRY_LIMIT}`);
  }
  
  return num;
}

/**
 * Validates version string
 * @param {string} version - Version to validate
 * @returns {boolean} - True if valid
 */
function validateVersion(version) {
  if (typeof version !== 'string') {
    return false;
  }
  
  if (version.length === 0 || version.length > 50) {
    return false;
  }
  
  // Allow semantic versioning patterns (e.g., 1.0.0, 1.0.0-beta.1)
  const versionPattern = /^v?\d+\.\d+\.\d+([\-+.]?[a-zA-Z0-9]+)*$/;
  return versionPattern.test(version);
}

// =============================================================================
// Changelog Parsing
// =============================================================================

/**
 * Parse a changelog file into structured entries
 * @param {string} content - Raw changelog content
 * @param {string} component - Component name
 * @returns {Array} - Parsed changelog entries
 */
function parseChangelog(content, component) {
  const entries = [];
  const lines = content.split('\n');
  
  let currentEntry = null;
  let currentSection = null;
  let buffer = [];
  
  for (const line of lines) {
    // Match version headers (## [1.0.0] or ## 1.0.0 or ## [Unreleased])
    // Must start with exactly ## (not ###)
    const versionMatch = line.match(/^##\s+\[?([^\]#\[]+)\]?/);
    
    if (versionMatch && !line.startsWith('###')) {
      // Save previous entry
      if (currentEntry && buffer.length > 0) {
        currentEntry.description = buffer.join('\n').trim();
      }
      
      // Start new entry
      currentEntry = {
        version: versionMatch[1].trim(),
        date: null,
        component,
        sections: {},
        description: '',
      };
      
      // Try to extract date from header (## [1.0.0] - 2024-01-15)
      const dateMatch = line.match(/-\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentEntry.date = dateMatch[1];
      }
      
      entries.push(currentEntry);
      buffer = [];
      currentSection = null;
      continue;
    }
    
    // Match section headers (### Added, ### Fixed, etc.)
    const sectionMatch = line.match(/^###\s*(.+)/);
    if (sectionMatch && currentEntry) {
      if (buffer.length > 0 && currentSection) {
        if (!currentEntry.sections[currentSection]) {
          currentEntry.sections[currentSection] = [];
        }
        currentEntry.sections[currentSection].push(buffer.join('\n').trim());
      }
      
      currentSection = sectionMatch[1].trim();
      buffer = [];
      continue;
    }
    
    // Match list items (- item or * item)
    const listMatch = line.match(/^[\s]*[-*]\s*(.+)/);
    if (listMatch && currentEntry && currentSection) {
      if (buffer.length > 0) {
        if (!currentEntry.sections[currentSection]) {
          currentEntry.sections[currentSection] = [];
        }
        currentEntry.sections[currentSection].push(buffer.join('\n').trim());
      }
      buffer = [listMatch[1]];
      continue;
    }
    
    // Continue buffer
    if (line.trim()) {
      buffer.push(line);
    }
  }
  
  // Don't forget the last entry
  if (currentEntry && buffer.length > 0) {
    if (currentSection) {
      if (!currentEntry.sections[currentSection]) {
        currentEntry.sections[currentSection] = [];
      }
      currentEntry.sections[currentSection].push(buffer.join('\n').trim());
    } else {
      currentEntry.description = buffer.join('\n').trim();
    }
  }
  
  return entries.filter(e => e.version.toLowerCase() !== 'changelog');
}

/**
 * Find changelog file for a component
 * @param {string} component - Component name
 * @returns {Promise<string|null>} - Path to changelog or null
 */
async function findChangelogPath(component) {
  const infraDir = await findInfraDir();
  
  if (!infraDir) {
    return null;
  }
  
  // Try multiple locations
  const candidates = [
    // Direct sibling of infrastructure
    path.join(path.dirname(infraDir), CHANGELOG_PATHS[component]),
    // Inside infrastructure directory
    path.join(infraDir, '..', CHANGELOG_PATHS[component]),
    // Nested structure
    path.join(infraDir, '..', '..', CHANGELOG_PATHS[component]),
    // Current workspace
    path.join(process.cwd(), CHANGELOG_PATHS[component]),
    // In the workspace directory
    path.join('/home/ubuntu/.openclaw/workspace', CHANGELOG_PATHS[component]),
  ];
  
  for (const candidate of candidates) {
    try {
      // Validate path to prevent directory traversal
      if (!isSafeString(candidate, { maxLength: 4096 })) {
        continue;
      }
      
      if (await fs.pathExists(candidate)) {
        return candidate;
      }
    } catch (err) {
      // Continue to next candidate
    }
  }
  
  return null;
}

/**
 * Read and parse changelog for a component
 * @param {string} component - Component name
 * @returns {Promise<Array|null>} - Parsed entries or null
 */
async function getChangelog(component) {
  const changelogPath = await findChangelogPath(component);
  
  if (!changelogPath) {
    return null;
  }
  
  try {
    const content = await fs.readFile(changelogPath, 'utf8');
    return parseChangelog(content, component);
  } catch (err) {
    if (process.env.MC_VERBOSE) {
      console.warn(chalk.yellow(`Warning: Could not read ${component} changelog: ${sanitizeForLog(err.message)}`));
    }
    return null;
  }
}

// =============================================================================
// Display Functions
// =============================================================================

/**
 * Format a single changelog entry for display
 * @param {Object} entry - Changelog entry
 * @param {boolean} compact - Use compact format
 * @returns {string} - Formatted entry
 */
function formatEntry(entry, compact = false) {
  const lines = [];
  
  // Header with version and date
  const versionColor = entry.version.toLowerCase() === 'unreleased' 
    ? chalk.yellow 
    : chalk.green;
  
  const dateStr = entry.date ? chalk.gray(`(${entry.date})`) : '';
  const componentStr = chalk.cyan(`[${entry.component}]`);
  
  lines.push(`${componentStr} ${versionColor(entry.version)} ${dateStr}`);
  
  if (compact) {
    // Just show the first line of description or section count
    const sectionCount = Object.keys(entry.sections).length;
    if (sectionCount > 0) {
      lines.push(chalk.gray(`  ${sectionCount} change sections`));
    }
    return lines.join('\n');
  }
  
  // Show sections
  for (const [sectionName, items] of Object.entries(entry.sections)) {
    const sectionColor = getSectionColor(sectionName);
    lines.push(`  ${sectionColor(sectionName)}:`);
    
    for (const item of items.slice(0, 5)) { // Limit items per section
      const shortItem = item.length > 80 ? item.substring(0, 77) + '...' : item;
      // Highlight key terms
      const highlightedItem = highlightTerms(shortItem);
      lines.push(`    • ${highlightedItem}`);
    }
    
    if (items.length > 5) {
      lines.push(chalk.gray(`    ... and ${items.length - 5} more`));
    }
  }
  
  return lines.join('\n');
}

/**
 * Get color for section name
 * @param {string} section - Section name
 * @returns {Function} - Chalk color function
 */
function getSectionColor(section) {
  const lower = section.toLowerCase();
  
  if (lower.includes('added') || lower.includes('new')) return chalk.green;
  if (lower.includes('fixed') || lower.includes('security')) return chalk.red;
  if (lower.includes('changed') || lower.includes('improved')) return chalk.yellow;
  if (lower.includes('deprecated')) return chalk.gray;
  if (lower.includes('removed')) return chalk.red.bold;
  
  return chalk.blue;
}

/**
 * Highlight important terms in changelog text
 * @param {string} text - Input text
 * @returns {string} - Text with highlights
 */
function highlightTerms(text) {
  const terms = [
    { pattern: /(NEW FEATURE|🆕|NEW)/gi, color: chalk.green.bold },
    { pattern: /(BREAKING CHANGE|⚠️|WARNING)/gi, color: chalk.yellow.bold },
    { pattern: /(SECURITY|🔒|🛡️)/gi, color: chalk.red.bold },
    { pattern: /(DEPRECATED|🚫)/gi, color: chalk.gray },
    { pattern: /(`[^`]+`)/g, color: chalk.cyan }, // Code snippets
  ];
  
  let result = text;
  for (const { pattern, color } of terms) {
    result = result.replace(pattern, (match) => color(match));
  }
  
  return result;
}

/**
 * Display changelogs in a summary view
 * @param {Object} changelogs - Map of component to entries
 * @param {Object} options - Display options
 */
function displaySummary(changelogs, options) {
  const { limit = DEFAULT_ENTRY_LIMIT } = options;
  
  console.log(chalk.blue('🐾 MasterClaw Changelog Summary'));
  console.log(chalk.gray('==============================\n'));
  
  // Collect all entries and sort by date/version
  const allEntries = [];
  for (const [component, entries] of Object.entries(changelogs)) {
    if (entries) {
      for (const entry of entries.slice(0, Math.ceil(limit / Object.keys(changelogs).length))) {
        allEntries.push({ ...entry, component });
      }
    }
  }
  
  // Sort: Unreleased first, then by date (newest first)
  allEntries.sort((a, b) => {
    if (a.version.toLowerCase() === 'unreleased') return -1;
    if (b.version.toLowerCase() === 'unreleased') return 1;
    if (a.date && b.date) return new Date(b.date) - new Date(a.date);
    return 0;
  });
  
  // Group by component for display
  const byComponent = {};
  for (const entry of allEntries.slice(0, limit)) {
    if (!byComponent[entry.component]) {
      byComponent[entry.component] = [];
    }
    byComponent[entry.component].push(entry);
  }
  
  // Display
  for (const [component, entries] of Object.entries(byComponent)) {
    console.log(chalk.cyan.bold(`📦 ${component.charAt(0).toUpperCase() + component.slice(1)}`));
    
    for (const entry of entries) {
      const versionColor = entry.version.toLowerCase() === 'unreleased'
        ? chalk.yellow.bold
        : chalk.white;
      const dateStr = entry.date ? chalk.gray(entry.date) : '';
      
      console.log(`  ${versionColor(entry.version.padEnd(12))} ${dateStr}`);
      
      // Show key highlights
      const highlights = [];
      if (entry.sections['Added'] || entry.sections['Added']) {
        highlights.push(chalk.green(`${(entry.sections['Added'] || []).length} added`));
      }
      if (entry.sections['Fixed']) {
        highlights.push(chalk.red(`${entry.sections['Fixed'].length} fixed`));
      }
      if (entry.sections['Changed']) {
        highlights.push(chalk.yellow(`${entry.sections['Changed'].length} changed`));
      }
      
      if (highlights.length > 0) {
        console.log(`    ${highlights.join(' | ')}`);
      }
    }
    console.log();
  }
  
  console.log(chalk.gray('Run `mc changelog <component>` for full details'));
}

/**
 * Display full changelog for a component
 * @param {Array} entries - Changelog entries
 * @param {string} component - Component name
 * @param {Object} options - Display options
 */
function displayFullChangelog(entries, component, options) {
  const { limit = DEFAULT_ENTRY_LIMIT, version } = options;
  
  console.log(chalk.blue(`🐾 MasterClaw ${component.charAt(0).toUpperCase() + component.slice(1)} Changelog`));
  console.log(chalk.gray('================================\n'));
  
  if (!entries || entries.length === 0) {
    console.log(chalk.yellow(`⚠️  No changelog found for ${component}`));
    return;
  }
  
  // Filter by version if specified
  let filteredEntries = entries;
  if (version) {
    filteredEntries = entries.filter(e => 
      e.version.toLowerCase() === version.toLowerCase() ||
      e.version.toLowerCase() === `v${version.toLowerCase()}`
    );
    
    if (filteredEntries.length === 0) {
      console.log(chalk.yellow(`⚠️  Version ${version} not found in ${component} changelog`));
      console.log(chalk.gray(`   Available versions: ${entries.slice(0, 10).map(e => e.version).join(', ')}`));
      return;
    }
  }
  
  // Display entries
  const displayEntries = filteredEntries.slice(0, limit);
  
  for (let i = 0; i < displayEntries.length; i++) {
    const entry = displayEntries[i];
    console.log(formatEntry(entry, false));
    
    if (i < displayEntries.length - 1) {
      console.log(); // Separator between entries
    }
  }
  
  if (filteredEntries.length > limit) {
    console.log(chalk.gray(`\n... and ${filteredEntries.length - limit} more entries`));
  }
}

// =============================================================================
// Commands
// =============================================================================

// Main changelog command
changelog
  .description('View changelogs from across the MasterClaw ecosystem')
  .argument('[component]', 'Component to show changelog for (core, tools, infrastructure, interface, all)', 'all')
  .option('-l, --limit <n>', 'Number of entries to show', String(DEFAULT_ENTRY_LIMIT))
  .option('-v, --version <version>', 'Show specific version only')
  .option('-j, --json', 'Output as JSON')
  .option('--since <date>', 'Show entries since date (YYYY-MM-DD)')
  .action(async (componentArg, options) => {
    // Rate limiting
    try {
      await rateLimiter.enforceRateLimit('changelog', { 
        command: 'changelog',
        component: componentArg 
      });
    } catch (err) {
      console.log(chalk.yellow('⚠️  Rate limit exceeded. Please wait before viewing changelog again.'));
      process.exit(6);
    }
    
    // Validate inputs
    const component = componentArg.toLowerCase();
    try {
      validateComponent(component);
    } catch (err) {
      console.log(chalk.red(`❌ ${err.message}`));
      process.exit(2);
    }
    
    let limit;
    try {
      limit = validateLimit(options.limit);
    } catch (err) {
      console.log(chalk.red(`❌ ${err.message}`));
      process.exit(2);
    }
    
    if (options.version && !validateVersion(options.version)) {
      console.log(chalk.red(`❌ Invalid version format: ${options.version}`));
      process.exit(2);
    }
    
    // Determine which components to fetch
    const componentsToFetch = component === 'all' 
      ? ['core', 'tools', 'infrastructure']
      : [component];
    
    // Fetch changelogs
    const changelogs = {};
    for (const comp of componentsToFetch) {
      changelogs[comp] = await getChangelog(comp);
    }
    
    // JSON output mode
    if (options.json) {
      const output = {};
      for (const [comp, entries] of Object.entries(changelogs)) {
        if (entries) {
          let filteredEntries = entries;
          
          if (options.version) {
            filteredEntries = entries.filter(e => 
              e.version.toLowerCase() === options.version.toLowerCase()
            );
          }
          
          if (options.since) {
            const sinceDate = new Date(options.since);
            filteredEntries = entries.filter(e => 
              e.date && new Date(e.date) >= sinceDate
            );
          }
          
          output[comp] = filteredEntries.slice(0, limit);
        }
      }
      
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    
    // Summary view for 'all'
    if (component === 'all') {
      displaySummary(changelogs, { limit });
      return;
    }
    
    // Full view for specific component
    displayFullChangelog(changelogs[component], component, { 
      limit, 
      version: options.version 
    });
  });

// Latest subcommand - show latest changes across all components
changelog
  .command('latest')
  .description('Show the latest changes from all components')
  .option('-n, --entries <n>', 'Number of entries per component', '3')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      await rateLimiter.enforceRateLimit('changelog-latest', { command: 'changelog latest' });
    } catch (err) {
      console.log(chalk.yellow('⚠️  Rate limit exceeded.'));
      process.exit(6);
    }
    
    let entriesPerComponent;
    try {
      entriesPerComponent = validateLimit(options.entries);
    } catch (err) {
      console.log(chalk.red(`❌ ${err.message}`));
      process.exit(2);
    }
    
    const components = ['core', 'tools', 'infrastructure'];
    const changelogs = {};
    
    for (const comp of components) {
      changelogs[comp] = await getChangelog(comp);
    }
    
    if (options.json) {
      const output = {};
      for (const [comp, entries] of Object.entries(changelogs)) {
        if (entries) {
          output[comp] = entries.slice(0, entriesPerComponent);
        }
      }
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    
    console.log(chalk.blue('🐾 Latest MasterClaw Changes'));
    console.log(chalk.gray('============================\n'));
    
    for (const [comp, entries] of Object.entries(changelogs)) {
      if (!entries || entries.length === 0) {
        continue;
      }
      
      console.log(chalk.cyan.bold(`📦 ${comp.charAt(0).toUpperCase() + comp.slice(1)}`));
      
      const latestEntries = entries.slice(0, entriesPerComponent);
      for (const entry of latestEntries) {
        const versionColor = entry.version.toLowerCase() === 'unreleased'
          ? chalk.yellow.bold
          : chalk.white;
        const dateStr = entry.date ? chalk.gray(`(${entry.date})`) : '';
        
        console.log(`  ${versionColor(entry.version)} ${dateStr}`);
        
        // Show first item from each section
        let itemCount = 0;
        for (const [sectionName, items] of Object.entries(entry.sections)) {
          if (items.length > 0 && itemCount < 3) {
            const sectionColor = getSectionColor(sectionName);
            const firstItem = items[0].split('\n')[0]; // First line only
            const shortItem = firstItem.length > 60 
              ? firstItem.substring(0, 57) + '...' 
              : firstItem;
            console.log(`    ${sectionColor(sectionName)}: ${shortItem}`);
            itemCount++;
          }
        }
      }
      console.log();
    }
    
    console.log(chalk.gray('Run `mc changelog <component>` for full details'));
  });

// Search subcommand - search across all changelogs
changelog
  .command('search')
  .description('Search for terms across all changelogs')
  .argument('<query>', 'Search query')
  .option('-j, --json', 'Output as JSON')
  .action(async (query, options) => {
    try {
      await rateLimiter.enforceRateLimit('changelog-search', { 
        command: 'changelog search',
        query: query.substring(0, 100)
      });
    } catch (err) {
      console.log(chalk.yellow('⚠️  Rate limit exceeded.'));
      process.exit(6);
    }
    
    if (!query || query.trim().length === 0) {
      console.log(chalk.red('❌ Search query is required'));
      process.exit(2);
    }
    
    const searchTerm = query.toLowerCase();
    const components = ['core', 'tools', 'infrastructure'];
    const results = [];
    
    for (const comp of components) {
      const entries = await getChangelog(comp);
      if (!entries) continue;
      
      for (const entry of entries) {
        // Search in version
        if (entry.version.toLowerCase().includes(searchTerm)) {
          results.push({ ...entry, component: comp, matchType: 'version' });
          continue;
        }
        
        // Search in sections
        for (const [sectionName, items] of Object.entries(entry.sections)) {
          for (const item of items) {
            if (item.toLowerCase().includes(searchTerm)) {
              results.push({ 
                ...entry, 
                component: comp, 
                matchType: 'content',
                matchedSection: sectionName,
                matchedItem: item
              });
              break;
            }
          }
        }
      }
    }
    
    if (options.json) {
      console.log(JSON.stringify(results.slice(0, 50), null, 2));
      return;
    }
    
    console.log(chalk.blue(`🐾 Changelog Search: "${query}"`));
    console.log(chalk.gray('================================\n'));
    
    if (results.length === 0) {
      console.log(chalk.yellow('⚠️  No results found'));
      return;
    }
    
    console.log(chalk.cyan(`Found ${results.length} results:\n`));
    
    for (const result of results.slice(0, 20)) {
      const versionColor = result.version.toLowerCase() === 'unreleased'
        ? chalk.yellow
        : chalk.green;
      const componentStr = chalk.cyan(`[${result.component}]`);
      
      console.log(`${componentStr} ${versionColor(result.version)}`);
      
      if (result.matchedItem) {
        const lines = result.matchedItem.split('\n');
        const firstLine = lines[0];
        
        // Highlight the search term
        const highlightedLine = firstLine.replace(
          new RegExp(`(${query})`, 'gi'),
          chalk.yellow.bold('$1')
        );
        
        console.log(`  ${highlightedLine.substring(0, 100)}${firstLine.length > 100 ? '...' : ''}`);
      }
      console.log();
    }
    
    if (results.length > 20) {
      console.log(chalk.gray(`... and ${results.length - 20} more results`));
    }
  });

// Export for testing
module.exports = changelog;
module.exports.parseChangelog = parseChangelog;
module.exports.validateComponent = validateComponent;
module.exports.validateLimit = validateLimit;
module.exports.validateVersion = validateVersion;
module.exports.findChangelogPath = findChangelogPath;
module.exports.getChangelog = getChangelog;
module.exports.formatEntry = formatEntry;
module.exports.highlightTerms = highlightTerms;
