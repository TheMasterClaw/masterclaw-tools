#!/usr/bin/env node
/**
 * mc cache - Cache management commands
 * 
 * View cache statistics, clear cache, and manage the Redis caching layer.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const { findInfraDir } = require('./services');
const { wrapCommand, ExitCode } = require('./error-handler');
const logger = require('./logger').child('cache');

/**
 * Get Core API URL
 */
async function getCoreApiUrl() {
  // Check if running locally
  try {
    const response = await fetch('http://localhost:8000/health', { 
      signal: AbortSignal.timeout(2000) 
    });
    if (response.ok) {
      return 'http://localhost:8000';
    }
  } catch {
    // Not available locally
  }

  // Check environment variable
  if (process.env.MC_CORE_URL) {
    return process.env.MC_CORE_URL;
  }

  // Default
  return 'http://localhost:8000';
}

/**
 * Display cache statistics
 */
async function showStats() {
  const apiUrl = await getCoreApiUrl();
  
  console.log(chalk.blue('🐾 MasterClaw Cache Statistics\n'));
  
  try {
    const response = await fetch(`${apiUrl}/cache/stats`, {
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const stats = await response.json();
    
    // Display status
    const statusIcon = stats.enabled ? chalk.green('✅') : chalk.yellow('⚠️');
    console.log(`${statusIcon} Cache ${stats.enabled ? 'Enabled' : 'Disabled'}`);
    
    // Backend info
    const backendStatus = stats.redis_connected 
      ? chalk.green('Connected (Redis)') 
      : chalk.yellow('Memory Fallback');
    console.log(`   Backend: ${backendStatus}`);
    console.log(`   Key Prefix: ${chalk.gray(stats.key_prefix)}`);
    
    console.log();
    
    // Redis-specific stats
    if (stats.redis_connected) {
      console.log(chalk.blue('Redis Statistics:'));
      if (stats.redis_version) {
        console.log(`   Version: ${stats.redis_version}`);
      }
      if (stats.used_memory_human) {
        console.log(`   Memory: ${stats.used_memory_human}`);
      }
      if (stats.total_keys !== undefined) {
        console.log(`   Total Keys: ${stats.total_keys.toLocaleString()}`);
      }
      if (stats.hit_rate !== undefined) {
        const hitRate = (stats.hit_rate * 100).toFixed(1);
        const hitRateColor = stats.hit_rate > 0.8 ? chalk.green : 
                            stats.hit_rate > 0.5 ? chalk.yellow : chalk.red;
        console.log(`   Hit Rate: ${hitRateColor(hitRate + '%')}`);
      }
    } else {
      console.log(chalk.yellow('Using in-memory cache (Redis unavailable)'));
      console.log(`   Memory Keys: ${stats.memory_keys}`);
    }
    
    console.log();
    console.log(chalk.gray('Use "mc cache health" for detailed health info'));
    
  } catch (error) {
    console.log(chalk.red('❌ Failed to fetch cache statistics'));
    console.log(chalk.gray(`   Error: ${error.message}`));
    console.log();
    console.log(chalk.gray('Make sure MasterClaw Core is running:'));
    console.log(chalk.gray('   mc status'));
    process.exit(ExitCode.SERVICE_UNAVAILABLE);
  }
}

/**
 * Check cache health
 */
async function checkHealth() {
  const apiUrl = await getCoreApiUrl();
  
  console.log(chalk.blue('🐾 MasterClaw Cache Health\n'));
  
  try {
    const response = await fetch(`${apiUrl}/cache/health`, {
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const health = await response.json();
    
    // Status
    const statusIcon = health.status === 'healthy' ? chalk.green('✅') :
                       health.status === 'disabled' ? chalk.yellow('⚠️') :
                       chalk.red('❌');
    console.log(`${statusIcon} Status: ${health.status}`);
    
    // Enabled
    console.log(`   Enabled: ${health.enabled ? chalk.green('Yes') : chalk.yellow('No')}`);
    
    // Backend
    const backendColor = health.backend === 'redis' ? chalk.green :
                         health.backend === 'memory' ? chalk.yellow :
                         chalk.gray;
    console.log(`   Backend: ${backendColor(health.backend)}`);
    
    // Latency
    if (health.latency_ms !== undefined && health.latency_ms >= 0) {
      const latencyColor = health.latency_ms < 10 ? chalk.green :
                           health.latency_ms < 50 ? chalk.yellow :
                           chalk.red;
      console.log(`   Latency: ${latencyColor(health.latency_ms + 'ms')}`);
    }
    
    // Error
    if (health.redis_error) {
      console.log();
      console.log(chalk.yellow('Redis Error:'));
      console.log(`   ${health.redis_error}`);
    }
    
    console.log();
    
    if (health.status === 'healthy') {
      console.log(chalk.green('✅ Cache is healthy and operational'));
    } else if (health.status === 'disabled') {
      console.log(chalk.yellow('⚠️  Cache is disabled'));
      console.log(chalk.gray('   Set REDIS_ENABLED=true to enable'));
    } else {
      console.log(chalk.yellow('⚠️  Cache is degraded'));
      console.log(chalk.gray('   Falling back to memory cache'));
    }
    
  } catch (error) {
    console.log(chalk.red('❌ Failed to check cache health'));
    console.log(chalk.gray(`   Error: ${error.message}`));
    process.exit(ExitCode.SERVICE_UNAVAILABLE);
  }
}

/**
 * Clear cache
 */
async function clearCache(pattern, options) {
  const apiUrl = await getCoreApiUrl();
  
  console.log(chalk.blue('🐾 MasterClaw Cache Clear\n'));
  
  // Confirm if not forced
  if (!options.force) {
    console.log(chalk.yellow('⚠️  Warning: This will delete cached data.'));
    
    if (pattern) {
      console.log(chalk.gray(`   Pattern: ${pattern}`));
    } else {
      console.log(chalk.gray('   This will clear ALL cache entries.'));
    }
    
    console.log();
    console.log(chalk.gray('Use --force to skip this confirmation'));
    console.log();
    
    const inquirer = await import('inquirer');
    const { confirm } = await inquirer.default.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: 'Are you sure you want to continue?',
      default: false,
    }]);
    
    if (!confirm) {
      console.log(chalk.yellow('Cancelled.'));
      return;
    }
  }
  
  try {
    const response = await fetch(`${apiUrl}/cache/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, confirm: true }),
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(error.detail || `API returned ${response.status}`);
    }
    
    const result = await response.json();
    
    if (result.success) {
      console.log(chalk.green(`✅ Cache cleared successfully`));
      console.log(`   Keys removed: ${chalk.bold(result.keys_cleared.toLocaleString())}`);
      
      if (result.pattern) {
        console.log(`   Pattern: ${chalk.gray(result.pattern)}`);
      }
    } else {
      console.log(chalk.yellow('⚠️  Cache clear completed with warnings'));
    }
    
  } catch (error) {
    console.log(chalk.red('❌ Failed to clear cache'));
    console.log(chalk.gray(`   Error: ${error.message}`));
    process.exit(ExitCode.SERVICE_UNAVAILABLE);
  }
}

/**
 * Warm cache (pre-populate)
 */
async function warmCache() {
  console.log(chalk.blue('🐾 MasterClaw Cache Warm\n'));
  
  console.log(chalk.yellow('⚠️  Cache warming is not yet implemented.'));
  console.log();
  console.log(chalk.gray('This feature will:'));
  console.log(chalk.gray('  - Pre-compute common embeddings'));
  console.log(chalk.gray('  - Cache frequently accessed data'));
  console.log(chalk.gray('  - Warm LLM response cache for common queries'));
  console.log();
  console.log(chalk.gray('Stay tuned for updates! 🐾'));
}

// =============================================================================
// CLI Setup
// =============================================================================

const program = new Command();

program
  .name('cache')
  .description('Manage MasterClaw caching layer');

// Stats command
program
  .command('stats')
  .description('Show cache statistics')
  .action(wrapCommand(showStats, 'cache stats'));

// Health command
program
  .command('health')
  .description('Check cache health')
  .action(wrapCommand(checkHealth, 'cache health'));

// Clear command
program
  .command('clear')
  .description('Clear cache entries')
  .option('-p, --pattern <pattern>', 'Pattern to match (e.g., "llm:*")')
  .option('-f, --force', 'Skip confirmation', false)
  .action(wrapCommand(clearCache, 'cache clear'));

// Warm command
program
  .command('warm')
  .description('Pre-populate cache with common data')
  .action(wrapCommand(warmCache, 'cache warm'));

module.exports = program;
