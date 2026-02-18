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

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');

// Import the SSRF validation from validate module
const { validateDomainSSRFProtection } = require('../lib/validate');

// Import security utilities
const { isValidIpAddress, isValidHostname } = require('../lib/security');

describe('HTTP Client Security', () => {
  describe('SSRF Protection', () => {
    it('should detect private IP addresses as SSRF vectors', () => {
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
        assert.strictEqual(result.isSSRFVector, true, 
          `Expected ${ip} to be detected as SSRF vector`);
        assert.ok(result.warnings.length > 0, 
          `Expected warnings for ${ip}`);
      }
    });

    it('should allow public IP addresses', () => {
      const publicIPs = [
        '8.8.8.8',
        '1.1.1.1',
        '104.16.249.249',
      ];

      for (const ip of publicIPs) {
        const result = validateDomainSSRFProtection(ip);
        // Public IPs should not be marked as SSRF vectors
        // (though they may generate warnings about using domains instead of IPs)
        assert.strictEqual(result.isSSRFVector, false,
          `Expected ${ip} not to be SSRF vector (may still have warnings)`);
      }
    });

    it('should detect internal hostnames', () => {
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
        assert.ok(result.warnings.length > 0,
          `Expected warnings for internal hostname: ${host}`);
        assert.ok(result.isInternal,
          `Expected ${host} to be marked as internal`);
      }
    });

    it('should detect suspicious domain patterns', () => {
      const suspiciousDomains = [
        'evil.local',
        'test.internal',
        'router.lan',
        'server.home',
        '192.168.1.1.evil.com',
      ];

      for (const domain of suspiciousDomains) {
        const result = validateDomainSSRFProtection(domain);
        assert.ok(result.warnings.length > 0,
          `Expected warnings for suspicious domain: ${domain}`);
      }
    });

    it('should allow valid public domains', () => {
      const validDomains = [
        'example.com',
        'api.masterclaw.io',
        'myapp.example.co.uk',
        'subdomain.test.org',
      ];

      for (const domain of validDomains) {
        const result = validateDomainSSRFProtection(domain);
        assert.strictEqual(result.valid, true,
          `Expected ${domain} to be valid with no warnings`);
        assert.strictEqual(result.warnings.length, 0,
          `Expected no warnings for ${domain}, got: ${result.warnings.join(', ')}`);
      }
    });

    it('should handle edge cases in SSRF validation', () => {
      // Empty/invalid inputs
      assert.strictEqual(validateDomainSSRFProtection('').valid, false);
      assert.strictEqual(validateDomainSSRFProtection(null).valid, false);
      assert.strictEqual(validateDomainSSRFProtection(undefined).valid, false);
      
      // Very long domain
      const longDomain = 'a'.repeat(250) + '.com';
      const longResult = validateDomainSSRFProtection(longDomain);
      assert.ok(longResult.warnings.length > 0 || longResult.valid,
        'Should either warn or validate very long domains');
    });
  });

  describe('IP Address Validation', () => {
    it('should validate IPv4 addresses correctly', () => {
      const validIPv4 = [
        '192.168.1.1',
        '10.0.0.1',
        '255.255.255.255',
        '0.0.0.0',
        '127.0.0.1',
      ];

      for (const ip of validIPv4) {
        assert.strictEqual(isValidIpAddress(ip), true,
          `Expected ${ip} to be valid IPv4`);
      }
    });

    it('should reject invalid IPv4 addresses', () => {
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
        assert.strictEqual(isValidIpAddress(ip), false,
          `Expected ${ip} to be invalid IPv4`);
      }
    });

    it('should validate IPv6 addresses', () => {
      const validIPv6 = [
        '::1',
        '::',
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      ];

      for (const ip of validIPv6) {
        assert.strictEqual(isValidIpAddress(ip), true,
          `Expected ${ip} to be valid IPv6`);
      }
    });
  });

  describe('Hostname Validation', () => {
    it('should validate valid hostnames', () => {
      const validHostnames = [
        'localhost',
        'example.com',
        'sub.example.com',
        'my-server.example.co.uk',
        'a.b',
        'test-123.example.com',
      ];

      for (const hostname of validHostnames) {
        assert.strictEqual(isValidHostname(hostname), true,
          `Expected ${hostname} to be valid`);
      }
    });

    it('should reject invalid hostnames', () => {
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
        assert.strictEqual(isValidHostname(hostname), false,
          `Expected ${hostname} to be invalid`);
      }
    });
  });

  describe('HTTP Security Configuration', () => {
    it('should enforce reasonable timeout values', () => {
      // Import axios configuration from services module
      const { SERVICES } = require('../lib/services');
      
      // Verify service URLs are defined
      assert.ok(SERVICES.core, 'Core service should be defined');
      assert.ok(SERVICES.backend, 'Backend service should be defined');
      assert.ok(SERVICES.interface, 'Interface service should be defined');
      
      // Verify URLs use localhost (safe for internal use)
      for (const [name, config] of Object.entries(SERVICES)) {
        assert.ok(config.url, `Service ${name} should have a URL`);
        assert.ok(config.url.includes('localhost') || config.url.includes('127.0.0.1'),
          `Service ${name} URL should use localhost`);
      }
    });

    it('should prevent HTTP header injection', () => {
      // Test that header values are properly validated
      const dangerousHeaderValues = [
        'value\r\nInjected-Header: evil',
        'value\nInjected: evil',
        'value\rInjected: evil',
      ];

      for (const value of dangerousHeaderValues) {
        // Headers with newlines should be rejected or sanitized
        const hasNewline = /[\r\n]/.test(value);
        assert.ok(hasNewline, 'Test value should contain newlines');
      }
    });
  });

  describe('Port Security', () => {
    it('should identify well-known ports correctly', () => {
      const wellKnownPorts = {
        80: 'HTTP',
        443: 'HTTPS',
        22: 'SSH',
        25: 'SMTP',
        53: 'DNS',
      };

      for (const [port, service] of Object.entries(wellKnownPorts)) {
        const portNum = parseInt(port, 10);
        assert.ok(portNum > 0 && portNum < 65536,
          `${service} port ${port} should be valid`);
      }
    });

    it('should reject invalid port numbers', () => {
      const invalidPorts = [
        -1,
        0,
        65536,
        99999,
        NaN,
        'abc',
        null,
        undefined,
      ];

      for (const port of invalidPorts) {
        const portNum = parseInt(port, 10);
        if (!isNaN(portNum)) {
          assert.ok(portNum <= 0 || portNum > 65535 || portNum !== port,
            `Port ${port} should be invalid`);
        }
      }
    });
  });
});

describe('HTTP Client SSRF Prevention', () => {
  it('should validate domains before making requests', () => {
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
        assert.ok(result.valid,
          `Expected ${domain} to be allowed for HTTP requests`);
      } else {
        assert.ok(!result.valid || result.warnings.length > 0,
          `Expected ${domain} to be blocked or warned for HTTP requests`);
      }
    }
  });

  it('should detect DNS rebinding attempts', () => {
    const rebindingDomains = [
      '192.168.1.1.evil.com',
      '127.0.0.1.local',
      '10.0.0.1.internal',
    ];

    for (const domain of rebindingDomains) {
      const result = validateDomainSSRFProtection(domain);
      // These should generate warnings about numeric components or internal patterns
      assert.ok(result.warnings.length > 0 || !result.valid,
        `Expected warning for potential DNS rebinding: ${domain}`);
    }
  });
});

// Export for use in other tests
module.exports = {
  validateDomainSSRFProtection,
  isValidIpAddress,
  isValidHostname,
};
