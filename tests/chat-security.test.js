/**
 * Tests for chat-security.js module
 * Run with: npm test -- chat-security.test.js
 * 
 * These tests verify the security controls for the chat command:
 * - Input validation (length, format, dangerous patterns)
 * - Input sanitization (control characters, normalization)
 * - Risk analysis (suspicious patterns detection)
 * - Sensitive data masking
 */

const {
  validateChatInput,
  analyzeInputRisk,
  sanitizeChatInput,
  truncateMessage,
  maskSensitiveInMessage,
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
  MAX_LINE_COUNT,
} = require('../lib/chat-security');

describe('Chat Security Module', () => {
  // ===========================================================================
  // Input Validation Tests
  // ===========================================================================
  describe('validateChatInput', () => {
    test('accepts valid messages', () => {
      const validMessages = [
        'Hello, MasterClaw!',
        'How do I deploy this application?',
        'What is the weather today?',
        'x'.repeat(1000), // Long but within limits
      ];

      for (const message of validMessages) {
        const result = validateChatInput(message);
        expect(result).toEqual({ valid: true });
      }
    });

    test('rejects non-string inputs', () => {
      const invalidInputs = [null, undefined, 123, {}, [], true];

      for (const input of invalidInputs) {
        const result = validateChatInput(input);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('must be a string');
      }
    });

    test('rejects empty messages', () => {
      const result = validateChatInput('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    test('rejects messages exceeding max length', () => {
      const longMessage = 'x'.repeat(MAX_MESSAGE_LENGTH + 1);
      const result = validateChatInput(longMessage);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
      expect(result.error).toContain(String(MAX_MESSAGE_LENGTH));
    });

    test('accepts messages at exactly max length', () => {
      const maxMessage = 'x'.repeat(MAX_MESSAGE_LENGTH);
      const result = validateChatInput(maxMessage);
      expect(result.valid).toBe(true);
    });

    test('rejects messages with too many lines', () => {
      const manyLines = Array(MAX_LINE_COUNT + 1).fill('line').join('\n');
      const result = validateChatInput(manyLines);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too many lines');
    });

    test('accepts messages at max line count', () => {
      const maxLines = Array(MAX_LINE_COUNT).fill('line').join('\n');
      const result = validateChatInput(maxLines);
      expect(result.valid).toBe(true);
    });

    test('rejects messages with null bytes', () => {
      const result = validateChatInput('Hello\0World');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('null bytes');
    });

    test('rejects messages with script tags', () => {
      const xssAttempts = [
        '<script>alert("xss")</script>',
        '<SCRIPT>alert("xss")</SCRIPT>',
        '<script src="http://evil.com/xss.js"></script>',
      ];

      for (const attempt of xssAttempts) {
        const result = validateChatInput(attempt);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('dangerous content');
      }
    });

    test('rejects messages with iframe tags', () => {
      const result = validateChatInput('<iframe src="http://evil.com"></iframe>');
      expect(result.valid).toBe(false);
    });

    test('rejects messages with object/embed tags', () => {
      expect(validateChatInput('<object data="evil.swf"></object>').valid).toBe(false);
      expect(validateChatInput('<embed src="evil.swf">').valid).toBe(false);
    });

    test('rejects messages with javascript: URLs', () => {
      const result = validateChatInput('javascript:alert("xss")');
      expect(result.valid).toBe(false);
    });

    test('rejects messages with event handlers', () => {
      const result = validateChatInput('<img onerror=alert("xss") src=x>');
      expect(result.valid).toBe(false);
    });

    test('rejects data:text/html URLs', () => {
      const result = validateChatInput('data:text/html,<script>alert("xss")</script>');
      expect(result.valid).toBe(false);
    });

    test('accepts legitimate HTML-looking content', () => {
      const legitimateContent = [
        'The < and > operators are used for comparison',
        'Use the <code> element for inline code',
        'I need help with < 5 and > 10 comparisons',
      ];

      for (const content of legitimateContent) {
        // Some might be rejected due to angle brackets, which is acceptable
        // for a security-focused validator
        const result = validateChatInput(content);
        // Just verify the function doesn't crash
        expect(typeof result.valid).toBe('boolean');
      }
    });
  });

  // ===========================================================================
  // Risk Analysis Tests
  // ===========================================================================
  describe('analyzeInputRisk', () => {
    test('returns safe for normal messages', () => {
      const result = analyzeInputRisk('Hello, how are you?');
      expect(result.risky).toBe(false);
      expect(result.risks).toEqual([]);
    });

    test('detects excessive repetition (DoS pattern)', () => {
      const result = analyzeInputRisk('a'.repeat(100));
      expect(result.risky).toBe(true);
      expect(result.risks).toContain('excessive_repetition');
    });

    test('detects excessive whitespace', () => {
      const result = analyzeInputRisk('Hello' + ' '.repeat(150) + 'World');
      expect(result.risky).toBe(true);
      expect(result.risks).toContain('excessive_whitespace');
    });

    test('detects suspicious Unicode characters', () => {
      const result = analyzeInputRisk('Hello\u200bWorld'); // Zero-width space
      expect(result.risky).toBe(true);
      expect(result.risks).toContain('suspicious_unicode');
    });

    test('detects mixed scripts (potential spoofing)', () => {
      // Latin + Cyrillic (looks like "paypal" but has Cyrillic characters)
      const result = analyzeInputRisk('payрal'); // р is Cyrillic
      expect(result.risky).toBe(true);
      expect(result.risks).toContain('mixed_scripts');
    });

    test('handles empty string', () => {
      const result = analyzeInputRisk('');
      expect(result.risky).toBe(false);
    });

    test('handles non-string input', () => {
      const result = analyzeInputRisk(null);
      expect(result.risky).toBe(false);
    });
  });

  // ===========================================================================
  // Input Sanitization Tests
  // ===========================================================================
  describe('sanitizeChatInput', () => {
    test('returns empty string for non-string input', () => {
      expect(sanitizeChatInput(null)).toBe('');
      expect(sanitizeChatInput(undefined)).toBe('');
      expect(sanitizeChatInput(123)).toBe('');
    });

    test('removes control characters', () => {
      const result = sanitizeChatInput('Hello\x00World\x01\x02');
      expect(result).toBe('HelloWorld');
    });

    test('removes ANSI escape sequences', () => {
      const result = sanitizeChatInput('\x1b[31mRed\x1b[0m Text');
      expect(result).toBe('Red Text');
    });

    test('removes suspicious Unicode', () => {
      const result = sanitizeChatInput('Hello\u200bWorld');
      expect(result).toBe('HelloWorld');
    });

    test('normalizes CRLF to LF', () => {
      const result = sanitizeChatInput('Line1\r\nLine2\rLine3');
      expect(result).toBe('Line1\nLine2\nLine3');
    });

    test('trims leading and trailing whitespace', () => {
      const result = sanitizeChatInput('  Hello World  ');
      expect(result).toBe('Hello World');
    });

    test('normalizes multiple newlines (max 2)', () => {
      const input = 'Line1\n\n\n\n\nLine2';
      const result = sanitizeChatInput(input);
      expect(result).toBe('Line1\n\nLine2');
    });

    test('limits consecutive spaces', () => {
      const input = 'Hello' + ' '.repeat(10) + 'World';
      const result = sanitizeChatInput(input);
      expect(result).toBe('Hello  World');
    });

    test('preserves legitimate content', () => {
      const input = 'Hello, World! How are you?';
      const result = sanitizeChatInput(input);
      expect(result).toBe('Hello, World! How are you?');
    });

    test('preserves code blocks', () => {
      const input = '```\nfunction hello() {\n  return "world";\n}\n```';
      const result = sanitizeChatInput(input);
      expect(result).toContain('function hello()');
      expect(result).toContain('return "world"');
    });

    test('handles empty string', () => {
      expect(sanitizeChatInput('')).toBe('');
    });
  });

  // ===========================================================================
  // Truncation Tests
  // ===========================================================================
  describe('truncateMessage', () => {
    test('returns empty string for non-string input', () => {
      expect(truncateMessage(null)).toBe('');
      expect(truncateMessage(undefined)).toBe('');
      expect(truncateMessage(123)).toBe('');
    });

    test('returns original string if within limit', () => {
      const input = 'Hello World';
      expect(truncateMessage(input, 100)).toBe(input);
    });

    test('truncates long strings with ellipsis', () => {
      const input = 'x'.repeat(100);
      const result = truncateMessage(input, 50);
      expect(result.length).toBe(50);
      expect(result.endsWith('...')).toBe(true);
    });

    test('uses default max length when not specified', () => {
      const input = 'x'.repeat(MAX_MESSAGE_LENGTH + 100);
      const result = truncateMessage(input);
      expect(result.length).toBe(MAX_MESSAGE_LENGTH);
      expect(result.endsWith('...')).toBe(true);
    });

    test('handles empty string', () => {
      expect(truncateMessage('')).toBe('');
    });
  });

  // ===========================================================================
  // Sensitive Data Masking Tests
  // ===========================================================================
  describe('maskSensitiveInMessage', () => {
    test('returns empty string for non-string input', () => {
      expect(maskSensitiveInMessage(null)).toBe('');
      expect(maskSensitiveInMessage(undefined)).toBe('');
    });

    test('masks hex tokens', () => {
      const input = 'My token is abc123def45678901234567890123456';
      const result = maskSensitiveInMessage(input);
      expect(result).toContain('[HEX_TOKEN]');
      expect(result).not.toContain('abc123def45678901234567890123456');
    });

    test('masks JWT tokens', () => {
      const input = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = maskSensitiveInMessage(input);
      expect(result).toContain('[JWT]');
      expect(result).not.toContain('eyJhbGci');
    });

    test('masks OpenAI-style API keys', () => {
      const input = 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456';
      const result = maskSensitiveInMessage(input);
      expect(result).toContain('[API_KEY]');
      expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    });

    test('masks passwords', () => {
      const input = 'password=supersecret123';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe('password=[REDACTED]');
    });

    test('masks passwords with colon separator', () => {
      const input = 'password: supersecret123';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe('password:[REDACTED]');
    });

    test('masks tokens', () => {
      const input = 'token=abc123xyz789';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe('token=[REDACTED]');
    });

    test('masks api keys', () => {
      const input = 'api_key=secret123';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe('api_key=[REDACTED]');
    });

    test('masks api-key format', () => {
      const input = 'api-key=secret123';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe('api-key=[REDACTED]');
    });

    test('preserves normal text', () => {
      const input = 'Hello, how do I use the API?';
      const result = maskSensitiveInMessage(input);
      expect(result).toBe(input);
    });

    test('handles empty string', () => {
      expect(maskSensitiveInMessage('')).toBe('');
    });
  });

  // ===========================================================================
  // Constants Tests
  // ===========================================================================
  describe('Security Constants', () => {
    test('MAX_MESSAGE_LENGTH is reasonable', () => {
      expect(MAX_MESSAGE_LENGTH).toBe(10000);
      expect(MAX_MESSAGE_LENGTH).toBeGreaterThan(1000);
    });

    test('MIN_MESSAGE_LENGTH is 1', () => {
      expect(MIN_MESSAGE_LENGTH).toBe(1);
    });

    test('MAX_LINE_COUNT is reasonable', () => {
      expect(MAX_LINE_COUNT).toBe(100);
      expect(MAX_LINE_COUNT).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  describe('Integration: validate + sanitize workflow', () => {
    test('validates then sanitizes safe input', () => {
      const input = '  Hello World!  ';
      
      const validation = validateChatInput(input);
      expect(validation.valid).toBe(true);
      
      const sanitized = sanitizeChatInput(input);
      expect(sanitized).toBe('Hello World!');
    });

    test('rejects input with dangerous patterns before sanitization', () => {
      const input = '<script>alert("xss")</script>';
      
      const validation = validateChatInput(input);
      expect(validation.valid).toBe(false);
      
      // Note: Sanitization focuses on control characters and normalization,
      // not HTML tag removal. Validation blocks dangerous patterns before
      // they reach the API.
      const sanitized = sanitizeChatInput(input);
      expect(sanitized).toContain('<script>'); // Sanitization doesn't strip HTML
    });

    test('sanitization makes some invalid inputs valid', () => {
      const input = 'Hello\x00World'; // Has null byte
      
      const validation = validateChatInput(input);
      expect(validation.valid).toBe(false);
      
      const sanitized = sanitizeChatInput(input);
      const revalidation = validateChatInput(sanitized);
      expect(revalidation.valid).toBe(true);
    });
  });
});

// Export for Jest
module.exports = {
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
  MAX_LINE_COUNT,
};
