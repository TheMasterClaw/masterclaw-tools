/**
 * Log Analysis Module - Intelligent log analysis and anomaly detection
 *
 * Provides automated analysis of MasterClaw logs to identify:
 * - Error patterns and frequency analysis
 * - Performance degradation indicators
 * - Security anomalies (failed auth, unusual access patterns)
 * - Resource exhaustion warnings
 * - Service dependency issues
 */

const chalk = require('chalk');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const { findInfraDir } = require('./services');

// Analysis configuration
const ANALYSIS_CONFIG = {
  // Time windows for analysis
  timeWindows: {
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  },

  // Error patterns to detect
  errorPatterns: [
    { pattern: /error|exception|fatal|panic/i, severity: 'error', category: 'runtime' },
    { pattern: /timeout|timed out/i, severity: 'warning', category: 'performance' },
    { pattern: /connection refused|ECONNREFUSED/i, severity: 'error', category: 'network' },
    { pattern: /memory.*exhausted|out of memory|oom/i, severity: 'critical', category: 'resource' },
    { pattern: /disk full|no space left/i, severity: 'critical', category: 'resource' },
    { pattern: /unauthorized|authentication failed|auth.*fail/i, severity: 'warning', category: 'security' },
    { pattern: /rate limit|too many requests|429/i, severity: 'warning', category: 'rate_limiting' },
    { pattern: /ssl.*error|certificate.*expired|cert.*invalid/i, severity: 'error', category: 'ssl' },
    { pattern: /database.*error|sqlite.*error|query.*failed/i, severity: 'error', category: 'database' },
    { pattern: /health.*check.*failed|unhealthy/i, severity: 'error', category: 'health' },
  ],

  // Thresholds for anomaly detection
  thresholds: {
    errorSpikeMultiplier: 3,      // 3x average = spike
    errorSpikeMinCount: 10,       // Minimum errors to trigger spike
    newErrorThreshold: 5,         // New error type appears 5+ times
    repeatedErrorThreshold: 20,   // Same error 20+ times
    slowRequestThreshold: 5000,   // 5 seconds
  },
};

/**
 * Get logs from Docker containers
 */
async function fetchLogs(service, options = {}) {
  const { since = '1h', tail = 1000 } = options;

  try {
    const infraDir = await findInfraDir();
    const containerName = service === 'all' ? '' : `mc-${service}`;

    let cmd;
    if (containerName) {
      cmd = `docker logs --since ${since} --tail ${tail} ${containerName} 2>&1`;
    } else {
      // Get logs from all containers
      cmd = `docker-compose logs --since ${since} --tail ${tail} 2>&1`;
    }

    const output = execSync(cmd, {
      cwd: infraDir,
      encoding: 'utf8',
      timeout: 30000,
    });

    return output.split('\n').filter(line => line.trim());
  } catch (error) {
    // Container might not be running
    if (error.stderr?.includes('No such container') ||
        error.message?.includes('No such container')) {
      return [];
    }
    throw error;
  }
}

/**
 * Parse log lines and extract structured information
 */
function parseLogLines(lines) {
  const parsed = [];

  for (const line of lines) {
    const entry = {
      raw: line,
      timestamp: null,
      level: 'info',
      service: 'unknown',
      message: line,
      metadata: {},
    };

    // Try to extract timestamp
    const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)/);
    if (timestampMatch) {
      entry.timestamp = new Date(timestampMatch[1]);
    }

    // Try to extract log level
    const levelMatch = line.match(/\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/i);
    if (levelMatch) {
      entry.level = levelMatch[1].toLowerCase();
    }

    // Try to extract service name from Docker Compose prefix
    const serviceMatch = line.match(/^(\w+)_\d+\s*\|/);
    if (serviceMatch) {
      entry.service = serviceMatch[1];
    }

    // Extract message (remove timestamp and level prefixes)
    entry.message = line
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s*/, '')
      .replace(/^\w+\s+(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\s*[:-]?\s*/i, '')
      .replace(/^\w+_\d+\s*\|\s*/, '')
      .trim();

    parsed.push(entry);
  }

  return parsed;
}

/**
 * Analyze logs for error patterns
 */
