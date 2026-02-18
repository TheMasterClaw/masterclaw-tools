/**
 * MasterClaw Performance Profiling CLI
 * 
 * Commands for viewing API performance metrics, slow endpoints,
 * and performance trends from the Core API.
 */

const chalk = require('chalk');
const axios = require('axios');
const { findInfraDir } = require('./services');
const config = require('./config');

const DEFAULT_API_URL = 'http://localhost:8000';

/**
 * Get the Core API URL from config or default
 */
function getApiUrl() {
  const cfg = config.readConfig();
  return cfg.core?.url || DEFAULT_API_URL;
}

/**
 * Get API key from config
 */
function getApiKey() {
  const cfg = config.readConfig();
  return cfg.core?.apiKey || null;
}

/**
 * Create axios instance with auth headers
 */
function createApiClient() {
  const headers = {};
  const apiKey = getApiKey();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }
  return axios.create({
    baseURL: getApiUrl(),
    headers,
    timeout: 10000,
  });
}

/**
 * Format duration with color coding
 */
function formatDuration(ms, threshold = 1000) {
  const num = typeof ms === 'number' ? ms : parseFloat(ms);
  if (num < threshold * 0.5) {
    return chalk.green(`${num.toFixed(2)}ms`);
  } else if (num < threshold) {
    return chalk.yellow(`${num.toFixed(2)}ms`);
  } else {
    return chalk.red(`${num.toFixed(2)}ms`);
  }
}

/**
 * Show performance summary
 */
async function showSummary() {
  const client = createApiClient();
  
  try {
    const response = await client.get('/v1/performance/summary');
    const data = response.data;
    
    console.log(chalk.blue('🐾 MasterClaw Performance Summary\n'));
    console.log(`Total Requests: ${chalk.bold(data.total_requests.toLocaleString())}`);
    console.log(`Average Response Time: ${formatDuration(data.avg_response_ms, data.slow_threshold_ms)}`);
    console.log(`Slow Requests: ${chalk.yellow(data.slow_requests.toLocaleString())} (${data.slow_percentage}%)`);
    console.log(`Endpoints Tracked: ${data.endpoints_tracked}`);
    console.log(`Slow Threshold: ${data.slow_threshold_ms}ms`);
    
    return data;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
      console.log(chalk.gray('   Make sure the Core service is running: mc revive'));
    } else {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
    return null;
  }
}

/**
 * Show endpoint statistics
 */
