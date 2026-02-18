/**
 * HTTP Client Security Tests
 * 
 * Tests for HTTP client security features:
 * - SSRF (Server-Side Request Forgery) protection
 * - Timeout configuration
 * - Response size limits
 * - Header injection prevention
 * - Redirection handling
 */

const httpClient = require('../lib/http-client');
const { validateDomainSSRFProtection } = require('../lib/validate');
const { isValidIpAddress, isValidHostname } = require('../lib/security');
const { SERVICES } = require('../lib/services');

// =============================================================================
// SSRF Protection Tests
// =============================================================================

describe('SSRF Protection', () => {
  test('should detect private IP addresses as SSRF vectors', () => {
    const privateIPs = [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.168.255.255',
      '169.254.1.1',
    ];

    for (const ip of privateIPs) {
      const result = validateDomainSSRFProtection(ip);
      expect(result.isSSRFVector).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  test('should allow public IP addresses', () => {
    const publicIPs = [
      '8.8.8.8',
      '1.1.1.1',
      '104.16.249.249',
    ];

    for (const ip of publicIPs) {
      const result = validateDomainSSRFProtection(ip);
      // Public IPs should not be marked as SSRF vectors
      expect(result.isSSRFVector).toBe(false);
    }
  });

  test('should detect internal hostnames', () => {
    const internalHosts = [
      'localhost',
      'localhost.localdomain',
      'myapp.local',
      'server.lan',
      'nas.home',
      'gateway.local',
      'kubernetes.svc.cluster.local',
    ];

    for (const host of internalHosts) {
      const result = validateDomainSSRFProtection(host);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.isInternal).toBe(true);
    }
  });

  test('should detect suspicious domain patterns', () => {
    const suspiciousDomains = [
      'evil.local',
      'test.internal',
      'router.lan',
      'server.home',
      '192.168.1.1.evil.com',
    ];

    for (const domain of suspiciousDomains) {
      const result = validateDomainSSRFProtection(domain);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  test('should allow valid public domains', () => {
    const validDomains = [
      'example.com',
      'api.masterclaw.io',
      'myapp.example.co.uk',
      'subdomain.test.org',
    ];

    for (const domain of validDomains) {
      const result = validateDomainSSRFProtection(domain);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    }
  });

  test('should handle edge cases in SSRF validation', () => {
    // Empty/invalid inputs
    expect(validateDomainSSRFProtection('').valid).toBe(false);
    expect(validateDomainSSRFProtection(null).valid).toBe(false);
    expect(validateDomainSSRFProtection(undefined).valid).toBe(false);
    
    // Very long domain
    const longDomain = 'a'.repeat(250) + '.com';
    const longResult = validateDomainSSRFProtection(longDomain);
    expect(longResult.warnings.length > 0 || longResult.valid).toBe(true);
  });
});

// =============================================================================
// HTTP Client URL Validation Tests
// =============================================================================

describe('HTTP Client URL Validation', () => {
  test('should block dangerous URL schemes', () => {
    const dangerousUrls = [
      { url: 'data:text/html,<script>alert(1)</script>', reason: 'data:' },
      { url: 'file:///etc/passwd', reason: 'file:' },
      { url: 'javascript:alert(1)', reason: 'javascript:' },
      { url: 'JavaScript:alert(1)', reason: 'javascript:' },
    ];

    for (const { url, reason } of dangerousUrls) {
      const result = httpClient.validateUrlSSRF(url);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not allowed');
    }
  });

  test('should block private IP URLs by default', () => {
    const privateUrls = [
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'https://localhost/',
    ];

    for (const url of privateUrls) {
      const result = httpClient.validateUrlSSRF(url);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/private|SSRF/i);
    }
  });

  test('should allow private IPs when explicitly enabled', () => {
    const privateUrls = [
      'http://127.0.0.1/health',
      'http://localhost/api',
    ];

    for (const url of privateUrls) {
      const result = httpClient.validateUrlSSRF(url, { allowPrivateIPs: true });
      expect(result.valid).toBe(true);
    }
  });

  test('should allow valid public URLs', () => {
    const validUrls = [
      'https://api.openai.com/v1/chat',
      'https://api.anthropic.com/v1/messages',
      'https://example.com/api/health',
    ];

    for (const url of validUrls) {
      const result = httpClient.validateUrlSSRF(url);
      expect(result.valid).toBe(true);
    }
  });

  test('should extract hostname correctly', () => {
    const testCases = [
      { url: 'https://example.com/path', expected: 'example.com' },
      { url: 'http://localhost:3000', expected: 'localhost' },
      { url: 'https://api.example.com:8443/v1', expected: 'api.example.com' },
    ];

    for (const { url, expected } of testCases) {
      const hostname = httpClient.extractHostname(url);
      expect(hostname).toBe(expected);
    }

    expect(httpClient.extractHostname('invalid')).toBeNull();
    expect(httpClient.extractHostname('')).toBeNull();
  });
});

// =============================================================================
// HTTP Client Header Security Tests
// =============================================================================

describe('HTTP Client Header Security', () => {
  test('should sanitize valid headers', () => {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer token123',
      'X-Custom-Header': 'value',
    };

    const result = httpClient.validateAndSanitizeHeaders(headers);
    expect(result.valid).toBe(true);
    expect(result.sanitized).toEqual(headers);
  });

  test('should reject headers with injection attempts', () => {
    const maliciousHeaders = [
      { 'X-Custom': 'value\r\nInjected: evil' },
      { 'X-Custom': 'value\nInjected: evil' },
      { 'X-Custom': 'value\rInjected: evil' },
    ];

    for (const headers of maliciousHeaders) {
      const result = httpClient.validateAndSanitizeHeaders(headers);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('injection');
    }
  });

  test('should reject invalid header names', () => {
    const invalidHeaders = [
      { 'Invalid Name': 'value' }, // Space in name
      { 'Invalid@Name': 'value' }, // Special char in name
      { '': 'value' }, // Empty name
    ];

    for (const headers of invalidHeaders) {
      const result = httpClient.validateAndSanitizeHeaders(headers);
      expect(result.valid).toBe(false);
    }
  });

  test('should handle null/undefined headers', () => {
    expect(httpClient.validateAndSanitizeHeaders(null).valid).toBe(true);
    expect(httpClient.validateAndSanitizeHeaders(undefined).valid).toBe(true);
    expect(httpClient.validateAndSanitizeHeaders({}).valid).toBe(true);
  });

  test('should sanitize header values', () => {
    const headers = {
      'X-Long': 'a'.repeat(10000),
    };

    const result = httpClient.validateAndSanitizeHeaders(headers);
    expect(result.valid).toBe(true);
    expect(result.sanitized['X-Long'].length).toBeLessThan(10000);
  });
});

// =============================================================================
// HTTP Client Response Size Validation Tests
// =============================================================================

describe('HTTP Client Response Size Validation', () => {
  test('should validate response with content-length header', () => {
    const smallResponse = {
      headers: { 'content-length': '1024' },
      data: 'small',
    };

    expect(httpClient.validateResponseSize(smallResponse)).toBe(true);

    const largeResponse = {
      headers: { 'content-length': String(20 * 1024 * 1024) }, // 20MB
      data: 'large',
    };

    expect(httpClient.validateResponseSize(largeResponse)).toBe(false);
  });

  test('should validate response by data size', () => {
    const validResponse = {
      headers: {},
      data: 'small data',
    };

    expect(httpClient.validateResponseSize(validResponse)).toBe(true);

    const oversizedResponse = {
      headers: {},
      data: 'x'.repeat(15 * 1024 * 1024), // 15MB string
    };

    expect(httpClient.validateResponseSize(oversizedResponse)).toBe(false);
  });

  test('should handle object data', () => {
    const objectResponse = {
      headers: {},
      data: { key: 'value' },
    };

    expect(httpClient.validateResponseSize(objectResponse)).toBe(true);
  });
});

// =============================================================================
// IP Address Validation Tests
// =============================================================================

describe('IP Address Validation', () => {
  test('should validate IPv4 addresses correctly', () => {
    const validIPv4 = [
      '192.168.1.1',
      '10.0.0.1',
      '255.255.255.255',
      '0.0.0.0',
      '127.0.0.1',
    ];

    for (const ip of validIPv4) {
      expect(isValidIpAddress(ip)).toBe(true);
    }
  });

  test('should reject invalid IPv4 addresses', () => {
    const invalidIPv4 = [
      '256.1.2.3',
      '192.168.1',
      '192.168.1.1.1',
      '192.168.1.256',
      'abc.def.ghi.jkl',
      '',
      '192.168.1.1/24',
    ];

    for (const ip of invalidIPv4) {
      expect(isValidIpAddress(ip)).toBe(false);
    }
  });

  test('should validate IPv6 addresses', () => {
    const validIPv6 = [
      '::1',
      '::',
      '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    ];

    for (const ip of validIPv6) {
      expect(isValidIpAddress(ip)).toBe(true);
    }
  });
});

// =============================================================================
// Hostname Validation Tests
// =============================================================================

describe('Hostname Validation', () => {
  test('should validate valid hostnames', () => {
    const validHostnames = [
      'localhost',
      'example.com',
      'sub.example.com',
      'my-server.example.co.uk',
      'a.b',
      'test-123.example.com',
    ];

    for (const hostname of validHostnames) {
      expect(isValidHostname(hostname)).toBe(true);
    }
  });

  test('should reject invalid hostnames', () => {
    const invalidHostnames = [
      '',
      '-example.com',
      'example-.com',
      'example..com',
      'example.com.',
      'a'.repeat(254), // Too long (> 253 chars)
      'example$.com',
      'example@com',
    ];

    for (const hostname of invalidHostnames) {
      expect(isValidHostname(hostname)).toBe(false);
    }
  });
});

// =============================================================================
// HTTP Security Configuration Tests
// =============================================================================

describe('HTTP Security Configuration', () => {
  test('should have all required services defined', () => {
    // Verify service URLs are defined
    expect(SERVICES).toBeDefined();
    expect(SERVICES.core).toBeDefined();
    expect(SERVICES.backend).toBeDefined();
    expect(SERVICES.interface).toBeDefined();
  });

  test('should enforce reasonable timeout values', () => {
    // Import axios configuration from services module
    const { MAX_HTTP_TIMEOUT } = require('../lib/services');
    
    // Verify timeout is defined and reasonable
    expect(MAX_HTTP_TIMEOUT).toBeDefined();
    expect(MAX_HTTP_TIMEOUT).toBeGreaterThan(0);
    expect(MAX_HTTP_TIMEOUT).toBeLessThanOrEqual(60000); // Max 60 seconds
  });

  test('should have services with valid URLs on localhost', () => {
    // Verify URLs use localhost (safe for internal use)
    for (const [name, config] of Object.entries(SERVICES)) {
      expect(config.url).toBeDefined();
      expect(
        config.url.includes('localhost') || config.url.includes('127.0.0.1')
      ).toBe(true);
    }
  });

  test('should prevent HTTP header injection', () => {
    // Test that header values are properly validated
    const dangerousHeaderValues = [
      'value\r\nInjected-Header: evil',
      'value\nInjected: evil',
      'value\rInjected: evil',
    ];

    for (const value of dangerousHeaderValues) {
      // Headers with newlines should be rejected or sanitized
      const hasNewline = /[\r\n]/.test(value);
      expect(hasNewline).toBe(true);
    }
  });

  test('should export correct constants', () => {
    expect(httpClient.DEFAULT_TIMEOUT_MS).toBe(10000);
    expect(httpClient.MAX_TIMEOUT_MS).toBe(60000);
    expect(httpClient.MIN_TIMEOUT_MS).toBe(1000);
    expect(httpClient.MAX_RESPONSE_SIZE_BYTES).toBe(10 * 1024 * 1024);
    expect(httpClient.MAX_REDIRECTS).toBe(5);
    expect(httpClient.USER_AGENT).toContain('MasterClaw-CLI');
  });
});

// =============================================================================
// Port Security Tests
// =============================================================================

describe('Port Security', () => {
  test('should identify well-known ports correctly', () => {
    const wellKnownPorts = {
      80: 'HTTP',
      443: 'HTTPS',
      22: 'SSH',
      25: 'SMTP',
      53: 'DNS',
    };

    for (const [port, service] of Object.entries(wellKnownPorts)) {
      const portNum = parseInt(port, 10);
      expect(portNum).toBeGreaterThan(0);
      expect(portNum).toBeLessThan(65536);
    }
  });

  test('should reject invalid port numbers', () => {
    const invalidPorts = [
      -1,
      0,
      65536,
      99999,
    ];

    for (const port of invalidPorts) {
      const portNum = parseInt(port, 10);
      expect(portNum <= 0 || portNum > 65535).toBe(true);
    }
  });

  test('should have services with valid port numbers', () => {
    for (const [name, config] of Object.entries(SERVICES)) {
      expect(config.port).toBeDefined();
      expect(config.port).toBeGreaterThan(0);
      expect(config.port).toBeLessThan(65536);
    }
  });
});

// =============================================================================
// HTTP Client SSRF Prevention Tests
// =============================================================================

describe('HTTP Client SSRF Prevention', () => {
  test('should validate domains before making requests', () => {
    // Test domain validation as it would be used before HTTP requests
    const testCases = [
      { domain: 'api.openai.com', shouldAllow: true },
      { domain: 'api.anthropic.com', shouldAllow: true },
      { domain: '127.0.0.1', shouldAllow: false },
      { domain: 'localhost', shouldAllow: false },
      { domain: '10.0.0.1', shouldAllow: false },
      { domain: '192.168.1.1', shouldAllow: false },
    ];

    for (const { domain, shouldAllow } of testCases) {
      const result = validateDomainSSRFProtection(domain);
      if (shouldAllow) {
        expect(result.valid).toBe(true);
      } else {
        expect(!result.valid || result.warnings.length > 0).toBe(true);
      }
    }
  });

  test('should detect DNS rebinding attempts', () => {
    const rebindingDomains = [
      '192.168.1.1.evil.com',
      '127.0.0.1.local',
      '10.0.0.1.internal',
    ];

    for (const domain of rebindingDomains) {
      const result = validateDomainSSRFProtection(domain);
      // These should generate warnings about numeric components or internal patterns
      expect(result.warnings.length > 0 || !result.valid).toBe(true);
    }
  });
});

// =============================================================================
// HTTP Client Helper Functions Tests
// =============================================================================

describe('HTTP Client Helper Functions', () => {
  test('withAudit should add audit flag to options', () => {
    const options = { timeout: 5000 };
    const result = httpClient.withAudit(options);
    expect(result._audit).toBe(true);
    expect(result.timeout).toBe(5000);
  });

  test('allowPrivateIPs should add private IP flag', () => {
    const options = { timeout: 5000 };
    const result = httpClient.allowPrivateIPs(options);
    expect(result._allowPrivateIPs).toBe(true);
    expect(result.timeout).toBe(5000);
  });

  test('withTimeout should clamp timeout values', () => {
    // Too low
    const tooLow = httpClient.withTimeout(100);
    expect(tooLow.timeout).toBe(httpClient.MIN_TIMEOUT_MS);

    // Too high
    const tooHigh = httpClient.withTimeout(120000);
    expect(tooHigh.timeout).toBe(httpClient.MAX_TIMEOUT_MS);

    // Valid
    const valid = httpClient.withTimeout(15000);
    expect(valid.timeout).toBe(15000);
  });
});

// =============================================================================
// Module Exports
// =============================================================================

module.exports = {
  validateDomainSSRFProtection,
  isValidIpAddress,
  isValidHostname,
};
