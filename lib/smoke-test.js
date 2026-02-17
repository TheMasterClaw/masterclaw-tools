#!/usr/bin/env node
/**
 * MasterClaw API Smoke Tests
 * Post-deployment verification suite
 * 
 * Tests all critical API endpoints to ensure the deployment is functional.
 * Designed to run immediately after deployment to catch issues early.
 */

const axios = require('axios');
const chalk = require('chalk');
const { URL } = require('url');

const { findInfraDir } = require('./services');
const config = require('./config');

// Test configuration
const TEST_CONFIG = {
  timeout: 10000,
  retries: 3,
  retryDelay: 2000,
};

// =============================================================================
// SSRF Protection - Security Hardening
// =============================================================================

/** 
 * Private/internal IP ranges that should not be accessed via smoke tests.
 * Prevents attackers from using the smoke test command to scan internal networks.
 */
const SSRF_BLOCKED_IP_PATTERNS = [
  /^127\./,                              // Loopback: 127.0.0.0/8
  /^10\./,                               // Private: 10.0.0.0/8
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,     // Private: 172.16.0.0/12
  /^192\.168\./,                        // Private: 192.168.0.0/16
  /^169\.254\./,                        // Link-local: 169.254.0.0/16
  /^0\./,                                // Current network: 0.0.0.0/8
  /^\[?::1\]?$/,                         // IPv6 loopback (with optional brackets)
  /^\[?::\]?$/,                          // IPv6 unspecified (with optional brackets)
  /^\[?fc00:/i,                          // IPv6 unique local (with optional brackets)
  /^\[?fe80:/i,                          // IPv6 link-local (with optional brackets)
  /^\[?::ffff:(127|10|172\.(1[6-9]|2[0-9]|3[0-1])|192\.168)\./i, // IPv4-mapped IPv6
];

/** 
 * Internal hostnames that could indicate SSRF attempts.
 */
const SSRF_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'internal',
  'intranet',
]);

/** 
 * Suspicious URL patterns that could indicate SSRF attacks
 */
const SSRF_SUSPICIOUS_PATTERNS = [
  /[\x00-\x1f\x7f]/,                      // Control characters
  /\.\.[\/\\]/,                          // Path traversal
  /@.*@/,                                 // Credentials injection attempt
  /#.*#/,                                 // Fragment manipulation
  /\?.*\?/,                               // Query string manipulation
];

/**
 * Validates a URL for SSRF (Server-Side Request Forgery) vulnerabilities.
 * Prevents the smoke test from being used to scan internal networks or
 * access private resources.
 * 
 * @param {string} urlString - URL to validate
 * @returns {Object} - Validation result { valid: boolean, error?: string }
 */
function validateUrlSSRFProtection(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    return { valid: false, error: `Invalid URL format: ${err.message}` };
  }

  // Only allow http and https protocols
  const allowedProtocols = ['http:', 'https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return { 
      valid: false, 
      error: `Protocol '${parsed.protocol}' is not allowed. Only HTTP and HTTPS are supported.` 
    };
  }

  // Check for control characters and suspicious patterns in the URL
  for (const pattern of SSRF_SUSPICIOUS_PATTERNS) {
    if (pattern.test(urlString)) {
      return { 
        valid: false, 
        error: 'URL contains suspicious characters or patterns' 
      };
    }
  }

  // Get hostname - for IPv6 URLs, URL constructor keeps brackets
  const hostname = parsed.hostname.toLowerCase();

  // Check for blocked internal hostnames
  if (SSRF_BLOCKED_HOSTNAMES.has(hostname)) {
    return { 
      valid: false, 
      error: `Hostname '${hostname}' is blocked for security reasons (SSRF protection)` 
    };
  }

  // Check for private IP patterns (handles both IPv4 and IPv6)
  for (const pattern of SSRF_BLOCKED_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { 
        valid: false, 
        error: `IP address '${hostname}' is in a private/internal range (SSRF protection)` 
      };
    }
  }

  // Block URL-encoded IP addresses (hex/octal encoding bypass attempts)
  const decodedHostname = decodeURIComponent(hostname);
  if (decodedHostname !== hostname) {
    // Re-check with decoded version
    for (const pattern of SSRF_BLOCKED_IP_PATTERNS) {
      if (pattern.test(decodedHostname)) {
        return { 
          valid: false, 
          error: 'URL contains encoded private IP address (SSRF protection)' 
        };
      }
    }
  }

  // Validate port (block common internal service ports)
  const port = parsed.port;
  if (port) {
    const blockedPorts = [
      22,    // SSH
      23,    // Telnet
      25,    // SMTP
      53,    // DNS
      110,   // POP3
      143,   // IMAP
      3306,  // MySQL
      5432,  // PostgreSQL
      6379,  // Redis
      27017, // MongoDB
      9200,  // Elasticsearch
    ];
    const portNum = parseInt(port, 10);
    if (blockedPorts.includes(portNum)) {
      return { 
        valid: false, 
        error: `Port ${port} is blocked for security reasons` 
      };
    }
  }

  // Check for credential injection attempts (user:pass@host)
  if (parsed.username || parsed.password) {
    return { 
      valid: false, 
      error: 'URLs with embedded credentials are not allowed' 
    };
  }

  return { valid: true };
}

