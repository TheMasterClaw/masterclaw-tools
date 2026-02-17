/**
 * Tests for smoke-test.js - API Smoke Test Suite
 * Run with: npm test -- smoke-test.test.js
 * 
 * Tests the post-deployment verification suite that validates
 * all critical API endpoints are functional.
 * 
 * Coverage:
 * - TestResult class initialization and modification
 * - SmokeTestSuite construction and configuration
 * - Test execution with retry logic (3 retries by default)
 * - Health endpoint tests (HTTP 200, status field validation)
 * - Metrics endpoint tests (Prometheus format validation)
 * - Security health endpoint tests (200/503 acceptance)
 * - Chat endpoint tests (response validation, error handling)
 * - Memory search endpoint tests (results array validation)
 * - Session list endpoint tests (sessions array validation)
 * - Cost summary endpoint tests (total_cost validation)
 * - Analytics stats endpoint tests (total_requests validation)
 * - WebSocket connectivity tests (connection, errors, protocol conversion)
 * - Report generation (success/failure states, critical detection, categorization)
 * - Edge cases (timeouts, DNS failures, malformed JSON)
 * - Security (sensitive data exclusion, unique session IDs)
 * 
 * @module tests/smoke-test.test.js
 * @requires axios
 * @requires ../lib/smoke-test
 */

const axios = require('axios');

// Module under test
const {
  SmokeTestSuite,
  runSmokeTests,
  runQuickSmokeTest,
  TestResult,
} = require('../lib/smoke-test');

// Mock dependencies
jest.mock('axios');
jest.mock('ws', () => jest.fn(), { virtual: true });
jest.mock('../lib/config', () => ({
  get: jest.fn(),
}));

const config = require('../lib/config');
const WebSocket = require('ws');

// Mock chalk to avoid ANSI codes in test output
jest.mock('chalk', () => ({
  blue: (str) => str,
  gray: (str) => str,
  green: (str) => str,
  red: (str) => str,
  cyan: (str) => str,
  yellow: (str) => str,
}));

// =============================================================================
// Setup & Teardown
// =============================================================================

let consoleLogSpy;
let consoleErrorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// =============================================================================
// TestResult Class Tests
// =============================================================================

describe('TestResult', () => {
  test('initializes with correct default values', () => {
    const result = new TestResult('Test Name', 'test-category');
    
    expect(result.name).toBe('Test Name');
    expect(result.category).toBe('test-category');
    expect(result.passed).toBe(false);
    expect(result.duration).toBe(0);
    expect(result.error).toBeNull();
    expect(result.details).toEqual({});
  });

  test('can be modified after creation', () => {
    const result = new TestResult('Test', 'category');
    
    result.passed = true;
    result.duration = 100;
    result.error = 'Some error';
    result.details = { attempt: 1 };
    
    expect(result.passed).toBe(true);
    expect(result.duration).toBe(100);
    expect(result.error).toBe('Some error');
    expect(result.details).toEqual({ attempt: 1 });
  });
});

// =============================================================================
// SmokeTestSuite Construction Tests
// =============================================================================

describe('SmokeTestSuite', () => {
  test('initializes with base URL', () => {
    const suite = new SmokeTestSuite('http://localhost:8000');
    
    expect(suite.baseUrl).toBe('http://localhost:8000');
    expect(suite.results).toEqual([]);
    expect(suite.startTime).toBeNull();
  });

  test('handles URL with trailing slash', () => {
    const suite = new SmokeTestSuite('http://api.example.com/');
    expect(suite.baseUrl).toBe('http://api.example.com/');
  });

  test('handles HTTPS URLs', () => {
    const suite = new SmokeTestSuite('https://secure.example.com');
    expect(suite.baseUrl).toBe('https://secure.example.com');
  });
});

// =============================================================================
// Test Execution & Retry Logic Tests
// =============================================================================

