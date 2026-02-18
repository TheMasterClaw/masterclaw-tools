/**
 * MasterClaw Plugin System
 * 
 * Allows extending the mc CLI with custom commands without modifying core code.
 * Plugins can be installed from npm, git repos, or local directories.
 * 
 * Usage:
 *   mc plugin list                    List installed plugins
 *   mc plugin install <name>          Install a plugin from npm
 *   mc plugin install <git-url>       Install from git repository
 *   mc plugin install ./local-path    Install from local directory
 *   mc plugin uninstall <name>        Remove a plugin
 *   mc plugin enable <name>           Enable a disabled plugin
 *   mc plugin disable <name>          Disable a plugin (keep installed)
 *   mc plugin info <name>             Show plugin details
 *   mc plugin search <query>          Search npm for plugins
 *   mc plugin update [name]           Update plugin(s)
 *   mc plugin create <name>           Scaffold a new plugin
 *   mc plugin run <name> [args]       Run a plugin command directly
 */

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync, spawn } = require('child_process');
const ora = require('ora');
const axios = require('axios');

const { wrapCommand, ExitCode } = require('./error-handler');
const logger = require('./logger');

// Plugin registry paths
const REX_DEUS_DIR = process.env.REX_DEUS_DIR || path.join(process.env.HOME || '/home/ubuntu', '.openclaw/workspace/rex-deus');
const PLUGINS_DIR = path.join(REX_DEUS_DIR, 'plugins');
const PLUGIN_REGISTRY_FILE = path.join(REX_DEUS_DIR, 'config', 'plugins.json');

// Plugin manifest schema version
const MANIFEST_VERSION = '1.0.0';

// Default plugin registry
const DEFAULT_REGISTRY = {
  version: MANIFEST_VERSION,
  plugins: {},
  sources: {
    npm: 'https://registry.npmjs.org',
    github: 'https://github.com'
  }
};

/**
 * Plugin manifest interface:
 * {
 *   name: string,           // Plugin name (must start with 'mc-plugin-')
 *   version: string,        // Semver version
 *   description: string,    // Short description
 *   author: string,         // Author name/email
 *   main: string,           // Entry point (relative to plugin dir)
 *   command: string,        // CLI command name (e.g., 'hello' -> 'mc hello')
 *   bin?: string,           // Optional: binary to execute
 *   scripts?: {
 *     install?: string,     // Run on plugin install
 *     uninstall?: string,   // Run on plugin uninstall
 *     update?: string       // Run on plugin update
 *   },
 *   dependencies?: string[], // npm dependencies to install
 *   permissions?: string[], // Required permissions (fs, network, docker, etc.)
 *   hooks?: {              // Lifecycle hooks
 *     preCommand?: string,
 *     postCommand?: string
 *   },
 *   config?: object         // Default configuration
 * }
 */

// Ensure plugin directories exist
async function ensurePluginDirs() {
  await fs.ensureDir(PLUGINS_DIR);
  await fs.ensureDir(path.dirname(PLUGIN_REGISTRY_FILE));
  if (!await fs.pathExists(PLUGIN_REGISTRY_FILE)) {
    await fs.writeJson(PLUGIN_REGISTRY_FILE, DEFAULT_REGISTRY, { spaces: 2 });
  }
}

// Load plugin registry
async function loadRegistry() {
  await ensurePluginDirs();
  try {
    return await fs.readJson(PLUGIN_REGISTRY_FILE);
  } catch (error) {
    logger.error('Failed to load plugin registry', { error: error.message });
    return DEFAULT_REGISTRY;
  }
}

// Save plugin registry
async function saveRegistry(registry) {
  await fs.writeJson(PLUGIN_REGISTRY_FILE, registry, { spaces: 2 });
}

// Get installed plugins
async function getInstalledPlugins() {
  const registry = await loadRegistry();
  const plugins = [];
  
  for (const [name, info] of Object.entries(registry.plugins)) {
    const pluginPath = path.join(PLUGINS_DIR, name);
    const exists = await fs.pathExists(pluginPath);
    const manifestPath = path.join(pluginPath, 'manifest.json');
    
    let manifest = null;
    if (await fs.pathExists(manifestPath)) {
      try {
        manifest = await fs.readJson(manifestPath);
      } catch (e) {
        // Invalid manifest
      }
    }
    
    plugins.push({
      name,
      ...info,
      installed: exists,
      manifest,
      path: pluginPath
    });
  }
  
  return plugins;
}

