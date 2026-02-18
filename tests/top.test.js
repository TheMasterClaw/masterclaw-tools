/**
 * Tests for top.js - Container Resource Monitor
 */

const { 
  parseMemory, 
  formatBytes, 
  formatPercent,
  getContainerStats,
  getSystemStats,
  validateInterval,
} = require('../lib/top');

// Mock child_process
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

const { execSync } = require('child_process');

describe('top.js - Container Resource Monitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parseMemory', () => {
    it('should parse bytes', () => {
      expect(parseMemory('500 B')).toBe(500);
      expect(parseMemory('0 B')).toBe(0);
    });

    it('should parse kilobytes', () => {
      expect(parseMemory('500 kB')).toBe(500 * 1024);
      expect(parseMemory('1 KB')).toBe(1024);
    });

    it('should parse megabytes', () => {
      expect(parseMemory('500 MiB')).toBe(500 * 1024 * 1024);
      expect(parseMemory('1 MB')).toBe(1024 * 1024);
    });

    it('should parse gigabytes', () => {
      expect(parseMemory('2 GiB')).toBe(2 * 1024 * 1024 * 1024);
      expect(parseMemory('1.5 GB')).toBe(1.5 * 1024 * 1024 * 1024);
    });

    it('should handle invalid inputs', () => {
      expect(parseMemory(null)).toBe(0);
      expect(parseMemory('N/A')).toBe(0);
      expect(parseMemory('')).toBe(0);
      expect(parseMemory('invalid')).toBe(0);
    });
  });

  describe('formatBytes', () => {
    it('should format zero bytes', () => {
      expect(formatBytes(0)).toBe('0 B');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
    });

    it('should respect decimal places', () => {
      expect(formatBytes(1536, 0)).toBe('2 KB');
      expect(formatBytes(1536, 2)).toBe('1.5 KB');
    });
  });

  describe('validateInterval', () => {
    // Security hardening tests for interval validation
    
    it('should accept valid intervals within bounds', () => {
      const result = validateInterval('3');
      expect(result.valid).toBe(true);
      expect(result.value).toBe(3000);
      expect(result.seconds).toBe(3);
    });

    it('should accept minimum valid interval (1 second)', () => {
      const result = validateInterval('1');
      expect(result.valid).toBe(true);
      expect(result.value).toBe(1000);
      expect(result.seconds).toBe(1);
    });

    it('should accept maximum valid interval (300 seconds)', () => {
      const result = validateInterval('300');
      expect(result.valid).toBe(true);
      expect(result.value).toBe(300000);
      expect(result.seconds).toBe(300);
    });

    it('should accept float intervals', () => {
      const result = validateInterval('1.5');
      expect(result.valid).toBe(true);
      expect(result.value).toBe(1500);
      expect(result.seconds).toBe(1.5);
    });

    it('should reject intervals below minimum (security: prevent DoS)', () => {
      const result = validateInterval('0.5');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
      expect(result.error).toContain('Minimum allowed is 1');
      expect(result.value).toBe(3000);
    });

    it('should reject zero interval (security: prevent DoS)', () => {
      const result = validateInterval('0');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
      expect(result.value).toBe(3000);
    });

    it('should reject negative intervals', () => {
      const result = validateInterval('-5');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too short');
      expect(result.value).toBe(3000);
    });

    it('should reject intervals above maximum', () => {
      const result = validateInterval('301');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('too long');
      expect(result.error).toContain('Maximum allowed is 300');
      expect(result.value).toBe(3000);
    });

    it('should reject invalid strings', () => {
      const result = validateInterval('abc');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid interval');
      expect(result.value).toBe(3000);
    });

    it('should reject empty strings', () => {
      const result = validateInterval('');
      expect(result.valid).toBe(false);
      expect(result.value).toBe(3000);
    });

    it('should reject null values', () => {
      const result = validateInterval(null);
      expect(result.valid).toBe(false);
      expect(result.value).toBe(3000);
    });

    it('should reject undefined values', () => {
      const result = validateInterval(undefined);
      expect(result.valid).toBe(false);
      expect(result.value).toBe(3000);
    });

    it('should reject Infinity', () => {
      const result = validateInterval('Infinity');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('finite number');
      expect(result.value).toBe(3000);
    });

    it('should reject negative Infinity', () => {
      const result = validateInterval('-Infinity');
      expect(result.valid).toBe(false);
      expect(result.value).toBe(3000);
    });

    it('should handle number input (not string)', () => {
      const result = validateInterval(5);
      expect(result.valid).toBe(true);
      expect(result.value).toBe(5000);
      expect(result.seconds).toBe(5);
    });

    it('should round milliseconds correctly', () => {
      const result = validateInterval('1.234');
      expect(result.valid).toBe(true);
      expect(result.value).toBe(1234);
    });
  });

  describe('getSystemStats', () => {
    it('should parse docker system df output', () => {
      const mockOutput = `Images|45|8.5GB
Containers|10|2.1GB
Local Volumes|12|500MB
Build Cache|0|0B`;
      
      execSync.mockReturnValue(mockOutput);
      
      const stats = getSystemStats();
      
      expect(stats).toEqual({
        containers: { count: 10, size: '2.1GB' },
        images: { count: 45, size: '8.5GB' },
        volumes: { count: 12, size: '500MB' },
      });
    });

    it('should handle errors gracefully', () => {
      execSync.mockImplementation(() => {
        throw new Error('Docker not running');
      });
      
      const stats = getSystemStats();
      
      expect(stats).toBeNull();
    });

    it('should handle missing docker', () => {
      execSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      
      const stats = getSystemStats();
      
      expect(stats).toBeNull();
    });
  });

  describe('getContainerStats', () => {
    it('should return stats for all services', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('docker inspect') && cmd.includes('State.Status')) {
          return 'running|healthy|masterclaw/core:latest';
        }
        if (cmd.includes('docker stats')) {
          return '12.5%|850MiB / 2GiB|12MB / 45MB|15';
        }
        if (cmd.includes('StartedAt')) {
          return '2026-02-16T10:00:00Z';
        }
        return '';
      });
      
      const stats = getContainerStats();
      
      expect(stats).toBeInstanceOf(Array);
      expect(stats.length).toBeGreaterThan(0);
      
      const first = stats[0];
      expect(first).toHaveProperty('name');
      expect(first).toHaveProperty('display');
      expect(first).toHaveProperty('category');
      expect(first).toHaveProperty('state');
      expect(first).toHaveProperty('health');
    });

    it('should handle not found containers', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('docker inspect') && cmd.includes('State.Status')) {
          return 'not_found';
        }
        return '';
      });
      
      const stats = getContainerStats();
      
      expect(stats[0].state).toBe('not_found');
      expect(stats[0].cpu).toBeNull();
    });

    it('should handle stopped containers', () => {
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('docker inspect') && cmd.includes('State.Status')) {
          return 'exited|unhealthy|masterclaw/core:latest';
        }
        return '';
      });
      
      const stats = getContainerStats();
      
      expect(stats[0].state).toBe('exited');
    });
  });

  describe('Service definitions', () => {
    it('should have all required service properties', () => {
      const { SERVICES } = jest.requireActual('../lib/top');
      
      SERVICES.forEach(service => {
        expect(service).toHaveProperty('name');
        expect(service).toHaveProperty('display');
        expect(service).toHaveProperty('category');
        expect(['infra', 'app', 'data', 'monitor']).toContain(service.category);
      });
    });

    it('should include core services', () => {
      const { SERVICES } = jest.requireActual('../lib/top');
      const names = SERVICES.map(s => s.name);
      
      expect(names).toContain('mc-core');
      expect(names).toContain('mc-backend');
      expect(names).toContain('mc-traefik');
      expect(names).toContain('mc-chroma');
    });
  });
});