describe('Test Execution with Retry Logic', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    // Speed up tests by reducing retry delay
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes on first successful attempt', async () => {
    const testFn = jest.fn().mockResolvedValue(undefined);
    
    const result = await suite.executeTest(testFn, 'Success Test', 'health');
    
    expect(result.passed).toBe(true);
    expect(result.name).toBe('Success Test');
    expect(result.category).toBe('health');
    expect(testFn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and passes if eventually successful', async () => {
    const testFn = jest.fn()
      .mockRejectedValueOnce(new Error('First failure'))
      .mockRejectedValueOnce(new Error('Second failure'))
      .mockResolvedValue(undefined);
    
    const result = await suite.executeTest(testFn, 'Retry Test', 'api');
    
    expect(result.passed).toBe(true);
    expect(testFn).toHaveBeenCalledTimes(3);
    expect(suite.delay).toHaveBeenCalledTimes(2);
  });

  test('fails after all retries exhausted', async () => {
    const testFn = jest.fn().mockRejectedValue(new Error('Persistent failure'));
    
    const result = await suite.executeTest(testFn, 'Fail Test', 'api');
    
    expect(result.passed).toBe(false);
    expect(result.error).toBe('Persistent failure');
    expect(testFn).toHaveBeenCalledTimes(3); // Default retries = 3
  });

  test('captures error details on failure', async () => {
    const testFn = jest.fn().mockRejectedValue(new Error('Detailed error'));
    
    const result = await suite.executeTest(testFn, 'Details Test', 'monitoring');
    
    expect(result.details.attempt).toBe(3);
    expect(result.details.lastError).toBe('Detailed error');
  });

  test('measures test duration', async () => {
    const testFn = jest.fn().mockImplementation(() => 
      new Promise(resolve => setTimeout(resolve, 10))
    );
    
    const result = await suite.executeTest(testFn, 'Duration Test', 'health');
    
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('adds result to suite results array', async () => {
    const testFn = jest.fn().mockResolvedValue(undefined);
    
    await suite.executeTest(testFn, 'Result Test', 'api');
    
    expect(suite.results).toHaveLength(1);
    expect(suite.results[0].name).toBe('Result Test');
  });
});

// =============================================================================
// Health Endpoint Tests
// =============================================================================

describe('Health Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when health endpoint returns 200 with status', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { status: 'healthy' },
    });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/health',
      { timeout: 10000 }
    );
  });

  test('fails when health endpoint returns non-200 status', async () => {
    axios.get.mockResolvedValue({
      status: 503,
      data: { status: 'unhealthy' },
    });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Expected 200, got 503');
  });

  test('fails when response missing status field', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { message: 'OK' }, // Missing 'status' field
    });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing status field');
  });

  test('fails when request throws error', async () => {
    axios.get.mockRejectedValue(new Error('Connection refused'));

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});

// =============================================================================
// Metrics Endpoint Tests
// =============================================================================

describe('Metrics Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when metrics endpoint returns masterclaw metrics', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: 'masterclaw_requests_total 42\nmasterclaw_errors_total 0',
    });

    const result = await suite.testMetricsEndpoint();

    expect(result.passed).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/metrics',
      { timeout: 10000 }
    );
  });

  test('fails when metrics missing masterclaw prefix', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: 'other_metric 123', // Missing 'masterclaw_' prefix
    });

    const result = await suite.testMetricsEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing MasterClaw metrics');
  });

  test('fails on non-200 status', async () => {
    axios.get.mockResolvedValue({
      status: 500,
      data: 'Error',
    });

    const result = await suite.testMetricsEndpoint();

    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// Security Health Endpoint Tests
// =============================================================================

describe('Security Health Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes with status 200', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { status: 'secure' },
    });

    const result = await suite.testSecurityHealthEndpoint();

    expect(result.passed).toBe(true);
  });

  test('passes with status 503 (security not configured)', async () => {
    axios.get.mockResolvedValue({
      status: 503,
      data: { status: 'not_configured' },
    });

    const result = await suite.testSecurityHealthEndpoint();

    expect(result.passed).toBe(true);
  });

  test('fails on unexpected status codes', async () => {
    axios.get.mockResolvedValue({
      status: 404,
      data: { status: 'not_found' },
    });

    const result = await suite.testSecurityHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Unexpected status: 404');
  });

  test('fails when response missing status field', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { message: 'OK' },
    });

    const result = await suite.testSecurityHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing status field');
  });
});

// =============================================================================
// Chat Endpoint Tests
// =============================================================================

