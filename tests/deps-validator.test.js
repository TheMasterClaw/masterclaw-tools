/**
 * Tests for deps-validator.js - Command Dependency Validator
 * 
 * Tests cover:
 * - Individual validation functions
 * - Command dependency resolution
 * - Cache behavior
 * - Integration with wrapper function
 */

// Mock child_process for disk space tests - must be before imports
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// Mock dependencies
jest.mock('../lib/docker', () => ({
  isDockerAvailable: jest.fn(),
  isComposeAvailable: jest.fn(),
}));

jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn(),
}));

jest.mock('../lib/config', () => ({
  securityAudit: jest.fn(),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn(),
}));

// Now import the modules after mocking
const {
  validateDocker,
  validateDockerCompose,
  validateInfraDir,
  validateConfig,
  validateEnvVars,
  validateFiles,
  validateDiskSpace,
  validateMemory,
  validateCommandDeps,
  validateCustomDeps,
  withDeps,
  DependencyType,
  COMMAND_DEPENDENCIES,
  getCachedValidation,
  cacheValidation,
  clearValidationCache,
} = require('../lib/deps-validator');

const { isDockerAvailable, isComposeAvailable } = require('../lib/docker');
const { findInfraDir } = require('../lib/services');
const { securityAudit } = require('../lib/config');
const fs = require('fs-extra');
const { execSync } = require('child_process');

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Dependency Validator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearValidationCache(); // Clear validation cache between tests
  });

  // =============================================================================
  // validateDocker Tests
  // =============================================================================
  
  describe('validateDocker', () => {
    it('should return satisfied when Docker is available', async () => {
      isDockerAvailable.mockResolvedValue(true);
      
      const result = await validateDocker();
      
      expect(result.satisfied).toBe(true);
      expect(result.type).toBe(DependencyType.DOCKER);
      expect(result.severity).toBe('critical');
      expect(result.message).toContain('available');
    });

    it('should return not satisfied when Docker is unavailable', async () => {
      isDockerAvailable.mockResolvedValue(false);
      
      const result = await validateDocker();
      
      expect(result.satisfied).toBe(false);
      expect(result.severity).toBe('critical');
      expect(result.remediation).toBeTruthy();
      expect(result.remediation.length).toBeGreaterThan(0);
    });

    it('should use cached results on subsequent calls', async () => {
      isDockerAvailable.mockResolvedValue(true);
      
      // First call should hit the mock
      await validateDocker();
      expect(isDockerAvailable).toHaveBeenCalledTimes(1);
      
      // Clear mock to verify caching on second call
      jest.clearAllMocks();
      
      // Second call should use cache (mock won't be called again)
      const result2 = await validateDocker();
      expect(isDockerAvailable).not.toHaveBeenCalled();
      expect(result2.satisfied).toBe(true);
    });
  });

  // =============================================================================
  // validateDockerCompose Tests
  // =============================================================================
  
  describe('validateDockerCompose', () => {
    it('should return satisfied when Docker Compose is available', async () => {
      isComposeAvailable.mockResolvedValue(true);
      
      const result = await validateDockerCompose();
      
      expect(result.satisfied).toBe(true);
      expect(result.type).toBe(DependencyType.DOCKER_COMPOSE);
    });

    it('should return not satisfied when Docker Compose is unavailable', async () => {
      isComposeAvailable.mockResolvedValue(false);
      
      const result = await validateDockerCompose();
      
      expect(result.satisfied).toBe(false);
      expect(result.remediation).toBeTruthy();
    });
  });

  // =============================================================================
  // validateInfraDir Tests
  // =============================================================================
  
  describe('validateInfraDir', () => {
    it('should return satisfied when infrastructure directory is found', async () => {
      findInfraDir.mockResolvedValue('/opt/masterclaw-infrastructure');
      
      const result = await validateInfraDir();
      
      expect(result.satisfied).toBe(true);
      expect(result.type).toBe(DependencyType.INFRA_DIR);
      expect(result.infraDir).toBe('/opt/masterclaw-infrastructure');
    });

    it('should return not satisfied when infrastructure directory is not found', async () => {
      findInfraDir.mockResolvedValue(null);
      
      const result = await validateInfraDir();
      
      expect(result.satisfied).toBe(false);
      expect(result.remediation.length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // validateEnvVars Tests
  // =============================================================================
  
  describe('validateEnvVars', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterAll(() => {
      process.env = originalEnv;
    });

    it('should return satisfied when all env vars are present', async () => {
      process.env.TEST_VAR_1 = 'value1';
      process.env.TEST_VAR_2 = 'value2';
      
      const result = await validateEnvVars(['TEST_VAR_1', 'TEST_VAR_2']);
      
      expect(result.satisfied).toBe(true);
      expect(result.present).toContain('TEST_VAR_1');
      expect(result.present).toContain('TEST_VAR_2');
      expect(result.missing).toHaveLength(0);
    });

    it('should return not satisfied when env vars are missing', async () => {
      delete process.env.MISSING_VAR_1;
      delete process.env.MISSING_VAR_2;
      
      const result = await validateEnvVars(['MISSING_VAR_1', 'MISSING_VAR_2']);
      
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('MISSING_VAR_1');
      expect(result.missing).toContain('MISSING_VAR_2');
      expect(result.remediation).toHaveLength(2);
    });

    it('should handle empty env var list', async () => {
      const result = await validateEnvVars([]);
      
      expect(result.satisfied).toBe(true);
    });
  });

  // =============================================================================
  // validateFiles Tests
  // =============================================================================
  
  describe('validateFiles', () => {
    it('should return satisfied when all files exist', async () => {
      fs.pathExists.mockResolvedValue(true);
      
      const result = await validateFiles(['/path/to/file1', '/path/to/file2']);
      
      expect(result.satisfied).toBe(true);
      expect(result.present).toHaveLength(2);
    });

    it('should return not satisfied when files are missing', async () => {
      fs.pathExists.mockResolvedValue(false);
      
      const result = await validateFiles(['/missing/file']);
      
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('/missing/file');
    });

    it('should handle mixed existing and missing files', async () => {
      fs.pathExists
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      
      const result = await validateFiles(['/exists', '/missing']);
      
      expect(result.satisfied).toBe(false);
      expect(result.present).toContain('/exists');
      expect(result.missing).toContain('/missing');
    });
  });

  // =============================================================================
  // validateDiskSpace Tests
  // =============================================================================
  
  describe('validateDiskSpace', () => {
    it('should return satisfied when sufficient disk space', async () => {
      execSync.mockReturnValue(
        'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1      100000000 50000000  50000000  50% /'
      );
      
      const result = await validateDiskSpace(1);
      
      expect(result.satisfied).toBe(true);
      expect(result.availableGB).toBeGreaterThan(0);
      expect(execSync).toHaveBeenCalledWith('df -k .', { encoding: 'utf8', timeout: 5000 });
    });

    it('should return not satisfied when insufficient disk space', async () => {
      execSync.mockReturnValue(
        'Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/sda1      100000000 99990000     10000  99% /'
      );
      
      const result = await validateDiskSpace(100); // Require 100GB
      
      expect(result.satisfied).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      execSync.mockImplementation(() => {
        throw new Error('Command failed');
      });
      
      const result = await validateDiskSpace(1);
      
      // Should return satisfied=true on error to allow operation to continue
      expect(result.satisfied).toBe(true);
      expect(result.severity).toBe('info');
    });
  });

  // =============================================================================
  // validateMemory Tests
  // =============================================================================
  
  describe('validateMemory', () => {
    it('should return satisfied when sufficient memory', async () => {
      const result = await validateMemory(1); // Require 1MB (always available)
      
      expect(result.satisfied).toBe(true);
      expect(result.freeMemoryMB).toBeGreaterThan(0);
      expect(result.totalMemoryMB).toBeGreaterThan(0);
    });

    it('should handle high memory requirements', async () => {
      // Request an extremely high amount of memory that's unlikely to be available
      const result = await validateMemory(1000000000); // 1 petabyte
      
      expect(result.satisfied).toBe(false);
      expect(result.remediation).toBeTruthy();
    });
  });

  // =============================================================================
  // validateCommandDeps Tests
  // =============================================================================
  
  describe('validateCommandDeps', () => {
    it('should validate Docker for status command', async () => {
      isDockerAvailable.mockResolvedValue(true);
      
      const result = await validateCommandDeps('status');
      
      expect(result.command).toBe('status');
      expect(result.canProceed).toBe(true);
    });

    it('should validate multiple dependencies for revive command', async () => {
      isDockerAvailable.mockResolvedValue(true);
      isComposeAvailable.mockResolvedValue(true);
      findInfraDir.mockResolvedValue('/opt/infra');
      
      const result = await validateCommandDeps('revive');
      
      expect(result.command).toBe('revive');
      expect(result.results).toHaveLength(3);
      expect(result.canProceed).toBe(true);
    });

    it('should fail when critical dependency fails', async () => {
      isDockerAvailable.mockResolvedValue(false);
      
      const result = await validateCommandDeps('status');
      
      expect(result.canProceed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('should handle unknown commands gracefully', async () => {
      const result = await validateCommandDeps('unknown-command');
      
      expect(result.command).toBe('unknown-command');
      expect(result.results).toHaveLength(0);
      expect(result.canProceed).toBe(true);
    });
  });

  // =============================================================================
  // validateCustomDeps Tests
  // =============================================================================
  
  describe('validateCustomDeps', () => {
    it('should validate array of dependency types', async () => {
      isDockerAvailable.mockResolvedValue(true);
      isComposeAvailable.mockResolvedValue(true);
      
      const result = await validateCustomDeps([
        DependencyType.DOCKER,
        DependencyType.DOCKER_COMPOSE,
      ]);
      
      expect(result.satisfied).toBe(true);
      expect(result.results).toHaveLength(2);
    });

    it('should support custom validator functions', async () => {
      const customValidator = jest.fn().mockResolvedValue({
        type: 'custom',
        satisfied: true,
        severity: 'info',
        message: 'Custom check passed',
      });
      
      const result = await validateCustomDeps([customValidator]);
      
      expect(customValidator).toHaveBeenCalled();
      expect(result.satisfied).toBe(true);
    });
  });

  // =============================================================================
  // withDeps Wrapper Tests
  // =============================================================================
  
  describe('withDeps', () => {
    beforeEach(() => {
      // Ensure fresh state for each withDeps test
      clearValidationCache();
    });

    it('should execute handler when dependencies satisfied', async () => {
      isDockerAvailable.mockResolvedValue(true);
      const handler = jest.fn().mockResolvedValue('success');
      
      const wrapped = withDeps('status', handler);
      const result = await wrapped({});
      
      expect(handler).toHaveBeenCalled();
      expect(result).toBe('success');
    });

    it('should not execute handler when dependencies fail', async () => {
      // Force Docker to be unavailable for this test
      isDockerAvailable.mockReset();
      isDockerAvailable.mockResolvedValue(false);
      
      // Verify the mock is working
      const dockerResult = await validateDocker();
      expect(dockerResult.satisfied).toBe(false);
      
      const handler = jest.fn();
      const wrapped = withDeps('status', handler);
      
      // Should exit, so we need to mock process.exit
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {});
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      
      await wrapped({});
      
      expect(handler).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(2);
      
      mockExit.mockRestore();
      consoleError.mockRestore();
    });

    it('should skip validation when skipValidation option set', async () => {
      const handler = jest.fn().mockResolvedValue('success');
      
      const wrapped = withDeps('status', handler, { skipValidation: true });
      await wrapped({});
      
      expect(handler).toHaveBeenCalled();
      expect(isDockerAvailable).not.toHaveBeenCalled();
    });

    it('should support custom dependencies', async () => {
      isDockerAvailable.mockResolvedValue(true);
      const handler = jest.fn().mockResolvedValue('success');
      
      const wrapped = withDeps('custom', handler, {
        customDeps: [DependencyType.DOCKER],
      });
      await wrapped({});
      
      expect(handler).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Cache Tests
  // =============================================================================
  
  describe('Cache Behavior', () => {
    it('should return cached result within TTL', () => {
      const cachedResult = { satisfied: true, type: 'test' };
      cacheValidation('test-key', cachedResult);
      
      const retrieved = getCachedValidation('test-key');
      
      expect(retrieved).toEqual(cachedResult);
    });

    it('should return null for missing cache key', () => {
      const retrieved = getCachedValidation('non-existent-key');
      
      expect(retrieved).toBeNull();
    });
  });

  // =============================================================================
  // Command Dependencies Configuration Tests
  // =============================================================================
  
  describe('COMMAND_DEPENDENCIES', () => {
    it('should have dependencies for known commands', () => {
      expect(COMMAND_DEPENDENCIES['status']).toContain(DependencyType.DOCKER);
      expect(COMMAND_DEPENDENCIES['revive']).toContain(DependencyType.DOCKER);
      expect(COMMAND_DEPENDENCIES['revive']).toContain(DependencyType.DOCKER_COMPOSE);
      expect(COMMAND_DEPENDENCIES['revive']).toContain(DependencyType.INFRA_DIR);
    });

    it('should use valid dependency types', () => {
      const validTypes = Object.values(DependencyType);
      
      for (const deps of Object.values(COMMAND_DEPENDENCIES)) {
        for (const dep of deps) {
          expect(validTypes).toContain(dep);
        }
      }
    });
  });
});
