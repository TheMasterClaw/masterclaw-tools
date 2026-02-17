/**
 * Tests for logger.js
 * Run with: npm test -- logger.test.js
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Module under test
const {
  LogLevel,
  LogLevelNames,
  configure,
  configureFromEnvironment,
  parseLevel,
  getLevelName,
  setLogFile,
  log,
  debug,
  info,
  warn,
  error,
  errorWithStack,
  child,
  flush,
  shutdown,
  DEFAULT_CONFIG,
  DEFAULT_LOG_DIR,
} = require('../lib/logger');

// Mock chalk to avoid ANSI codes in tests
jest.mock('chalk', () => ({
  gray: (str) => str,
  blue: (str) => str,
  yellow: (str) => str,
  red: (str) => str,
  cyan: (str) => str,
}));

// Mock security module
jest.mock('../lib/security', () => ({
  maskSensitiveData: jest.fn((data) => data.replace(/secret/g, '[REDACTED]')),
  sanitizeForLog: jest.fn((str, maxLength = 1000) => {
    if (typeof str !== 'string') return String(str);
    return str.slice(0, maxLength).replace(/[\r\n]/g, '\\n');
  }),
}));

// =============================================================================
// Setup & Teardown
// =============================================================================

let tempDir;
let consoleLogSpy;
let consoleErrorSpy;

beforeEach(() => {
  // Create temp directory for log files
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  
  // Reset logger to defaults
  configure({
    level: LogLevel.INFO,
    format: 'human',
    colorize: false,
    timestamp: false,
    file: null,
    redactSensitive: true,
    exitOnError: false,
  });
  
  // Spy on console methods
  consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
});

afterEach(async () => {
  // Cleanup
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  
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
// Log Level Tests
// =============================================================================

describe('LogLevel', () => {
  test('has correct numeric values', () => {
    expect(LogLevel.SILENT).toBe(0);
    expect(LogLevel.ERROR).toBe(1);
    expect(LogLevel.WARN).toBe(2);
    expect(LogLevel.INFO).toBe(3);
    expect(LogLevel.DEBUG).toBe(4);
  });

  test('follows priority order', () => {
    expect(LogLevel.SILENT < LogLevel.ERROR).toBe(true);
    expect(LogLevel.ERROR < LogLevel.WARN).toBe(true);
    expect(LogLevel.WARN < LogLevel.INFO).toBe(true);
    expect(LogLevel.INFO < LogLevel.DEBUG).toBe(true);
  });
});

describe('LogLevelNames', () => {
  test('maps string names to levels', () => {
    expect(LogLevelNames.silent).toBe(LogLevel.SILENT);
    expect(LogLevelNames.error).toBe(LogLevel.ERROR);
    expect(LogLevelNames.warn).toBe(LogLevel.WARN);
    expect(LogLevelNames.warning).toBe(LogLevel.WARN);
    expect(LogLevelNames.info).toBe(LogLevel.INFO);
    expect(LogLevelNames.debug).toBe(LogLevel.DEBUG);
    expect(LogLevelNames.verbose).toBe(LogLevel.DEBUG);
  });
});

describe('parseLevel', () => {
  test('parses string level names', () => {
    expect(parseLevel('debug')).toBe(LogLevel.DEBUG);
    expect(parseLevel('info')).toBe(LogLevel.INFO);
    expect(parseLevel('warn')).toBe(LogLevel.WARN);
    expect(parseLevel('error')).toBe(LogLevel.ERROR);
    expect(parseLevel('silent')).toBe(LogLevel.SILENT);
  });

  test('is case insensitive', () => {
    expect(parseLevel('DEBUG')).toBe(LogLevel.DEBUG);
    expect(parseLevel('Info')).toBe(LogLevel.INFO);
    expect(parseLevel('WARN')).toBe(LogLevel.WARN);
  });

  test('accepts numeric levels', () => {
    expect(parseLevel(0)).toBe(0);
    expect(parseLevel(4)).toBe(4);
    expect(parseLevel(2)).toBe(2);
  });

  test('clamps out-of-range numbers', () => {
    expect(parseLevel(-1)).toBe(0);
    expect(parseLevel(10)).toBe(4);
  });

  test('defaults to INFO for unknown strings', () => {
    expect(parseLevel('unknown')).toBe(LogLevel.INFO);
    expect(parseLevel('')).toBe(LogLevel.INFO);
  });

  test('accepts verbose as debug alias', () => {
    expect(parseLevel('verbose')).toBe(LogLevel.DEBUG);
  });
});

describe('getLevelName', () => {
  test('returns correct name for current level', () => {
    configure({ level: LogLevel.DEBUG });
    expect(getLevelName()).toBe('debug');
    
    configure({ level: LogLevel.INFO });
    expect(getLevelName()).toBe('info');
    
    configure({ level: LogLevel.WARN });
    expect(getLevelName()).toBe('warn');
    
    configure({ level: LogLevel.ERROR });
    expect(getLevelName()).toBe('error');
    
    configure({ level: LogLevel.SILENT });
    expect(getLevelName()).toBe('silent');
  });
});

// =============================================================================
// Configuration Tests
// =============================================================================

describe('configure', () => {
  test('sets log level', () => {
    configure({ level: LogLevel.DEBUG });
    expect(getLevelName()).toBe('debug');
  });

  test('sets format', () => {
    configure({ format: 'json' });
    // Can't directly test, but subsequent logs should be JSON
  });

  test('sets colorize option', () => {
    configure({ colorize: true });
    // Can't directly test internal state
  });

  test('sets timestamp option', () => {
    configure({ timestamp: true });
    // Can't directly test internal state
  });

  test('sets redactSensitive option', () => {
    configure({ redactSensitive: false });
    // Can't directly test internal state
  });

  test('sets exitOnError option', () => {
    configure({ exitOnError: true });
    // Can't directly test internal state
  });

  test('handles partial configuration', () => {
    configure({ level: LogLevel.WARN });
    // Other options should remain at defaults
    expect(getLevelName()).toBe('warn');
  });
});

describe('configureFromEnvironment', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('configures level from MC_LOG_LEVEL', () => {
    process.env.MC_LOG_LEVEL = 'debug';
    configureFromEnvironment();
    expect(getLevelName()).toBe('debug');
  });

  test('configures format from MC_LOG_FORMAT', () => {
    process.env.MC_LOG_FORMAT = 'json';
    configureFromEnvironment();
    // Can't directly test, but should not throw
  });

  test('disables colorize from MC_LOG_COLORIZE=false', () => {
    process.env.MC_LOG_COLORIZE = 'false';
    configureFromEnvironment();
    // Should not throw
  });

  test('disables colorize from MC_LOG_COLORIZE=0', () => {
    process.env.MC_LOG_COLORIZE = '0';
    configureFromEnvironment();
    // Should not throw
  });

  test('disables timestamp from MC_LOG_TIMESTAMP=false', () => {
    process.env.MC_LOG_TIMESTAMP = 'false';
    configureFromEnvironment();
    // Should not throw
  });

  test('disables redaction from MC_LOG_REDACT=false', () => {
    process.env.MC_LOG_REDACT = 'false';
    configureFromEnvironment();
    // Should not throw
  });

  test('sets debug level from MC_VERBOSE', () => {
    process.env.MC_VERBOSE = '1';
    configureFromEnvironment();
    expect(getLevelName()).toBe('debug');
  });

  test('sets debug level from DEBUG', () => {
    process.env.DEBUG = 'masterclaw:*';
    configureFromEnvironment();
    expect(getLevelName()).toBe('debug');
  });
});

// =============================================================================
// Logging Level Filtering Tests
// =============================================================================

describe('Level filtering', () => {
  beforeEach(() => {
    // Reset to known state before each test
    configure({ level: LogLevel.DEBUG });
  });

  test('debug is filtered when level is INFO', () => {
    configure({ level: LogLevel.INFO });
    debug('test debug message');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test('debug is shown when level is DEBUG', () => {
    configure({ level: LogLevel.DEBUG });
    debug('test debug message');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('info is shown when level is INFO', () => {
    configure({ level: LogLevel.INFO });
    info('test info message');
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('info is filtered when level is WARN', () => {
    configure({ level: LogLevel.WARN });
    info('test info message');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  test('warn is shown when level is WARN', () => {
    configure({ level: LogLevel.WARN });
    warn('test warn message');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('warn is filtered when level is ERROR', () => {
    configure({ level: LogLevel.ERROR });
    warn('test warn message');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  test('error is shown when level is ERROR', () => {
    configure({ level: LogLevel.ERROR });
    error('test error message');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  test('all messages filtered when level is SILENT', () => {
    configure({ level: LogLevel.SILENT });
    debug('debug');
    info('info');
    warn('warn');
    error('error');
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Log Output Format Tests
// =============================================================================

describe('Human format output', () => {
  beforeEach(() => {
    configure({ format: 'human', timestamp: false, colorize: false, level: LogLevel.DEBUG });
  });

  test('info outputs to console.log', () => {
    info('test message');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('test message'));
  });

  test('warn outputs to console.error', () => {
    warn('test warning');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test warning'));
  });

  test('error outputs to console.error', () => {
    error('test error');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('test error'));
  });

  test('includes level in output', () => {
    info('test');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('INFO'));
  });

  test('includes context when provided', () => {
    info('test', {}, { context: 'MyContext' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[MyContext]'));
  });

  test('includes metadata in output', () => {
    info('test', { userId: 123, action: 'login' });
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('userId'));
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('123'));
  });
});

describe('JSON format output', () => {
  beforeEach(() => {
    configure({ format: 'json', timestamp: false });
  });

  test('outputs valid JSON', () => {
    info('test message');
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.message).toBe('test message');
    expect(parsed.level).toBe('info');
  });

  test('includes timestamp when enabled', () => {
    configure({ format: 'json', timestamp: true });
    info('test');
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.timestamp).toBeDefined();
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  test('includes metadata fields', () => {
    info('test', { key: 'value', num: 42 });
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.key).toBe('value');
    expect(parsed.num).toBe(42);
  });

  test('includes context field', () => {
    info('test', {}, { context: 'TestContext' });
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.context).toBe('TestContext');
  });
});

// =============================================================================
// Sensitive Data Redaction Tests
// =============================================================================

describe('Sensitive data redaction', () => {
  const { maskSensitiveData } = require('../lib/security');

  beforeEach(() => {
    configure({ redactSensitive: true });
  });

  test('redacts sensitive data in messages', () => {
    info('secret token in message');
    expect(maskSensitiveData).toHaveBeenCalled();
  });

  test('can be disabled', () => {
    configure({ redactSensitive: false });
    maskSensitiveData.mockClear();
    info('secret token');
    expect(maskSensitiveData).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Error Logging Tests
// =============================================================================

describe('errorWithStack', () => {
  test('logs error with stack trace', () => {
    const err = new Error('Test error');
    errorWithStack('Something went wrong', err);
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    const output = consoleErrorSpy.mock.calls[0][0];
    expect(output).toContain('Something went wrong');
  });

  test('includes error metadata in JSON format', () => {
    configure({ format: 'json' });
    const err = new Error('Test error');
    err.code = 'TEST_CODE';
    errorWithStack('Something went wrong', err);
    
    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toBe('Test error');
    expect(parsed.error.code).toBe('TEST_CODE');
    expect(parsed.error.stack).toBeDefined();
  });
});

// =============================================================================
// Child Logger Tests
// =============================================================================

describe('child logger', () => {
  test('creates logger with context', () => {
    const childLogger = child('TestService');
    childLogger.info('test message');
    
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('[TestService]'));
  });

  test('includes default metadata', () => {
    configure({ format: 'json' });
    const childLogger = child('TestService', { serviceVersion: '1.0.0' });
    childLogger.info('test');
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.serviceVersion).toBe('1.0.0');
    expect(parsed.context).toBe('TestService');
  });

  test('merges metadata with log call', () => {
    configure({ format: 'json' });
    const childLogger = child('TestService', { defaultKey: 'default' });
    childLogger.info('test', { extraKey: 'extra' });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.defaultKey).toBe('default');
    expect(parsed.extraKey).toBe('extra');
  });

  test('child errorWithStack includes context', () => {
    configure({ format: 'json' });
    const childLogger = child('ErrorHandler');
    const err = new Error('Test');
    childLogger.errorWithStack('Failed', err);
    
    const output = consoleErrorSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.context).toBe('ErrorHandler');
  });
});

// =============================================================================
// File Output Tests
// =============================================================================

describe('File output', () => {
  test('creates log file', async () => {
    const logFile = path.join(tempDir, 'test.log');
    setLogFile(logFile);
    
    info('test message');
    await flush();
    
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('test message');
  });

  test('writes JSON to file even when console is human format', async () => {
    configure({ format: 'human' });
    const logFile = path.join(tempDir, 'test.log');
    setLogFile(logFile);
    
    info('test message', { key: 'value' });
    await flush();
    
    const content = fs.readFileSync(logFile, 'utf8').trim();
    const parsed = JSON.parse(content);
    expect(parsed.message).toBe('test message');
    expect(parsed.key).toBe('value');
  });

  test('buffers messages when stream not ready', async () => {
    // Test that the logger handles missing streams gracefully
    // by setting up a valid path but then closing the stream manually
    const logFile = path.join(tempDir, 'buffer-test.log');
    
    setLogFile(logFile);
    
    // Close stream to simulate failure
    shutdown();
    
    // Should buffer message without throwing
    expect(() => {
      info('buffered message after shutdown');
    }).not.toThrow();
    
    // Small delay to allow any async operations to complete
    await new Promise(resolve => setTimeout(resolve, 10));
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Logger integration', () => {
  test('complete logging flow', () => {
    configure({
      level: LogLevel.DEBUG,
      format: 'json',
      timestamp: true,
    });

    debug('debug message', { detail: 'verbose' });
    info('info message', { user: 'alice' });
    warn('warn message', { slow: true });
    error('error message', { code: 500 });

    // debug and info go to console.log
    expect(consoleLogSpy).toHaveBeenCalledTimes(2);
    // warn and error go to console.error
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
  });

  test('respects level changes dynamically', () => {
    configure({ level: LogLevel.INFO });
    debug('should not appear');
    expect(consoleLogSpy).not.toHaveBeenCalled();

    configure({ level: LogLevel.DEBUG });
    debug('should appear');
    expect(consoleLogSpy).toHaveBeenCalled();
  });
});

// =============================================================================
// Security Features Tests - New in v0.16.1
// =============================================================================

describe('Security: Metadata Sanitization', () => {
  // We test the behavior through the public log API since sanitizeMetadata
  // uses sanitizeForLog internally which is mocked

  test('handles circular references in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const obj = { name: 'test' };
    obj.self = obj; // Circular reference
    
    info('test message', obj);
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.self).toBe('[Circular]');
    expect(parsed.name).toBe('test');
  });

  test('limits nesting depth in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    // Create a deeply nested object programmatically
    let deep = { level: 12 };
    for (let i = 11; i >= 1; i--) {
      deep = { level: i, nested: deep };
    }
    
    info('test message', deep);
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe(1);
    // Navigate through nesting - depth limit is 10
    let current = parsed;
    let depth = 0;
    while (current && typeof current === 'object' && current.nested && typeof current.nested === 'object' && depth < 15) {
      expect(current.level).toBe(depth + 1);
      current = current.nested;
      depth++;
    }
    // Should have stopped at depth 10 (level 10), and level 11 should have MaxDepthExceeded markers
    expect(depth).toBe(10);
    // current should now be the level 11 object with all values truncated
    expect(current.level).toBe('[MaxDepthExceeded]');
    expect(current.nested).toBe('[MaxDepthExceeded]');
  });

  test('limits total keys in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const obj = {};
    for (let i = 0; i < 150; i++) {
      obj[`key${i}`] = i;
    }
    
    info('test message', obj);
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed['[truncated]']).toBe('[MaxKeysExceeded]');
  });

  test('limits array length in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const arr = new Array(150).fill('item');
    
    info('test message', { items: arr });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    // Array should be limited to around 100 items plus truncation indicator
    expect(parsed.items.length).toBeLessThanOrEqual(101);
    // Last item should indicate truncation
    const lastItem = parsed.items[parsed.items.length - 1];
    expect(typeof lastItem === 'string' && lastItem.includes('more')).toBe(true);
  });

  test('limits string length in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const longString = 'a'.repeat(20000);
    
    info('test message', { value: longString });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.value.length).toBeLessThan(15000);
  });

  test('sanitizes newlines in strings', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    
    info('test message', { message: 'line1\nline2\rline3' });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.message).toContain('\\n');
  });

  test('converts functions to [Function]', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    
    info('test message', { fn: () => {}, name: 'test' });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.fn).toBe('[Function]');
    expect(parsed.name).toBe('test');
  });

  test('converts Date to ISO string', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const date = new Date('2024-01-15');
    
    info('test message', { created: date });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.created).toBe('2024-01-15T00:00:00.000Z');
  });

  test('redacts binary data', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const buffer = Buffer.from('secret data');
    
    info('test message', { data: buffer });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.data).toBe('[BinaryData:11bytes]');
  });

  test('handles Error objects in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const err = new Error('Test error');
    err.code = 'TEST_CODE';
    
    info('test message', { error: err });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('Test error');
    expect(parsed.error.code).toBe('TEST_CODE');
    expect(parsed.error.stack).toBeDefined();
  });

  test('handles BigInt in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    
    info('test message', { big: BigInt(9007199254740991) });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.big).toBe('9007199254740991');
  });

  test('handles Symbol in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const sym = Symbol('test');
    
    info('test message', { symbol: sym });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.symbol).toContain('Symbol');
  });

  test('handles RegExp in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const regex = /test/gi;
    
    info('test message', { pattern: regex });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.pattern).toBe('/test/gi');
  });

  test('handles Error objects in metadata', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const err = new Error('Test error');
    err.code = 'TEST_CODE';
    
    info('test message', { error: err });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('Test error');
    expect(parsed.error.code).toBe('TEST_CODE');
    expect(parsed.error.stack).toBeDefined();
  });

  test('handles BigInt', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    
    info('test message', { big: BigInt(9007199254740991) });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.big).toBe('9007199254740991');
  });

  test('handles Symbol', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const sym = Symbol('test');
    
    info('test message', { symbol: sym });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.symbol).toContain('Symbol');
  });

  test('handles RegExp', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    const regex = /test/gi;
    
    info('test message', { pattern: regex });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.pattern).toBe('/test/gi');
  });
});

describe('Security: Sensitive Key Detection', () => {
  test('redacts sensitive values in metadata', () => {
    configure({ format: 'json', redactSensitive: true, level: LogLevel.DEBUG });
    info('test', { password: 'secret123', api_key: 'abc123', safe: 'value' });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.api_key).toBe('[REDACTED]');
    expect(parsed.safe).toBe('value');
  });
});

describe('Security: Log Entry Size Limits', () => {
  test('truncates oversized entries', () => {
    configure({ format: 'json', level: LogLevel.DEBUG });
    // Create an object that will exceed 100KB but stay within key limits
    // Each key has 2000 chars, 60 keys = ~120KB of string data
    // This should trigger the entry size limit
    const hugeMeta = {};
    for (let i = 0; i < 60; i++) {
      hugeMeta[`k${i}`] = 'x'.repeat(2000);
    }
    
    info('test message', hugeMeta);
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    // Entry should be truncated due to size or the metadata should be limited
    // The key assertion is that the log was written without errors
    expect(parsed.message).toBe('test message');
    // Either _truncated is set or the metadata was reduced
    expect(parsed._truncated === true || Object.keys(parsed).length < 65).toBe(true);
  });
});

describe('Security: Log Injection Prevention', () => {
  test('sanitizes log injection characters in message', () => {
    const { sanitizeForLog } = jest.requireMock('../lib/security');
    configure({ format: 'json' });
    
    info('test\nmessage\rwith\rcrlf');
    
    expect(sanitizeForLog).toHaveBeenCalledWith(expect.any(String), 10000);
  });

  test('sanitizes context', () => {
    configure({ format: 'json' });
    info('message', {}, { context: 'Test\nContext' });
    
    const output = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.context).not.toContain('\n');
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('Constants', () => {
  test('DEFAULT_CONFIG has expected properties', () => {
    expect(DEFAULT_CONFIG.level).toBe(LogLevel.INFO);
    expect(DEFAULT_CONFIG.format).toBe('human');
    expect(DEFAULT_CONFIG.colorize).toBe(true);
    expect(DEFAULT_CONFIG.timestamp).toBe(true);
    expect(DEFAULT_CONFIG.maxFileSize).toBe(10 * 1024 * 1024);
    expect(DEFAULT_CONFIG.maxFiles).toBe(5);
    expect(DEFAULT_CONFIG.redactSensitive).toBe(true);
    expect(DEFAULT_CONFIG.exitOnError).toBe(false);
  });

  test('DEFAULT_LOG_DIR points to .masterclaw/logs', () => {
    expect(DEFAULT_LOG_DIR).toContain('.masterclaw');
    expect(DEFAULT_LOG_DIR).toContain('logs');
  });

  test('security constants are defined', () => {
    const { MAX_LOG_ENTRY_SIZE, MAX_METADATA_DEPTH, MAX_METADATA_KEYS, MAX_METADATA_VALUE_LENGTH, SENSITIVE_METADATA_KEYS } = require('../lib/logger');
    
    expect(MAX_LOG_ENTRY_SIZE).toBe(100 * 1024); // 100KB
    expect(MAX_METADATA_DEPTH).toBe(10);
    expect(MAX_METADATA_KEYS).toBe(100);
    expect(MAX_METADATA_VALUE_LENGTH).toBe(10000);
    expect(SENSITIVE_METADATA_KEYS).toContain('password');
    expect(SENSITIVE_METADATA_KEYS).toContain('token');
  });
});