// Validate plugin name
function validatePluginName(name) {
  if (!name) return { valid: false, error: 'Plugin name is required' };
  if (!/^mc-plugin-[a-z0-9-]+$/.test(name)) {
    return { 
      valid: false, 
      error: 'Plugin name must start with "mc-plugin-" and contain only lowercase letters, numbers, and hyphens' 
    };
  }
  return { valid: true };
}

// Validate plugin manifest
function validateManifest(manifest) {
  const required = ['name', 'version', 'description', 'main', 'command'];
  const missing = required.filter(field => !manifest[field]);
  
  if (missing.length > 0) {
    return { valid: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  
  if (!validatePluginName(manifest.name).valid) {
    return { valid: false, error: 'Invalid plugin name in manifest' };
  }
  
  return { valid: true };
}

// Install plugin from npm
async function installFromNpm(packageName, registry) {
  const spinner = ora(`Installing ${packageName} from npm...`).start();
  
  try {
    // Validate name
    const validation = validatePluginName(packageName);
    if (!validation.valid) {
      spinner.fail(validation.error);
      return { success: false, error: validation.error };
    }
    
    const pluginPath = path.join(PLUGINS_DIR, packageName);
    
    // Check if already installed
    if (await fs.pathExists(pluginPath)) {
      spinner.fail(`Plugin ${packageName} is already installed`);
      return { success: false, error: 'Plugin already installed' };
    }
    
    // Create temp directory for download
    const tempDir = path.join(PLUGINS_DIR, `.tmp-${Date.now()}`);
    await fs.ensureDir(tempDir);
    
    try {
      // Download and extract from npm
      const npmInfo = await axios.get(`${registry.sources.npm}/${packageName}`);
      const latestVersion = npmInfo.data['dist-tags']?.latest;
      
      if (!latestVersion) {
        throw new Error('Could not find latest version');
      }
      
      const tarballUrl = npmInfo.data.versions[latestVersion].dist.tarball;
      
      // Download tarball
      const tarballPath = path.join(tempDir, 'package.tgz');
      const response = await axios.get(tarballUrl, { responseType: 'arraybuffer' });
      await fs.writeFile(tarballPath, response.data);
      
      // Extract
      execSync(`tar -xzf ${tarballPath} -C ${tempDir}`, { stdio: 'ignore' });
      
      // Move to final location
      const extractedDir = path.join(tempDir, 'package');
      await fs.move(extractedDir, pluginPath);
      
      // Read manifest
      const manifestPath = path.join(pluginPath, 'manifest.json');
      if (!await fs.pathExists(manifestPath)) {
        // Try to use package.json as fallback
        const packageJsonPath = path.join(pluginPath, 'package.json');
        if (await fs.pathExists(packageJsonPath)) {
          const pkg = await fs.readJson(packageJsonPath);
          const manifest = {
            name: pkg.name,
            version: pkg.version,
            description: pkg.description || '',
            author: pkg.author || '',
            main: pkg.main || 'index.js',
            command: pkg.name.replace('mc-plugin-', ''),
            dependencies: Object.keys(pkg.dependencies || {})
          };
          await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        } else {
          throw new Error('No manifest.json or package.json found');
        }
      }
      
      const manifest = await fs.readJson(manifestPath);
      
      // Validate manifest
      const manifestValidation = validateManifest(manifest);
      if (!manifestValidation.valid) {
        throw new Error(manifestValidation.error);
      }
      
      // Install dependencies if present
      if (manifest.dependencies && manifest.dependencies.length > 0) {
        spinner.text = 'Installing dependencies...';
        const nodeModulesPath = path.join(pluginPath, 'node_modules');
        await fs.ensureDir(nodeModulesPath);
        
        for (const dep of manifest.dependencies) {
          try {
            execSync(`npm install ${dep} --prefix ${pluginPath}`, { 
              stdio: 'ignore',
              timeout: 60000 
            });
          } catch (e) {
            logger.warn(`Failed to install dependency: ${dep}`, { error: e.message });
          }
        }
      }
      
      // Run install script if present
      if (manifest.scripts?.install) {
        spinner.text = 'Running install script...';
        execSync(manifest.scripts.install, { 
          cwd: pluginPath, 
          stdio: 'ignore' 
        });
      }
      
      // Update registry
      const reg = await loadRegistry();
      reg.plugins[packageName] = {
        version: latestVersion,
        installedAt: new Date().toISOString(),
        source: 'npm',
        enabled: true,
        command: manifest.command
      };
      await saveRegistry(reg);
      
      spinner.succeed(`Installed ${packageName}@${latestVersion}`);
      
      return { 
        success: true, 
        name: packageName, 
        version: latestVersion,
        command: manifest.command 
      };
      
    } finally {
      // Cleanup temp directory
      await fs.remove(tempDir).catch(() => {});
    }
    
  } catch (error) {
    spinner.fail(`Failed to install ${packageName}`);
    logger.error('Plugin install error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Install plugin from git repository
async function installFromGit(gitUrl, registry) {
  const spinner = ora(`Installing from ${gitUrl}...`).start();
  
  try {
    // Extract plugin name from URL
    const match = gitUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    if (!match) {
      throw new Error('Could not extract plugin name from URL');
    }
    
    const packageName = match[1];
    const validation = validatePluginName(packageName);
    if (!validation.valid) {
      spinner.fail(validation.error);
      return { success: false, error: validation.error };
    }
    
    const pluginPath = path.join(PLUGINS_DIR, packageName);
    
    // Check if already installed
    if (await fs.pathExists(pluginPath)) {
      spinner.fail(`Plugin ${packageName} is already installed`);
      return { success: false, error: 'Plugin already installed' };
    }
    
    // Clone repository
    execSync(`git clone --depth 1 ${gitUrl} ${pluginPath}`, { stdio: 'ignore' });
    
    // Read manifest
    const manifestPath = path.join(pluginPath, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('No manifest.json found in repository');
    }
    
    const manifest = await fs.readJson(manifestPath);
    
    // Validate manifest
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.valid) {
      throw new Error(manifestValidation.error);
    }
    
    // Install npm dependencies if package.json exists
    const packageJsonPath = path.join(pluginPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      spinner.text = 'Installing npm dependencies...';
      try {
        execSync('npm install', { cwd: pluginPath, stdio: 'ignore' });
      } catch (e) {
        logger.warn('Failed to install npm dependencies', { error: e.message });
      }
    }
    
    // Run install script if present
    if (manifest.scripts?.install) {
      spinner.text = 'Running install script...';
      execSync(manifest.scripts.install, { cwd: pluginPath, stdio: 'ignore' });
    }
    
    // Update registry
    const reg = await loadRegistry();
    reg.plugins[packageName] = {
      version: manifest.version,
      installedAt: new Date().toISOString(),
      source: 'git',
      sourceUrl: gitUrl,
      enabled: true,
      command: manifest.command
    };
    await saveRegistry(reg);
    
    spinner.succeed(`Installed ${packageName}@${manifest.version} from git`);
    
    return { 
      success: true, 
      name: packageName, 
      version: manifest.version,
      command: manifest.command 
    };
    
  } catch (error) {
    spinner.fail(`Failed to install from git`);
    logger.error('Git install error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Install from local directory
async function installFromLocal(localPath, registry) {
  const spinner = ora(`Installing from ${localPath}...`).start();
  
  try {
    const resolvedPath = path.resolve(localPath);
    
    if (!await fs.pathExists(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }
    
    // Read manifest
    const manifestPath = path.join(resolvedPath, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('No manifest.json found in directory');
    }
    
    const manifest = await fs.readJson(manifestPath);
    
    // Validate manifest
    const manifestValidation = validateManifest(manifest);
    if (!manifestValidation.valid) {
      throw new Error(manifestValidation.error);
    }
    
    const packageName = manifest.name;
    const pluginPath = path.join(PLUGINS_DIR, packageName);
    
    // Check if already installed
    if (await fs.pathExists(pluginPath)) {
      spinner.fail(`Plugin ${packageName} is already installed`);
      return { success: false, error: 'Plugin already installed' };
    }
    
    // Copy directory
    await fs.copy(resolvedPath, pluginPath);
    
    // Update registry
    const reg = await loadRegistry();
    reg.plugins[packageName] = {
      version: manifest.version,
      installedAt: new Date().toISOString(),
      source: 'local',
      sourcePath: resolvedPath,
      enabled: true,
      command: manifest.command
    };
    await saveRegistry(reg);
    
    spinner.succeed(`Installed ${packageName}@${manifest.version} from local path`);
    
    return { 
      success: true, 
      name: packageName, 
      version: manifest.version,
      command: manifest.command 
    };
    
  } catch (error) {
    spinner.fail(`Failed to install from local path`);
    logger.error('Local install error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Uninstall plugin
async function uninstallPlugin(name) {
  const spinner = ora(`Uninstalling ${name}...`).start();
  
  try {
    const registry = await loadRegistry();
    
    if (!registry.plugins[name]) {
      spinner.fail(`Plugin ${name} is not installed`);
      return { success: false, error: 'Plugin not found' };
    }
    
    const pluginPath = path.join(PLUGINS_DIR, name);
    const manifestPath = path.join(pluginPath, 'manifest.json');
    
    // Run uninstall script if present
    if (await fs.pathExists(manifestPath)) {
      try {
        const manifest = await fs.readJson(manifestPath);
        if (manifest.scripts?.uninstall) {
          spinner.text = 'Running uninstall script...';
          execSync(manifest.scripts.uninstall, { cwd: pluginPath, stdio: 'ignore' });
        }
      } catch (e) {
        // Ignore manifest errors during uninstall
      }
    }
    
    // Remove plugin directory
    await fs.remove(pluginPath);
    
    // Update registry
    delete registry.plugins[name];
    await saveRegistry(registry);
    
    spinner.succeed(`Uninstalled ${name}`);
    return { success: true };
    
  } catch (error) {
    spinner.fail(`Failed to uninstall ${name}`);
    logger.error('Uninstall error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Enable/disable plugin
async function setPluginEnabled(name, enabled) {
  try {
    const registry = await loadRegistry();
    
    if (!registry.plugins[name]) {
      return { success: false, error: 'Plugin not found' };
    }
    
    registry.plugins[name].enabled = enabled;
    await saveRegistry(registry);
    
    return { success: true };
  } catch (error) {
    logger.error('Failed to update plugin status', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Update plugin
async function updatePlugin(name) {
  const spinner = ora(`Updating ${name}...`).start();
  
  try {
    const registry = await loadRegistry();
    const plugin = registry.plugins[name];
    
    if (!plugin) {
      spinner.fail(`Plugin ${name} is not installed`);
      return { success: false, error: 'Plugin not found' };
    }
    
    // Re-install based on source
    if (plugin.source === 'npm') {
      // Check for updates on npm
      const npmInfo = await axios.get(`${registry.sources.npm}/${name}`);
      const latestVersion = npmInfo.data['dist-tags']?.latest;
      
      if (latestVersion === plugin.version) {
        spinner.info(`${name} is already up to date (${latestVersion})`);
        return { success: true, upToDate: true };
      }
      
      // Run update script if present
      const pluginPath = path.join(PLUGINS_DIR, name);
      const manifestPath = path.join(pluginPath, 'manifest.json');
      
      if (await fs.pathExists(manifestPath)) {
        const manifest = await fs.readJson(manifestPath);
        if (manifest.scripts?.update) {
          spinner.text = 'Running pre-update script...';
          execSync(manifest.scripts.update, { cwd: pluginPath, stdio: 'ignore' });
        }
      }
      
      // Remove and re-install
      await fs.remove(pluginPath);
      
      const result = await installFromNpm(name, registry);
      if (result.success) {
        spinner.succeed(`Updated ${name} to ${result.version}`);
      }
      return result;
      
    } else if (plugin.source === 'git') {
      spinner.text = 'Pulling latest from git...';
      const pluginPath = path.join(PLUGINS_DIR, name);
      
      execSync('git pull', { cwd: pluginPath, stdio: 'ignore' });
      
      // Re-read manifest for new version
      const manifestPath = path.join(pluginPath, 'manifest.json');
      const manifest = await fs.readJson(manifestPath);
      
      plugin.version = manifest.version;
      plugin.updatedAt = new Date().toISOString();
      await saveRegistry(registry);
      
      spinner.succeed(`Updated ${name} to ${manifest.version}`);
      return { success: true, version: manifest.version };
      
    } else {
      spinner.info(`Local plugins cannot be automatically updated`);
      return { success: true, skipped: true };
    }
    
  } catch (error) {
    spinner.fail(`Failed to update ${name}`);
    logger.error('Update error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Search npm for plugins
async function searchPlugins(query) {
  const spinner = ora(`Searching for "${query}"...`).start();
  
  try {
    const response = await axios.get(
      `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}+mc-plugin&size=20`
    );
    
    spinner.stop();
    
    const packages = response.data.objects || [];
    
    if (packages.length === 0) {
      console.log(chalk.yellow('No plugins found matching your query.'));
      return [];
    }
    
    return packages.map(pkg => ({
      name: pkg.package.name,
      version: pkg.package.version,
      description: pkg.package.description,
      author: pkg.package.author?.name || 'Unknown',
      date: pkg.package.date
    }));
    
  } catch (error) {
    spinner.fail('Search failed');
    logger.error('Search error', { error: error.message });
    return [];
  }
}

// Scaffold a new plugin
async function createPlugin(name) {
  const spinner = ora(`Creating plugin ${name}...`).start();
  
  try {
    const validation = validatePluginName(name);
    if (!validation.valid) {
      spinner.fail(validation.error);
      return { success: false, error: validation.error };
    }
    
    const command = name.replace('mc-plugin-', '');
    const pluginDir = path.join(process.cwd(), name);
    
    if (await fs.pathExists(pluginDir)) {
      spinner.fail(`Directory ${name} already exists`);
      return { success: false, error: 'Directory already exists' };
    }
    
    // Create directory structure
    await fs.ensureDir(pluginDir);
    
    // Create manifest.json
    const manifest = {
      name: name,
      version: '1.0.0',
      description: `A MasterClaw plugin that adds the '${command}' command`,
      author: 'Your Name <email@example.com>',
      main: 'index.js',
      command: command,
      dependencies: [],
      permissions: ['fs'],
      config: {
        greeting: 'Hello from MasterClaw!'
      }
    };
    
    await fs.writeJson(path.join(pluginDir, 'manifest.json'), manifest, { spaces: 2 });
    
    // Create index.js
    const indexJs = `#!/usr/bin/env node
/**
 * ${name}
 * ${manifest.description}
 */

const chalk = require('chalk');

// Load config
const config = require('./config.json');

// Main entry point
async function main(args) {
  console.log(chalk.blue('🐾'), chalk.bold(config.greeting || 'Hello from ${name}!'));
  
  if (args.length === 0) {
    console.log('\\nUsage: mc ${command} [options]');
    console.log('\\nOptions:');
    console.log('  --help     Show help');
    console.log('  --version  Show version');
    return;
  }
  
  // Handle arguments
  const arg = args[0];
  
  if (arg === '--help' || arg === '-h') {
    console.log('\\n${name} - ${manifest.description}');
    console.log('\\nUsage: mc ${command} [options]');
    console.log('\\nThis is a template plugin. Customize it to add your own functionality!');
  } else if (arg === '--version' || arg === '-v') {
    console.log('${manifest.version}');
  } else {
    console.log(chalk.green('You ran:'), args.join(' '));
    console.log(chalk.gray('\\nEdit index.js to customize this plugin!'));
  }
}

// Run if called directly
if (require.main === module) {
  main(process.argv.slice(2)).catch(err => {
    console.error(chalk.red('Error:'), err.message);
    process.exit(1);
  });
}

module.exports = { main };
`;
    
    await fs.writeFile(path.join(pluginDir, 'index.js'), indexJs);
    
    // Create config.json
    await fs.writeJson(path.join(pluginDir, 'config.json'), manifest.config, { spaces: 2 });
    
    // Create README.md
    const readme = `# ${name}

${manifest.description}

## Installation

\`\`\`bash
mc plugin install ./${name}
\`\`\`

## Usage

\`\`\`bash
mc ${command}
\`\`\`

## Configuration

Edit \`config.json\` to customize the plugin behavior.

## Development

1. Make changes to \`index.js\`
2. Test with \`node index.js --help\`
3. Re-install with \`mc plugin uninstall ${name} && mc plugin install ./${name}\`

## License

MIT
`;
    
    await fs.writeFile(path.join(pluginDir, 'README.md'), readme);
    
    // Create .gitignore
    const gitignore = `node_modules/
*.log
.DS_Store
`;
    
    await fs.writeFile(path.join(pluginDir, '.gitignore'), gitignore);
    
    spinner.succeed(`Created ${name} in ./${name}/`);
    
    console.log(chalk.blue('\\nNext steps:'));
    console.log(`  cd ${name}`);
    console.log('  npm init -y  # Optional: if you need npm dependencies');
    console.log('  # Edit index.js to customize');
    console.log(`  mc plugin install ./${name}  # Install to mc`);
    
    return { success: true, path: pluginDir };
    
  } catch (error) {
    spinner.fail(`Failed to create plugin`);
    logger.error('Create error', { error: error.message });
    return { success: false, error: error.message };
  }
}

// Execute a plugin
async function executePlugin(name, args) {
  try {
    const registry = await loadRegistry();
    const plugin = registry.plugins[name];
    
    if (!plugin) {
      console.error(chalk.red(`Plugin ${name} is not installed`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    if (!plugin.enabled) {
      console.error(chalk.yellow(`Plugin ${name} is disabled. Enable with: mc plugin enable ${name}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    const pluginPath = path.join(PLUGINS_DIR, name);
    const manifestPath = path.join(pluginPath, 'manifest.json');
    
    if (!await fs.pathExists(manifestPath)) {
      console.error(chalk.red(`Plugin ${name} is missing its manifest`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    const manifest = await fs.readJson(manifestPath);
    const mainPath = path.join(pluginPath, manifest.main);
    
    if (!await fs.pathExists(mainPath)) {
      console.error(chalk.red(`Plugin ${name} main file not found: ${manifest.main}`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    // Run pre-command hook if present
    if (manifest.hooks?.preCommand) {
      execSync(manifest.hooks.preCommand, { cwd: pluginPath, stdio: 'inherit' });
    }
    
    // Execute plugin
    if (manifest.bin) {
      // Binary execution
      const binPath = path.join(pluginPath, manifest.bin);
      const child = spawn(binPath, args, {
        cwd: pluginPath,
        stdio: 'inherit'
      });
      
      child.on('close', (code) => {
        // Run post-command hook
        if (manifest.hooks?.postCommand) {
          execSync(manifest.hooks.postCommand, { cwd: pluginPath, stdio: 'ignore' });
        }
        process.exit(code || 0);
      });
    } else {
      // Node.js module execution
      const pluginModule = require(mainPath);
      
      if (typeof pluginModule.main === 'function') {
        await pluginModule.main(args);
      } else if (typeof pluginModule === 'function') {
        await pluginModule(args);
      } else {
        // Try to run as script
        const child = spawn('node', [mainPath, ...args], {
          cwd: pluginPath,
          stdio: 'inherit'
        });
        
        child.on('close', (code) => {
          // Run post-command hook
          if (manifest.hooks?.postCommand) {
            execSync(manifest.hooks.postCommand, { cwd: pluginPath, stdio: 'ignore' });
          }
          process.exit(code || 0);
        });
        
        return; // Don't run hooks here, handled in child.on('close')
      }
      
      // Run post-command hook
      if (manifest.hooks?.postCommand) {
        execSync(manifest.hooks.postCommand, { cwd: pluginPath, stdio: 'ignore' });
      }
    }
    
  } catch (error) {
    console.error(chalk.red(`Plugin execution error:`), error.message);
    logger.error('Plugin execution error', { plugin: name, error: error.message });
    process.exit(ExitCode.GENERAL_ERROR);
  }
}

// Create the plugin command
const pluginCmd = new Command('plugin')
  .description('Manage MasterClaw CLI plugins - extend mc with custom commands');

// List plugins
pluginCmd
  .command('list')
  .description('List installed plugins')
  .option('-a, --all', 'Show all plugins including disabled')
  .action(wrapCommand(async (options) => {
    const plugins = await getInstalledPlugins();
    
    if (plugins.length === 0) {
      console.log(chalk.yellow('No plugins installed.'));
      console.log(chalk.gray('Install a plugin with: mc plugin install <name>'));
      return;
    }
    
    console.log(chalk.blue('🐾 Installed Plugins\n'));
    
    const enabled = plugins.filter(p => p.enabled && p.installed);
    const disabled = plugins.filter(p => !p.enabled && p.installed);
    const missing = plugins.filter(p => !p.installed);
    
    if (enabled.length > 0) {
      console.log(chalk.green('Enabled:'));
      enabled.forEach(p => {
        const cmd = p.manifest?.command || p.command || 'unknown';
        console.log(`  ● ${chalk.bold(p.name)}@${p.version || 'unknown'}`);
        console.log(`    Command: mc ${cmd}`);
        if (p.manifest?.description) {
          console.log(`    ${chalk.gray(p.manifest.description)}`);
        }
        console.log();
      });
    }
    
    if (options.all && disabled.length > 0) {
      console.log(chalk.yellow('Disabled:'));
      disabled.forEach(p => {
        console.log(`  ○ ${chalk.bold(p.name)}`);
        console.log(`    Run: mc plugin enable ${p.name}`);
        console.log();
      });
    }
    
    if (options.all && missing.length > 0) {
      console.log(chalk.red('Missing (files deleted):'));
      missing.forEach(p => {
        console.log(`  ✗ ${chalk.bold(p.name)}`);
        console.log(`    Run: mc plugin uninstall ${p.name} to clean up`);
        console.log();
      });
    }
    
    console.log(chalk.gray(`Total: ${plugins.length} plugins (${enabled.length} enabled)`));
  }, 'plugin-list'));

// Install plugin
pluginCmd
  .command('install <source>')
  .description('Install a plugin from npm, git, or local path')
  .option('-g, --global', 'Install globally (default)')
  .action(wrapCommand(async (source) => {
    const registry = await loadRegistry();
    
    let result;
    if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@')) {
      result = await installFromGit(source, registry);
    } else if (source.startsWith('./') || source.startsWith('../') || source.startsWith('/')) {
      result = await installFromLocal(source, registry);
    } else {
      result = await installFromNpm(source, registry);
    }
    
    if (!result.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    console.log(chalk.green(`\n✅ Plugin installed successfully!`));
    console.log(chalk.blue(`\nUsage: mc ${result.command}`));
    console.log(chalk.gray(`Run 'mc plugin info ${result.name}' for details`));
  }, 'plugin-install'));

// Uninstall plugin
pluginCmd
  .command('uninstall <name>')
  .description('Uninstall a plugin')
  .alias('remove')
  .action(wrapCommand(async (name) => {
    const result = await uninstallPlugin(name);
    if (!result.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
    console.log(chalk.green(`✅ Plugin ${name} uninstalled`));
  }, 'plugin-uninstall'));

// Enable plugin
pluginCmd
  .command('enable <name>')
  .description('Enable a disabled plugin')
  .action(wrapCommand(async (name) => {
    const result = await setPluginEnabled(name, true);
    if (!result.success) {
      console.error(chalk.red(`Plugin ${name} not found`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    console.log(chalk.green(`✅ Plugin ${name} enabled`));
    console.log(chalk.gray(`Run 'mc plugin list' to see available commands`));
  }, 'plugin-enable'));

// Disable plugin
pluginCmd
  .command('disable <name>')
  .description('Disable a plugin (keep installed but inactive)')
  .action(wrapCommand(async (name) => {
    const result = await setPluginEnabled(name, false);
    if (!result.success) {
      console.error(chalk.red(`Plugin ${name} not found`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    console.log(chalk.yellow(`⚠️  Plugin ${name} disabled`));
    console.log(chalk.gray(`Run 'mc plugin enable ${name}' to re-enable`));
  }, 'plugin-disable'));

// Plugin info
pluginCmd
  .command('info <name>')
  .description('Show detailed information about a plugin')
  .action(wrapCommand(async (name) => {
    const plugins = await getInstalledPlugins();
    const plugin = plugins.find(p => p.name === name);
    
    if (!plugin) {
      console.error(chalk.red(`Plugin ${name} not found`));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    console.log(chalk.blue(`🐾 ${plugin.name}\n`));
    
    if (plugin.manifest) {
      console.log(chalk.bold('Description:'), plugin.manifest.description || 'N/A');
      console.log(chalk.bold('Version:'), plugin.version);
      console.log(chalk.bold('Author:'), plugin.manifest.author || 'N/A');
      console.log(chalk.bold('Command:'), `mc ${plugin.manifest.command || plugin.command}`);
      console.log(chalk.bold('Main:'), plugin.manifest.main);
      console.log();
      
      if (plugin.manifest.permissions && plugin.manifest.permissions.length > 0) {
        console.log(chalk.bold('Permissions:'));
        plugin.manifest.permissions.forEach(p => console.log(`  • ${p}`));
        console.log();
      }
      
      if (plugin.manifest.dependencies && plugin.manifest.dependencies.length > 0) {
        console.log(chalk.bold('Dependencies:'));
        plugin.manifest.dependencies.forEach(d => console.log(`  • ${d}`));
        console.log();
      }
    }
    
    console.log(chalk.bold('Status:'), plugin.enabled ? chalk.green('Enabled') : chalk.yellow('Disabled'));
    console.log(chalk.bold('Source:'), plugin.source);
    console.log(chalk.bold('Installed:'), new Date(plugin.installedAt).toLocaleDateString());
    console.log(chalk.bold('Path:'), plugin.path);
  }, 'plugin-info'));

// Search plugins
pluginCmd
  .command('search <query>')
  .description('Search npm for available plugins')
  .action(wrapCommand(async (query) => {
    const results = await searchPlugins(query);
    
    if (results.length === 0) return;
    
    console.log(chalk.blue(`🐾 Search Results for "${query}"\n`));
    
    results.forEach(pkg => {
      console.log(`${chalk.bold(pkg.name)}@${chalk.gray(pkg.version)}`);
      if (pkg.description) {
        console.log(`  ${pkg.description}`);
      }
      console.log(`  ${chalk.gray(`Install: mc plugin install ${pkg.name}`)}`);
      console.log();
    });
  }, 'plugin-search'));

// Update plugin
pluginCmd
  .command('update [name]')
  .description('Update plugin(s) to latest version')
  .option('-a, --all', 'Update all plugins')
  .action(wrapCommand(async (name, options) => {
    const plugins = await getInstalledPlugins();
    
    if (options.all) {
      console.log(chalk.blue('🐾 Updating all plugins...\n'));
      
      let updated = 0;
      let failed = 0;
      
      for (const plugin of plugins) {
        const result = await updatePlugin(plugin.name);
        if (result.success) updated++;
        else failed++;
      }
      
      console.log(chalk.green(`\n✅ Updated ${updated} plugins`));
      if (failed > 0) {
        console.log(chalk.red(`❌ Failed to update ${failed} plugins`));
      }
    } else if (name) {
      const result = await updatePlugin(name);
      if (!result.success) {
        process.exit(ExitCode.GENERAL_ERROR);
      }
    } else {
      console.error(chalk.red('Please specify a plugin name or use --all'));
      process.exit(ExitCode.INVALID_ARGUMENTS);
    }
  }, 'plugin-update'));

// Create plugin scaffold
pluginCmd
  .command('create <name>')
  .description('Create a new plugin from template')
  .action(wrapCommand(async (name) => {
    const result = await createPlugin(name);
    if (!result.success) {
      process.exit(ExitCode.GENERAL_ERROR);
    }
  }, 'plugin-create'));

// Run plugin directly
pluginCmd
  .command('run <name> [args...]')
  .description('Run a plugin directly with arguments')
  .allowUnknownOption()
  .action(wrapCommand(async (name, args) => {
    // Get any additional args from rawArgs
    const extraArgs = pluginCmd.rawArgs.slice(4);
    await executePlugin(name, [...args, ...extraArgs]);
  }, 'plugin-run'));

module.exports = {
  pluginCmd,
  executePlugin,
  getInstalledPlugins,
  loadRegistry
};
