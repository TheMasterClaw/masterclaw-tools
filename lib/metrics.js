/**
 * Metrics command for mc CLI
 * Quick view of system metrics without needing Grafana access
 * 
 * Commands:
 * - mc metrics              Show key metrics summary
 * - mc metrics --live       Live updating metrics (watch mode)
 * - mc metrics --json       Output as JSON for scripting
 * - mc metrics --export     Export metrics to file
 * - mc metrics compare      Compare current vs previous metrics
 */

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { wrapCommand, ExitCode } = require('./error-handler');
const rateLimiter = require('./rate-limiter');
const logger = require('./logger');

// Constants
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const CORE_URL = process.env.CORE_URL || 'http://localhost:8000';
const METRICS_HISTORY_FILE = path.join(process.env.HOME || '/home/ubuntu', '.openclaw/workspace/.mc-metrics-history.json');
const MAX_HISTORY_ENTRIES = 100;

// Metric queries for Prometheus
const QUERIES = {
  // Request metrics
  totalRequests: 'sum(masterclaw_http_requests_total)',
  requestRate: 'sum(rate(masterclaw_http_requests_total[5m]))',
  errorRate: 'sum(rate(masterclaw_http_requests_total{status=~"5.."}[5m]))',
  
  // Response time metrics
  avgResponseTime: 'avg(masterclaw_http_request_duration_seconds_sum / masterclaw_http_request_duration_seconds_count)',
  p95ResponseTime: 'histogram_quantile(0.95, sum(rate(masterclaw_http_request_duration_seconds_bucket[5m])) by (le))',
  
  // LLM metrics
  llmRequests: 'sum(masterclaw_llm_requests_total)',
  llmRequestRate: 'sum(rate(masterclaw_llm_requests_total[5m]))',
  llmCostTotal: 'sum(masterclaw_llm_cost_total)',
  
  // Memory metrics
  memoryEntries: 'masterclaw_memory_entries_total',
  memoryOpsRate: 'sum(rate(masterclaw_memory_operations_total[5m]))',
  
  // Session metrics
  activeSessions: 'masterclaw_active_sessions',
  
  // System metrics (from node_exporter if available)
  cpuUsage: '100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)',
  memoryUsage: '((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / node_memory_MemTotal_bytes) * 100',
  diskUsage: '(node_filesystem_size_bytes{mountpoint="/"} - node_filesystem_avail_bytes{mountpoint="/"}) / node_filesystem_size_bytes{mountpoint="/"} * 100',
};

/**
 * Check if Prometheus is available
 */
async function isPrometheusAvailable() {
  try {
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/status/targets`, {
      timeout: 2000,
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Check if Core API is available
 */
async function isCoreAvailable() {
  try {
    const response = await axios.get(`${CORE_URL}/health`, {
      timeout: 2000,
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

/**
 * Query Prometheus for a single metric
 */
async function queryPrometheus(query) {
  try {
    const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
      params: { query },
      timeout: 5000,
    });
    
    if (response.data?.data?.result?.[0]?.value) {
      return parseFloat(response.data.data.result[0].value[1]);
    }
    return null;
  } catch (error) {
    logger.debug(`Prometheus query failed: ${query}`, { error: error.message });
    return null;
  }
}

/**
 * Fetch metrics from Core API /metrics endpoint
 */
async function fetchCoreMetrics() {
  try {
    const response = await axios.get(`${CORE_URL}/metrics`, {
      timeout: 5000,
    });
    
    const metrics = {
      timestamp: new Date().toISOString(),
      source: 'core',
    };
    
    // Parse Prometheus-style text format
    const lines = response.data.split('\n');
    
    for (const line of lines) {
      // Parse counters and gauges
      const match = line.match(/^(\w+)\s*{?[^}]*}?\s+(\S+)/);
      if (match) {
        const [, name, value] = match;
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          if (!metrics[name]) {
            metrics[name] = 0;
          }
          metrics[name] += numValue;
        }
      }
    }
    
    return metrics;
  } catch (error) {
    logger.debug('Core metrics fetch failed', { error: error.message });
    return null;
  }
}

/**
 * Collect all metrics from available sources
 */
async function collectMetrics() {
  const metrics = {
    timestamp: new Date().toISOString(),
    prometheus: null,
    core: null,
    derived: {},
  };
  
  // Try Prometheus first for rich metrics
  if (await isPrometheusAvailable()) {
    const prometheusMetrics = {};
    
    for (const [key, query] of Object.entries(QUERIES)) {
      prometheusMetrics[key] = await queryPrometheus(query);
    }
    
    metrics.prometheus = prometheusMetrics;
  }
  
  // Fallback to Core metrics
  if (await isCoreAvailable()) {
    metrics.core = await fetchCoreMetrics();
  }
  
  // Calculate derived metrics
  calculateDerivedMetrics(metrics);
  
  return metrics;
}

/**
 * Calculate useful derived metrics from raw data
 */
function calculateDerivedMetrics(metrics) {
  const derived = {};
  
  if (metrics.prometheus) {
    const p = metrics.prometheus;
    
    // Error rate percentage
    if (p.requestRate !== null && p.errorRate !== null && p.requestRate > 0) {
      derived.errorRatePercent = (p.errorRate / p.requestRate) * 100;
    }
    
    // Average response time in ms
    if (p.avgResponseTime !== null) {
      derived.avgResponseTimeMs = p.avgResponseTime * 1000;
    }
    
    // P95 response time in ms
    if (p.p95ResponseTime !== null) {
      derived.p95ResponseTimeMs = p.p95ResponseTime * 1000;
    }
    
    // Health score (0-100)
    let healthScore = 100;
    if (derived.errorRatePercent > 5) healthScore -= 20;
    if (derived.errorRatePercent > 1) healthScore -= 10;
    if (derived.avgResponseTimeMs > 1000) healthScore -= 15;
    if (derived.avgResponseTimeMs > 500) healthScore -= 5;
    derived.healthScore = Math.max(0, healthScore);
  }
  
  if (metrics.core) {
    // Calculate total cost if available
    const costMetrics = Object.keys(metrics.core).filter(k => k.includes('cost'));
    if (costMetrics.length > 0) {
      derived.hasCostData = true;
    }
  }
  
  metrics.derived = derived;
}

/**
 * Format a number with appropriate units
 */
function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || isNaN(value)) {
    return chalk.gray('N/A');
  }
  
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(decimals)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(decimals)}k`;
  }
  return value.toFixed(decimals);
}