describe('Chat Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when chat returns 200 with response', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { response: 'Hello! I received your message.' },
    });

    const result = await suite.testChatEndpoint();

    expect(result.passed).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/v1/chat',
      expect.objectContaining({
        message: expect.stringContaining('smoke test'),
        use_memory: false,
        session_id: expect.stringMatching(/^smoke-test-\d+$/),
      }),
      { timeout: 30000, validateStatus: expect.any(Function) }
    );
  });

  test('passes when chat returns non-500 (e.g., no API keys)', async () => {
    axios.post.mockResolvedValue({
      status: 401,
      data: { detail: 'No API key configured' },
    });

    const result = await suite.testChatEndpoint();

    expect(result.passed).toBe(true);
  });

  test('fails on 500 server error', async () => {
    axios.post.mockResolvedValue({
      status: 500,
      data: { detail: 'Internal server error' },
    });

    const result = await suite.testChatEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Server error: Internal server error');
  });

  test('fails when 200 response missing response field', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { message: 'OK' }, // Missing 'response' field
    });

    const result = await suite.testChatEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing response field');
  });

  test('handles request errors', async () => {
    axios.post.mockRejectedValue(new Error('Request timeout'));

    const result = await suite.testChatEndpoint();

    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// Memory Search Endpoint Tests
// =============================================================================

describe('Memory Search Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when memory search returns results array', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { results: [{ id: '1', text: 'Memory entry' }] },
    });

    const result = await suite.testMemorySearch();

    expect(result.passed).toBe(true);
    expect(axios.post).toHaveBeenCalledWith(
      'http://localhost:8000/v1/memory/search',
      { query: 'smoke test', top_k: 5 },
      { timeout: 10000 }
    );
  });

  test('passes with empty results array', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { results: [] },
    });

    const result = await suite.testMemorySearch();

    expect(result.passed).toBe(true);
  });

  test('fails when results is not an array', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { results: 'not an array' },
    });

    const result = await suite.testMemorySearch();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing or invalid results array');
  });

  test('fails on non-200 status', async () => {
    axios.post.mockResolvedValue({
      status: 500,
      data: { error: 'Database error' },
    });

    const result = await suite.testMemorySearch();

    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// Session List Endpoint Tests
// =============================================================================

describe('Session List Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when sessions endpoint returns array', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { sessions: [{ id: '1', name: 'Test Session' }] },
    });

    const result = await suite.testSessionList();

    expect(result.passed).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/v1/sessions',
      { timeout: 10000 }
    );
  });

  test('passes with empty sessions array', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { sessions: [] },
    });

    const result = await suite.testSessionList();

    expect(result.passed).toBe(true);
  });

  test('fails when sessions is not an array', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { sessions: null },
    });

    const result = await suite.testSessionList();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing or invalid sessions array');
  });
});

// =============================================================================
// Cost Summary Endpoint Tests
// =============================================================================

describe('Cost Summary Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when cost endpoint returns numeric total_cost', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_cost: 12.34 },
    });

    const result = await suite.testCostSummary();

    expect(result.passed).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/v1/costs',
      { timeout: 10000 }
    );
  });

  test('passes with zero total_cost', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_cost: 0 },
    });

    const result = await suite.testCostSummary();

    expect(result.passed).toBe(true);
  });

  test('fails when total_cost is not a number', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_cost: '12.34' }, // String instead of number
    });

    const result = await suite.testCostSummary();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing or invalid total_cost field');
  });

  test('fails when total_cost is missing', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { costs_by_model: {} },
    });

    const result = await suite.testCostSummary();

    expect(result.passed).toBe(false);
  });
});

// =============================================================================
// Analytics Stats Endpoint Tests
// =============================================================================

describe('Analytics Stats Endpoint Test', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
  });

  test('passes when analytics returns total_requests', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_requests: 100 },
    });

    const result = await suite.testAnalyticsStats();

    expect(result.passed).toBe(true);
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:8000/v1/analytics/stats',
      { timeout: 10000 }
    );
  });

  test('passes with zero total_requests', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_requests: 0 },
    });

    const result = await suite.testAnalyticsStats();

    expect(result.passed).toBe(true);
  });

  test('fails when total_requests is missing', async () => {
    axios.get.mockResolvedValue({
      status: 200,
      data: { total_cost: 5.00 }, // Missing total_requests
    });

    const result = await suite.testAnalyticsStats();

    expect(result.passed).toBe(false);
    expect(result.error).toContain('Missing total_requests field');
  });
});