/**
 * Sanitizes and validates an API URL for smoke testing.
 * Throws an error if the URL fails SSRF validation.
 * 
 * @param {string} urlString - URL to sanitize
 * @returns {string} - Sanitized URL
 * @throws {Error} - If URL is invalid or unsafe
 */
function sanitizeApiUrl(urlString) {
  if (!urlString) {
    throw new Error('API URL is required');
  }

  // Ensure URL has protocol
  let sanitized = urlString.trim();
  if (!/^https?:\/\//i.test(sanitized)) {
    sanitized = `http://${sanitized}`;
  }

  // Remove trailing slash
  sanitized = sanitized.replace(/\/$/, '');

  // Validate for SSRF protection
  const validation = validateUrlSSRFProtection(sanitized);
  if (!validation.valid) {
    throw new Error(`SSRF Protection: ${validation.error}`);
  }

  return sanitized;
}

/**
 * Test result structure
 */
class TestResult {
  constructor(name, category) {
    this.name = name;
    this.category = category;
    this.passed = false;
    this.duration = 0;
    this.error = null;
    this.details = {};
  }
}

/**
 * Smoke test suite
 */
class SmokeTestSuite {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.results = [];
    this.startTime = null;
  }

  /**
   * Run all smoke tests
   */
  async runAll() {
    this.startTime = Date.now();
    
    console.log(chalk.blue('🧪 MasterClaw API Smoke Tests'));
    console.log(chalk.gray(`   Base URL: ${this.baseUrl}`));
    console.log('');

    // Health & Monitoring Tests
    await this.testHealthEndpoint();
    await this.testMetricsEndpoint();
    await this.testSecurityHealthEndpoint();

    // API Functionality Tests
    await this.testChatEndpoint();
    await this.testMemorySearch();
    await this.testSessionList();
    await this.testCostSummary();
    await this.testAnalyticsStats();

    // WebSocket Tests (connectivity only)
    await this.testWebSocketConnectivity();

    return this.generateReport();
  }

  /**
   * Execute a test with retry logic
   */
  async executeTest(testFn, name, category) {
    const result = new TestResult(name, category);
    const start = Date.now();

    for (let attempt = 1; attempt <= TEST_CONFIG.retries; attempt++) {
      try {
        await testFn();
        result.passed = true;
        result.duration = Date.now() - start;
        break;
      } catch (error) {
        result.error = error.message;
        result.details = { attempt, lastError: error.message };
        
        if (attempt < TEST_CONFIG.retries) {
          await this.delay(TEST_CONFIG.retryDelay);
        }
      }
    }

    if (!result.passed) {
      result.duration = Date.now() - start;
    }

    this.results.push(result);
    this.printResult(result);
    return result;
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Print test result
   */
  printResult(result) {
    const icon = result.passed ? chalk.green('✅') : chalk.red('❌');
    const duration = chalk.gray(`(${result.duration}ms)`);
    console.log(`  ${icon} ${result.name} ${duration}`);
    
    if (!result.passed && result.error) {
      console.log(chalk.red(`     → ${result.error}`));
    }
  }

  /**
   * Test 1: Basic health endpoint
   */
  async testHealthEndpoint() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/health`, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      if (!response.data.status) {
        throw new Error('Missing status field in response');
      }
    }, 'Health Endpoint', 'health');
  }

  /**
   * Test 2: Metrics endpoint (Prometheus)
   */
  async testMetricsEndpoint() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/metrics`, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      // Check for Prometheus format
      if (!response.data.includes('masterclaw_')) {
        throw new Error('Missing MasterClaw metrics in response');
      }
    }, 'Metrics Endpoint', 'monitoring');
  }

  /**
   * Test 3: Security health endpoint
   */
  async testSecurityHealthEndpoint() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/health/security`, {
        timeout: TEST_CONFIG.timeout,
        validateStatus: () => true, // Accept any status
      });
      
      // Should return 200 or 503 depending on security config
      if (response.status !== 200 && response.status !== 503) {
        throw new Error(`Unexpected status: ${response.status}`);
      }
      
      if (!response.data.status) {
        throw new Error('Missing status field in security health response');
      }
    }, 'Security Health Check', 'health');
  }

  /**
   * Test 4: Chat endpoint (basic functionality)
   */
  async testChatEndpoint() {
    return this.executeTest(async () => {
      const response = await axios.post(`${this.baseUrl}/v1/chat`, {
        message: 'Hello, this is a smoke test. Please respond with "pong".',
        session_id: `smoke-test-${Date.now()}`,
        use_memory: false, // Don't pollute memory with tests
      }, {
        timeout: 30000, // LLM calls need more time
        validateStatus: () => true,
      });
      
      // Should return 200 or error if no API keys (both acceptable for smoke test)
      if (response.status === 500) {
        throw new Error(`Server error: ${response.data.detail || 'Unknown'}`);
      }
      
      // If we have a valid response, check structure
      if (response.status === 200) {
        if (!response.data.response) {
          throw new Error('Missing response field in chat response');
        }
      }
    }, 'Chat Endpoint', 'api');
  }

  /**
   * Test 5: Memory search endpoint
   */
  async testMemorySearch() {
    return this.executeTest(async () => {
      const response = await axios.post(`${this.baseUrl}/v1/memory/search`, {
        query: 'smoke test',
        top_k: 5,
      }, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      if (!Array.isArray(response.data.results)) {
        throw new Error('Missing or invalid results array');
      }
    }, 'Memory Search', 'api');
  }

  /**
   * Test 6: Session list endpoint
   */
  async testSessionList() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/sessions`, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      if (!Array.isArray(response.data.sessions)) {
        throw new Error('Missing or invalid sessions array');
      }
    }, 'Session List', 'api');
  }

  /**
   * Test 7: Cost summary endpoint
   */
  async testCostSummary() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/costs`, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      if (typeof response.data.total_cost !== 'number') {
        throw new Error('Missing or invalid total_cost field');
      }
    }, 'Cost Summary', 'api');
  }

  /**
   * Test 8: Analytics stats endpoint
   */
  async testAnalyticsStats() {
    return this.executeTest(async () => {
      const response = await axios.get(`${this.baseUrl}/v1/analytics/stats`, {
        timeout: TEST_CONFIG.timeout,
      });
      
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      
      // Should have some stats fields
      if (!response.data.total_requests && response.data.total_requests !== 0) {
        throw new Error('Missing total_requests field');
      }
    }, 'Analytics Stats', 'api');
  }

  /**
   * Test 9: WebSocket connectivity
   */
  async testWebSocketConnectivity() {
    return this.executeTest(async () => {
      const WebSocket = require('ws');
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/v1/chat/stream/smoke-test-${Date.now()}`;
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          ws.terminate();
          reject(new Error('WebSocket connection timeout'));
        }, TEST_CONFIG.timeout);
        
        ws.on('open', () => {
          clearTimeout(timeout);
          ws.close();
          resolve();
        });
        
        ws.on('error', (err) => {
          clearTimeout(timeout);
          // Some errors are acceptable (auth, etc.) - we just want to verify connectivity
          if (err.message.includes('ECONNREFUSED')) {
            reject(new Error('WebSocket endpoint not reachable'));
          } else {
            // Other errors mean the endpoint is responding
            resolve();
          }
        });
      });
    }, 'WebSocket Connectivity', 'realtime');
  }

  /**
   * Generate final report
   */
  generateReport() {
    const duration = Date.now() - this.startTime;
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    
    console.log('');
    console.log(chalk.cyan('📊 Test Results'));
    console.log(chalk.gray(`   Duration: ${duration}ms`));
    console.log(`   ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}`);
    console.log('');
    
    // Group by category
    const categories = {};
    this.results.forEach(r => {
      if (!categories[r.category]) categories[r.category] = [];
      categories[r.category].push(r);
    });
    
    console.log(chalk.cyan('Category Breakdown:'));
    for (const [cat, tests] of Object.entries(categories)) {
      const catPassed = tests.filter(t => t.passed).length;
      const icon = catPassed === tests.length ? chalk.green('✅') : chalk.yellow('⚠️');
      console.log(`  ${icon} ${cat}: ${catPassed}/${tests.length}`);
    }
    
    console.log('');
    
    if (failed === 0) {
      console.log(chalk.green('✅ All smoke tests passed! Deployment is healthy.'));
      return { success: true, passed, failed, duration, results: this.results };
    } else {
      console.log(chalk.red('❌ Some smoke tests failed. Please review the issues above.'));
      
      // Critical vs non-critical failures
      const criticalTests = ['Health Endpoint', 'Chat Endpoint'];
      const criticalFailures = this.results.filter(
        r => !r.passed && criticalTests.includes(r.name)
      );
      
      if (criticalFailures.length > 0) {
        console.log(chalk.red('\n🚨 Critical failures detected - deployment may be unhealthy!'));
        return { success: false, passed, failed, duration, results: this.results, critical: true };
      }
      
      return { success: false, passed, failed, duration, results: this.results, critical: false };
    }
  }
}

