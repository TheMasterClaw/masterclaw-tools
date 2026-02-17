// update.js - Update management commands for mc CLI
// Handles Docker image updates, CLI self-updates, and version checks

const { Command } = require('commander');
const chalk = require('chalk');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const update = new Command('update');

// Find infrastructure directory
async function findInfraDir() {
  const candidates = [
    process.env.MASTERCLAW_INFRA,
    path.join(process.cwd(), 'masterclaw-infrastructure'),
    path.join(process.cwd(), '..', 'masterclaw-infrastructure'),
    path.join(require('os').homedir(), 'masterclaw-infrastructure'),
    '/opt/masterclaw-infrastructure',
  ];
  
  for (const dir of candidates) {
    if (dir && await fs.pathExists(path.join(dir, 'docker-compose.yml'))) {
      return dir;
    }
  }
  
  return null;
}

// Check if Docker is available
async function isDockerAvailable() {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Get current CLI version
function getCliVersion() {
  try {
    const packageJson = require('../package.json');
    return packageJson.version;
  } catch {
    return 'unknown';
  }
}

// Get latest CLI version from npm/registry
async function getLatestCliVersion() {
  try {
    const response = await axios.get('https://registry.npmjs.org/masterclaw-tools/latest', {
      timeout: 5000,
    });
    return response.data.version;
  } catch {
    // Fallback: try GitHub releases
    try {
      const response = await axios.get(
        'https://api.github.com/repos/TheMasterClaw/masterclaw-tools/releases/latest',
        { timeout: 5000 }
      );
      return response.data.tag_name.replace(/^v/, '');
    } catch {
      return null;
    }
  }
}

// Get Docker image versions
async function getImageVersions() {
  try {
    const output = execSync(
      'docker ps --format "{{.Image}}" --filter "name=mc-"',
      { encoding: 'utf8' }
    );
    
    const images = output.trim().split('\n').filter(Boolean);
    const versions = {};
    
    for (const image of images) {
      try {
        const inspect = execSync(
          `docker inspect --format='{{.Config.Image}}|{{.Id}}|{{.Created}}' "${image}"`,
          { encoding: 'utf8' }
        );
        const [img, id, created] = inspect.trim().split('|');
        versions[img] = { id: id.slice(0, 12), created };
      } catch {
        versions[image] = { id: 'unknown', created: 'unknown' };
      }
    }
    
    return versions;
  } catch {
    return {};
  }
}

// Check for available image updates
async function checkImageUpdates() {
  const images = await getImageVersions();
  const updates = [];
  
  for (const image of Object.keys(images)) {
    try {
      // Check if there's a newer image available
      const manifest = execSync(
        `docker manifest inspect ${image} 2>/dev/null || echo "[]"`,
        { encoding: 'utf8' }
      );
      
      // Simple check: if manifest exists, there might be updates
      // In a real scenario, we'd compare digests
      updates.push({
        image,
        current: images[image].id,
        hasUpdate: true, // Simplified - would check digest in production
      });
    } catch {
      // Skip images we can't check
    }
  }
  
  return updates;
}

// Main update command
update
  .description('Update MasterClaw services and CLI')
  .option('-c, --check', 'Check for available updates without applying')
  .option('-d, --dry-run', 'Show what would be updated without making changes')
  .option('-s, --services', 'Update Docker services only (skip CLI)')
  .option('-f, --force', 'Force update even if no changes detected')
  .option('--cli-only', 'Update CLI only (skip Docker services)')
  .action(async (options) => {
    const ora = require('ora');
    const isCheckMode = options.check;
    const isDryRun = options.dryRun;
    
    console.log(chalk.blue('🐾 MasterClaw Update'));
    console.log('====================\n');
    
    if (isCheckMode) {
      console.log(chalk.cyan('📋 Checking for available updates...\n'));
    } else if (isDryRun) {
      console.log(chalk.cyan('📋 Dry run mode - showing what would be updated:\n'));
    }
    
    // CLI Version Check
    const cliSpinner = ora('Checking CLI version...').start();
    const currentVersion = getCliVersion();
    const latestVersion = await getLatestCliVersion();
    cliSpinner.stop();
    
    console.log(chalk.cyan('CLI:'));
    console.log(`  Current:  ${currentVersion}`);
    
    if (latestVersion) {
      console.log(`  Latest:   ${latestVersion}`);
      const needsCliUpdate = latestVersion !== currentVersion;
      
      if (needsCliUpdate) {
        console.log(`  Status:   ${chalk.yellow('⚠️  Update available')}`);
      } else {
        console.log(`  Status:   ${chalk.green('✅ Up to date')}`);
      }
    } else {
      console.log(`  Status:   ${chalk.gray('⚠️  Could not check for updates')}`);
    }
    console.log();
    
    // Skip service checks if CLI-only
    if (options.cliOnly) {
      if (!isCheckMode && !isDryRun && latestVersion && latestVersion !== currentVersion) {
        console.log(chalk.cyan('Updating CLI...'));
        console.log(chalk.gray('  Run: npm install -g masterclaw-tools'));
      }
      return;
    }
    
    // Docker Services Check
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.log(chalk.yellow('⚠️  Docker is not available - skipping service checks'));
      return;
    }
    
    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.yellow('⚠️  Infrastructure directory not found'));
      console.log(chalk.gray('   Set MASTERCLAW_INFRA or run from infrastructure directory'));
      return;
    }
    
    const serviceSpinner = ora('Checking service images...').start();
    const imageVersions = await getImageVersions();
    serviceSpinner.stop();
    
    console.log(chalk.cyan('Docker Services:'));
    
    if (Object.keys(imageVersions).length === 0) {
      console.log(`  ${chalk.gray('ℹ️  No MasterClaw services running')}`);
    } else {
      for (const [image, info] of Object.entries(imageVersions)) {
        const shortImage = image.split('/').pop() || image;
        console.log(`  ${chalk.gray('•')} ${shortImage} ${chalk.gray(`(${info.id})`)}`);
      }
    }
    console.log();
    
    // Check mode - exit after showing status
    if (isCheckMode) {
      console.log(chalk.gray('Use without --check to apply updates'));
      return;
    }
    
    // Dry run mode - exit after showing what would happen
    if (isDryRun) {
      console.log(chalk.cyan('Would execute:'));
      console.log(`  cd ${infraDir}`);
      console.log('  docker-compose pull');
      console.log('  docker-compose up -d');
      
      if (latestVersion && latestVersion !== currentVersion) {
        console.log('  npm install -g masterclaw-tools');
      }
      return;
    }
    
    // Apply updates
    if (options.services || !options.cliOnly) {
      console.log(chalk.blue('📥 Updating Docker images...\n'));
      
      const pullSpinner = ora('Pulling latest images...').start();
      
      try {
        await new Promise((resolve, reject) => {
          const pull = spawn('docker-compose', ['pull'], {
            cwd: infraDir,
            stdio: 'pipe',
          });
          
          let output = '';
          pull.stdout.on('data', (data) => { output += data.toString(); });
          pull.stderr.on('data', (data) => { output += data.toString(); });
          
          pull.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Pull failed with code ${code}`));
          });
        });
        
        pullSpinner.succeed('Images pulled successfully');
      } catch (err) {
        pullSpinner.fail(`Failed to pull images: ${err.message}`);
        process.exit(1);
      }
      
      // Restart services with new images
      const upSpinner = ora('Restarting services...').start();
      
      try {
        await new Promise((resolve, reject) => {
          const up = spawn('docker-compose', ['up', '-d', '--remove-orphans'], {
            cwd: infraDir,
            stdio: 'pipe',
          });
          
          up.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Restart failed with code ${code}`));
          });
        });
        
        upSpinner.succeed('Services restarted successfully');
      } catch (err) {
        upSpinner.fail(`Failed to restart services: ${err.message}`);
        process.exit(1);
      }
    }
    
    console.log();
    console.log(chalk.green('✅ Update complete!'));
    
    if (latestVersion && latestVersion !== currentVersion) {
      console.log();
      console.log(chalk.yellow('⚠️  CLI update available:'));
      console.log(chalk.gray('   Run: npm install -g masterclaw-tools'));
    }
    
    console.log();
    console.log(chalk.gray('Run "mc status" to verify services are healthy'));
  });

