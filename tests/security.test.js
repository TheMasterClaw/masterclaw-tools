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

    test('returns null for non-string input', () => {
      expect(security.safeJsonParse(null)).toBeNull();
      expect(security.safeJsonParse(undefined)).toBeNull();
      expect(security.safeJsonParse(123)).toBeNull();
      expect(security.safeJsonParse({})).toBeNull();
      expect(security.safeJsonParse([])).toBeNull();
    });

    test('enforces depth limit correctly', () => {
      // Depth 5: {"a":{"b":{"c":{"d":{"e":"deep"}}}}}
      const deepObject = JSON.stringify({ a: { b: { c: { d: { e: 'deep' } } } } });
      expect(security.safeJsonParse(deepObject, 3)).toBeNull();
      expect(security.safeJsonParse(deepObject, 4)).toBeNull();
      expect(security.safeJsonParse(deepObject, 5)).toEqual({ a: { b: { c: { d: { e: 'deep' } } } } });
      expect(security.safeJsonParse(deepObject, 10)).toEqual({ a: { b: { c: { d: { e: 'deep' } } } } });
    });

    test('enforces depth limit for arrays', () => {
      const deepArray = JSON.stringify([[[[[1]]]]]);
      expect(security.safeJsonParse(deepArray, 3)).toBeNull();
      expect(security.safeJsonParse(deepArray, 5)).toEqual([[[[[1]]]]]);
    });

    test('enforces maximum input size', () => {
      const hugeString = '{"' + 'x'.repeat(security.MAX_JSON_STRING_LENGTH) + '":1}';
      expect(security.safeJsonParse(hugeString)).toBeNull();
    });

    test('prevents prototype pollution via __proto__', () => {
      const malicious = '{"__proto__":{"polluted":true}}';
      const result = security.safeJsonParse(malicious);
      expect(result).toBeNull();
    });

    test('prevents prototype pollution via constructor', () => {
      const malicious = '{"constructor":{"prototype":{"polluted":true}}}';
      const result = security.safeJsonParse(malicious);
      expect(result).toBeNull();
    });

    test('prevents prototype pollution via prototype property', () => {
      const malicious = '{"prototype":{"polluted":true}}';
      const result = security.safeJsonParse(malicious);
      expect(result).toBeNull();
    });

    test('allows prototype keys when explicitly permitted', () => {
      const malicious = '{"__proto__":{"allowed":true}}';
      const result = security.safeJsonParse(malicious, 100, true);
      expect(result.__proto__).toEqual({ allowed: true });
    });

    test('handles deeply nested malicious objects with prototype pollution', () => {
      // Raw JSON string with __proto__ as a key (not using JSON.stringify)
      const malicious = '{"a":{"__proto__":{"injected":true},"b":{"c":"value"}}}';
      const result = security.safeJsonParse(malicious);
      // Since __proto__ is detected anywhere in the JSON, the whole thing is rejected
      expect(result).toBeNull();
    });

    test('handles strings containing braces correctly', () => {
      const json = '{"msg":"Hello {world}!","code":"{123}"}';
      const result = security.safeJsonParse(json);
      expect(result).toEqual({ msg: 'Hello {world}!', code: '{123}' });
    });

    test('handles escaped quotes correctly', () => {
      const json = '{"msg":"She said \\"Hello\\" to me"}';
      const result = security.safeJsonParse(json);
      expect(result).toEqual({ msg: 'She said "Hello" to me' });
    });

    test('handles empty objects and arrays', () => {
      expect(security.safeJsonParse('{}')).toEqual({});
      expect(security.safeJsonParse('[]')).toEqual([]);
    });

    test('handles null and primitive values', () => {
      expect(security.safeJsonParse('null')).toBeNull();
      expect(security.safeJsonParse('42')).toBe(42);
      expect(security.safeJsonParse('"string"')).toBe('string');
      expect(security.safeJsonParse('true')).toBe(true);
    });
  });

  // ===========================================================================
  // Safe JSON Helper Tests
  // ===========================================================================
  describe('getJsonDepth', () => {
    test('calculates depth for simple objects', () => {
      expect(security.getJsonDepth('{}')).toBe(1);
      expect(security.getJsonDepth('{"a":1}')).toBe(1);
      expect(security.getJsonDepth('{"a":{"b":1}}')).toBe(2);
      expect(security.getJsonDepth('{"a":{"b":{"c":1}}}')).toBe(3);
    });

    test('calculates depth for nested arrays', () => {
      expect(security.getJsonDepth('[]')).toBe(1);
      expect(security.getJsonDepth('[1,2,3]')).toBe(1);
      expect(security.getJsonDepth('[[1]]')).toBe(2);
      expect(security.getJsonDepth('[[[1,2],[3,4]]]')).toBe(3);
    });

    test('calculates depth for mixed structures', () => {
      expect(security.getJsonDepth('{"a":[1,2]}')).toBe(2);
      expect(security.getJsonDepth('[{"a":{"b":1}}]')).toBe(3);
      // {"a":[{"b":[{"c":1}}]}]} - outer obj(1) > a(1) > array(2) > obj(3) > b(3) > array(4) > obj(5)
      expect(security.getJsonDepth('{"a":[{"b":[{"c":1}]}]}')).toBe(5);
    });

    test('ignores braces inside strings', () => {
      expect(security.getJsonDepth('{"msg":"{not nested}"}')).toBe(1);
      expect(security.getJsonDepth('{"a":"{b:{c}}"}')).toBe(1);
      expect(security.getJsonDepth('{"a":{"b":"[not array]"}}')).toBe(2);
    });

    test('handles escaped quotes correctly', () => {
      expect(security.getJsonDepth('{"a":"Say \\"hello\\" to {me}"}')).toBe(1);
    });

    test('returns 0 for empty string', () => {
      expect(security.getJsonDepth('')).toBe(0);
    });

    test('handles complex nested structures', () => {
      const complex = JSON.stringify({
        level1: {
          level2: {
            level3: {
              level4: {
                level5: 'deep'
              }
            }
          }
        }
      });
      expect(security.getJsonDepth(complex)).toBe(5);
    });
  });

  describe('hasProtoPollutionKeys', () => {
    test('detects __proto__ key', () => {
      expect(security.hasProtoPollutionKeys('{"__proto__":{"polluted":true}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"a":{"__proto__":{}}}')).toBe(true);
    });

    test('detects constructor key', () => {
      expect(security.hasProtoPollutionKeys('{"constructor":{"prototype":{}}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"a":{"constructor":{}}}')).toBe(true);
    });

    test('detects prototype key', () => {
      expect(security.hasProtoPollutionKeys('{"prototype":{"polluted":true}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"a":{"prototype":{}}}')).toBe(true);
    });

    test('is case insensitive', () => {
      expect(security.hasProtoPollutionKeys('{"__PROTO__":{}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"Constructor":{}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"PROTOTYPE":{}}')).toBe(true);
    });

    test('ignores keys in string values', () => {
      expect(security.hasProtoPollutionKeys('{"msg":"__proto__ is not a key here"}')).toBe(false);
      expect(security.hasProtoPollutionKeys('{"data":"constructor string"}')).toBe(false);
    });

    test('allows safe JSON without dangerous keys', () => {
      expect(security.hasProtoPollutionKeys('{"key":"value"}')).toBe(false);
      expect(security.hasProtoPollutionKeys('[1,2,3]')).toBe(false);
      expect(security.hasProtoPollutionKeys('{"__proto_safe__":true}')).toBe(false);
    });

    test('handles whitespace around keys', () => {
      expect(security.hasProtoPollutionKeys('{"__proto__" : {"polluted":true}}')).toBe(true);
      expect(security.hasProtoPollutionKeys('{"constructor"  :  {}}')).toBe(true);
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

  // ===========================================================================
  // Security Constants Tests
  // ===========================================================================
  describe('Security Constants', () => {
    test('MAX_SAFE_LOG_LENGTH is defined', () => {
      expect(security.MAX_SAFE_LOG_LENGTH).toBe(10000);
    });

    test('MAX_JSON_STRING_LENGTH is defined', () => {
      expect(security.MAX_JSON_STRING_LENGTH).toBe(10 * 1024 * 1024);
    });

    test('LOG_INJECTION_CHARS is defined', () => {
      expect(security.LOG_INJECTION_CHARS).toBeInstanceOf(RegExp);
    });

    test('LOG_NEWLINE_CHARS is defined', () => {
      expect(security.LOG_NEWLINE_CHARS).toBeInstanceOf(RegExp);
    });

    test('DANGEROUS_PROTO_KEYS contains expected keys', () => {
      expect(security.DANGEROUS_PROTO_KEYS).toContain('__proto__');
      expect(security.DANGEROUS_PROTO_KEYS).toContain('constructor');
      expect(security.DANGEROUS_PROTO_KEYS).toContain('prototype');
    });
  });
});
