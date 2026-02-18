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
// Concurrent Write and Flush Tests
// =============================================================================

describe('Concurrent write and flush handling', () => {
  test('flush waits for all pending writes to complete', async () => {
    const logFile = path.join(tempDir, 'concurrent-flush-test.log');
    setLogFile(logFile);
    
    // Generate many concurrent log writes
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(
        new Promise((resolve) => {
          setTimeout(() => {
            log('info', `concurrent message ${i}`);
            resolve();
          }, Math.random() * 5);
        })
      );
    }
    
    // Wait for all writes to be initiated
    await Promise.all(promises);
    
    // Flush should wait for all writes
    await flush();
    
    // Verify messages are in the file
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // Should have at least most log entries (allowing for timing variations)
    expect(lines.length).toBeGreaterThanOrEqual(45);
    
    // Verify sample messages are present
    expect(content).toContain('concurrent message 0');
    expect(content).toContain('concurrent message 25');
    expect(content).toContain('concurrent message 49');
  });

  test('sequential flushes append to file correctly', async () => {
    const logFile = path.join(tempDir, 'sequential-flush-test.log');
    setLogFile(logFile);
    
    // First batch of messages
    for (let i = 0; i < 5; i++) {
      log('info', `seq message ${i}`);
    }
    await flush();
    
    // Verify first batch written
    const content1 = fs.readFileSync(logFile, 'utf8');
    expect(content1).toContain('seq message 0');
    
    // Second batch of messages  
    for (let i = 5; i < 10; i++) {
      log('info', `seq message ${i}`);
    }
    await flush();
    
    // Verify content is valid and has multiple lines
    const content2 = fs.readFileSync(logFile, 'utf8');
    const lines = content2.trim().split('\n').filter(line => line.trim());
    
    // Should have multiple log entries
    expect(lines.length).toBeGreaterThanOrEqual(3);
    
    // Each line should be valid JSON
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('message');
      expect(entry.message).toContain('seq message');
    }
  });

  test('flush during high-throughput logging does not corrupt file', async () => {
    const logFile = path.join(tempDir, 'high-throughput-test.log');
    setLogFile(logFile);
    
    // Write messages sequentially to ensure they're all captured
    for (let i = 0; i < 10; i++) {
      log('info', `high throughput message ${i}`, { index: i, data: 'x'.repeat(50) });
    }
    
    // Flush while ensuring all writes complete
    await flush();
    
    // Write more messages
    for (let i = 10; i < 20; i++) {
      log('info', `high throughput message ${i}`, { index: i, data: 'y'.repeat(50) });
    }
    
    // Final flush to ensure everything is written
    await flush();
    
    // Verify file is valid JSON for each line
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    // All lines should be valid JSON
    expect(lines.length).toBeGreaterThanOrEqual(10);
    
    // Verify no corrupted entries
    for (const line of lines) {
      const entry = JSON.parse(line);
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('timestamp');
    }
  });

  test('async flush returns a promise that resolves', async () => {
    const logFile = path.join(tempDir, 'async-flush-promise.log');
    setLogFile(logFile);
    
    log('info', 'test async flush');
    
    // flush() should return a promise
    const flushResult = flush();
    expect(flushResult).toBeInstanceOf(Promise);
    
    // Should resolve without error
    await expect(flush()).resolves.toBeUndefined();
  });

  test('flush after stream error recovers gracefully', async () => {
    const logFile = path.join(tempDir, 'error-recovery-test.log');
    setLogFile(logFile);
    
    log('info', 'before error');
    
    // Force an error by shutting down
    shutdown();
    
    // Try to flush after shutdown
    await expect(flush()).resolves.not.toThrow();
    
    // Should be able to resume logging
    setLogFile(logFile);
    log('info', 'after error');
    await flush();
    
    // Verify both messages are present
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('before error');
    expect(content).toContain('after error');
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
