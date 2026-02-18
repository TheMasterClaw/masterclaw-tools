/**
 * MasterClaw Performance Profiling CLI
 *
 * Commands for viewing API performance metrics, slow endpoints,
 * and performance trends from the Core API.
 *
 * Security & Reliability Features:
 * - Input validation for all numeric parameters (prevents injection/DoS)
 * - Correlation ID propagation for distributed tracing
 * - Exponential backoff retry logic for resilient API calls
 * - Proper timeout handling on all HTTP requests
 * - Response size limiting to prevent memory exhaustion
 */

const chalk = require('chalk');
const axios = require('axios');
const { findInfraDir } = require('./services');
const config = require('./config');
const { getCurrentCorrelationId, CORRELATION_ID_HEADER } = require('./correlation');
const { maskSensitiveData } = require('./security');

const DEFAULT_API_URL = 'http://localhost:8000';

// =============================================================================
// Security & Validation Constants
// =============================================================================

/** Maximum number of endpoints to fetch (DoS protection) */
const MAX_ENDPOINTS_LIMIT = 100;

/** Maximum number of profiles to fetch (DoS protection) */
const MAX_PROFILES_LIMIT = 1000;

/** Minimum valid limit values */
const MIN_LIMIT = 1;

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 10000;

/** Maximum request timeout in milliseconds */
const MAX_TIMEOUT_MS = 60000;

/** Maximum response size in bytes (1MB) */
const MAX_RESPONSE_SIZE = 1024 * 1024;

// =============================================================================
// Retry Configuration
// =============================================================================

/** Default retry configuration for resilient API calls */
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableStatuses: [502, 503, 504, 429], // Gateway errors + rate limiting
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'],
};

// =============================================================================
// Input Validation Functions
// =============================================================================

/**
 * Validates and sanitizes a numeric limit parameter
 * @param {*} value - The value to validate
 * @param {number} defaultValue - Default value if invalid
 * @param {number} maxValue - Maximum allowed value
 * @returns {number} - Validated and bounded value
 * @throws {Error} - If value is invalid type
 */
function validateLimit(value, defaultValue, maxValue) {
  // Handle undefined/null
  if (value === undefined || value === null) {
    return defaultValue;
  }

  // Convert to number if string
  let num = value;
  if (typeof value === 'string') {
    num = parseInt(value, 10);
    if (isNaN(num)) {
      console.warn(chalk.yellow(`⚠️  Invalid limit value "${value}", using default: ${defaultValue}`));
      return defaultValue;
    }
  }

  // Validate type
  if (typeof num !== 'number' || isNaN(num)) {
    console.warn(chalk.yellow(`⚠️  Invalid limit type, using default: ${defaultValue}`));
    return defaultValue;
  }

  // Check for unsafe integers
  if (!Number.isSafeInteger(num)) {
    console.warn(chalk.yellow(`⚠️  Limit value too large, using maximum: ${maxValue}`));
    return maxValue;
  }

  // Enforce minimum
  if (num < MIN_LIMIT) {
    console.warn(chalk.yellow(`⚠️  Limit must be at least ${MIN_LIMIT}, using: ${MIN_LIMIT}`));
    return MIN_LIMIT;
  }

  // Enforce maximum (DoS protection)
  if (num > maxValue) {
    console.warn(chalk.yellow(`⚠️  Limit exceeds maximum (${maxValue}), using: ${maxValue}`));
    return maxValue;
  }

  return num;
}

/**
 * Validates timeout configuration
 * @param {*} timeoutMs - Timeout in milliseconds
 * @returns {number} - Validated timeout
 */
