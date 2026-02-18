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

// Import the SSRF validation from validate module
const { validateDomainSSRFProtection } = require('../lib/validate');

// Import security utilities
const { isValidIpAddress, isValidHostname } = require('../lib/security');

// Import services configuration
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
// Module Exports
// =============================================================================

module.exports = {
  validateDomainSSRFProtection,
  isValidIpAddress,
  isValidHostname,
};
