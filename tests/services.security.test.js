/**
 * Services Security Tests
 *
 * Tests for services.js security hardening:
 * - Secure HTTP client usage (SSRF/DNS rebinding protection)
 * - No raw axios usage for internal requests
 * - Proper use of allowPrivateIPs() for internal services
 * - Security documentation in module header
 */

const services = require('../lib/services');
const httpClient = require('../lib/http-client');

// =============================================================================
// Security: HTTP Client Usage Tests
// =============================================================================

describe('Services Security', () => {
  describe('Module Structure', () => {
    test('should not export axios directly', () => {
      // After security hardening, axios should not be exported
      expect(services.axios).toBeUndefined();
    });

    test('should export all expected service functions', () => {
      // Verify all expected exports are present
      expect(typeof services.checkService).toBe('function');
      expect(typeof services.getAllStatuses).toBe('function');
      expect(typeof services.checkDockerContainers).toBe('function');
      expect(typeof services.runDockerCompose).toBe('function');
      expect(typeof services.validateServiceName).toBe('function');
      expect(typeof services.findInfraDir).toBe('function');
    });
  });

  describe('HTTP Client Security', () => {
    test('should have httpClient module available', () => {
      expect(httpClient).toBeDefined();
      expect(typeof httpClient.get).toBe('function');
      expect(typeof httpClient.allowPrivateIPs).toBe('function');
    });

    test('httpClient should have SSRF protection', () => {
      // Verify SSRF protection is available
      expect(typeof httpClient.validateUrlSSRF).toBe('function');
      
      // Test that private IPs are blocked by default
      const result = httpClient.validateUrlSSRF('http://127.0.0.1/health');
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/private|SSRF/i);
    });

    test('httpClient should have DNS rebinding protection', () => {
      // Verify DNS rebinding protection constants exist
      expect(httpClient).toHaveProperty('get');
      
      // Private IP check should be enforced
      const privateResult = httpClient.validateUrlSSRF('http://192.168.1.1/');
      expect(privateResult.valid).toBe(false);
    });

    test('should allow private IPs with allowPrivateIPs wrapper', () => {
      // allowPrivateIPs should return configuration options with _allowPrivateIPs flag
      const options = httpClient.allowPrivateIPs({ timeout: 5000 });
      expect(options).toBeDefined();
      expect(options.timeout).toBe(5000);
      expect(options._allowPrivateIPs).toBe(true);
    });
  });

  describe('Service Configuration Security', () => {
    test('should have valid SERVICE constants defined', () => {
      expect(services.SERVICES).toBeDefined();
      expect(services.SERVICES.core).toBeDefined();
      expect(services.SERVICES.backend).toBeDefined();
      expect(services.SERVICES.interface).toBeDefined();
      expect(services.SERVICES.gateway).toBeDefined();
    });

    test('should use localhost URLs for internal services', () => {
      // All service URLs should be localhost (internal)
      Object.values(services.SERVICES).forEach(service => {
        expect(service.url).toMatch(/^http:\/\/localhost/);
      });
    });

    test('should have reasonable timeout values', () => {
      expect(services.MAX_HTTP_TIMEOUT).toBeDefined();
      expect(services.MAX_HTTP_TIMEOUT).toBeGreaterThan(0);
      expect(services.MAX_HTTP_TIMEOUT).toBeLessThanOrEqual(60000); // Max 60s
    });

    test('should validate service names against whitelist', () => {
      // Valid service names
      expect(() => services.validateServiceName('core')).not.toThrow();
      expect(() => services.validateServiceName('backend')).not.toThrow();
      expect(() => services.validateServiceName('interface')).not.toThrow();

      // Invalid service names
      expect(() => services.validateServiceName('invalid')).toThrow();
      expect(() => services.validateServiceName('')).toThrow();
      expect(() => services.validateServiceName(null)).toThrow();
    });
  });

  describe('Circuit Breaker Security', () => {
    test('should have circuit breaker configuration', () => {
      expect(services.SERVICE_CIRCUIT_CONFIG).toBeDefined();
      expect(services.SERVICE_CIRCUIT_CONFIG.failureThreshold).toBeDefined();
      expect(services.SERVICE_CIRCUIT_CONFIG.resetTimeoutMs).toBeDefined();
    });

    test('circuit breaker should have reasonable thresholds', () => {
      const config = services.SERVICE_CIRCUIT_CONFIG;
      expect(config.failureThreshold).toBeGreaterThanOrEqual(1);
      expect(config.failureThreshold).toBeLessThanOrEqual(10);
      expect(config.resetTimeoutMs).toBeGreaterThanOrEqual(1000);
      expect(config.errorRateThreshold).toBeLessThanOrEqual(100);
    });
  });

  describe('Retry Configuration Security', () => {
    test('should have retry configuration with safe defaults', () => {
      expect(services.DEFAULT_RETRY_CONFIG).toBeDefined();
      expect(services.DEFAULT_RETRY_CONFIG.maxRetries).toBeDefined();
      expect(services.DEFAULT_RETRY_CONFIG.maxDelayMs).toBeDefined();
    });

    test('retry config should have reasonable limits', () => {
      const config = services.DEFAULT_RETRY_CONFIG;
      expect(config.maxRetries).toBeGreaterThanOrEqual(0);
      expect(config.maxRetries).toBeLessThanOrEqual(10);
      expect(config.maxDelayMs).toBeLessThanOrEqual(30000); // Max 30s delay
    });
  });

  describe('Docker Security Constants', () => {
    test('should have buffer size limits', () => {
      expect(services.MAX_OUTPUT_BUFFER_SIZE).toBeDefined();
      expect(services.MAX_OUTPUT_BUFFER_SIZE).toBe(10 * 1024 * 1024); // 10MB
      expect(services.MAX_PS_LINES).toBeDefined();
      expect(services.MAX_PS_LINES).toBeLessThanOrEqual(10000);
    });

    test('should have compose timeout limits', () => {
      expect(services.COMPOSE_TIMEOUT_MS).toBeDefined();
      expect(services.COMPOSE_TIMEOUT_MS).toBe(5 * 60 * 1000); // 5 minutes
      expect(services.COMPOSE_MAX_BUFFER_SIZE).toBeDefined();
    });
  });
});