function validateTimeout(timeoutMs) {
  if (typeof timeoutMs !== 'number' || isNaN(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }

  // Enforce bounds
  const bounded = Math.max(1000, Math.min(timeoutMs, MAX_TIMEOUT_MS));
  return bounded;
}

// =============================================================================
// Retry Logic with Exponential Backoff
// =============================================================================

/**
 * Sleeps for the specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines if an error is retryable
 * @param {Error} error - The error that occurred
 * @returns {boolean} - True if retryable
 */
function isRetryableError(error) {
  if (!error) return false;

  // Check error codes
  if (error.code && RETRY_CONFIG.retryableErrors.includes(error.code)) {
    return true;
  }

  // Check HTTP status codes
  if (error.response && RETRY_CONFIG.retryableStatuses.includes(error.response.status)) {
    return true;
  }

  // Timeout errors
  if (error.message?.includes('timeout') || error.code === 'ECONNABORTED') {
    return true;
  }

  return false;
}

/**
 * Calculates delay with exponential backoff and jitter
 * @param {number} attempt - Current attempt number (0-indexed)
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoff(attempt) {
  const exponentialDelay = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
  const boundedDelay = Math.min(exponentialDelay, RETRY_CONFIG.maxDelayMs);
  // Add jitter (±25%) to prevent thundering herd
  const jitter = boundedDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.floor(boundedDelay + jitter);
}

/**
 * Executes an API call with retry logic
 * @param {Function} apiCall - Async function that makes the API call
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise<any>} - API response data
 */
async function executeWithRetry(apiCall, operationName) {
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt or if error isn't retryable
      if (attempt === RETRY_CONFIG.maxRetries || !isRetryableError(error)) {
        break;
      }

      const delay = calculateBackoff(attempt);
      const attemptNum = attempt + 1;

      // Log retry attempt (but don't spam)
      if (attemptNum <= 2) {
        console.log(chalk.yellow(`⚠️  ${operationName} failed (attempt ${attemptNum}), retrying in ${delay}ms...`));
      }

      await sleep(delay);
    }
  }

  // All retries exhausted
  throw lastError;
}

// =============================================================================
// API Client Configuration
// =============================================================================

/**
 * Get the Core API URL from config or default
 * @returns {string} - API URL
 */
function getApiUrl() {
  const cfg = config.readConfig();
  return cfg.core?.url || DEFAULT_API_URL;
}

/**
 * Get API key from config
 * @returns {string|null} - API key or null
 */
function getApiKey() {
  const cfg = config.readConfig();
  return cfg.core?.apiKey || null;
}

/**
 * Creates axios instance with security hardening:
 * - Authentication headers
 * - Correlation ID propagation
 * - Timeout configuration
 * - Response size limits
 * @returns {Object} - Configured axios instance
 */
function createApiClient() {
  const headers = {};

  // Add API key if available
  const apiKey = getApiKey();
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  // Add correlation ID for distributed tracing
  const correlationId = getCurrentCorrelationId();
  if (correlationId) {
    headers[CORRELATION_ID_HEADER] = correlationId;
  }

  return axios.create({
    baseURL: getApiUrl(),
    headers,
    timeout: DEFAULT_TIMEOUT_MS,
    maxContentLength: MAX_RESPONSE_SIZE,
    maxBodyLength: MAX_RESPONSE_SIZE,
  });
}

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Handles API errors with user-friendly messages
 * @param {Error} error - The error that occurred
 * @param {string} context - Context for the error message
 * @returns {null} - Always returns null for consistent handling
 */
function handleApiError(error, context) {
  // Handle specific error types
  if (error.code === 'ECONNREFUSED') {
    console.log(chalk.red('❌ Cannot connect to MasterClaw Core'));
    console.log(chalk.gray('   Make sure the Core service is running: mc revive'));
  } else if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    console.log(chalk.red(`❌ ${context} timed out`));
    console.log(chalk.gray('   The service may be overloaded. Try again later.'));
  } else if (error.code === 'ENOTFOUND') {
    console.log(chalk.red(`❌ Cannot resolve MasterClaw Core address`));
    console.log(chalk.gray('   Check your network connection and Core URL configuration.'));
  } else if (error.response?.status === 401) {
    console.log(chalk.red('❌ Authentication required'));
    console.log(chalk.gray('   Set API key in config: mc config set core.apiKey <key>'));
  } else if (error.response?.status === 429) {
    console.log(chalk.red('❌ Rate limit exceeded'));
    console.log(chalk.gray('   Too many requests. Please wait before retrying.'));
  } else if (error.response?.status >= 500) {
    console.log(chalk.red(`❌ Server error (${error.response.status})`));
    console.log(chalk.gray('   The Core service encountered an error. Check logs: mc logs core'));
  } else {
    // Generic error - mask any potentially sensitive data
    const safeMessage = maskSensitiveData(error.message || 'Unknown error');
    console.log(chalk.red(`❌ ${context}: ${safeMessage}`));
  }

  return null;
}

// =============================================================================
// Output Formatting
// =============================================================================

/**
 * Format duration with color coding
 * @param {number} ms - Duration in milliseconds
 * @param {number} threshold - Slow threshold in milliseconds
 * @returns {string} - Formatted duration with color
 */
function formatDuration(ms, threshold = 1000) {
  const num = typeof ms === 'number' ? ms : parseFloat(ms);
  if (!isFinite(num) || isNaN(num)) {
    return chalk.gray('N/A');
  }

  if (num < threshold * 0.5) {
    return chalk.green(`${num.toFixed(2)}ms`);
  } else if (num < threshold) {
    return chalk.yellow(`${num.toFixed(2)}ms`);
  } else {
    return chalk.red(`${num.toFixed(2)}ms`);
  }
}