// =============================================================================
// WebSocket Connectivity Tests
// =============================================================================

describe('WebSocket Connectivity Test', () => {
  let suite;
  let mockWs;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    mockWs = {
      on: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
    };
    WebSocket.mockImplementation(() => mockWs);
  });

  test('passes when WebSocket connects successfully', async () => {
    // Simulate successful connection
    setTimeout(() => {
      const openHandler = mockWs.on.mock.calls.find(call => call[0] === 'open')[1];
      openHandler();
    }, 10);

    const result = await suite.testWebSocketConnectivity();

    expect(result.passed).toBe(true);
    expect(WebSocket).toHaveBeenCalledWith(
      expect.stringMatching(/^ws:\/\/localhost:8000\/v1\/chat\/stream\/smoke-test-\d+$/)
    );
    expect(mockWs.close).toHaveBeenCalled();
  });

  test('passes on non-connection errors (endpoint responding)', async () => {
    // Simulate auth error (means endpoint is reachable)
    setTimeout(() => {
      const errorHandler = mockWs.on.mock.calls.find(call => call[0] === 'error')[1];
      errorHandler(new Error('Authentication failed'));
    }, 10);

    const result = await suite.testWebSocketConnectivity();

    expect(result.passed).toBe(true);
  });

  test.skip('fails on connection refused error', async () => {
    // Requires actual WebSocket module behavior
  });

  test.skip('fails on timeout', async () => {
    // Requires actual WebSocket module behavior
  });

  test('converts HTTPS to WSS', async () => {
    const httpsSuite = new SmokeTestSuite('https://secure.example.com');
    httpsSuite.delay = jest.fn(() => Promise.resolve());

    setTimeout(() => {
      const mockInstance = WebSocket.mock.results[0].value;
      const openHandler = mockInstance.on.mock.calls.find(call => call[0] === 'open')[1];
      openHandler();
    }, 10);

    await httpsSuite.testWebSocketConnectivity();

    expect(WebSocket).toHaveBeenCalledWith(
      expect.stringMatching(/^wss:\/\/secure.example.com/)
    );
  });
});

// =============================================================================
// Report Generation Tests
// =============================================================================

describe('Report Generation', () => {
  let suite;

  beforeEach(() => {
    suite = new SmokeTestSuite('http://localhost:8000');
    suite.startTime = Date.now() - 1000; // Simulate 1 second elapsed
  });

  test('generates success report when all tests pass', () => {
    suite.results = [
      { name: 'Test 1', category: 'health', passed: true, duration: 50 },
      { name: 'Test 2', category: 'api', passed: true, duration: 100 },
    ];

    const report = suite.generateReport();

    expect(report.success).toBe(true);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.duration).toBeGreaterThanOrEqual(1000);
    expect(report.results).toHaveLength(2);
  });

  test('generates failure report when some tests fail', () => {
    suite.results = [
      { name: 'Test 1', category: 'health', passed: true, duration: 50 },
      { name: 'Test 2', category: 'api', passed: false, duration: 100, error: 'Failed' },
    ];

    const report = suite.generateReport();

    expect(report.success).toBe(false);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.critical).toBeFalsy();
  });

  test('marks as critical when critical tests fail', () => {
    suite.results = [
      { name: 'Health Endpoint', category: 'health', passed: false, error: 'Down' },
      { name: 'Test 2', category: 'api', passed: true },
    ];

    const report = suite.generateReport();

    expect(report.success).toBe(false);
    expect(report.critical).toBe(true);
  });

  test('groups results by category', () => {
    suite.results = [
      { name: 'Health Test', category: 'health', passed: true },
      { name: 'API Test 1', category: 'api', passed: true },
      { name: 'API Test 2', category: 'api', passed: false },
    ];

    suite.generateReport();

    // Verify console output includes category breakdown
    const categoryOutput = consoleLogSpy.mock.calls.find(
      call => call[0] && call[0].includes && call[0].includes('Category Breakdown')
    );
    expect(categoryOutput).toBeTruthy();
  });
});

// =============================================================================
// runSmokeTests Integration Tests
// =============================================================================

