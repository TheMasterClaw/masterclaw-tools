/**
 * Tests for MasterClaw Auto-Heal Module
 */

const heal = require('../lib/heal');
const { ISSUE_TYPES, HEAL_CONFIG, HealResult } = require('../lib/heal');

// Mock dependencies
jest.mock('../lib/services');
jest.mock('../lib/config');
jest.mock('../lib/circuit-breaker');
jest.mock('../lib/logger', () => ({
  child: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const { getAllStatuses } = require('../lib/services');
const { getAllCircuitStatus, resetCircuit } = require('../lib/circuit-breaker');

describe('Heal Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('HealResult', () => {
    test('should track fixes correctly', () => {
      const result = new HealResult();
      
      result.addFix(ISSUE_TYPES.SERVICE_DOWN, 'Service is down', 'Restart service', true);
      result.addFix(ISSUE_TYPES.CONFIG_PERMISSIONS, 'Bad permissions', 'Fix permissions', false, 'Permission denied');
      
      expect(result.issuesFixed).toBe(1);
      expect(result.issuesFailed).toBe(1);
      expect(result.fixes).toHaveLength(2);
    });

    test('should track warnings', () => {
      const result = new HealResult();
      result.addWarning('Test warning');
      
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].message).toBe('Test warning');
    });

    test('should calculate duration', async () => {
      const result = new HealResult();
      await new Promise(r => setTimeout(r, 10));
      
      expect(result.duration).toBeGreaterThanOrEqual(10);
    });

    test('should provide summary', () => {
      const result = new HealResult();
      result.issuesFound = 5;
      result.issuesFixed = 3;
      result.issuesFailed = 1;
      result.issuesSkipped = 1;
      
      const summary = result.summary;
      expect(summary.issuesFound).toBe(5);
      expect(summary.issuesFixed).toBe(3);
      expect(summary.issuesFailed).toBe(1);
      expect(summary.issuesSkipped).toBe(1);
      expect(summary.success).toBe(false);
    });
  });

  describe('Issue Type Constants', () => {
    test('should have all expected issue types', () => {
      expect(ISSUE_TYPES.DOCKER_DOWN).toBe('docker_down');
      expect(ISSUE_TYPES.SERVICE_DOWN).toBe('service_down');
      expect(ISSUE_TYPES.SERVICE_UNHEALTHY).toBe('service_unhealthy');
      expect(ISSUE_TYPES.LOW_DISK_SPACE).toBe('low_disk_space');
      expect(ISSUE_TYPES.LOW_MEMORY).toBe('low_memory');
      expect(ISSUE_TYPES.CONFIG_PERMISSIONS).toBe('config_permissions');
      expect(ISSUE_TYPES.CIRCUIT_OPEN).toBe('circuit_open');
      expect(ISSUE_TYPES.STALE_CONTAINERS).toBe('stale_containers');
      expect(ISSUE_TYPES.UNUSED_IMAGES).toBe('unused_images');
      expect(ISSUE_TYPES.DANGLING_VOLUMES).toBe('dangling_volumes');
    });
  });

  describe('Heal Configuration', () => {
    test('should have reasonable thresholds', () => {
      expect(HEAL_CONFIG.diskCritical).toBeLessThan(HEAL_CONFIG.diskWarning);
      expect(HEAL_CONFIG.memoryCritical).toBeLessThan(HEAL_CONFIG.memoryWarning);
      expect(HEAL_CONFIG.restartDelayMs).toBeGreaterThan(0);
      expect(HEAL_CONFIG.maxRestartAttempts).toBeGreaterThan(0);
    });
  });

  describe('Service Issue Detection', () => {
    test('should detect down services', async () => {
      getAllStatuses.mockResolvedValue([
        { name: 'core', status: 'down' },
        { name: 'backend', status: 'healthy' },
      ]);

      const issues = await heal.detectServiceIssues();
      
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe(ISSUE_TYPES.SERVICE_DOWN);
      expect(issues[0].service).toBe('core');
      expect(issues[0].autoFixable).toBe(true);
    });

    test('should detect unhealthy services', async () => {
      getAllStatuses.mockResolvedValue([
        { name: 'core', status: 'unhealthy' },
        { name: 'backend', status: 'healthy' },
      ]);

      const issues = await heal.detectServiceIssues();
      
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe(ISSUE_TYPES.SERVICE_UNHEALTHY);
      expect(issues[0].service).toBe('core');
    });

    test('should return empty array when all services healthy', async () => {
      getAllStatuses.mockResolvedValue([
        { name: 'core', status: 'healthy' },
        { name: 'backend', status: 'healthy' },
      ]);

      const issues = await heal.detectServiceIssues();
      
      expect(issues).toHaveLength(0);
    });

    test('should handle errors gracefully', async () => {
      getAllStatuses.mockRejectedValue(new Error('Connection failed'));

      const issues = await heal.detectServiceIssues();
      
      expect(issues).toHaveLength(0);
    });
  });

  describe('Circuit Issue Detection', () => {
    test('should detect open circuits', async () => {
      getAllCircuitStatus.mockReturnValue({
        core: { state: 'OPEN', failureCount: 5 },
        backend: { state: 'CLOSED', failureCount: 0 },
      });

      const issues = await heal.detectCircuitIssues();
      
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe(ISSUE_TYPES.CIRCUIT_OPEN);
      expect(issues[0].service).toBe('core');
      expect(issues[0].autoFixable).toBe(true);
    });

    test('should return empty array when all circuits closed', async () => {
      getAllCircuitStatus.mockReturnValue({
        core: { state: 'CLOSED', failureCount: 0 },
        backend: { state: 'CLOSED', failureCount: 0 },
      });

      const issues = await heal.detectCircuitIssues();
      
      expect(issues).toHaveLength(0);
    });
  });

  describe('Docker Issue Detection', () => {
    const { execAsync } = require('child_process');
    
    beforeEach(() => {
      jest.resetModules();
    });

    test('should detect Docker daemon down', async () => {
      // Mock execAsync to throw error
      jest.doMock('util', () => ({
        promisify: () => () => Promise.reject(new Error('Connection refused')),
      }));

      const { detectDockerIssues } = require('../lib/heal');
      const issues = await detectDockerIssues();
      
      expect(issues).toHaveLength(1);
      expect(issues[0].type).toBe(ISSUE_TYPES.DOCKER_DOWN);
      expect(issues[0].autoFixable).toBe(false);
    });
  });

  describe('runHeal Integration', () => {
    test('should run in dry-run mode by default', async () => {
      getAllStatuses.mockResolvedValue([
        { name: 'core', status: 'healthy' },
      ]);
      getAllCircuitStatus.mockReturnValue({});

      const result = await heal.runHeal({ json: true });
      
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('fixes');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('nonFixableIssues');
    });

    test('should respect category filters', async () => {
      getAllStatuses.mockResolvedValue([
        { name: 'core', status: 'down' },
      ]);

      // With docker category only, services should not be checked
      const result = await heal.runHeal({ 
        json: true, 
        categories: ['docker'],
      });
      
      // Should not find service issues when filtering to docker only
      expect(result.summary.issuesFound).toBe(0);
    });
  });
});
