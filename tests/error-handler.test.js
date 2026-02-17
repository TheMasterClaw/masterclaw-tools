/**
 * Tests for error-handler.js
 * Run with: npm test -- error-handler.test.js
 */

const {
  wrapCommand,
  classifyError,
  getUserMessage,
  getSuggestion,
  displayError,
  isJsonOutputMode,
  ExitCode,
  ErrorCategory,
  ERROR_MESSAGE_MAP,
} = require('../lib/error-handler');

const { DockerSecurityError, DockerCommandError } = require('../lib/docker');

// Mock chalk to avoid ANSI codes in tests
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  green: (str) => str,
  cyan: (str) => str,
  gray: (str) => str,
  bold: (str) => str,
  blue: (str) => str,
}));

// Mock audit module
jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(true),
  logAudit: jest.fn().mockResolvedValue(true),
}));

// =============================================================================
// Error Classification Tests
// =============================================================================

describe('classifyError', () => {
  test('classifies DockerSecurityError as security violation', () => {
    const err = new DockerSecurityError('Test security error', 'TEST_CODE');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.SECURITY);
    expect(classification.exitCode).toBe(ExitCode.SECURITY_VIOLATION);
    expect(classification.shouldAudit).toBe(true);
    expect(classification.auditEvent).toBe('SECURITY_VIOLATION');
  });
  
  test('classifies DockerCommandError as docker error', () => {
    const err = new DockerCommandError('Command failed', 'CMD_FAIL', 1);
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.DOCKER);
    expect(classification.exitCode).toBe(ExitCode.DOCKER_ERROR);
    expect(classification.shouldAudit).toBe(false);
  });
  
  test('classifies ENOENT as config error', () => {
    const err = new Error('File not found');
    err.code = 'ENOENT';
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.CONFIG);
    expect(classification.exitCode).toBe(ExitCode.CONFIG_ERROR);
  });
  
  test('classifies EACCES as permission error', () => {
    const err = new Error('Permission denied');
    err.code = 'EACCES';
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.PERMISSION);
    expect(classification.exitCode).toBe(ExitCode.PERMISSION_DENIED);
  });
  
  test('classifies ECONNREFUSED as network error', () => {
    const err = new Error('Connection refused');
    err.code = 'ECONNREFUSED';
    err.hostname = 'localhost';
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.NETWORK);
    expect(classification.exitCode).toBe(ExitCode.NETWORK_ERROR);
  });
  
  test('classifies Docker not installed error correctly', () => {
    const err = new Error('docker: command not found');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.DOCKER);
    expect(classification.exitCode).toBe(ExitCode.DOCKER_ERROR);
    expect(classification.message).toContain('not installed');
    expect(classification.suggestion).toContain('get.docker.com');
  });
  
  test('classifies Docker daemon not running error correctly', () => {
    const err = new Error('Docker daemon is not running');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.DOCKER);
    expect(classification.exitCode).toBe(ExitCode.DOCKER_ERROR);
    expect(classification.message).toContain('daemon is not running');
  });
  
  test('classifies permission denied error correctly', () => {
    const err = new Error('permission denied while trying to connect to Docker');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.PERMISSION);
    expect(classification.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    expect(classification.message).toContain('Permission denied');
  });
  
  test('classifies network timeout error correctly', () => {
    const err = new Error('Request timed out');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.NETWORK);
    expect(classification.exitCode).toBe(ExitCode.NETWORK_ERROR);
    expect(classification.message).toContain('timed out');
  });
  
  test('classifies unknown errors as internal', () => {
    const err = new Error('Something weird happened');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.INTERNAL);
    expect(classification.exitCode).toBe(ExitCode.GENERAL_ERROR);
  });
  
  test('classifies generic errors without code as internal', () => {
    const err = new Error('Generic error');
    const classification = classifyError(err);
    
    expect(classification.category).toBe(ErrorCategory.INTERNAL);
  });
});

// =============================================================================
// User Message Tests
// =============================================================================