/**
 * Format duration in ms with color coding
 */
function formatDuration(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) {
    return chalk.gray('N/A');
  }
  
  let color = chalk.green;
  if (ms > 500) color = chalk.yellow;
  if (ms > 1000) color = chalk.red;
  
  return color(`${ms.toFixed(0)}ms`);
}

/**
 * Format percentage with color coding
 */
function formatPercent(value, inverse = false) {
  if (value === null || value === undefined || isNaN(value)) {
    return chalk.gray('N/A');
  }
  
  let color = chalk.green;
  if (!inverse) {
    if (value > 5) color = chalk.yellow;
    if (value > 10) color = chalk.red;
  } else {
    if (value < 50) color = chalk.red;
    if (value < 80) color = chalk.yellow;
  }
  
  return color(`${value.toFixed(1)}%`);
}

/**
 * Display metrics in a formatted table
 */
function displayMetrics(metrics, previousMetrics = null) {
  console.log(chalk.blue('🐾 MasterClaw Metrics'));
  console.log(chalk.gray(`   ${new Date(metrics.timestamp).toLocaleString()}`));
  console.log('');
  
  // Data source indicator
  const sources = [];
  if (metrics.prometheus) sources.push('Prometheus');
  if (metrics.core) sources.push('Core API');
  console.log(chalk.gray(`Sources: ${sources.join(', ') || 'None available'}`));
  console.log('');
  
  // Health Score
  if (metrics.derived.healthScore !== undefined) {
    const score = metrics.derived.healthScore;
    let icon = '✅';
    let color = chalk.green;
    if (score < 70) { icon = '⚠️'; color = chalk.yellow; }
    if (score < 50) { icon = '❌'; color = chalk.red; }
    
    console.log(`${icon} ${chalk.bold('Health Score')}: ${color(`${score}/100`)}`);
    console.log('');
  }
  
  // Request Metrics
  console.log(chalk.bold('📊 Request Metrics'));
  console.log('─'.repeat(50));
  
  if (metrics.prometheus) {
    const p = metrics.prometheus;
    
    if (p.totalRequests !== null) {
      console.log(`  Total Requests: ${chalk.cyan(formatNumber(p.totalRequests, 0))}`);
    }
    
    if (p.requestRate !== null) {
      const prevRate = previousMetrics?.prometheus?.requestRate;
      const trend = prevRate ? getTrend(p.requestRate, prevRate) : '';
      console.log(`  Request Rate:   ${chalk.cyan(`${p.requestRate.toFixed(2)} req/s`)} ${trend}`);
    }
    
    if (metrics.derived.errorRatePercent !== undefined) {
      const prevError = previousMetrics?.derived?.errorRatePercent;
      const trend = prevError ? getTrend(metrics.derived.errorRatePercent, prevError, true) : '';
      console.log(`  Error Rate:     ${formatPercent(metrics.derived.errorRatePercent)} ${trend}`);
    }
    
    if (metrics.derived.avgResponseTimeMs !== undefined) {
      const prevTime = previousMetrics?.derived?.avgResponseTimeMs;
      const trend = prevTime ? getTrend(metrics.derived.avgResponseTimeMs, prevTime, true) : '';
      console.log(`  Avg Response:   ${formatDuration(metrics.derived.avgResponseTimeMs)} ${trend}`);
    }
    
    if (metrics.derived.p95ResponseTimeMs !== undefined) {
      console.log(`  P95 Response:   ${formatDuration(metrics.derived.p95ResponseTimeMs)}`);
    }
  } else if (metrics.core) {
    console.log(`  ${chalk.yellow('Limited metrics available')}`);
    console.log(`  Connect Prometheus for detailed metrics`);
  }
  
  console.log('');
  
  // LLM Metrics
  console.log(chalk.bold('🤖 LLM Metrics'));
  console.log('─'.repeat(50));
  
  if (metrics.prometheus) {
    const p = metrics.prometheus;
    
    if (p.llmRequests !== null) {
      console.log(`  Total LLM Calls: ${chalk.cyan(formatNumber(p.llmRequests, 0))}`);
    }
    
    if (p.llmRequestRate !== null) {
      console.log(`  LLM Rate:        ${chalk.cyan(`${p.llmRequestRate.toFixed(2)} calls/s`)}`);
    }
    
    if (p.llmCostTotal !== null) {
      console.log(`  Total Cost:      ${chalk.cyan(`$${p.llmCostTotal.toFixed(2)}`)}`);
    }
  } else if (metrics.core?.masterclaw_llm_requests_total !== undefined) {
    console.log(`  Total LLM Calls: ${chalk.cyan(formatNumber(metrics.core.masterclaw_llm_requests_total, 0))}`);
  }
  
  console.log('');
  
  // Memory & Sessions
  console.log(chalk.bold('💾 Memory & Sessions'));
  console.log('─'.repeat(50));
  
  if (metrics.prometheus) {
    const p = metrics.prometheus;
    
    if (p.memoryEntries !== null) {
      console.log(`  Memory Entries:  ${chalk.cyan(formatNumber(p.memoryEntries, 0))}`);
    }
    
    if (p.activeSessions !== null) {
      console.log(`  Active Sessions: ${chalk.cyan(formatNumber(p.activeSessions, 0))}`);
    }
  }
  
  console.log('');
  
  // System Metrics (if available)
  if (metrics.prometheus?.cpuUsage !== null) {
    console.log(chalk.bold('🖥️  System Resources'));
    console.log('─'.repeat(50));
    
    const p = metrics.prometheus;
    
    if (p.cpuUsage !== null) {
      console.log(`  CPU Usage:    ${formatPercent(p.cpuUsage)}`);
    }
    
    if (p.memoryUsage !== null) {
      console.log(`  Memory Usage: ${formatPercent(p.memoryUsage)}`);
    }
    
    if (p.diskUsage !== null) {
      console.log(`  Disk Usage:   ${formatPercent(p.diskUsage)}`);
    }
    
    console.log('');
  }
  
  // Legend
  console.log(chalk.gray('Tip: Run `mc metrics --live` for real-time updates'));
  console.log(chalk.gray('     Run `make monitor` to start Prometheus/Grafana'));
}