// Version subcommand
update
  .command('version')
  .description('Show current versions of all components')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const cliVersion = getCliVersion();
    const infraDir = await findInfraDir();
    
    const versions = {
      cli: cliVersion,
      timestamp: new Date().toISOString(),
    };
    
    if (infraDir) {
      try {
        const composeContent = await fs.readFile(
          path.join(infraDir, 'docker-compose.yml'),
          'utf8'
        );
        
        // Extract image versions from compose file
        const imageMatches = composeContent.match(/image:\s*(.+)/g) || [];
        versions.services = imageMatches.map(m => {
          const image = m.replace('image:', '').trim();
          return {
            image,
            tag: image.split(':').pop() || 'latest',
          };
        });
      } catch {
        versions.services = [];
      }
    }
    
    if (options.json) {
      console.log(JSON.stringify(versions, null, 2));
      return;
    }
    
    console.log(chalk.blue('🐾 MasterClaw Versions'));
    console.log('=====================\n');
    
    console.log(chalk.cyan('CLI:'));
    console.log(`  Version: ${cliVersion}`);
    console.log();
    
    if (versions.services && versions.services.length > 0) {
      console.log(chalk.cyan('Configured Services:'));
      for (const svc of versions.services) {
        const name = svc.image.split('/').pop() || svc.image;
        console.log(`  ${name.padEnd(30)} ${chalk.gray(svc.tag)}`);
      }
    }
    
    console.log();
    console.log(chalk.gray(`Checked at: ${versions.timestamp}`));
  });

module.exports = update;