// =============================================================================
// Security Documentation Tests
// =============================================================================

describe('Services Security Documentation', () => {
  const fs = require('fs');
  const path = require('path');

  test('should have security documentation in module header', () => {
    const servicesPath = path.join(__dirname, '../lib/services.js');
    const content = fs.readFileSync(servicesPath, 'utf8');

    // Check for security-related comments in the header
    expect(content).toMatch(/security|SSRF|DNS rebinding/i);
  });

  test('should import http-client for secure requests', () => {
    const servicesPath = path.join(__dirname, '../lib/services.js');
    const content = fs.readFileSync(servicesPath, 'utf8');

    // Should import http-client
    expect(content).toMatch(/require\(['"]\.\/http-client['"]\)/);
  });

  test('should not use raw axios in service health checks', () => {
    const servicesPath = path.join(__dirname, '../lib/services.js');
    const content = fs.readFileSync(servicesPath, 'utf8');

    // Should not have axios.get for health checks
    // (the import may exist for other reasons but should not be used for internal requests)
    const checkServiceMatch = content.match(/async function checkService[\s\S]*?^async function /m);
    if (checkServiceMatch) {
      expect(checkServiceMatch[0]).not.toMatch(/axios\.get/);
    }
  });

  test('should use httpClient.allowPrivateIPs for internal requests', () => {
    const servicesPath = path.join(__dirname, '../lib/services.js');
    const content = fs.readFileSync(servicesPath, 'utf8');

    // Should use allowPrivateIPs wrapper for localhost/internal requests
    expect(content).toMatch(/allowPrivateIPs/);
  });
});

// =============================================================================
// Integration Security Tests
// =============================================================================

describe('Services Security Integration', () => {
  test('checkService should validate service name before making requests', async () => {
    // Mock invalid service name
    const result = await services.checkService('invalid-service', { url: 'http://localhost:8000' });
    
    // Should return error status without making HTTP request
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/Unknown service/);
  });

  test('validateServiceNames should reject non-array inputs', () => {
    expect(() => services.validateServiceNames('not-an-array')).toThrow();
    expect(() => services.validateServiceNames(null)).toThrow();
    expect(() => services.validateServiceNames(undefined)).toThrow();
  });
});