/**
 * Get trend indicator comparing current to previous
 */
function getTrend(current, previous, lowerIsBetter = false) {
  if (!previous || previous === 0) return '';
  
  const change = ((current - previous) / previous) * 100;
  const isImprovement = lowerIsBetter ? change < 0 : change > 0;
  
  if (Math.abs(change) < 1) return chalk.gray('→');
  
  const arrow = change > 0 ? '↑' : '↓';
  const color = isImprovement ? chalk.green : chalk.red;
  
  return color(`${arrow} ${Math.abs(change).toFixed(0)}%`);
}

/**
 * Save metrics to history file
 */
async function saveMetricsToHistory(metrics) {
  try {
    let history = [];
    if (await fs.pathExists(METRICS_HISTORY_FILE)) {
      history = await fs.readJson(METRICS_HISTORY_FILE);
    }
    
    history.push(metrics);
    
    // Keep only recent entries
    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(-MAX_HISTORY_ENTRIES);
    }
    
    await fs.ensureDir(path.dirname(METRICS_HISTORY_FILE));
    await fs.writeJson(METRICS_HISTORY_FILE, history, { spaces: 0 });
  } catch (error) {
    logger.debug('Failed to save metrics history', { error: error.message });
  }
}

/**
 * Load previous metrics for comparison
 */
async function loadPreviousMetrics() {
  try {
    if (await fs.pathExists(METRICS_HISTORY_FILE)) {
      const history = await fs.readJson(METRICS_HISTORY_FILE);
      if (history.length > 0) {
        return history[history.length - 1];
      }
    }
  } catch (error) {
    logger.debug('Failed to load metrics history', { error: error.message });
  }
  return null;
}

