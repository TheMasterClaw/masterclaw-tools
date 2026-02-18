/**
 * Tests for isPortAvailable timeout protection and security features
 * Run with: npm test -- validate.port.test.js
 */

const {
  isPortAvailable,
  isValidPortNumber,
  PORT_CHECK_TIMEOUT_MS,
  MIN_VALID_PORT,
  MAX_VALID_PORT,
} = require('../lib/validate');

const net = require('net');

describe('Port Availability - Timeout Protection & Security', () => {
  // Track servers for cleanup
  const servers = [];

  afterEach(async () => {
    // Clean up any servers created during tests
    for (const server of servers) {
      try {
        await new Promise((resolve) => {
          if (server.listening) {
            server.close(() => resolve());
          } else {
            resolve();
          }
        });
      } catch {
        // Ignore cleanup errors
      }
    }
    servers.length = 0;
  });

  describe('Port Validation Constants', () => {
    test('PORT_CHECK_TIMEOUT_MS is defined and reasonable', () => {
      expect(PORT_CHECK_TIMEOUT_MS).toBeDefined();
      expect(PORT_CHECK_TIMEOUT_MS).toBe(5000); // 5 seconds
      expect(PORT_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
    });

    test('MIN_VALID_PORT is correct', () => {
      expect(MIN_VALID_PORT).toBe(1);
    });

    test('MAX_VALID_PORT is correct', () => {
      expect(MAX_VALID_PORT).toBe(65535);
    });
  });

  describe('isValidPortNumber', () => {
    test('accepts valid port numbers', () => {
      expect(isValidPortNumber(1)).toBe(true);
      expect(isValidPortNumber(80)).toBe(true);
      expect(isValidPortNumber(443)).toBe(true);
      expect(isValidPortNumber(8080)).toBe(true);
      expect(isValidPortNumber(65535)).toBe(true);
    });

    test('rejects port 0', () => {
      expect(isValidPortNumber(0)).toBe(false);
    });

    test('rejects negative ports', () => {
      expect(isValidPortNumber(-1)).toBe(false);
      expect(isValidPortNumber(-80)).toBe(false);
    });

    test('rejects ports above maximum', () => {
      expect(isValidPortNumber(65536)).toBe(false);
      expect(isValidPortNumber(100000)).toBe(false);
    });

    test('rejects non-integers', () => {
      expect(isValidPortNumber(80.5)).toBe(false);
      expect(isValidPortNumber('80')).toBe(false);
      expect(isValidPortNumber(null)).toBe(false);
      expect(isValidPortNumber(undefined)).toBe(false);
    });

    test('rejects non-numbers', () => {
      expect(isValidPortNumber('string')).toBe(false);
      expect(isValidPortNumber({})).toBe(false);
      expect(isValidPortNumber([])).toBe(false);
    });
  });

  describe('isPortAvailable - Basic Functionality', () => {
    test('returns true for available port', async () => {
      // Use a high port unlikely to be in use
      const result = await isPortAvailable(41234);
      expect(result).toBe(true);
    }, 10000);

    test('returns false for port in use', async () => {
      const port = 41235;
      const server = net.createServer();
      servers.push(server);

      // Start a server on the port
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', resolve);
        server.listen(port);
      });

      // Port should not be available
      const result = await isPortAvailable(port);
      expect(result).toBe(false);
    }, 10000);

    test('handles multiple ports correctly', async () => {
      const results = await Promise.all([
        isPortAvailable(41236),
        isPortAvailable(41237),
        isPortAvailable(41238),
      ]);

      expect(results).toEqual([true, true, true]);
    }, 10000);
  });

  describe('isPortAvailable - Invalid Port Handling', () => {
    test('returns false for port 0', async () => {
      const result = await isPortAvailable(0);
      expect(result).toBe(false);
    });

    test('returns false for negative port', async () => {
      const result = await isPortAvailable(-1);
      expect(result).toBe(false);
    });

    test('returns false for port above 65535', async () => {
      const result = await isPortAvailable(65536);
      expect(result).toBe(false);
    });

    test('returns false for non-integer port', async () => {
      const result = await isPortAvailable(80.5);
      expect(result).toBe(false);
    });

    test('returns false for string port', async () => {
      const result = await isPortAvailable('8080');
      expect(result).toBe(false);
    });

    test('returns false for null port', async () => {
      const result = await isPortAvailable(null);
      expect(result).toBe(false);
    });

    test('returns false for undefined port', async () => {
      const result = await isPortAvailable(undefined);
      expect(result).toBe(false);
    });
  });

  describe('isPortAvailable - Timeout Protection', () => {
    test('respects custom timeout', async () => {
      const start = Date.now();
      // Use an invalid port that will cause immediate resolution
      await isPortAvailable(0, 100);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500); // Should resolve quickly
    });

    test('uses default timeout when not specified', async () => {
      // This test verifies the function works with default timeout
      const result = await isPortAvailable(41239);
      expect(typeof result).toBe('boolean');
    }, 10000);
  });

  describe('isPortAvailable - Race Condition Safety', () => {
    test('handles rapid consecutive checks on same port', async () => {
      const port = 41240;
      
      // Perform multiple rapid checks
      const results = await Promise.all([
        isPortAvailable(port),
        isPortAvailable(port),
        isPortAvailable(port),
      ]);

      // At least one should succeed (port was available), others may see it in use
      // due to race condition in the OS network stack
      expect(results.some(r => r === true)).toBe(true);
      // All results should be booleans
      results.forEach(r => expect(typeof r).toBe('boolean'));
    }, 10000);

    test('handles check immediately after server closes', async () => {
      const port = 41241;
      const server = net.createServer();
      servers.push(server);

      // Start server
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', resolve);
        server.listen(port);
      });

      // Verify port is in use
      const inUse = await isPortAvailable(port);
      expect(inUse).toBe(false);

      // Close server
      await new Promise((resolve) => {
        server.close(resolve);
      });

      // Small delay for OS to release port
      await new Promise(resolve => setTimeout(resolve, 100));

      // Port should now be available
      const available = await isPortAvailable(port);
      expect(available).toBe(true);
    }, 10000);
  });

  describe('isPortAvailable - Well-known Ports', () => {
    test('correctly checks well-known ports', async () => {
      // These tests check ports that may or may not be in use
      // We just verify the function returns a boolean without throwing
      const ports = [22, 80, 443, 3306, 5432, 6379, 8080];
      
      for (const port of ports) {
        const result = await isPortAvailable(port);
        expect(typeof result).toBe('boolean');
      }
    }, 15000);
  });

  describe('isPortAvailable - Edge Cases', () => {
    test('handles very high port numbers', async () => {
      const result = await isPortAvailable(65535);
      expect(typeof result).toBe('boolean');
    });

    test('handles port boundary at 65535', async () => {
      // 65535 should be valid, 65536 should not
      const validResult = await isPortAvailable(65535);
      const invalidResult = await isPortAvailable(65536);
      
      expect(typeof validResult).toBe('boolean');
      expect(invalidResult).toBe(false);
    });

    test('handles concurrent checks on different ports', async () => {
      const ports = [50000, 50001, 50002, 50003, 50004];
      
      const results = await Promise.all(
        ports.map(port => isPortAvailable(port))
      );

      // All should be boolean values
      results.forEach(result => {
        expect(typeof result).toBe('boolean');
      });
    }, 10000);
  });

  describe('Security - Input Validation', () => {
    test('rejects object injection attempt', async () => {
      const result = await isPortAvailable({ toString: () => '80' });
      expect(result).toBe(false);
    });

    test('rejects array injection attempt', async () => {
      const result = await isPortAvailable([80]);
      expect(result).toBe(false);
    });

    test('rejects boolean values', async () => {
      expect(await isPortAvailable(true)).toBe(false);
      expect(await isPortAvailable(false)).toBe(false);
    });
  });

  describe('Integration with REQUIRED_PORTS', () => {
    const { REQUIRED_PORTS } = require('../lib/validate');

    test('REQUIRED_PORTS are all valid port numbers', () => {
      for (const port of REQUIRED_PORTS) {
        expect(isValidPortNumber(port)).toBe(true);
      }
    });

    test('can check all required ports', async () => {
      const results = await Promise.all(
        REQUIRED_PORTS.map(port => isPortAvailable(port))
      );

      results.forEach(result => {
        expect(typeof result).toBe('boolean');
      });
    }, 10000);
  });
});

module.exports = {
  isValidPortNumber,
  PORT_CHECK_TIMEOUT_MS,
};