function analyzeErrors(parsedLogs) {
  const errors = {
    byCategory: {},
    bySeverity: {},
    byService: {},
    timeline: [],
    patterns: [],
    uniqueErrors: new Map(),
  };

  for (const log of parsedLogs) {
    // Check against error patterns
    for (const errorPattern of ANALYSIS_CONFIG.errorPatterns) {
      if (errorPattern.pattern.test(log.message)) {
        const category = errorPattern.category;
        const severity = errorPattern.severity;

        // Count by category
        errors.byCategory[category] = (errors.byCategory[category] || 0) + 1;

        // Count by severity
        errors.bySeverity[severity] = (errors.bySeverity[severity] || 0) + 1;

        // Count by service
        errors.byService[log.service] = (errors.byService[log.service] || 0) + 1;

        // Track unique error signatures
        const signature = `${category}:${log.message.substring(0, 100)}`;
        if (!errors.uniqueErrors.has(signature)) {
          errors.uniqueErrors.set(signature, {
            category,
            severity,
            message: log.message.substring(0, 200),
            firstSeen: log.timestamp,
            count: 0,
            service: log.service,
          });
        }
        errors.uniqueErrors.get(signature).count++;
        errors.uniqueErrors.get(signature).lastSeen = log.timestamp;

        break; // Only match first pattern
      }
    }
  }

  // Convert unique errors to array and sort by count
  errors.patterns = Array.from(errors.uniqueErrors.values())
    .sort((a, b) => b.count - a.count);

  return errors;
}

/**
 * Detect anomalies in log patterns
 */