/**
 * Watch mode - continuously update metrics
 */
async function watchMetrics(options) {
  const interval = parseInt(options.interval, 10) * 1000 || 5000;
  
  console.log(chalk.blue('🐾 MasterClaw Metrics (Live)'));
  console.log(chalk.gray(`Press Ctrl+C to exit`));
  console.log('');
  
  let isFirstRun = true;
  
  const update = async () => {
    try {
      // Clear screen (except first run)
      if (!isFirstRun) {
        process.stdout.write('\x1Bc');
      }
      isFirstRun = false;
      
      const previousMetrics = await loadPreviousMetrics();
      const metrics = await collectMetrics();
      
      displayMetrics(metrics, previousMetrics);
      await saveMetricsToHistory(metrics);
      
      console.log(chalk.gray(`\nRefreshing every ${interval / 1000}s...`));
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
    }
  };
  
  // Initial update
  await update();
  
  // Set up interval
  const timer = setInterval(update, interval);
  
  // Handle exit
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n');
    process.exit(0);
  });
}

/**
 * Export metrics to file
 */
async function exportMetrics(options) {
  const metrics = await collectMetrics();
  const outputFile = options.output || `mc-metrics-${Date.now()}.json`;
  
  await fs.writeJson(outputFile, metrics, { spaces: 2 });
  console.log(chalk.green(`✅ Metrics exported to ${outputFile}`));
}

/**
 * Compare current metrics with historical data
 */
async function compareMetrics(options) {
  const current = await collectMetrics();
  
  let previous;
  if (options.with) {
    // Load specific historical file
    previous = await fs.readJson(options.with);
  } else {
    // Load from history
    previous = await loadPreviousMetrics();
  }
  
  if (!previous) {
    console.log(chalk.yellow('⚠️  No previous metrics found for comparison'));
    return;
  }
  
  console.log(chalk.blue('🐾 MasterClaw Metrics Comparison'));
  console.log(chalk.gray(`Current:  ${new Date(current.timestamp).toLocaleString()}`));
  console.log(chalk.gray(`Previous: ${new Date(previous.timestamp).toLocaleString()}`));
  console.log('');
  
  displayMetrics(current, previous);
}

// Create the metrics command
const metricsCmd = new Command('metrics')
  .description('View system metrics and performance data')
  .option('-w, --watch', 'Watch mode - continuously update')
  .option('-i, --interval <seconds>', 'Update interval in seconds (default: 5)', '5')
  .option('-j, --json', 'Output as JSON')
  .option('-e, --export', 'Export metrics to file')
  .option('-o, --output <file>', 'Output file for export')
  .option('-c, --compare', 'Compare with previous metrics')
  .option('--with <file>', 'Compare with specific file')
  .addHelpText('after', `
Examples:
  $ mc metrics                    # Show current metrics
  $ mc metrics --watch            # Live updating metrics
  $ mc metrics --json             # Output as JSON
  $ mc metrics --export           # Export to file
  $ mc metrics --compare          # Compare with previous

Environment Variables:
  PROMETHEUS_URL    Prometheus endpoint (default: http://localhost:9090)
  CORE_URL          Core API endpoint (default: http://localhost:8000)
`)
  .action(wrapCommand(async (options) => {
    // Check rate limiting
    const rateLimitKey = `metrics${options.watch ? '-watch' : ''}`;
    const rateLimitResult = await rateLimiter.checkRateLimit(rateLimitKey, {
      maxAttempts: options.watch ? 1 : 10,
      windowMs: 60000,
    });
    
    if (!rateLimitResult.allowed) {
      console.log(chalk.yellow('⚠️  Rate limit exceeded. Please wait before checking metrics again.'));
      process.exit(ExitCode.GENERAL_ERROR);
    }
    
    if (options.watch) {
      await watchMetrics(options);
      return;
    }
    
    if (options.export) {
      await exportMetrics(options);
      return;
    }
    
    if (options.compare || options.with) {
      await compareMetrics(options);
      return;
    }
    
    // Collect and display metrics
    const previousMetrics = await loadPreviousMetrics();
    const metrics = await collectMetrics();
    
    if (options.json) {
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      displayMetrics(metrics, previousMetrics);
    }
    
    // Save to history for future comparison
    await saveMetricsToHistory(metrics);
    
    // Exit with error if no metrics available
    if (!metrics.prometheus && !metrics.core) {
      console.log(chalk.red('\n❌ No metrics sources available'));
      console.log(chalk.gray('   Ensure Prometheus or Core API is running'));
      process.exit(ExitCode.SERVICE_UNAVAILABLE);
    }
  }, 'metrics'));

module.exports = {
  metricsCmd,
  collectMetrics,
  isPrometheusAvailable,
  isCoreAvailable,
};
