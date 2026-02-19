/**
 * http-client.dns-rebinding.test.js - Tests for DNS Rebinding Protection
 *
 * Tests the DNS rebinding attack protection in the HTTP client:
 * - DNS resolution validation
 * - Private IP detection after resolution
 * - Timeout handling for DNS lookups
 * - Audit logging of DNS rebinding attempts
 */

const httpClient = require('../lib/http-client');
const { logAudit } = require('../lib/audit');

// Mock dependencies
jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
  AuditEventType: {
    SECURITY_VIOLATION: 'SECURITY_VIOLATION',
    EXTERNAL_CALL: 'EXTERNAL_CALL',
  },
  Severity: {
    CRITICAL: 'critical',
    WARNING: 'warning',
    DEBUG: 'debug',
  },
}));

jest.mock('../lib/correlation', () => ({
  getCurrentCorrelationId: jest.fn().mockReturnValue('test-correlation-id'),
}));

// Mock dns module
const mockDnsLookup = jest.fn();
jest.mock('dns', () => ({
  lookup: jest.fn((...args) => mockDnsLookup(...args)),
}));

describe('HTTP Client - DNS Rebinding Protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDnsLookup.mockReset();
  });

  describe('isPrivateIP', () => {
    const { isPrivateIP } = httpClient;

    it('should detect loopback addresses', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true);
      expect(isPrivateIP('127.255.255.255')).toBe(true);
      expect(isPrivateIP('127.0.0.53')).toBe(true);
    });

    it('should detect private class A addresses', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true);
      expect(isPrivateIP('10.255.255.255')).toBe(true);
    });

    it('should detect private class B addresses', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true);
      expect(isPrivateIP('172.31.255.255')).toBe(true);
    });

    it('should detect private class C addresses', () => {
      expect(isPrivateIP('192.168.0.1')).toBe(true);
      expect(isPrivateIP('192.168.255.255')).toBe(true);
    });

    it('should detect link-local addresses', () => {
      expect(isPrivateIP('169.254.0.1')).toBe(true);
      expect(isPrivateIP('169.254.255.255')).toBe(true);
    });

    it('should detect IPv6 loopback', () => {
      expect(isPrivateIP('::1')).toBe(true);
    });

    it('should detect IPv6 unique local addresses', () => {
      expect(isPrivateIP('fc00::1')).toBe(true);
      expect(isPrivateIP('fc00:1234::')).toBe(true);
    });

    it('should detect IPv6 link-local addresses', () => {
      expect(isPrivateIP('fe80::1')).toBe(true);
      expect(isPrivateIP('fe80::1234:5678:90ab:cdef')).toBe(true);
    });

    it('should detect IPv4-mapped IPv6 private addresses', () => {
      expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true);
    });

    it('should allow public IP addresses', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false);
      expect(isPrivateIP('1.1.1.1')).toBe(false);
      expect(isPrivateIP('104.16.249.249')).toBe(false);
    });

    it('should detect current network addresses (0.x.x.x)', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true);
      expect(isPrivateIP('0.255.255.255')).toBe(true);
    });
  });

  describe('validateDNSRebinding', () => {
    const { validateDNSRebinding } = httpClient;

    it('should skip validation for direct IP addresses', async () => {
      const result = await validateDNSRebinding('8.8.8.8');
      expect(result.valid).toBe(true);
      expect(mockDnsLookup).not.toHaveBeenCalled();
    });

    it('should pass validation for domains resolving to public IPs', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '104.16.249.249', family: 4 });
      });

      const result = await validateDNSRebinding('example.com');
      expect(result.valid).toBe(true);
      expect(result.resolvedIP).toBe('104.16.249.249');
    });

    it('should reject domains resolving to private IPs (DNS rebinding attack)', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '192.168.1.1', family: 4 });
      });

      const result = await validateDNSRebinding('attacker.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('DNS rebinding protection');
      expect(result.error).toContain('192.168.1.1');
      expect(result.resolvedIP).toBe('192.168.1.1');
    });

    it('should reject domains resolving to loopback addresses', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '127.0.0.1', family: 4 });
      });

      const result = await validateDNSRebinding('localhost.attacker.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('127.0.0.1');
    });

    it('should allow private IPs when explicitly permitted', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '10.0.0.1', family: 4 });
      });

      const result = await validateDNSRebinding('internal.service', {
        allowPrivateIPs: true,
      });
      expect(result.valid).toBe(true);
      expect(result.resolvedIP).toBe('10.0.0.1');
    });

    it('should handle DNS lookup failures', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(new Error('DNS lookup failed'), null);
      });

      const result = await validateDNSRebinding('nonexistent.domain.xyz');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('DNS resolution failed');
    });

    it('should timeout on slow DNS lookups', async () => {
      // Simulate a slow DNS lookup that takes longer than timeout
      mockDnsLookup.mockImplementation(() => {
        return new Promise(() => {
          // Never resolves
        });
      });

      const result = await validateDNSRebinding('slow.domain.com');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('DNS resolution failed');
    }, 10000); // Allow 10s for timeout test
  });

  describe('Integration with HTTP Client', () => {
    it('should block requests to domains that resolve to private IPs', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '10.0.0.1', family: 4 });
      });

      await expect(
        httpClient.get('http://attacker-controlled-domain.com/data')
      ).rejects.toThrow(/DNS_REBINDING_VIOLATION|DNS Protection|DNS rebinding protection/i);

      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'SECURITY_VIOLATION',
          severity: 'critical',
          details: expect.objectContaining({
            violationType: 'DNS_REBINDING_ATTEMPT',
            resolvedIP: '10.0.0.1',
          }),
        })
      );
    });

    it('should allow requests to domains that resolve to public IPs', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '1.1.1.1', family: 4 });
      });

      // This will fail with connection error (no real server), but should pass DNS validation
      try {
        await httpClient.get('http://example-test-domain.com/data', { timeout: 100 });
      } catch (error) {
        // Expected to fail (no real server), but not with DNS_REBINDING_VIOLATION
        expect(error.code).not.toBe('DNS_REBINDING_VIOLATION');
      }
    });

    it('should allow private IPs when using allowPrivateIPs option', async () => {
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: '192.168.1.100', family: 4 });
      });

      // Should not throw DNS_REBINDING_VIOLATION when allowPrivateIPs is set
      try {
        await httpClient.get(
          'http://internal-service.local/data',
          httpClient.allowPrivateIPs({ timeout: 100 })
        );
      } catch (error) {
        expect(error.code).not.toBe('DNS_REBINDING_VIOLATION');
      }
    });
  });

  describe('DNS Lookup Timeout', () => {
    it('should use the configured DNS lookup timeout', () => {
      const { DNS_LOOKUP_TIMEOUT_MS } = httpClient;
      expect(DNS_LOOKUP_TIMEOUT_MS).toBe(5000); // 5 seconds default
    });
  });

  describe('IPv6 Support', () => {
    it('should detect IPv6 private addresses in DNS results', async () => {
      const { validateDNSRebinding } = httpClient;
      
      mockDnsLookup.mockImplementation((hostname, options, callback) => {
        callback(null, { address: 'fc00::1234', family: 6 });
      });

      const result = await validateDNSRebinding('ipv6-attacker.com');
      expect(result.valid).toBe(false);
      expect(result.resolvedIP).toBe('fc00::1234');
    });
  });
});