describe('getUserMessage', () => {
  test('returns mapped message for known errors', () => {
    const err = new Error('Docker is not installed');
    const classification = classifyError(err);
    const message = getUserMessage(err, classification);
    
    expect(message).toContain('not installed');
  });
  
  test('returns category-specific message for unknown errors', () => {
    const err = new Error('Some random error');
    const classification = { category: ErrorCategory.NETWORK };
    const message = getUserMessage(err, classification);
    
    expect(message).toContain('Network');
  });
  
  test('returns generic message for unrecognized errors', () => {
    const err = new Error('');
    const classification = { category: 'unknown' };
    const message = getUserMessage(err, classification);
    
    expect(message).toContain('error occurred');
  });
});

// =============================================================================
// Suggestion Tests
// =============================================================================

describe('getSuggestion', () => {
  test('returns mapped suggestion for known errors', () => {
    const err = new Error('Docker not installed');
    const classification = classifyError(err);
    const suggestion = getSuggestion(err, classification);
    
    expect(suggestion).toContain('get.docker.com');
  });
  
  test('returns category-specific suggestion when no mapping', () => {
    const err = new Error('Network issue');
    const classification = { category: ErrorCategory.NETWORK };
    const suggestion = getSuggestion(err, classification);
    
    expect(suggestion).toContain('network connection');
  });
  
  test('returns null for internal errors', () => {
    const err = new Error('Internal');
    const classification = { category: ErrorCategory.INTERNAL };
    const suggestion = getSuggestion(err, classification);
    
    expect(suggestion).toContain('report this issue');
  });
});

// =============================================================================
// Display Error Tests
// =============================================================================

describe('displayError', () => {
  let consoleErrorSpy;
  
  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });
  
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });
  
  test('displays error with appropriate icon', () => {
    const err = new Error('Docker not installed');
    displayError(err);
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    const output = consoleErrorSpy.mock.calls[0][0];
    expect(output).toContain('Error:');
    expect(output).toContain('not installed');
  });
  
  test('includes suggestion when available', () => {
    const err = new Error('Docker not installed');
    displayError(err);
    
    const output = consoleErrorSpy.mock.calls.join('\n');
    expect(output).toContain('💡');
    expect(output).toContain('get.docker.com');
  });
  
  test('includes verbose details when verbose flag is set', () => {
    const err = new Error('Detailed error message');
    err.code = 'TEST_CODE';
    displayError(err, { verbose: true });
    
    const output = consoleErrorSpy.mock.calls.join('\n');
    expect(output).toContain('Details:');
    expect(output).toContain('Code:');
  });
  
  test('returns appropriate exit code', () => {
    const err = new Error('Docker not installed');
    const exitCode = displayError(err);
    
    expect(exitCode).toBe(ExitCode.DOCKER_ERROR);
  });
  
  test('masks sensitive data in verbose output', () => {
    const err = new Error('Token: secret12345');
    displayError(err, { verbose: true });
    
    const output = consoleErrorSpy.mock.calls.join('\n');
    expect(output).not.toContain('secret12345');
    expect(output).toContain('[REDACTED]');
  });
});

// =============================================================================
// Wrap Command Tests
// =============================================================================