// =============================================================================
// API Functions with Retry Logic
// =============================================================================

/**
 * Show performance summary with retry logic
 * @returns {Promise<Object|null>} - Summary data or null on error
 */
async function showSummary() {
  const client = createApiClient();

  try {
    const response = await executeWithRetry(
      () => client.get('/v1/performance/summary'),
      'Fetching performance summary'
    );

    const data = response.data;

    console.log(chalk.blue('🐾 MasterClaw Performance Summary\n'));
    console.log(`Total Requests: ${chalk.bold((data.total_requests || 0).toLocaleString())}`);
    console.log(`Average Response Time: ${formatDuration(data.avg_response_ms, data.slow_threshold_ms)}`);

    const slowRequests = data.slow_requests || 0;
    const slowPercentage = data.slow_percentage || 0;
    console.log(`Slow Requests: ${chalk.yellow(slowRequests.toLocaleString())} (${slowPercentage}%)`);
    console.log(`Endpoints Tracked: ${data.endpoints_tracked || 0}`);
    console.log(`Slow Threshold: ${data.slow_threshold_ms || 1000}ms`);

    return data;
  } catch (error) {
    return handleApiError(error, 'Failed to fetch performance summary');
  }
}

/**
 * Show endpoint statistics with retry logic
 * @returns {Promise<boolean>} - True if successful
 */
