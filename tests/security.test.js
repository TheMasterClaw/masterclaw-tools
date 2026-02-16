/**
 * Tests for security.js module
 * Run with: npm test -- security.test.js
 */

const security = require('../lib/security');

describe('Security Module', () => {
  // ===========================================================================
  // Log Sanitization Tests
  // ===========================================================================
  describe('sanitizeForLog', () => {
    test('returns string for non-string input', () => {
      expect(security.sanitizeForLog(123)).toBe('123');
      expect(security.sanitizeForLog(null)).toBe('null');
      expect(security.sanitizeForLog(undefined)).toBe('undefined');
    });

    test('limits string length', () => {
      const longString = 'a'.repeat(10000);
      const result = security.sanitizeForLog(longString, 100);
      expect(result.length).toBe(100);
    });

    test('removes control characters', () => {
      const input = 'Hello\x00World\x01\x02';
      const result = security.sanitizeForLog(input);
      expect(result).toBe('HelloWorld');
    });

    test('escapes newlines', () => {
      const input = 'Line1\nLine2\rLine3\r\nLine4';
      const result = security.sanitizeForLog(input);
      expect(result).not.toContain('\n');
      expect(result).not.toContain('\r');
      expect(result).toContain('\\n');
    });

    test('removes ANSI escape sequences', () => {
      const input = '\x1b[31mRed\x1b[0m Normal \x1b[1;32mGreen\x1b[0m';
      const result = security.sanitizeForLog(input);
      expect(result).toBe('Red Normal Green');
    });

    test('prevents log injection attacks', () => {
      // Simulated attack: injecting a fake log entry
      const attack = 'User login\n[2024-01-01] SUCCESS: Admin accessed';
      const result = security.sanitizeForLog(attack);
      expect(result).not.toContain('\n');
    });

    test('enforces maximum safe log length', () => {
      const hugeString = 'x'.repeat(security.MAX_SAFE_LOG_LENGTH * 2);
      const result = security.sanitizeForLog(hugeString);
      expect(result.length).toBeLessThanOrEqual(security.MAX_SAFE_LOG_LENGTH);
    });
  });

  // ===========================================================================
  // Sensitive Data Masking Tests
  // ===========================================================================
  describe('maskSensitiveData', () => {
    test('masks tokens', () => {
      const input = 'auth_token=abc123def456';
      const result = security.maskSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abc123def456');
    });

    test('masks API keys', () => {
      const input = 'api_key=sk-1234567890abcdef';
      expect(security.maskSensitiveData(input)).toBe('api_key=[REDACTED]');
    });

    test('masks passwords', () => {
      const input = 'password=secret123';
      expect(security.maskSensitiveData(input)).toBe('password=[REDACTED]');
    });

    test('masks secrets', () => {
      const input = 'client_secret=mySecretValue123';
      const result = security.maskSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('mySecretValue123');
    });

    test('masks Bearer tokens', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      expect(security.maskSensitiveData(input)).toBe('Authorization: Bearer [REDACTED]');
    });

    test('masks Basic auth', () => {
      const input = 'Authorization: Basic dXNlcjpwYXNz';
      expect(security.maskSensitiveData(input)).toBe('Authorization: Basic [REDACTED]');
    });

    test('handles multiple sensitive values', () => {
      const input = 'token=abc123def456 api_key=xyz789ghi password=hunter2';
      const result = security.maskSensitiveData(input);
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('abc123def456');
      expect(result).not.toContain('xyz789ghi');
      expect(result).not.toContain('hunter2');
    });

    test('returns non-strings unchanged', () => {
      expect(security.maskSensitiveData(123)).toBe(123);
      expect(security.maskSensitiveData(null)).toBe(null);
    });
  });

  // ===========================================================================
  // Secure Log String Tests
  // ===========================================================================
  describe('secureLogString', () => {
    test('combines sanitization and masking', () => {
      const input = 'token=secret123\nAuth: Bearer abc123\x1b[31m';
      const result = security.secureLogString(input);
      expect(result).not.toContain('secret123');
      expect(result).not.toContain('\n');
      expect(result).not.toContain('\x1b[');
      expect(result).toContain('[REDACTED]');
    });
  });

  // ===========================================================================
  // Input Validation Tests
  // ===========================================================================
  describe('isSafeString', () => {
    test('accepts valid strings', () => {
      expect(security.isSafeString('hello')).toBe(true);
      expect(security.isSafeString('Hello World 123!')).toBe(true);
    });

    test('rejects non-strings', () => {
      expect(security.isSafeString(123)).toBe(false);
      expect(security.isSafeString(null)).toBe(false);
      expect(security.isSafeString({})).toBe(false);
    });

    test('rejects empty strings by default', () => {
      expect(security.isSafeString('')).toBe(false);
    });

    test('accepts empty strings when allowed', () => {
      expect(security.isSafeString('', { allowEmpty: true })).toBe(true);
    });

    test('rejects strings exceeding max length', () => {
      const longString = 'x'.repeat(101);
      expect(security.isSafeString(longString, { maxLength: 100 })).toBe(false);
    });

    test('rejects strings with null bytes', () => {
      expect(security.isSafeString('hello\0world')).toBe(false);
    });
  });

  describe('isValidIpAddress', () => {
    test('accepts valid IPv4 addresses', () => {
      expect(security.isValidIpAddress('192.168.1.1')).toBe(true);
      expect(security.isValidIpAddress('10.0.0.1')).toBe(true);
      expect(security.isValidIpAddress('255.255.255.255')).toBe(true);
      expect(security.isValidIpAddress('0.0.0.0')).toBe(true);
    });

    test('rejects invalid IPv4 addresses', () => {
      expect(security.isValidIpAddress('256.1.1.1')).toBe(false);
      expect(security.isValidIpAddress('192.168.1')).toBe(false);
      expect(security.isValidIpAddress('192.168.1.1.1')).toBe(false);
    });

    test('accepts valid IPv6 addresses', () => {
      expect(security.isValidIpAddress('::1')).toBe(true);
      expect(security.isValidIpAddress('::')).toBe(true);
      expect(security.isValidIpAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
    });

    test('rejects non-string inputs', () => {
      expect(security.isValidIpAddress(null)).toBe(false);
      expect(security.isValidIpAddress(123)).toBe(false);
    });
  });

  describe('isValidHostname', () => {
    test('accepts valid hostnames', () => {
      expect(security.isValidHostname('example.com')).toBe(true);
      expect(security.isValidHostname('sub.domain.example.com')).toBe(true);
      expect(security.isValidHostname('localhost')).toBe(true);
      expect(security.isValidHostname('server-1')).toBe(true);
    });

    test('rejects invalid hostnames', () => {
      expect(security.isValidHostname('-invalid')).toBe(false);
      expect(security.isValidHostname('invalid-')).toBe(false);
      expect(security.isValidHostname('a'.repeat(254))).toBe(false);
    });

    test('rejects non-string inputs', () => {
      expect(security.isValidHostname(null)).toBe(false);
      expect(security.isValidHostname(123)).toBe(false);
    });
  });

  // ===========================================================================
  // Path Security Tests
  // ===========================================================================
  describe('containsPathTraversal', () => {
    test('detects path traversal attempts', () => {
      expect(security.containsPathTraversal('../etc/passwd')).toBe(true);
      expect(security.containsPathTraversal('../../../etc/shadow')).toBe(true);
      expect(security.containsPathTraversal('..\\windows\\system32')).toBe(true);
      expect(security.containsPathTraversal('file/../../../etc/passwd')).toBe(true);
    });

    test('allows safe paths', () => {
      expect(security.containsPathTraversal('/home/user/file.txt')).toBe(false);
      expect(security.containsPathTraversal('./config.json')).toBe(false);
      expect(security.containsPathTraversal('logs/app.log')).toBe(false);
    });

    test('rejects non-strings', () => {
      expect(security.containsPathTraversal(null)).toBe(true);
      expect(security.containsPathTraversal(123)).toBe(true);
    });

    test('detects null byte injection', () => {
      expect(security.containsPathTraversal('file.txt\0.php')).toBe(true);
    });
  });

  describe('sanitizeFilename', () => {
    test('sanitizes basic filenames', () => {
      expect(security.sanitizeFilename('file.txt')).toBe('file.txt');
      expect(security.sanitizeFilename('my-file_name.txt')).toBe('my-file_name.txt');
    });

    test('removes path components', () => {
      expect(security.sanitizeFilename('/path/to/file.txt')).toBe('file.txt');
      expect(security.sanitizeFilename('..\\windows\\file.txt')).toBe('file.txt');
    });

    test('replaces dangerous characters', () => {
      expect(security.sanitizeFilename('file\u003cname\u003e.txt')).toBe('file_name_.txt');
      expect(security.sanitizeFilename('file:name.txt')).toBe('file_name.txt');
    });

    test('prevents hidden files', () => {
      expect(security.sanitizeFilename('.htaccess')).toBe('_htaccess');
      expect(security.sanitizeFilename('..hidden')).toBe('_hidden');
    });

    test('limits length', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = security.sanitizeFilename(longName);
      expect(result.length).toBeLessThanOrEqual(255);
    });

    test('handles empty strings', () => {
      expect(security.sanitizeFilename('')).toBe('unnamed');
    });

    test('uses custom replacement', () => {
      expect(security.sanitizeFilename('file\u003cname\u003e.txt', { replacement: '-' })).toBe('file-name-.txt');
    });
  });

  // ===========================================================================
  // Timing Attack Prevention Tests
  // ===========================================================================
  describe('constantTimeCompare', () => {
    test('returns true for equal strings', () => {
      expect(security.constantTimeCompare('secret', 'secret')).toBe(true);
      expect(security.constantTimeCompare('', '')).toBe(true);
    });

    test('returns false for different strings', () => {
      expect(security.constantTimeCompare('secret', 'Secret')).toBe(false);
      expect(security.constantTimeCompare('secret', 'secrets')).toBe(false);
      expect(security.constantTimeCompare('secret', '')).toBe(false);
    });

    test('returns false for non-strings', () => {
      expect(security.constantTimeCompare('secret', null)).toBe(false);
      expect(security.constantTimeCompare(null, 'secret')).toBe(false);
      expect(security.constantTimeCompare(123, 123)).toBe(false);
    });

    test('handles strings of different lengths', () => {
      expect(security.constantTimeCompare('short', 'longer string')).toBe(false);
    });
  });

  // ===========================================================================
  // Safe JSON Tests
  // ===========================================================================
  describe('safeJsonParse', () => {
    test('parses valid JSON', () => {
      expect(security.safeJsonParse('{"key":"value"}')).toEqual({ key: 'value' });
      expect(security.safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
    });

    test('returns null for invalid JSON', () => {
      expect(security.safeJsonParse('not json')).toBeNull();
      expect(security.safeJsonParse('{"incomplete"')).toBeNull();
    });

    test('enforces depth limit', () => {
      const deepObject = JSON.stringify({ a: { b: { c: { d: { e: 'deep' } } } } });
      expect(security.safeJsonParse(deepObject, 3)).toBeNull();
      expect(security.safeJsonParse(deepObject, 10)).toEqual({ a: { b: { c: { d: { e: 'deep' } } } } });
    });
  });

  describe('safeJsonStringify', () => {
    test('stringifies valid objects', () => {
      expect(security.safeJsonStringify({ key: 'value' })).toBe('{"key":"value"}');
    });

    test('handles circular references', () => {
      const obj = { a: 1 };
      obj.self = obj;
      expect(security.safeJsonStringify(obj)).toContain('[Circular]');
    });

    test('removes prototype pollution keys', () => {
      const obj = {
        safe: 'value',
        __proto__: { polluted: true },
        constructor: { alsoPolluted: true },
      };
      const result = security.safeJsonStringify(obj);
      expect(result).not.toContain('polluted');
      expect(result).not.toContain('alsoPolluted');
    });

    test('truncates oversized output', () => {
      const obj = { data: 'x'.repeat(200000) };
      const result = security.safeJsonStringify(obj, 100);
      const parsed = JSON.parse(result);
      expect(parsed._truncated).toBe(true);
    });

    test('handles stringification errors gracefully', () => {
      const obj = {};
      obj.a = obj;
      obj.b = obj;
      // Should not throw, should return error object
      expect(security.safeJsonStringify(obj)).toContain('[Circular]');
    });
  });
});
