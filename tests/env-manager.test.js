/**
 * Tests for env-manager.js module
 * Run with: npm test -- env-manager.test.js
 *
 * Tests environment management functionality.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Mock services before requiring env-manager
const mockInfraDir = path.join(os.tmpdir(), 'masterclaw-test-env-' + Date.now());

jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn().mockResolvedValue(mockInfraDir),
}));

const {
  getCurrentEnv,
  listEnvironments,
  createEnvironment,
  switchEnvironment,
  deleteEnvironment,
  diffEnvironments,
  initializeEnvironments,
  getEnvConfig,
  ENV_TEMPLATES,
} = require('../lib/env-manager');

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Environment Manager Module', () => {
  beforeEach(async () => {
    await fs.ensureDir(mockInfraDir);
  });

  afterEach(async () => {
    await fs.remove(mockInfraDir);
  });

  afterAll(async () => {
    await fs.remove(mockInfraDir);
  });

  // ===========================================================================
  // ENV_TEMPLATES Constant Tests
  // ===========================================================================
  describe('ENV_TEMPLATES', () => {
    test('contains dev template', () => {
      expect(ENV_TEMPLATES).toHaveProperty('dev');
      expect(ENV_TEMPLATES.dev.name).toBe('development');
      expect(ENV_TEMPLATES.dev.config.DOMAIN).toBe('localhost');
    });

    test('contains staging template', () => {
      expect(ENV_TEMPLATES).toHaveProperty('staging');
      expect(ENV_TEMPLATES.staging.name).toBe('staging');
      expect(ENV_TEMPLATES.staging.config.DOMAIN).toContain('staging');
    });

    test('contains prod template', () => {
      expect(ENV_TEMPLATES).toHaveProperty('prod');
      expect(ENV_TEMPLATES.prod.name).toBe('production');
      expect(ENV_TEMPLATES.prod.config.TRAEFIK_LOG_LEVEL).toBe('WARN');
    });

    test('each template has required properties', () => {
      for (const [name, template] of Object.entries(ENV_TEMPLATES)) {
        expect(template).toHaveProperty('name');
        expect(template).toHaveProperty('description');
        expect(template).toHaveProperty('config');
        expect(template).toHaveProperty('dockerOverride');
        expect(template.config).toHaveProperty('DOMAIN');
        expect(template.config).toHaveProperty('ACME_EMAIL');
      }
    });

    test('templates have appropriate resource limits', () => {
      // Dev has debug logging
      expect(ENV_TEMPLATES.dev.config.TRAEFIK_LOG_LEVEL).toBe('DEBUG');
      // Prod has warning logging
      expect(ENV_TEMPLATES.prod.config.TRAEFIK_LOG_LEVEL).toBe('WARN');
      // Prod has higher retention
      expect(parseInt(ENV_TEMPLATES.prod.config.RETENTION_DAYS))
        .toBeGreaterThan(parseInt(ENV_TEMPLATES.dev.config.RETENTION_DAYS));
    });
  });

  // ===========================================================================
  // getCurrentEnv Tests
  // ===========================================================================
  describe('getCurrentEnv', () => {
    test('returns null when no active environment', async () => {
      const env = await getCurrentEnv();
      expect(env).toBeNull();
    });

    test('returns active environment name', async () => {
      const activeFile = path.join(mockInfraDir, '.env-active');
      await fs.writeFile(activeFile, 'dev');

      const env = await getCurrentEnv();
      expect(env).toBe('dev');
    });

    test('trims whitespace from active file', async () => {
      const activeFile = path.join(mockInfraDir, '.env-active');
      await fs.writeFile(activeFile, '  staging  \n');

      const env = await getCurrentEnv();
      expect(env).toBe('staging');
    });
  });

  // ===========================================================================
  // listEnvironments Tests
  // ===========================================================================
  describe('listEnvironments', () => {
    test('returns empty array when no environments exist', async () => {
      const envs = await listEnvironments();
      expect(envs).toEqual([]);
    });

    test('lists created environments', async () => {
      await createEnvironment('test-env', 'dev');

      const envs = await listEnvironments();
      expect(envs.length).toBe(1);
      expect(envs[0].name).toBe('test-env');
      expect(envs[0].isActive).toBe(false);
    });

    test('marks active environment', async () => {
      await createEnvironment('active-env', 'dev');
      const activeFile = path.join(mockInfraDir, '.env-active');
      await fs.writeFile(activeFile, 'active-env');

      const envs = await listEnvironments();
      const activeEnv = envs.find(e => e.name === 'active-env');
      expect(activeEnv.isActive).toBe(true);
    });

    test('includes config for each environment', async () => {
      await createEnvironment('config-env', 'dev');

      const envs = await listEnvironments();
      expect(envs[0].config).toBeDefined();
      expect(envs[0].config.name).toBe('config-env');
    });
  });

  // ===========================================================================
  // createEnvironment Tests
  // ===========================================================================
  describe('createEnvironment', () => {
    test('creates environment from dev template', async () => {
      const envDir = await createEnvironment('my-dev', 'dev');

      expect(await fs.pathExists(envDir)).toBe(true);
      expect(await fs.pathExists(path.join(envDir, '.env'))).toBe(true);
      expect(await fs.pathExists(path.join(envDir, 'config.json'))).toBe(true);
    });

    test('throws if environment already exists', async () => {
      await createEnvironment('existing', 'dev');

      await expect(createEnvironment('existing', 'dev'))
        .rejects.toThrow("Environment 'existing' already exists");
    });

    test('creates environment files with correct content', async () => {
      const envDir = await createEnvironment('test-env', 'staging');

      const envContent = await fs.readFile(path.join(envDir, '.env'), 'utf8');
      expect(envContent).toContain('DOMAIN=staging.mc.example.com');

      const config = await fs.readJson(path.join(envDir, 'config.json'));
      expect(config.name).toBe('test-env');
      expect(config.template).toBe('staging');
    });

    test('sets created timestamp', async () => {
      const before = Date.now();
      await createEnvironment('timestamp-test', 'dev');
      const after = Date.now();

      const config = await getEnvConfig('timestamp-test');
      const created = new Date(config.created).getTime();
      expect(created).toBeGreaterThanOrEqual(before);
      expect(created).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // switchEnvironment Tests
  // ===========================================================================
  describe('switchEnvironment', () => {
    test('switches to environment', async () => {
      await createEnvironment('switch-test', 'dev');

      const result = await switchEnvironment('switch-test');

      expect(result.envName).toBe('switch-test');
      expect(await fs.pathExists(path.join(mockInfraDir, '.env'))).toBe(true);
    });

    test('throws if environment does not exist', async () => {
      await expect(switchEnvironment('nonexistent'))
        .rejects.toThrow("Environment 'nonexistent' does not exist");
    });

    test('backs up current .env', async () => {
      await fs.writeFile(path.join(mockInfraDir, '.env'), 'ORIGINAL=value');
      await createEnvironment('backup-test', 'dev');

      await switchEnvironment('backup-test');

      expect(await fs.pathExists(path.join(mockInfraDir, '.env.backup'))).toBe(true);
      const backup = await fs.readFile(path.join(mockInfraDir, '.env.backup'), 'utf8');
      expect(backup).toContain('ORIGINAL=value');
    });

    test('updates active environment marker', async () => {
      await createEnvironment('active-test', 'dev');

      await switchEnvironment('active-test');

      const current = await getCurrentEnv();
      expect(current).toBe('active-test');
    });
  });

  // ===========================================================================
  // deleteEnvironment Tests
  // ===========================================================================
  describe('deleteEnvironment', () => {
    test('deletes environment', async () => {
      await createEnvironment('delete-me', 'dev');
      const envDir = path.join(mockInfraDir, '.environments', 'delete-me');

      await deleteEnvironment('delete-me');

      expect(await fs.pathExists(envDir)).toBe(false);
    });

    test('throws if environment does not exist', async () => {
      await expect(deleteEnvironment('nonexistent'))
        .rejects.toThrow("Environment 'nonexistent' does not exist");
    });

    test('throws if trying to delete active environment', async () => {
      await createEnvironment('active-delete', 'dev');
      await switchEnvironment('active-delete');

      await expect(deleteEnvironment('active-delete'))
        .rejects.toThrow('Cannot delete active environment');
    });
  });

  // ===========================================================================
  // diffEnvironments Tests
  // ===========================================================================
  describe('diffEnvironments', () => {
    test('returns empty array for identical environments', async () => {
      await createEnvironment('diff-a', 'dev');
      await createEnvironment('diff-b', 'dev');

      const differences = await diffEnvironments('diff-a', 'diff-b');

      expect(differences).toEqual([]);
    });

    test('finds differences between environments', async () => {
      await createEnvironment('diff-dev', 'dev');
      await createEnvironment('diff-prod', 'prod');

      const differences = await diffEnvironments('diff-dev', 'diff-prod');

      // Should find DOMAIN difference at minimum
      const domainDiff = differences.find(d => d.key === 'DOMAIN');
      expect(domainDiff).toBeDefined();
      expect(domainDiff.valueA).toBe('localhost');
      expect(domainDiff.valueB).toBe('mc.example.com');
    });

    test('handles non-existent first environment gracefully', async () => {
      await createEnvironment('diff-exists', 'dev');

      // diffEnvironments doesn't throw but returns differences with (not set)
      const differences = await diffEnvironments('nonexistent', 'diff-exists');
      expect(differences.length).toBeGreaterThan(0);
      // First env values should be (not set)
      expect(differences[0].valueA).toBe('(not set)');
    });

    test('handles non-existent second environment gracefully', async () => {
      await createEnvironment('diff-exists2', 'dev');

      // diffEnvironments doesn't throw but returns differences with (not set)
      const differences = await diffEnvironments('diff-exists2', 'nonexistent');
      expect(differences.length).toBeGreaterThan(0);
      // Second env values should be (not set)
      expect(differences[0].valueB).toBe('(not set)');
    });
  });

  // ===========================================================================
  // initializeEnvironments Tests
  // ===========================================================================
  describe('initializeEnvironments', () => {
    test('creates default environments', async () => {
      const created = await initializeEnvironments();

      expect(created).toBe(true);
      expect(await fs.pathExists(path.join(mockInfraDir, '.environments', 'dev'))).toBe(true);
      expect(await fs.pathExists(path.join(mockInfraDir, '.environments', 'staging'))).toBe(true);
      expect(await fs.pathExists(path.join(mockInfraDir, '.environments', 'prod'))).toBe(true);
    });

    test('returns false if already initialized', async () => {
      await initializeEnvironments();

      const created = await initializeEnvironments();

      expect(created).toBe(false);
    });

    test('creates environments with correct templates', async () => {
      await initializeEnvironments();

      const devConfig = await getEnvConfig('dev');
      expect(devConfig.template).toBe('dev');

      const prodConfig = await getEnvConfig('prod');
      expect(prodConfig.template).toBe('prod');
    });
  });

  // ===========================================================================
  // getEnvConfig Tests
  // ===========================================================================
  describe('getEnvConfig', () => {
    test('returns config for environment', async () => {
      await createEnvironment('config-test', 'dev');

      const config = await getEnvConfig('config-test');

      expect(config).toBeDefined();
      expect(config.name).toBe('config-test');
    });

    test('returns null for non-existent environment', async () => {
      const config = await getEnvConfig('nonexistent');
      expect(config).toBeNull();
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  describe('Integration', () => {
    test('full environment lifecycle', async () => {
      // Initialize
      await initializeEnvironments();

      // List should show all environments
      let envs = await listEnvironments();
      expect(envs.length).toBe(3);

      // Create custom environment
      await createEnvironment('custom', 'dev');

      // Switch to it
      await switchEnvironment('custom');
      expect(await getCurrentEnv()).toBe('custom');

      // Delete it (should fail because active)
      await expect(deleteEnvironment('custom')).rejects.toThrow();

      // Switch away first
      await switchEnvironment('dev');

      // Now can delete
      await deleteEnvironment('custom');

      // Verify deleted
      envs = await listEnvironments();
      expect(envs.find(e => e.name === 'custom')).toBeUndefined();
    });
  });
});