async function showStats() {
  const client = createApiClient();

  try {
    const response = await executeWithRetry(
      () => client.get('/v1/performance/stats'),
      'Fetching endpoint statistics'
    );

    const { endpoints, summary } = response.data;

    console.log(chalk.blue('🐾 MasterClaw Endpoint Performance\n'));

    // Show summary with safe defaults
    const totalRequests = summary?.total_requests || 0;
    const avgResponse = summary?.avg_response_ms || 0;
    const slowPercentage = summary?.slow_percentage || 0;
    const slowThreshold = summary?.slow_threshold_ms || 1000;

    console.log(chalk.gray('Summary:'));
    console.log(`  Total Requests: ${totalRequests.toLocaleString()}`);
    console.log(`  Avg Response: ${formatDuration(avgResponse, slowThreshold)}`);
    console.log(`  Slow Requests: ${chalk.yellow(`${slowPercentage  }%`)}`);
    console.log();

    // Show endpoint table
    const endpointList = Object.entries(endpoints || {});
    if (endpointList.length === 0) {
      console.log(chalk.gray('No endpoint data available yet.'));
      return true;
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
    endpointList.sort((a, b) => (b[1]?.avg_ms || 0) - (a[1]?.avg_ms || 0));

    for (const [endpoint, stats] of endpointList) {
      const path = endpoint.length > 37 ? `...${  endpoint.slice(-34)}` : endpoint;
      const slowPct = (stats?.slow_percent || 0);
      const slowDisplay = slowPct > 20
        ? chalk.red(`${slowPct  }%`)
        : slowPct > 5
          ? chalk.yellow(`${slowPct  }%`)
          : chalk.green(`${slowPct  }%`);

      console.log(
        path.padEnd(40),
        (stats?.count || 0).toLocaleString().padStart(8),
        formatDuration(stats?.avg_ms, slowThreshold).padStart(12),
        formatDuration(stats?.min_ms, slowThreshold).padStart(12),
        formatDuration(stats?.max_ms, slowThreshold).padStart(12),
        slowDisplay.padStart(8)
      );
    }

    console.log(chalk.gray('─'.repeat(100)));
    return true;
  } catch (error) {
    handleApiError(error, 'Failed to fetch endpoint statistics');
    return false;
  }
}

/**
 * Show slowest endpoints with validated input and retry logic
 * @param {*} n - Number of endpoints to show (validated)
 * @returns {Promise<boolean>} - True if successful
 */
async function showSlowest(n = 10) {
  // Validate and bound the input (security: prevents DoS from huge values)
  const validatedN = validateLimit(n, 10, MAX_ENDPOINTS_LIMIT);

  const client = createApiClient();

  try {
    const response = await executeWithRetry(
      () => client.get(`/v1/performance/slowest?n=${validatedN}`),
      'Fetching slowest endpoints'
    );

    const { endpoints, threshold_ms } = response.data;
    const threshold = threshold_ms || 1000;

    console.log(chalk.blue(`🐾 Top ${validatedN} Slowest Endpoints\n`));
    console.log(chalk.gray(`Slow threshold: ${threshold}ms\n`));

    const endpointList = endpoints || [];
    if (endpointList.length === 0) {
      console.log(chalk.gray('No endpoint data available yet.'));
      return true;
    }

    let i = 1;
    for (const ep of endpointList) {
      const rank = i.toString().padStart(2);
      const slowPercent = ep?.slow_percent || 0;
      const icon = slowPercent > 20 ? '🔴' : slowPercent > 10 ? '🟡' : '🟢';

      console.log(`${rank}. ${icon} ${chalk.bold(ep?.endpoint || 'Unknown')}`);
      console.log(`    Count: ${(ep?.count || 0).toLocaleString()} | ` +
                  `Avg: ${formatDuration(ep?.avg_ms, threshold)} | ` +
                  `Max: ${formatDuration(ep?.max_ms, threshold)} | ` +
                  `Slow: ${ep?.slow_count || 0} (${slowPercent}%)`);
      console.log();
      i++;
    }

    return true;
  } catch (error) {
    handleApiError(error, 'Failed to fetch slowest endpoints');
    return false;
  }
}

/**
 * Show recent profiles with validated input and retry logic
 * @param {Object} options - Options object
 * @param {*} options.limit - Number of profiles to show (validated)
 * @param {boolean} options.slowOnly - Show only slow requests
 * @returns {Promise<boolean>} - True if successful
 */
async function showProfiles(options = {}) {
  // Validate inputs (security: prevents DoS from huge values)
  const limit = validateLimit(options.limit, 20, MAX_PROFILES_LIMIT);
  const slowOnly = !!options.slowOnly;

  const client = createApiClient();

  try {
    const url = `/v1/performance/profiles?limit=${limit}&slow_only=${slowOnly}`;
    const response = await executeWithRetry(
      () => client.get(url),
      'Fetching request profiles'
    );

    const { profiles, total } = response.data;
    const profileList = profiles || [];

    const title = slowOnly ? 'Slow Request Profiles' : 'Recent Request Profiles';
    console.log(chalk.blue(`🐾 ${title}\n`));
    console.log(chalk.gray(`Showing ${profileList.length} of ${total || 0} profiles\n`));

    if (profileList.length === 0) {
      console.log(chalk.gray('No profiles available yet.'));
      return true;
    }

    // Group by endpoint for better readability
    const grouped = {};
    for (const profile of profileList) {
      const method = profile?.method || 'UNKNOWN';
      const path = profile?.path || '/';
      const key = `${method} ${path}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(profile);
    }

    for (const [endpoint, reqs] of Object.entries(grouped)) {
      console.log(chalk.bold(endpoint));
      for (const req of reqs.slice(0, 5)) {
        const timestamp = req?.timestamp;
        let time = 'Unknown';
        try {
          time = timestamp ? new Date(timestamp).toLocaleTimeString() : 'Unknown';
        } catch {
          time = 'Invalid';
        }
        const duration = formatDuration(req?.duration_ms, 1000);
        const icon = req?.slow ? '🔴' : '●';
        const statusCode = req?.status_code || '???';
        console.log(`  ${icon} ${time} - ${duration} - ${statusCode}`);
      }
      if (reqs.length > 5) {
        console.log(chalk.gray(`  ... and ${reqs.length - 5} more`));
      }
      console.log();
    }

    return true;
  } catch (error) {
    handleApiError(error, 'Failed to fetch request profiles');
    return false;
  }
}

/**
 * Clear all performance profiles with retry logic
 * @returns {Promise<boolean>} - True if successful
 */
async function clearProfiles() {
  const client = createApiClient();

  try {
    const response = await executeWithRetry(
      () => client.delete('/v1/performance/profiles'),
      'Clearing performance profiles'
    );

    const message = response.data?.message || 'Performance profiles cleared';
    console.log(chalk.green(`✅ ${message}`));
    return true;
  } catch (error) {
    handleApiError(error, 'Failed to clear performance profiles');
    return false;
  }
}

// =============================================================================
// Exports
// =============================================================================

module.exports = {
  // Main functions
  showSummary,
  showStats,
  showSlowest,
  showProfiles,
  clearProfiles,

  // Validation utilities (exported for testing)
  validateLimit,
  validateTimeout,
  MAX_ENDPOINTS_LIMIT,
  MAX_PROFILES_LIMIT,
  MIN_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,

  // Retry utilities (exported for testing)
  executeWithRetry,
  isRetryableError,
  calculateBackoff,
  sleep,
  RETRY_CONFIG,

  // Error handling (exported for testing)
  handleApiError,

  // API client (exported for testing)
  createApiClient,
  getApiUrl,
  getApiKey,

  // Formatting (exported for testing)
  formatDuration,
};
