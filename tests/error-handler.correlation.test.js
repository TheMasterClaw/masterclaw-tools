/**
 * Tests for error-handler correlation ID integration
 * Run with: npm test -- error-handler.correlation.test.js
 */

const { 
  wrapCommand, 
  displayError, 
  ExitCode, 
  ErrorCategory,
  classifyError,
  getUserMessage,
  getSuggestion,
} = require('../lib/error-handler');
const { 
  getCurrentCorrelationId, 
  setCorrelationId,
  generateCorrelationId,
  clearCorrelationContext,
  runWithCorrelationIdAsync,
} = require('../lib/correlation');

// Mock chalk to avoid ANSI codes in test output
jest.mock('chalk', () => ({
  red: (str) => str,
  yellow: (str) => str,
  gray: (str) => str,
  blue: (str) => str,
  green: (str) => str,
}));

// Mock audit module
jest.mock('../lib/audit', () => ({
  logSecurityViolation: jest.fn().mockResolvedValue(),
  logAudit: jest.fn().mockResolvedValue(),
}));

describe('Error Handler Correlation ID Integration', () => {
  beforeEach(() => {
    // Clear any existing correlation context
    clearCorrelationContext();
    
    // Reset environment
    delete process.env.MC_JSON_OUTPUT;
    delete process.env.MC_VERBOSE;
    
    // Mock console.error and console.log
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('wrapCommand', () => {
    it('should include correlation ID in error output when command fails', async () => {
      const mockHandler = jest.fn().mockRejectedValue(new Error('Test error'));
      const wrapped = wrapCommand(mockHandler, 'test-command');
      
      // Mock process.exit to prevent actual exit
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      
      await wrapped({ verbose: true });
      
      // Verify error was displayed
      expect(console.error).toHaveBeenCalled();
      
      // Verify process.exit was called with error code
      expect(mockExit).toHaveBeenCalledWith(expect.any(Number));
      
      mockExit.mockRestore();
    });

    it('should create unique correlation ID for each command execution', async () => {
      const correlationIds = [];
      
      const mockHandler = jest.fn().mockImplementation(() => {
        correlationIds.push(getCurrentCorrelationId());
        return Promise.resolve();
      });
      
      const wrapped = wrapCommand(mockHandler, 'test-command');
      
      await wrapped({});
      await wrapped({});
      
      // Each execution should have a different correlation ID
      expect(correlationIds[0]).toBeTruthy();
      expect(correlationIds[1]).toBeTruthy();
      expect(correlationIds[0]).not.toBe(correlationIds[1]);
    });
  });

  describe('displayError with correlation ID', () => {
    it('should include correlation ID in JSON output', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      const testCorrelationId = 'mc_test_abc123';
      runWithCorrelationIdAsync(() => {
        displayError(new Error('Test error'), { command: 'test' });
      }, testCorrelationId);
      
      // Get the JSON output
      const errorCall = console.error.mock.calls.find(
        call => {
          try {
            const parsed = JSON.parse(call[0]);
            return parsed.level === 'error';
          } catch {
            return false;
          }
        }
      );
      
      expect(errorCall).toBeTruthy();
      const output = JSON.parse(errorCall[0]);
      expect(output.correlationId).toBeTruthy();
    });

    it('should show correlation ID in verbose mode for human-readable output', () => {
      process.env.MC_VERBOSE = '1';
      
      const testCorrelationId = 'mc_test_xyz789';
      runWithCorrelationIdAsync(() => {
        displayError(new Error('Test error'), { command: 'test', verbose: true });
      }, testCorrelationId);
      
      // Check that correlation ID is in the output
      const correlationOutput = console.error.mock.calls.find(
        call => call[0] && call[0].includes && call[0].includes('Correlation ID')
      );
      
      expect(correlationOutput).toBeTruthy();
    });

    it('should show correlation ID for security errors', () => {
      // Use a rate limit error which is classified as SECURITY
      const { RateLimitError } = require('../lib/rate-limiter');
      const securityError = new RateLimitError('Rate limit exceeded', {
        allowed: false,
        retryAfterSec: 60,
        limit: 10,
        window: 60,
      });
      
      runWithCorrelationIdAsync(() => {
        displayError(securityError, { command: 'test' });
      }, 'mc_security_test');
      
      // Security errors should show correlation ID
      const output = console.error.mock.calls.some(
        call => call[0] && call[0].includes && call[0].includes('Correlation ID')
      );
      
      expect(output).toBe(true);
    });
  });

  describe('Error classification', () => {
    it('should correctly classify security errors', () => {
      const securityError = new Error('Permission denied');
      securityError.code = 'EACCES';
      
      const classification = classifyError(securityError);
      expect(classification.category).toBe(ErrorCategory.PERMISSION);
      expect(classification.exitCode).toBe(ExitCode.PERMISSION_DENIED);
    });

    it('should correctly classify network errors', () => {
      const networkError = new Error('Connection refused');
      networkError.code = 'ECONNREFUSED';
      
      const classification = classifyError(networkError);
      expect(classification.category).toBe(ErrorCategory.NETWORK);
      expect(classification.exitCode).toBe(ExitCode.NETWORK_ERROR);
    });

    it('should provide user-friendly messages', () => {
      const dockerError = new Error('Docker daemon not running');
      const message = getUserMessage(dockerError, classifyError(dockerError));
      
      expect(message).toBeTruthy();
      expect(message).not.toContain('ECONNREFUSED');
    });

    it('should provide remediation suggestions', () => {
      const dockerError = new Error('Docker daemon not running');
      const suggestion = getSuggestion(dockerError, classifyError(dockerError));
      
      expect(suggestion).toBeTruthy();
    });
  });

  describe('Error output formats', () => {
    it('should output valid JSON in JSON mode', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      runWithCorrelationIdAsync(() => {
        displayError(new Error('Test error'), { command: 'test' });
      }, 'mc_json_test');
      
      // Find JSON output
      const jsonOutput = console.error.mock.calls.find(call => {
        try {
          JSON.parse(call[0]);
          return true;
        } catch {
          return false;
        }
      });
      
      expect(jsonOutput).toBeTruthy();
      
      const parsed = JSON.parse(jsonOutput[0]);
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('category');
      expect(parsed).toHaveProperty('exitCode');
      expect(parsed).toHaveProperty('message');
      expect(parsed).toHaveProperty('error');
      expect(parsed.error).toHaveProperty('type');
      expect(parsed.error).toHaveProperty('message');
    });

    it('should include verbose details when requested in JSON mode', () => {
      process.env.MC_JSON_OUTPUT = '1';
      
      runWithCorrelationIdAsync(() => {
        displayError(new Error('Test error'), { command: 'test', verbose: true });
      }, 'mc_verbose_test');
      
      const jsonOutput = console.error.mock.calls.find(call => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.verbose !== undefined;
        } catch {
          return false;
        }
      });
      
      expect(jsonOutput).toBeTruthy();
      const parsed = JSON.parse(jsonOutput[0]);
      expect(parsed.verbose).toHaveProperty('stack');
      expect(parsed.verbose).toHaveProperty('classification');
    });
  });
});