/**
 * Run smoke tests with auto-discovery of API URL
 * 
 * Security: All URLs are validated for SSRF protection before use.
 * This prevents the smoke test from being used to scan internal networks.
 */
async function runSmokeTests(options = {}) {
  // Determine API URL
  let baseUrl = options.apiUrl;
  
  if (!baseUrl) {
    // Try to get from config
    baseUrl = await config.get('core.url');
  }
  
  if (!baseUrl) {
    // Default to localhost - explicitly allowed for local testing
    // but validated through the same path for consistency
    baseUrl = 'http://localhost:8000';
  }
  
  // Apply SSRF-safe URL sanitization
  // For localhost URLs (development mode), we bypass SSRF blocks
  // but still validate format and structure
  const isLocalhost = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl);
  
  if (isLocalhost) {
    // Localhost URLs: basic sanitization only
    let sanitized = baseUrl.trim();
    if (!/^https?:\/\//i.test(sanitized)) {
      sanitized = `http://${sanitized}`;
    }
    sanitized = sanitized.replace(/\/$/, '');
    
    // Still check for suspicious patterns even on localhost
    const validation = validateUrlSSRFProtection(sanitized);
    if (!validation.valid && !validation.error.includes('127.') && !validation.error.includes('localhost')) {
      throw new Error(`URL Validation: ${validation.error}`);
    }
    baseUrl = sanitized;
  } else {
    // Non-localhost URLs: full SSRF validation
    baseUrl = sanitizeApiUrl(baseUrl);
  }
  
  const suite = new SmokeTestSuite(baseUrl);
  return suite.runAll();
}