function detectAnomalies(parsedLogs, errors) {
  const anomalies = [];
  const { thresholds } = ANALYSIS_CONFIG;

  // Group logs by hour for trend analysis
  const hourlyCounts = {};
  for (const log of parsedLogs) {
    if (log.timestamp) {
      const hour = new Date(log.timestamp).setMinutes(0, 0, 0);
      hourlyCounts[hour] = (hourlyCounts[hour] || 0) + 1;
    }
  }

  // Calculate average hourly rate
  const hours = Object.keys(hourlyCounts).length || 1;
  const avgRate = parsedLogs.length / hours;

  // Check for error spikes
  const totalErrors = Object.values(errors.bySeverity).reduce((a, b) => a + b, 0);
  if (totalErrors > thresholds.errorSpikeMinCount &&
      totalErrors > avgRate * thresholds.errorSpikeMultiplier) {
    anomalies.push({
      type: 'error_spike',
      severity: 'critical',
      message: `Error rate is ${(totalErrors / avgRate).toFixed(1)}x above normal`,
      details: { totalErrors, avgRate, hours },
    });
  }

  // Check for repeated errors
  for (const pattern of errors.patterns) {
    if (pattern.count >= thresholds.repeatedErrorThreshold) {
      anomalies.push({
        type: 'repeated_error',
        severity: pattern.severity,
        message: `Error repeated ${pattern.count} times: ${pattern.message.substring(0, 60)}...`,
        details: pattern,
      });
    }
  }

  // Check for service imbalance (one service dominating errors)
  const serviceErrorCounts = Object.entries(errors.byService);
  if (serviceErrorCounts.length > 1) {
    const total = serviceErrorCounts.reduce((a, [, c]) => a + c, 0);
    for (const [service, count] of serviceErrorCounts) {
      if (count / total > 0.8 && count > 10) {
        anomalies.push({
          type: 'service_error_concentration',
          severity: 'warning',
          message: `${service} accounts for ${(count / total * 100).toFixed(0)}% of all errors`,
          details: { service, count, total },
        });
      }
    }
  }

  // Check for SSL issues
  if (errors.byCategory.ssl > 0) {
    anomalies.push({
      type: 'ssl_issue',
      severity: 'critical',
      message: `${errors.byCategory.ssl} SSL/certificate errors detected`,
      details: { count: errors.byCategory.ssl },
    });
  }

  // Check for resource exhaustion
  if (errors.byCategory.resource > 0) {
    anomalies.push({
      type: 'resource_exhaustion',
      severity: 'critical',
      message: `${errors.byCategory.resource} resource exhaustion events detected`,
      details: { count: errors.byCategory.resource },
    });
  }

  return anomalies.sort((a, b) => {
    const severityOrder = { critical: 0, error: 1, warning: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

/**
 * Generate insights and recommendations
 */
function generateInsights(errors, anomalies) {
  const insights = [];

  // Critical resource issues
  if (errors.byCategory.resource > 0) {
    insights.push({
      type: 'critical',
      title: 'Resource Exhaustion Detected',
      recommendation: 'Check disk space with `mc doctor --category system` and memory usage with `mc top`',
      action: 'mc doctor --category system',
    });
  }

  // SSL issues
  if (errors.byCategory.ssl > 0) {
    insights.push({
      type: 'critical',
      title: 'SSL/Certificate Problems',
      recommendation: 'Verify SSL certificate status with `mc ssl check`',
      action: 'mc ssl check',
    });
  }

  // Network connectivity
  if (errors.byCategory.network > 5) {
    insights.push({
      type: 'warning',
      title: 'Network Connectivity Issues',
      recommendation: 'Check service dependencies with `mc deps-check`',
      action: 'mc deps-check',
    });
  }

  // Database errors
  if (errors.byCategory.database > 5) {
    insights.push({
      type: 'warning',
      title: 'Database Errors',
      recommendation: 'Check database integrity and connection pool settings',
      action: 'mc exec mc-core "python -c \\"from masterclaw_core.memory import get_memory_store; store = get_memory_store(); print(store.healthcheck())\\""',
    });
  }

  // High error rate
  if (anomalies.some(a => a.type === 'error_spike')) {
    insights.push({
      type: 'warning',
      title: 'Error Rate Spike',
      recommendation: 'Review recent changes and check service health',
      action: 'mc health',
    });
  }

  // Security issues
  if (errors.byCategory.security > 5) {
    insights.push({
      type: 'warning',
      title: 'Security Events Detected',
      recommendation: 'Review security audit logs for potential threats',
      action: 'mc audit --summary',
    });
  }

  // Performance issues
  if (errors.byCategory.performance > 10) {
    insights.push({
      type: 'info',
      title: 'Performance Issues',
      recommendation: 'Check API performance metrics',
      action: 'mc performance --stats',
    });
  }

  // If everything looks good
  if (insights.length === 0 && Object.keys(errors.byCategory).length === 0) {
    insights.push({
      type: 'success',
      title: 'No Issues Detected',
      recommendation: 'Your MasterClaw instance appears healthy',
      action: null,
    });
  }

  return insights;
}

/**
 * Run complete log analysis
 */
async function runAnalysis(options = {}) {
  const {
    service = 'all',
    since = '1h',
    focus,
  } = options;

  const startTime = Date.now();

  // Fetch logs
  const lines = await fetchLogs(service, { since });
  if (lines.length === 0) {
    return {
      success: true,
      logsFound: 0,
      errors: { byCategory: {}, bySeverity: {}, patterns: [] },
      anomalies: [],
      insights: [],
      duration: Date.now() - startTime,
    };
  }

  // Parse logs
  const parsed = parseLogLines(lines);

  // Analyze errors
  const errors = analyzeErrors(parsed);

  // Detect anomalies
  const anomalies = detectAnomalies(parsed, errors);

  // Generate insights
  let insights = generateInsights(errors, anomalies);

  // Filter by focus if specified
  if (focus) {
    insights = insights.filter(i =>
      i.title.toLowerCase().includes(focus.toLowerCase()) ||
      i.type === focus.toLowerCase()
    );
  }

  return {
    success: true,
    logsFound: lines.length,
    errors,
    anomalies,
    insights,
    duration: Date.now() - startTime,
  };
}

/**
 * Display analysis results
 */
function displayResults(results, options = {}) {
  const { verbose = false, json = false } = options;

  if (json) {
    console.log(JSON.stringify(results, (key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      return value;
    }, 2));
    return;
  }

  console.log(chalk.blue('\n🔍 MasterClaw Log Analysis\n'));
  console.log(chalk.gray(`Analyzed ${results.logsFound.toLocaleString()} log lines in ${results.duration}ms\n`));

  // Error summary
  console.log(chalk.cyan('Error Summary:'));
  if (Object.keys(results.errors.byCategory).length === 0) {
    console.log(chalk.green('  ✅ No errors detected'));
  } else {
    for (const [category, count] of Object.entries(results.errors.byCategory)) {
      const color = count > 10 ? chalk.red : count > 5 ? chalk.yellow : chalk.gray;
      console.log(`  ${color(category.padEnd(15))} ${count.toString().padStart(4)}`);
    }
  }
  console.log('');

  // Top error patterns
  if (results.errors.patterns.length > 0) {
    console.log(chalk.cyan('Top Error Patterns:'));
    const topPatterns = results.errors.patterns.slice(0, verbose ? 10 : 5);
    for (let i = 0; i < topPatterns.length; i++) {
      const pattern = topPatterns[i];
      const icon = pattern.severity === 'critical' ? '🔴' :
        pattern.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${icon} [${pattern.category}] ${pattern.message.substring(0, 70)}${pattern.message.length > 70 ? '...' : ''}`);
      console.log(chalk.gray(`     Count: ${pattern.count} | Service: ${pattern.service}`));
    }
    if (results.errors.patterns.length > topPatterns.length) {
      console.log(chalk.gray(`  ... and ${results.errors.patterns.length - topPatterns.length} more unique error types`));
    }
    console.log('');
  }

  // Anomalies
  if (results.anomalies.length > 0) {
    console.log(chalk.cyan('Detected Anomalies:'));
    for (const anomaly of results.anomalies) {
      const icon = anomaly.severity === 'critical' ? '🔴' :
        anomaly.severity === 'error' ? '❌' : '⚠️';
      console.log(`  ${icon} ${anomaly.message}`);
    }
    console.log('');
  }

  // Insights & Recommendations
  console.log(chalk.cyan('Insights & Recommendations:'));
  for (const insight of results.insights) {
    const icon = insight.type === 'critical' ? '🔴' :
      insight.type === 'warning' ? '⚠️' :
        insight.type === 'success' ? '✅' : '💡';
    console.log(`  ${icon} ${chalk.bold(insight.title)}`);
    console.log(`     ${insight.recommendation}`);
    if (insight.action) {
      console.log(chalk.cyan(`     → Run: ${insight.action}`));
    }
    console.log('');
  }

  // Overall health score
  const criticalCount = results.anomalies.filter(a => a.severity === 'critical').length;
  const warningCount = results.anomalies.filter(a => a.severity === 'warning').length;

  let healthIcon, healthText;
  if (criticalCount > 0) {
    healthIcon = '🔴';
    healthText = chalk.red('CRITICAL - Immediate attention required');
  } else if (warningCount > 0) {
    healthIcon = '⚠️';
    healthText = chalk.yellow('WARNING - Issues detected');
  } else if (Object.keys(results.errors.byCategory).length > 0) {
    healthIcon = '💛';
    healthText = chalk.yellow('DEGRADED - Minor issues present');
  } else {
    healthIcon = '✅';
    healthText = chalk.green('HEALTHY - No issues detected');
  }

  console.log(chalk.cyan('Overall Health:'));
  console.log(`  ${healthIcon} ${healthText}\n`);
}

/**
 * Generate trend report (compare with historical data)
 */
async function generateTrendReport(_days = 7) {
  const historyPath = path.join(
    require('os').homedir(),
    '.config',
    'masterclaw',
    'analysis-history.json'
  );

  let history = [];
  if (await fs.pathExists(historyPath)) {
    history = await fs.readJson(historyPath);
  }

  // Add current snapshot
  const snapshot = {
    timestamp: new Date().toISOString(),
    // Current analysis would be added here
  };

  // Keep only last 30 days
  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  history = history.filter(h => new Date(h.timestamp).getTime() > cutoff);
  history.push(snapshot);

  await fs.ensureDir(path.dirname(historyPath));
  await fs.writeJson(historyPath, history);

  return history;
}

module.exports = {
  runAnalysis,
  displayResults,
  fetchLogs,
  parseLogLines,
  analyzeErrors,
  detectAnomalies,
  generateInsights,
  generateTrendReport,
  ANALYSIS_CONFIG,
};