async function showStats() {
  const client = createApiClient();
  
  try {
    const response = await client.get('/v1/performance/stats');
    const { endpoints, summary } = response.data;
    
    console.log(chalk.blue('🐾 MasterClaw Endpoint Performance\n'));
    
    // Show summary
    console.log(chalk.gray('Summary:'));
    console.log(`  Total Requests: ${summary.total_requests.toLocaleString()}`);
    console.log(`  Avg Response: ${formatDuration(summary.avg_response_ms, summary.slow_threshold_ms)}`);
    console.log(`  Slow Requests: ${chalk.yellow(summary.slow_percentage + '%')}`);
    console.log();
    
    // Show endpoint table
    const endpointList = Object.entries(endpoints);
    if (endpointList.length === 0) {
      console.log(chalk.gray('No endpoint data available yet.'));
      return;
    }
    
    console.log(chalk.bold('Endpoint Statistics:'));
    console.log(chalk.gray('─'.repeat(100)));
    console.log(
      chalk.bold('Method/Path').padEnd(40),
      chalk.bold('Count').padStart(8),
      chalk.bold('Avg').padStart(12),
      chalk.bold('Min').padStart(12),
      chalk.bold('Max').padStart(12),
      chalk.bold('Slow%').padStart(8)
    );
    console.log(chalk.gray('─'.repeat(100)));
    
    // Sort by average response time
    endpointList.sort((a, b) => b[1].avg_ms - a[1].avg_ms);
    
    for (const [endpoint, stats] of endpointList) {
      const path = endpoint.length > 37 ? '...' + endpoint.slice(-34) : endpoint;
      const slowPct = stats.slow_percent > 10 
        ? chalk.red(stats.slow_percent + '%')
        : stats.slow_percent > 5
          ? chalk.yellow(stats.slow_percent + '%')
          : chalk.green(stats.slow_percent + '%');
      
      console.log(
        path.padEnd(40),
        stats.count.toLocaleString().padStart(8),
        formatDuration(stats.avg_ms, summary.slow_threshold_ms).padStart(12),
        formatDuration(stats.min_ms, summary.slow_threshold_ms).padStart(12),
        formatDuration(stats.max_ms, summary.slow_threshold_ms).padStart(12),
        slowPct.padStart(8)
      );
    }
    
    console.log(chalk.gray('─'.repeat(100)));
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
      console.log(chalk.gray('   Make sure the Core service is running: mc revive'));
    } else {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

/**
 * Show slowest endpoints
 */
async function showSlowest(n = 10) {
  const client = createApiClient();
  
  try {
    const response = await client.get(`/v1/performance/slowest?n=${n}`);
    const { endpoints, threshold_ms } = response.data;
    
    console.log(chalk.blue(`🐾 Top ${n} Slowest Endpoints\n`));
    console.log(chalk.gray(`Slow threshold: ${threshold_ms}ms\n`));
    
    if (endpoints.length === 0) {
      console.log(chalk.gray('No endpoint data available yet.'));
      return;
    }
    
    let i = 1;
    for (const ep of endpoints) {
      const rank = i.toString().padStart(2);
      const icon = ep.slow_percent > 20 ? '🔴' : ep.slow_percent > 10 ? '🟡' : '🟢';
      
      console.log(`${rank}. ${icon} ${chalk.bold(ep.endpoint)}`);
      console.log(`    Count: ${ep.count.toLocaleString()} | ` +
                  `Avg: ${formatDuration(ep.avg_ms, threshold_ms)} | ` +
                  `Max: ${formatDuration(ep.max_ms, threshold_ms)} | ` +
                  `Slow: ${ep.slow_count} (${ep.slow_percent}%)`);
      console.log();
      i++;
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
      console.log(chalk.gray('   Make sure the Core service is running: mc revive'));
    } else {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

/**
 * Show recent profiles
 */
async function showProfiles(options = {}) {
  const client = createApiClient();
  const limit = options.limit || 20;
  const slowOnly = options.slowOnly || false;
  
  try {
    const url = `/v1/performance/profiles?limit=${limit}&slow_only=${slowOnly}`;
    const response = await client.get(url);
    const { profiles, total } = response.data;
    
    const title = slowOnly ? 'Slow Request Profiles' : 'Recent Request Profiles';
    console.log(chalk.blue(`🐾 ${title}\n`));
    console.log(chalk.gray(`Showing ${profiles.length} of ${total} profiles\n`));
    
    if (profiles.length === 0) {
      console.log(chalk.gray('No profiles available yet.'));
      return;
    }
    
    // Group by endpoint for better readability
    const grouped = {};
    for (const profile of profiles) {
      const key = `${profile.method} ${profile.path}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(profile);
    }
    
    for (const [endpoint, reqs] of Object.entries(grouped)) {
      console.log(chalk.bold(endpoint));
      for (const req of reqs.slice(0, 5)) {
        const time = new Date(req.timestamp).toLocaleTimeString();
        const duration = formatDuration(req.duration_ms, 1000);
        const icon = req.slow ? '🔴' : '●';
        console.log(`  ${icon} ${time} - ${duration} - ${req.status_code}`);
      }
      if (reqs.length > 5) {
        console.log(chalk.gray(`  ... and ${reqs.length - 5} more`));
      }
      console.log();
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
      console.log(chalk.gray('   Make sure the Core service is running: mc revive'));
    } else {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

/**
 * Clear all performance profiles
 */
async function clearProfiles() {
  const client = createApiClient();
  
  try {
    const response = await client.delete('/v1/performance/profiles');
    console.log(chalk.green(`✅ ${response.data.message}`));
  } catch (error) {
    if (error.response?.status === 401) {
      console.log(chalk.red('❌ Authentication required'));
      console.log(chalk.gray('   Set API key in config: mc config set core.apiKey <key>'));
    } else if (error.code === 'ECONNREFUSED') {
      console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
    } else {
      console.log(chalk.red(`❌ Error: ${error.message}`));
    }
  }
}

module.exports = {
  showSummary,
  showStats,
  showSlowest,
  showProfiles,
  clearProfiles,
};