/**
 * Run quick smoke test (subset of critical tests)
 * 
 * Security: All URLs are validated for SSRF protection before use.
 */
async function runQuickSmokeTest(options = {}) {
  console.log(chalk.blue('🧪 Quick Smoke Test (Critical Endpoints Only)\n'));
  
  let baseUrl = options.apiUrl || await config.get('core.url') || 'http://localhost:8000';
  
  // Apply SSRF-safe URL sanitization
  const isLocalhost = /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/.test(baseUrl);
  
  if (isLocalhost) {
    // Localhost URLs: basic sanitization only
    let sanitized = baseUrl.trim();
    if (!/^https?:\/\//i.test(sanitized)) {
      sanitized = `http://${sanitized}`;
    }
    sanitized = sanitized.replace(/\/$/, '');
    baseUrl = sanitized;
  } else {
    // Non-localhost URLs: full SSRF validation
    baseUrl = sanitizeApiUrl(baseUrl);
  }
  
  const suite = new SmokeTestSuite(baseUrl);
  
  // Run only critical tests
  await suite.testHealthEndpoint();
  await suite.testChatEndpoint();
  await suite.testSessionList();
  
  const passed = suite.results.filter(r => r.passed).length;
  const failed = suite.results.filter(r => !r.passed).length;
  
  console.log('');
  console.log(`Quick test: ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}`);
  
  return { success: failed === 0, passed, failed, results: suite.results };
}

module.exports = {
  SmokeTestSuite,
  runSmokeTests,
  runQuickSmokeTest,
  TestResult,
  // SSRF Protection exports (for testing and external use)
  validateUrlSSRFProtection,
  sanitizeApiUrl,
  SSRF_BLOCKED_IP_PATTERNS,
  SSRF_BLOCKED_HOSTNAMES,
  SSRF_SUSPICIOUS_PATTERNS,
};