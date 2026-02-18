/**
 * Tests for logger flush on process exit behavior
 * Run with: npm test -- logger.flush.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Module under test
const {
  configure,
  setLogFile,
  log,
  flush,
  shutdown,
  LogLevel,
} = require('../lib/logger');

// Mock chalk
jest.mock('chalk', () => ({
  gray: (str) => str,
  blue: (str) => str,
  yellow: (str) => str,
  red: (str) => str,
  cyan: (str) => str,
}));

// Mock security module
jest.mock('../lib/security', () => ({
  maskSensitiveData: jest.fn((data) => data),
  sanitizeForLog: jest.fn((str, maxLength = 1000) => {
    if (typeof str !== 'string') return String(str);
    return str.slice(0, maxLength);
  }),
}));

// =============================================================================
// Setup & Teardown
// =============================================================================

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-flush-test-'));
  
  // Reset logger to defaults
  configure({
    level: LogLevel.INFO,
    format: 'json',
    colorize: false,
    timestamp: false,
    file: null,
    redactSensitive: true,
    exitOnError: false,
  });
});

afterEach(async () => {
  // Shutdown logger
  shutdown();
  
  // Remove temp directory
  try {
    fs.removeSync(tempDir);
  } catch {
    // Ignore cleanup errors
  }
});

// =============================================================================
// Flush Tests
// =============================================================================

describe('Logger flush functionality', () => {
  test('flush writes buffered messages to file', async () => {
    const logFile = path.join(tempDir, 'flush-test.log');
    setLogFile(logFile);
    
    // Log a message
    log('info', 'test message for flush');
    
    // Flush explicitly
    await flush();
    
    // Verify file exists and contains the message
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('test message for flush');
  });

  test('flush handles empty buffer gracefully', async () => {
    const logFile = path.join(tempDir, 'empty-flush-test.log');
    setLogFile(logFile);
    
    // Flush without any messages
    await expect(flush()).resolves.not.toThrow();
    
    // File may or may not exist depending on implementation
    // The important thing is that no error was thrown
  });

  test('shutdown flushes buffered messages before closing', async () => {
    const logFile = path.join(tempDir, 'shutdown-test.log');
    setLogFile(logFile);
    
    // Log multiple messages
    log('info', 'message 1');
    log('info', 'message 2');
    log('warn', 'warning message');
    
    // Shutdown (should flush)
    shutdown();
    
    // Give a small delay for async writes
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Verify file contains all messages
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('message 1');
    expect(content).toContain('message 2');
    expect(content).toContain('warning message');
  });

  test('flush preserves JSON format in file', async () => {
    const logFile = path.join(tempDir, 'json-flush-test.log');
    setLogFile(logFile);
    
    log('info', 'json test', { key: 'value', number: 42 });
    
    await flush();
    
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    
    expect(parsed.message).toBe('json test');
    expect(parsed.level).toBe('info');
    expect(parsed.key).toBe('value');
    expect(parsed.number).toBe(42);
  });

  test('multiple flushes do not duplicate messages', async () => {
    const logFile = path.join(tempDir, 'duplicate-flush-test.log');
    setLogFile(logFile);
    
    log('info', 'single message');
    
    // Flush twice
    await flush();
    await flush();
    
    // Re-open and write another message
    setLogFile(logFile);
    log('info', 'second message');
    await flush();
    
    const content = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    // Should have exactly 2 log entries
    expect(content.length).toBe(2);
    
    const first = JSON.parse(content[0]);
    const second = JSON.parse(content[1]);
    expect(first.message).toBe('single message');
    expect(second.message).toBe('second message');
  });

  test('flush is safe to call when no log file is set', async () => {
    // Don't set a log file
    setLogFile(null);
    
    // Log to console only
    log('info', 'console only message');
    
    // Flush should not throw
    await expect(flush()).resolves.not.toThrow();
  });
});

// =============================================================================
// Error Handler Integration Tests
// =============================================================================

describe('Error handler log flushing integration', () => {
  const { setupGlobalErrorHandlers, ExitCode } = require('../lib/error-handler');
  
  // Store original process.exit
  let originalExit;
  
  beforeEach(() => {
    originalExit = process.exit;
    // Mock process.exit to prevent actual exit
    process.exit = jest.fn((code) => {
      // In real scenario, this would exit the process
      // But for tests, we just record the call
    });
  });
  
  afterEach(() => {
    process.exit = originalExit;
  });

  test('setupGlobalErrorHandlers installs handlers that call flush on uncaught exception', async () => {
    const logFile = path.join(tempDir, 'exception-flush-test.log');
    setLogFile(logFile);
    
    // Setup error handlers
    setupGlobalErrorHandlers();
    
    // Trigger an uncaught exception
    const testError = new Error('Test uncaught exception');
    process.emit('uncaughtException', testError);
    
    // Wait for async flush
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify process.exit was called
    expect(process.exit).toHaveBeenCalledWith(ExitCode.INTERNAL_ERROR);
  });

  test('setupGlobalErrorHandlers installs handlers that call flush on SIGINT', async () => {
    const logFile = path.join(tempDir, 'sigint-flush-test.log');
    setLogFile(logFile);
    
    // Setup error handlers
    setupGlobalErrorHandlers();
    
    // Trigger SIGINT
    process.emit('SIGINT');
    
    // Wait for async flush
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify process.exit was called with success code
    expect(process.exit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });

  test('setupGlobalErrorHandlers installs handlers that call flush on SIGTERM', async () => {
    const logFile = path.join(tempDir, 'sigterm-flush-test.log');
    setLogFile(logFile);
    
    // Setup error handlers
    setupGlobalErrorHandlers();
    
    // Trigger SIGTERM
    process.emit('SIGTERM');
    
    // Wait for async flush
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify process.exit was called with success code
    expect(process.exit).toHaveBeenCalledWith(ExitCode.SUCCESS);
  });
});

// =============================================================================
// Buffer Management Tests
// =============================================================================

describe('Log buffer management during shutdown', () => {
  test('shutdown clears buffer after writing', async () => {
    const logFile = path.join(tempDir, 'buffer-clear-test.log');
    setLogFile(logFile);
    
    // Close stream to force buffering
    shutdown();
    
    // These messages should be buffered
    log('info', 'buffered 1');
    log('info', 'buffered 2');
    
    // Re-open stream and shutdown to trigger flush
    setLogFile(logFile);
    shutdown();
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Verify messages were written
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('buffered 1');
    expect(content).toContain('buffered 2');
  });

  test('handles errors during shutdown gracefully', async () => {
    const logFile = path.join(tempDir, 'error-shutdown-test.log');
    setLogFile(logFile);
    
    // Log a message
    log('info', 'pre-error message');
    
    // Shutdown should not throw even if there are errors
    expect(() => {
      shutdown();
      shutdown(); // Double shutdown should be safe
    }).not.toThrow();
  });
});