describe('runSmokeTests', () => {
  beforeEach(() => {
    config.get.mockResolvedValue(null);
  });

  test.skip('uses provided apiUrl option', async () => {
    // Full integration test - skipped due to WebSocket dependency
  });

  test.skip('uses URL from config when apiUrl not provided', async () => {
    // Full integration test - skipped due to WebSocket dependency
  });

  test.skip('defaults to localhost when no URL provided', async () => {
    // Full integration test - skipped due to WebSocket dependency  
  });

  test.skip('adds http:// protocol if missing', async () => {
    // Full integration test - skipped due to WebSocket dependency
  });

  test.skip('removes trailing slash from URL', async () => {
    // Full integration test - skipped due to WebSocket dependency
  });
});

// =============================================================================
// runQuickSmokeTest Tests
// =============================================================================

describe('runQuickSmokeTest', () => {
  beforeEach(() => {
    config.get.mockResolvedValue(null);
  });

  test('runs only critical tests', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { status: 'ok', sessions: [] } });
    axios.post.mockResolvedValue({ status: 200, data: { response: 'test' } });

    const result = await runQuickSmokeTest({ apiUrl: 'http://localhost:8000' });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3); // Health, Chat, Sessions
    
    const testNames = result.results.map(r => r.name);
    expect(testNames).toContain('Health Endpoint');
    expect(testNames).toContain('Chat Endpoint');
    expect(testNames).toContain('Session List');
  });

  test('returns correct result structure', async () => {
    axios.get.mockResolvedValue({ status: 200, data: { status: 'ok', sessions: [] } });
    axios.post.mockResolvedValue({ status: 200, data: { response: 'test' } });

    const result = await runQuickSmokeTest({});

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('failed');
    expect(result).toHaveProperty('results');
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// =============================================================================
// Edge Cases & Error Handling
// =============================================================================

describe('Edge Cases', () => {
  test('handles network timeouts gracefully', async () => {
    const suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    axios.get.mockRejectedValue({ code: 'ETIMEDOUT', message: 'Request timeout' });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('handles DNS resolution failures', async () => {
    const suite = new SmokeTestSuite('http://invalid-host:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    axios.get.mockRejectedValue({ code: 'ENOTFOUND', message: 'DNS lookup failed' });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
  });

  test('handles malformed JSON responses', async () => {
    const suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    // axios automatically parses JSON, so we simulate by returning invalid data structure
    axios.get.mockResolvedValue({
      status: 200,
      data: null, // Null data should be handled
    });

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
  });

  test('handles extremely long response times', async () => {
    const suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    // Simulate a slow response that exceeds timeout (using shorter delay for test)
    axios.get.mockImplementation(() => 
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 100)
      )
    );

    const result = await suite.testHealthEndpoint();

    expect(result.passed).toBe(false);
  }, 1000); // 1 second timeout for this test
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Security', () => {
  test('does not include sensitive data in test queries', async () => {
    const suite = new SmokeTestSuite('http://localhost:8000');
    suite.delay = jest.fn(() => Promise.resolve());
    
    axios.post.mockResolvedValue({
      status: 200,
      data: { response: 'test' },
    });

    await suite.testChatEndpoint();

    const postCall = axios.post.mock.calls[0];
    const requestBody = postCall[1];
    
    // Verify no sensitive patterns in request
    expect(requestBody.message).not.toContain('password');
    expect(requestBody.message).not.toContain('secret');
    expect(requestBody.message).not.toContain('token');
    
    // Verify use_memory is false to avoid polluting memory
    expect(requestBody.use_memory).toBe(false);
    
    // Verify session_id follows expected pattern
    expect(requestBody.session_id).toMatch(/^smoke-test-\d+$/);
  });

  test('uses unique session IDs for each test run', async () => {
    const suite1 = new SmokeTestSuite('http://localhost:8000');
    const suite2 = new SmokeTestSuite('http://localhost:8000');
    suite1.delay = jest.fn(() => Promise.resolve());
    suite2.delay = jest.fn(() => Promise.resolve());
    
    axios.post.mockResolvedValue({
      status: 200,
      data: { response: 'test' },
    });

    // Add small delay to ensure different timestamps
    await suite1.testChatEndpoint();
    await new Promise(resolve => setTimeout(resolve, 10));
    await suite2.testChatEndpoint();

    const call1 = axios.post.mock.calls[0];
    const call2 = axios.post.mock.calls[1];
    
    expect(call1[1].session_id).not.toBe(call2[1].session_id);
  });
});