describe('wrapCommand', () => {
  let processExitSpy;
  let consoleErrorSpy;
  
  beforeEach(() => {
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });
  
  afterEach(() => {
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
  
  test('executes successful handler without error', async () => {
    const handler = jest.fn().mockResolvedValue('success');
    const wrapped = wrapCommand(handler, 'test-cmd');
    
    await wrapped({});
    
    expect(handler).toHaveBeenCalled();
    expect(processExitSpy).not.toHaveBeenCalled();
  });
  
  test('handles errors and exits with appropriate code', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('Docker not installed'));
    const wrapped = wrapCommand(handler, 'test-cmd');
    
    await wrapped({});
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(ExitCode.DOCKER_ERROR);
  });
  
  test('passes arguments to handler', async () => {
    const handler = jest.fn().mockResolvedValue('success');
    const wrapped = wrapCommand(handler, 'test-cmd');
    
    await wrapped('arg1', 'arg2', { verbose: true });
    
    expect(handler).toHaveBeenCalledWith('arg1', 'arg2', { verbose: true });
  });
  
  test('detects verbose flag from options', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('Test error'));
    const wrapped = wrapCommand(handler, 'test-cmd');
    
    await wrapped({ verbose: true });
    
    // Should display verbose output
    const output = consoleErrorSpy.mock.calls.join('\n');
    expect(output).toContain('Details:');
  });
  
  test('handles security errors with audit logging', async () => {
    const { logSecurityViolation } = require('../lib/audit');
    const err = new DockerSecurityError('Security violation', 'SEC_ERROR');
    const handler = jest.fn().mockRejectedValue(err);
    const wrapped = wrapCommand(handler, 'test-cmd');
    
    await wrapped({});
    
    expect(processExitSpy).toHaveBeenCalledWith(ExitCode.SECURITY_VIOLATION);
    // Allow time for async audit logging
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(logSecurityViolation).toHaveBeenCalled();
  });
});

// =============================================================================
// Exit Code Constants Tests
// =============================================================================

describe('ExitCode', () => {
  test('has expected exit codes', () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.INVALID_ARGUMENTS).toBe(2);
    expect(ExitCode.DOCKER_ERROR).toBe(3);
    expect(ExitCode.SERVICE_UNAVAILABLE).toBe(4);
    expect(ExitCode.PERMISSION_DENIED).toBe(5);
    expect(ExitCode.SECURITY_VIOLATION).toBe(6);
    expect(ExitCode.CONFIG_ERROR).toBe(7);
    expect(ExitCode.NETWORK_ERROR).toBe(8);
    expect(ExitCode.VALIDATION_FAILED).toBe(9);
    expect(ExitCode.INTERNAL_ERROR).toBe(99);
  });
  
  test('success code is 0', () => {
    expect(ExitCode.SUCCESS).toBe(0);
  });
});

// =============================================================================
// Error Category Constants Tests
// =============================================================================

describe('ErrorCategory', () => {
  test('has expected categories', () => {
    expect(ErrorCategory.DOCKER).toBe('docker');
    expect(ErrorCategory.SECURITY).toBe('security');
    expect(ErrorCategory.CONFIG).toBe('config');
    expect(ErrorCategory.NETWORK).toBe('network');
    expect(ErrorCategory.VALIDATION).toBe('validation');
    expect(ErrorCategory.SERVICE).toBe('service');
    expect(ErrorCategory.PERMISSION).toBe('permission');
    expect(ErrorCategory.INTERNAL).toBe('internal');
    expect(ErrorCategory.USER).toBe('user');
  });
});

// =============================================================================
// Error Message Map Tests
// =============================================================================

describe('ERROR_MESSAGE_MAP', () => {
  test('contains Docker not installed pattern', () => {
    const dockerNotInstalled = ERROR_MESSAGE_MAP.find(m => 
      m.pattern.test('docker command not found')
    );
    expect(dockerNotInstalled).toBeDefined();
    expect(dockerNotInstalled.category).toBe(ErrorCategory.DOCKER);
  });
  
  test('contains network error patterns', () => {
    const networkError = ERROR_MESSAGE_MAP.find(m => 
      m.pattern.test('ECONNREFUSED')
    );
    expect(networkError).toBeDefined();
    expect(networkError.category).toBe(ErrorCategory.NETWORK);
  });
  
  test('contains permission denied pattern', () => {
    const permError = ERROR_MESSAGE_MAP.find(m => 
      m.pattern.test('permission denied accessing docker')
    );
    expect(permError).toBeDefined();
    expect(permError.category).toBe(ErrorCategory.PERMISSION);
  });
  
  test('all entries have required fields', () => {
    for (const entry of ERROR_MESSAGE_MAP) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.category).toBeDefined();
      expect(typeof entry.message === 'string' || typeof entry.message === 'function').toBe(true);
      expect(entry.suggestion).toBeDefined();
      expect(typeof entry.exitCode).toBe('number');
    }
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Error Handler Integration', () => {
  test('handles complete error flow', async () => {
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    
    // Simulate a Docker error
    const handler = async () => {
      const err = new Error('docker: command not found');
      throw err;
    };
    
    const wrapped = wrapCommand(handler, 'test');
    await wrapped({});
    
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(ExitCode.DOCKER_ERROR);
    
    processExitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });
  
  test('preserves successful return values', async () => {
    const handler = async () => ({ success: true, data: 'test' });
    const wrapped = wrapCommand(handler, 'test');
    
    const result = await wrapped({});
    
    expect(result).toEqual({ success: true, data: 'test' });
  });
});

