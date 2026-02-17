const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');

const config = require('./config');

const maintenance = new Command('maintenance');

// Default maintenance configuration
const DEFAULTS = {
  sessionRetentionDays: 30,
  dockerPrune: true,
  verifyBackups: true,
  runHealthCheck: true,
  cleanupLogs: false,
  optimizeChroma: false,
};

/**
 * Find infrastructure directory
 */
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

/**
 * Check service health
 */
async function checkServiceHealth(coreUrl) {
  try {
    const response = await axios.get(`${coreUrl}/health`, { timeout: 5000 });
    return { healthy: response.status === 200, data: response.data };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

/**
 * Get session statistics
 */
async function getSessionStats(coreUrl) {
  try {
    const response = await axios.get(`${coreUrl}/v1/sessions/stats/summary`, {
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    return null;
  }
}

/**
 * Get old sessions for cleanup
 */
async function getOldSessions(coreUrl, days) {
  try {
    const response = await axios.get(`${coreUrl}/v1/sessions?limit=500`, {
      timeout: 30000,
    });
    const sessions = response.data.sessions || [];
    const now = new Date();
    
    return sessions.filter(s => {
      const lastActive = new Date(s.last_active);
      const diffDays = (now - lastActive) / (1000 * 60 * 60 * 24);
      return diffDays > days;
    });
  } catch (err) {
    return [];
  }
}

/**
 * Delete a session
 */
async function deleteSession(coreUrl, sessionId) {
  try {
    await axios.delete(`${coreUrl}/v1/sessions/${sessionId}`, {
      timeout: 10000,
    });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Check disk space
 * Includes timeout protection to prevent hanging on slow filesystems.
 */
async function checkDiskSpace() {
  try {
    const output = execSync('df -h / | tail -1', { 
      encoding: 'utf8',
      timeout: 10000, // 10 second timeout
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const parts = output.trim().split(/\s+/);
    const size = parts[1];
    const used = parts[2];
    const available = parts[3];
    const percentUsed = parseInt(parts[4].replace('%', ''), 10);
    
    return {
      size,
      used,
      available,
      percentUsed,
      healthy: percentUsed < 85,
    };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

/**
 * Get Docker system usage
 * Includes timeout protection and resource limit detection.
 */
async function getDockerUsage() {
  try {
    const output = execSync('docker system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}"', {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout for system df
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024, // 1MB max buffer
    });
    
    const lines = output.trim().split('\n');
    const usage = {};
    
    for (const line of lines) {
      const [type, size, reclaimable] = line.split('|');
      usage[type.toLowerCase()] = { size, reclaimable };
    }
    
    return usage;
  } catch (err) {
    return null;
  }
}

/**
 * Prune Docker system
 * Includes timeout protection and error handling for security and reliability.
 * Prevents hanging processes if Docker daemon becomes unresponsive.
 */
async function pruneDocker() {
  const PRUNE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes timeout per operation
  const PRUNE_MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB max output per operation (DoS protection)

  return new Promise((resolve) => {
    const results = {
      volumes: null,
      images: null,
      containers: null,
    };

    let completed = 0;
    let hasResolved = false;

    const checkComplete = () => {
      completed++;
      if (completed >= 3 && !hasResolved) {
        hasResolved = true;
        resolve(results);
      }
    };

    /**
     * Helper to spawn a prune command with timeout and resource protection
     * @param {string} resource - Resource type (volume, image, container)
     * @param {string[]} args - Arguments for docker command
     * @param {string} successPattern - Pattern to match for success detection
     * @param {string} successValue - Value to set if pattern matches
     * @param {string} emptyValue - Value to set if no match
     */
    const spawnPrune = (resource, args, successPattern, successValue, emptyValue) => {
      const proc = spawn('docker', args, {
        timeout: PRUNE_TIMEOUT_MS,
      });

      let output = '';
      let outputExceeded = false;
      let killed = false;

      // Handle stdout with output size limiting
      proc.stdout.on('data', (d) => {
        if (outputExceeded || killed) return;

        const chunk = d.toString();

        // DoS protection: limit output size
        if (output.length + chunk.length > PRUNE_MAX_OUTPUT_SIZE) {
          outputExceeded = true;
          killed = true;
          proc.kill('SIGTERM');
          console.warn(`[Maintenance] Docker ${resource} prune output exceeded limit, terminated`);
          return;
        }

        output += chunk;
      });

      // Handle stderr (log warnings but don't fail)
      proc.stderr.on('data', (d) => {
        const errorMsg = d.toString().trim();
        if (errorMsg && process.env.MC_VERBOSE) {
          console.warn(`[Maintenance] Docker ${resource} prune warning: ${errorMsg}`);
        }
      });

      // Handle process completion
      proc.on('close', (code, signal) => {
        if (killed) {
          results[resource] = 'timeout';
          checkComplete();
          return;
        }

        if (signal === 'SIGTERM') {
          results[resource] = 'timeout';
          checkComplete();
          return;
        }

        if (code !== 0 && code !== null) {
          // Non-zero exit code - log warning but don't fail entire operation
          if (process.env.MC_VERBOSE) {
            console.warn(`[Maintenance] Docker ${resource} prune exited with code ${code}`);
          }
          results[resource] = 'error';
        } else {
          const match = output.match(successPattern);
          results[resource] = match ? successValue : emptyValue;
        }

        checkComplete();
      });

      // Handle process errors (e.g., Docker not running)
      proc.on('error', (err) => {
        if (!killed) {
          killed = true;
          if (process.env.MC_VERBOSE) {
            console.warn(`[Maintenance] Docker ${resource} prune failed: ${err.message}`);
          }
          results[resource] = 'error';
          checkComplete();
        }
      });

      // Safety timeout - force resolve if process hangs
      setTimeout(() => {
        if (!killed && results[resource] === null) {
          killed = true;
          proc.kill('SIGKILL');
          results[resource] = 'timeout';
          checkComplete();
        }
      }, PRUNE_TIMEOUT_MS + 5000); // Extra 5s buffer
    };

    // Prune volumes
    spawnPrune('volumes', ['volume', 'prune', '-f'], /reclaimed space/, 'reclaimed', 'none');

    // Prune images (older than 168 hours / 7 days)
    spawnPrune('images', ['image', 'prune', '-af', '--filter', 'until=168h'], /reclaimed space/, 'reclaimed', 'none');

    // Prune containers
    spawnPrune('containers', ['container', 'prune', '-f'], /removed/, 'removed', 'none');

    // Overall safety timeout - resolve after maximum possible duration
    setTimeout(() => {
      if (!hasResolved) {
        hasResolved = true;
        // Mark any unfinished operations as timeout
        if (results.volumes === null) results.volumes = 'timeout';
        if (results.images === null) results.images = 'timeout';
        if (results.containers === null) results.containers = 'timeout';
        resolve(results);
      }
    }, PRUNE_TIMEOUT_MS * 2 + 10000); // 2x individual timeout + 10s buffer
  });
}

/**
 * Check backups
 */
async function checkBackups(infraDir) {
  try {
    const backupDir = path.join(infraDir, 'backups');
    
    if (!await fs.pathExists(backupDir)) {
      return { exists: false, count: 0, latest: null };
    }
    
    const files = await fs.readdir(backupDir);
    const backups = files
      .filter(f => f.startsWith('masterclaw_backup_') && f.endsWith('.tar.gz'))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        stat: fs.statSync(path.join(backupDir, f)),
      }))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    
    if (backups.length === 0) {
      return { exists: true, count: 0, latest: null };
    }
    
    const latest = backups[0];
    const ageHours = (Date.now() - latest.stat.mtime) / (1000 * 60 * 60);
    
    return {
      exists: true,
      count: backups.length,
      latest: {
        name: latest.name,
        size: formatBytes(latest.stat.size),
        ageHours: Math.round(ageHours * 10) / 10,
      },
      healthy: ageHours < 48, // Backup should be less than 48 hours old
    };
  } catch (err) {
    return { exists: false, error: err.message };
  }
}

/**
 * Format bytes
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get log sizes
 * Includes timeout protection for Docker operations.
 */
async function getLogSizes() {
  try {
    const output = execSync('docker system df --format "{{.Type}}|{{.Size}}|{{.Reclaimable}}"', {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024, // 1MB max buffer
    });
    
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const [type, size, reclaimable] = line.split('|');
      if (type.toLowerCase() === 'local volumes') {
        return { size, reclaimable };
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Main maintenance command
maintenance
  .description('Run comprehensive system maintenance')
  .option('-d, --days <number>', 'Session retention days', '30')
  .option('--no-cleanup', 'Skip session cleanup')
  .option('--no-docker', 'Skip Docker pruning')
  .option('--no-verify', 'Skip backup verification')
  .option('--no-health', 'Skip health checks')
  .option('--optimize', 'Run ChromaDB optimization (may take a while)')
  .option('--logs', 'Clean up old container logs')
  .option('-f, --force', 'Skip confirmation prompts')
  .option('--report', 'Generate maintenance report file')
  .action(async (options) => {
    const startTime = Date.now();
    const report = {
      timestamp: new Date().toISOString(),
      tasks: {},
      summary: {},
    };
    
    console.log(chalk.blue('🔧 MasterClaw Maintenance\n'));
    
    // Find infrastructure directory
    const infraDir = await findInfraDir();
    if (!infraDir) {
      console.log(chalk.yellow('⚠️  Infrastructure directory not found'));
      console.log(chalk.gray('   Some features may be limited'));
    }
    
    const coreUrl = await config.get('core.url') || 'http://localhost:8000';
    
    // ============================================================
    // PHASE 1: Health Checks
    // ============================================================
    if (options.health !== false) {
      console.log(chalk.cyan('📊 Phase 1: Health Checks'));
      console.log('=========================\n');
      
      const healthSpinner = ora('Checking service health...').start();
      const health = await checkServiceHealth(coreUrl);
      healthSpinner.stop();
      
      if (health.healthy) {
        console.log(chalk.green('  ✅ Core API: Healthy'));
        console.log(chalk.gray(`     Version: ${health.data?.version || 'unknown'}`));
      } else {
        console.log(chalk.red('  ❌ Core API: Unhealthy'));
        console.log(chalk.gray(`     Error: ${health.error}`));
      }
      report.tasks.health = { status: health.healthy ? 'passed' : 'failed', details: health };
      
      // Disk space check
      const diskSpinner = ora('Checking disk space...').start();
      const disk = await checkDiskSpace();
      diskSpinner.stop();
      
      if (disk.healthy) {
        console.log(chalk.green(`  ✅ Disk: ${disk.percentUsed}% used (${disk.used}/${disk.size})`));
      } else {
        console.log(chalk.red(`  ❌ Disk: ${disk.percentUsed}% used (${disk.used}/${disk.size})`));
        console.log(chalk.yellow('     ⚠️  Disk space is above 85%!'));
      }
      report.tasks.disk = { status: disk.healthy ? 'passed' : 'warning', details: disk };
      
      // Session stats
      const statsSpinner = ora('Fetching session statistics...').start();
      const stats = await getSessionStats(coreUrl);
      statsSpinner.stop();
      
      if (stats) {
        console.log(chalk.gray(`  📈 Sessions: ${stats.total_sessions} total, ${stats.active_sessions_24h} active (24h)`));
        report.tasks.sessions = { status: 'ok', details: stats };
      } else {
        console.log(chalk.yellow('  ⚠️  Could not fetch session statistics'));
        report.tasks.sessions = { status: 'failed' };
      }
      
      console.log('');
    }
    
    // ============================================================
    // PHASE 2: Session Cleanup
    // ============================================================
    if (options.cleanup !== false) {
      console.log(chalk.cyan('🧹 Phase 2: Session Cleanup'));
      console.log('===========================\n');
      
      const retentionDays = parseInt(options.days, 10);
      const cleanupSpinner = ora('Identifying old sessions...').start();
      const oldSessions = await getOldSessions(coreUrl, retentionDays);
      cleanupSpinner.stop();
      
      if (oldSessions.length === 0) {
        console.log(chalk.green('  ✅ No sessions older than ${retentionDays} days'));
        report.tasks.cleanup = { status: 'skipped', reason: 'no old sessions' };
      } else {
        const totalMessages = oldSessions.reduce((sum, s) => sum + s.message_count, 0);
        console.log(chalk.yellow(`  ⚠️  Found ${oldSessions.length} sessions older than ${retentionDays} days`));
        console.log(chalk.gray(`     Total messages to remove: ${totalMessages}`));
        
        // Show sample
        const sample = oldSessions.slice(0, 3);
        for (const session of sample) {
          console.log(chalk.gray(`     - ${session.session_id.substring(0, 16)}... (${session.message_count} messages)`));
        }
        if (oldSessions.length > 3) {
          console.log(chalk.gray(`     ... and ${oldSessions.length - 3} more`));
        }
        
        // Confirmation
        let proceed = options.force;
        if (!proceed) {
          const { confirm } = await inquirer.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Delete ${oldSessions.length} old sessions?`,
            default: false,
          }]);
          proceed = confirm;
        }
        
        if (proceed) {
          const deleteSpinner = ora('Deleting sessions...').start();
          let deleted = 0;
          let failed = 0;
          
          for (const session of oldSessions) {
            if (await deleteSession(coreUrl, session.session_id)) {
              deleted++;
            } else {
              failed++;
            }
            deleteSpinner.text = `Deleting sessions... (${deleted}/${oldSessions.length})`;
          }
          
          if (failed === 0) {
            deleteSpinner.succeed(`Deleted ${deleted} sessions`);
            report.tasks.cleanup = { status: 'completed', deleted, failed };
          } else {
            deleteSpinner.warn(`Deleted ${deleted} sessions, ${failed} failed`);
            report.tasks.cleanup = { status: 'partial', deleted, failed };
          }
        } else {
          console.log(chalk.gray('  ⏭️  Cleanup skipped'));
          report.tasks.cleanup = { status: 'skipped', reason: 'user declined' };
        }
      }
      
      console.log('');
    }
    
    // ============================================================
    // PHASE 3: Backup Verification
    // ============================================================
    if (options.verify !== false && infraDir) {
      console.log(chalk.cyan('💾 Phase 3: Backup Verification'));
      console.log('================================\n');
      
      const backupSpinner = ora('Checking backups...').start();
      const backups = await checkBackups(infraDir);
      backupSpinner.stop();
      
      if (!backups.exists) {
        console.log(chalk.yellow('  ⚠️  Backup directory not found'));
        report.tasks.backups = { status: 'failed', reason: 'no backup dir' };
      } else if (backups.count === 0) {
        console.log(chalk.yellow('  ⚠️  No backups found'));
        console.log(chalk.gray('     Run: mc backup'));
        report.tasks.backups = { status: 'warning', reason: 'no backups' };
      } else {
        console.log(chalk.green(`  ✅ ${backups.count} backup(s) found`));
        console.log(chalk.gray(`     Latest: ${backups.latest.name}`));
        console.log(chalk.gray(`     Size: ${backups.latest.size}`));
        console.log(chalk.gray(`     Age: ${backups.latest.ageHours} hours`));
        
        if (backups.healthy) {
          console.log(chalk.green('     Status: Fresh (< 48h)'));
        } else {
          console.log(chalk.red('     Status: Stale (> 48h)'));
          console.log(chalk.gray('     Run: mc backup'));
        }
        
        report.tasks.backups = { 
          status: backups.healthy ? 'healthy' : 'stale',
          details: backups 
        };
      }
      
      console.log('');
    }
    
    // ============================================================
    // PHASE 4: Docker Maintenance
    // ============================================================
    if (options.docker !== false) {
      console.log(chalk.cyan('🐳 Phase 4: Docker Maintenance'));
      console.log('===============================\n');
      
      // Check Docker usage
      const usageSpinner = ora('Checking Docker usage...').start();
      const usage = await getDockerUsage();
      usageSpinner.stop();
      
      if (usage) {
        console.log(chalk.gray('  Current Usage:'));
        if (usage.images) {
          console.log(chalk.gray(`     Images: ${usage.images.size} (${usage.images.reclaimable} reclaimable)`));
        }
        if (usage.containers) {
          console.log(chalk.gray(`     Containers: ${usage.containers.size} (${usage.containers.reclaimable} reclaimable)`));
        }
        if (usage.volumes) {
          console.log(chalk.gray(`     Volumes: ${usage.volumes.size} (${usage.volumes.reclaimable} reclaimable)`));
        }
      }
      
      // Confirmation
      let proceed = options.force;
      if (!proceed) {
        const { confirm } = await inquirer.prompt([{
          type: 'confirm',
          name: 'confirm',
          message: 'Prune unused Docker images, containers, and volumes?',
          default: false,
        }]);
        proceed = confirm;
      }
      
      if (proceed) {
        const pruneSpinner = ora('Pruning Docker system...').start();
        const pruneResults = await pruneDocker();
        pruneSpinner.stop();
        
        console.log(chalk.green('  ✅ Docker pruning complete'));
        if (pruneResults.images === 'reclaimed') {
          console.log(chalk.gray('     Images: space reclaimed'));
        }
        if (pruneResults.containers === 'removed') {
          console.log(chalk.gray('     Containers: removed'));
        }
        if (pruneResults.volumes === 'reclaimed') {
          console.log(chalk.gray('     Volumes: space reclaimed'));
        }
        
        report.tasks.docker = { status: 'completed', results: pruneResults };
      } else {
        console.log(chalk.gray('  ⏭️  Docker pruning skipped'));
        report.tasks.docker = { status: 'skipped', reason: 'user declined' };
      }
      
      console.log('');
    }
    
    // ============================================================
    // PHASE 5: Log Cleanup (Optional)
    // ============================================================
    if (options.logs) {
      console.log(chalk.cyan('📜 Phase 5: Log Cleanup'));
      console.log('========================\n');
      
      const logSpinner = ora('Cleaning logs...').start();
      
      try {
        execSync('docker system prune --volumes -f', { stdio: 'pipe' });
        logSpinner.succeed('Logs cleaned');
        report.tasks.logs = { status: 'completed' };
      } catch (err) {
        logSpinner.fail(`Log cleanup failed: ${err.message}`);
        report.tasks.logs = { status: 'failed', error: err.message };
      }
      
      console.log('');
    }
    
    // ============================================================
    // SUMMARY
    // ============================================================
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(chalk.cyan('📋 Maintenance Summary'));
    console.log('======================\n');
    
    const taskResults = Object.entries(report.tasks);
    const passed = taskResults.filter(([, r]) => r.status === 'passed' || r.status === 'ok' || r.status === 'completed' || r.status === 'healthy').length;
    const warnings = taskResults.filter(([, r]) => r.status === 'warning' || r.status === 'stale' || r.status === 'partial').length;
    const failed = taskResults.filter(([, r]) => r.status === 'failed').length;
    const skipped = taskResults.filter(([, r]) => r.status === 'skipped').length;
    
    console.log(`  ${chalk.green('✅ Passed:')} ${passed}`);
    if (warnings > 0) console.log(`  ${chalk.yellow('⚠️  Warnings:')} ${warnings}`);
    if (failed > 0) console.log(`  ${chalk.red('❌ Failed:')} ${failed}`);
    if (skipped > 0) console.log(`  ${chalk.gray('⏭️  Skipped:')} ${skipped}`);
    
    console.log('');
    console.log(chalk.gray(`  Duration: ${duration}s`));
    console.log(chalk.gray(`  Completed: ${new Date().toLocaleString()}`));
    
    // Generate report file if requested
    if (options.report) {
      const reportPath = path.join(process.cwd(), `maintenance-report-${Date.now()}.json`);
      await fs.writeJson(reportPath, report, { spaces: 2 });
      console.log('');
      console.log(chalk.gray(`  Report saved: ${reportPath}`));
    }
    
    console.log('');
    if (failed === 0 && warnings === 0) {
      console.log(chalk.green('🐾 Maintenance complete! System is healthy.'));
    } else if (failed === 0) {
      console.log(chalk.yellow('🐾 Maintenance complete with warnings. Review above.'));
    } else {
      console.log(chalk.red('🐾 Maintenance completed with issues. Action required.'));
    }
    
    // Recommendations
    console.log('');
    console.log(chalk.gray('Recommendations:'));
    if (report.tasks.backups?.status === 'warning' || report.tasks.backups?.status === 'stale') {
      console.log(chalk.gray('  • Run mc backup to create a fresh backup'));
    }
    if (report.tasks.disk?.status === 'warning') {
      console.log(chalk.gray('  • Disk space is low. Consider running mc cleanup --days 7'));
    }
    console.log(chalk.gray('  • Schedule maintenance: mc maintenance schedule'));
  });

// Schedule command
maintenance
  .command('schedule')
  .description('Show how to schedule automatic maintenance via cron')
  .action(() => {
    console.log(chalk.blue('🗓️  Scheduling MasterClaw Maintenance\n'));
    
    console.log(chalk.gray('Add to crontab for automatic maintenance:\n'));
    
    console.log(chalk.cyan('# Run maintenance weekly on Sundays at 3 AM'));
    console.log('0 3 * * 0 /usr/local/bin/mc maintenance --force --days 30');
    console.log('');
    
    console.log(chalk.cyan('# Run maintenance daily with all options'));
    console.log('0 2 * * * /usr/local/bin/mc maintenance --force --days 14 --logs');
    console.log('');
    
    console.log(chalk.cyan('# Run maintenance monthly with full optimization'));
    console.log('0 4 1 * * /usr/local/bin/mc maintenance --force --days 90 --logs --optimize');
    console.log('');
    
    console.log(chalk.gray('To edit your crontab:'));
    console.log('  crontab -e');
    console.log('');
    console.log(chalk.gray('To view current crontab:'));
    console.log('  crontab -l');
    console.log('');
    
    console.log(chalk.gray('Tips:'));
    console.log(chalk.gray('  • Use --force for unattended runs'));
    console.log(chalk.gray('  • Use --report to generate audit logs'));
    console.log(chalk.gray('  • Redirect output: >> /var/log/masterclaw-maintenance.log 2>&1'));
  });

// Quick status command
maintenance
  .command('status')
  .description('Quick maintenance status check')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    const coreUrl = await config.get('core.url') || 'http://localhost:8000';
    const infraDir = await findInfraDir();
    
    const status = {
      timestamp: new Date().toISOString(),
      health: await checkServiceHealth(coreUrl),
      disk: await checkDiskSpace(),
      sessions: await getSessionStats(coreUrl),
      backups: infraDir ? await checkBackups(infraDir) : null,
      docker: await getDockerUsage(),
    };
    
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    
    console.log(chalk.blue('🔧 MasterClaw Maintenance Status\n'));
    
    // Health
    const healthIcon = status.health.healthy ? chalk.green('✅') : chalk.red('❌');
    console.log(`${healthIcon} Core API: ${status.health.healthy ? 'Healthy' : 'Unhealthy'}`);
    
    // Disk
    const diskIcon = status.disk.healthy ? chalk.green('✅') : chalk.yellow('⚠️');
    console.log(`${diskIcon} Disk: ${status.disk.percentUsed}% used`);
    
    // Sessions
    if (status.sessions) {
      console.log(chalk.gray(`   Sessions: ${status.sessions.total_sessions} total`));
    }
    
    // Backups
    if (status.backups?.latest) {
      const backupIcon = status.backups.healthy ? chalk.green('✅') : chalk.yellow('⚠️');
      console.log(`${backupIcon} Latest Backup: ${status.backups.latest.ageHours}h ago`);
    } else {
      console.log(chalk.yellow('⚠️  No backups found'));
    }
    
    // Recommendations
    console.log('');
    if (!status.disk.healthy) {
      console.log(chalk.yellow('⚠️  Low disk space. Run: mc maintenance'));
    }
    if (!status.backups?.healthy) {
      console.log(chalk.yellow('⚠️  Backup is stale. Run: mc backup'));
    }
  });

module.exports = maintenance;