// =============================================================================
// JSON Output Mode Tests
// =============================================================================

describe('JSON Output Mode', () => {
  let consoleErrorSpy;
  
  afterEach(() => {
    delete process.env.MC_JSON_OUTPUT;
    if (consoleErrorSpy) {
      consoleErrorSpy.mockRestore();
    }
  });
  
  describe('isJsonOutputMode', () => {
    test('returns false by default', () => {
      expect(isJsonOutputMode()).toBe(false);
    });
    
    test('returns true when MC_JSON_OUTPUT=1', () => {
      process.env.MC_JSON_OUTPUT = '1';
      expect(isJsonOutputMode()).toBe(true);
    });
    
    test('returns true when MC_JSON_OUTPUT=true', () => {
      process.env.MC_JSON_OUTPUT = 'true';
      expect(isJsonOutputMode()).toBe(true);
    });
    
    test('returns false when MC_JSON_OUTPUT is other value', () => {
      process.env.MC_JSON_OUTPUT = 'yes';
      expect(isJsonOutputMode()).toBe(false);
    });
  });
  
  describe('displayError with JSON mode', () => {
    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    
    afterEach(() => {
      consoleErrorSpy.mockRestore();
      delete process.env.MC_JSON_OUTPUT;
    });
    
    test('outputs JSON when MC_JSON_OUTPUT is set', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const err = new Error('Docker not installed');
      err.code = 'ENOENT';
      
      displayError(err, { command: 'status' });
      
      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('category');
      expect(parsed).toHaveProperty('exitCode');
      expect(parsed).toHaveProperty('message');
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toHaveProperty('type');
      expect(parsed.error).toHaveProperty('message');
    });
    
    test('includes suggestion in JSON output when available', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      // Use a Docker error that has a suggestion
      const err = new Error('docker: command not found');
      
      displayError(err, { command: 'status' });
      
      const output = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      
      expect(parsed).toHaveProperty('suggestion');
    });
    
    test('includes verbose details when verbose is true', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const err = new Error('Test error');
      err.stack = 'Error: Test error\n    at Test.method';
      
      displayError(err, { verbose: true, command: 'test' });
      
      const output = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      
      expect(parsed).toHaveProperty('verbose');
      expect(parsed.verbose).toHaveProperty('stack');
    });
    
    test('masks sensitive data in JSON output', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const err = new Error('api_key=sk-test1234567890abcdef failed');
      
      displayError(err, { verbose: true });
      
      const output = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      
      // The API key should be masked
      expect(parsed.error.message).not.toContain('sk-test1234567890abcdef');
      expect(parsed.error.message).toContain('[REDACTED]');
    });
    
    test('omits undefined values from JSON output', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const err = new Error('Test error');
      
      displayError(err, {});  // No command specified
      
      const output = consoleErrorSpy.mock.calls[0][0];
      const parsed = JSON.parse(output);
      
      // command should not be in output since it was undefined
      expect(parsed).not.toHaveProperty('command');
    });
    
    test('returns correct exit code in JSON mode', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const err = new Error('ECONNREFUSED');
      
      const exitCode = displayError(err, {});
      
      expect(exitCode).toBe(ExitCode.NETWORK_ERROR);
    });
  });
});

// Export for Jest
module.exports = {
  ExitCode,
  ErrorCategory,
};
