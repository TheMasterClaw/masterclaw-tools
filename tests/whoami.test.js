/**
 * Tests for whoami.js module
 * Run with: npm test -- whoami.test.js
 *
 * Tests whoami command utility functions.
 */

const {
  getSystemInfo,
  getCliConfig,
  getEnvironmentStatus,
  checkInfraStatus,
  maskSecret,
  formatBytes,
} = require('../lib/whoami');

// Mock dependencies
jest.mock('../lib/config', () => ({
  get: jest.fn((key) => {
    const values = {
      'infraDir': '/tmp/test-infra',
      'core.url': 'http://localhost:8000',
      'gateway.url': 'http://localhost:3000',
    };
    return Promise.resolve(values[key] || null);
  }),
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn((path) => {
    // Mock that docker-compose.yml exists but .env doesn't
    if (path.includes('docker-compose.yml')) return Promise.resolve(true);
    if (path.includes('.env')) return Promise.resolve(false);
    return Promise.resolve(true);
  }),
}));

// =============================================================================
// getSystemInfo Tests
// =============================================================================

describe('getSystemInfo', () => {
  test('returns system information object', async () => {
    const info = await getSystemInfo();

    expect(info).toHaveProperty('platform');
    expect(info).toHaveProperty('arch');
    expect(info).toHaveProperty('nodeVersion');
    expect(info).toHaveProperty('hostname');
    expect(info).toHaveProperty('cpus');
    expect(info).toHaveProperty('totalMemory');
    expect(info).toHaveProperty('freeMemory');
    expect(info).toHaveProperty('homeDir');
    expect(info).toHaveProperty('tmpDir');
    expect(info).toHaveProperty('cwd');
    expect(info).toHaveProperty('shell');
    expect(info).toHaveProperty('user');
  });

  test('returns valid platform', async () => {
    const info = await getSystemInfo();
    expect(['darwin', 'linux', 'win32']).toContain(info.platform);
  });

  test('returns valid architecture', async () => {
    const info = await getSystemInfo();
    expect(['x64', 'arm64', 'ia32']).toContain(info.arch);
  });

  test('returns Node.js version', async () => {
    const info = await getSystemInfo();
    expect(info.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test('returns positive CPU count', async () => {
    const info = await getSystemInfo();
    expect(typeof info.cpus).toBe('number');
    expect(info.cpus).toBeGreaterThan(0);
  });

  test('returns formatted memory strings', async () => {
    const info = await getSystemInfo();
    expect(info.totalMemory).toMatch(/\d+\.?\d*\s+(Bytes|KB|MB|GB|TB)/);
    expect(info.freeMemory).toMatch(/\d+\.?\d*\s+(Bytes|KB|MB|GB|TB)/);
  });

  test('returns valid paths', async () => {
    const info = await getSystemInfo();
    expect(info.homeDir).toBeTruthy();
    expect(info.tmpDir).toBeTruthy();
    expect(info.cwd).toBeTruthy();
  });
});

// =============================================================================
// getCliConfig Tests
// =============================================================================

describe('getCliConfig', () => {
  test('returns CLI configuration', async () => {
    const config = await getCliConfig();

    expect(config).toHaveProperty('infraDir');
    expect(config).toHaveProperty('coreUrl');
    expect(config).toHaveProperty('gatewayUrl');
    expect(config).toHaveProperty('configFile');
  });

  test('config file path is valid', async () => {
    const config = await getCliConfig();
    expect(config.configFile).toContain('.masterclaw');
    expect(config.configFile).toContain('config.json');
  });

  test('returns configured values from config module', async () => {
    const config = await getCliConfig();
    expect(config.infraDir).toBe('/tmp/test-infra');
    expect(config.coreUrl).toBe('http://localhost:8000');
    expect(config.gatewayUrl).toBe('http://localhost:3000');
  });
});

// =============================================================================
// getEnvironmentStatus Tests
// =============================================================================

describe('getEnvironmentStatus', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns environment variables object', async () => {
    const env = await getEnvironmentStatus();

    expect(env).toHaveProperty('OPENAI_API_KEY');
    expect(env).toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).toHaveProperty('GATEWAY_TOKEN');
    expect(env).toHaveProperty('MASTERCLAW_INFRA');
    expect(env).toHaveProperty('NODE_ENV');
    expect(env).toHaveProperty('ENV');
  });

  test('masks API keys when set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test12345secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';

    const env = await getEnvironmentStatus();

    expect(env.OPENAI_API_KEY).toContain('****');
    expect(env.ANTHROPIC_API_KEY).toContain('****');
    expect(env.OPENAI_API_KEY).not.toBe('sk-test12345secret');
  });

  test('shows "Not set" for missing variables', async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const env = await getEnvironmentStatus();

    expect(env.OPENAI_API_KEY).toBe('Not set');
    expect(env.ANTHROPIC_API_KEY).toBe('Not set');
  });

  test('shows actual values for non-secret variables', async () => {
    process.env.MASTERCLAW_INFRA = '/path/to/infra';
    process.env.NODE_ENV = 'production';

    const env = await getEnvironmentStatus();

    expect(env.MASTERCLAW_INFRA).toBe('/path/to/infra');
    expect(env.NODE_ENV).toBe('production');
  });
});

// =============================================================================
// checkInfraStatus Tests
// =============================================================================

describe('checkInfraStatus', () => {
  test('returns status for configured infra directory', async () => {
    const status = await checkInfraStatus('/tmp/test-infra');

    expect(status).toHaveProperty('exists');
    expect(status).toHaveProperty('dockerCompose');
    expect(status).toHaveProperty('envFile');
    expect(status).toHaveProperty('path');
  });

  test('returns false for not configured', async () => {
    const status = await checkInfraStatus('Not configured');

    expect(status.exists).toBe(false);
    expect(status.dockerCompose).toBe(false);
    expect(status.envFile).toBe(false);
  });

  test('returns false for null infraDir', async () => {
    const status = await checkInfraStatus(null);

    expect(status.exists).toBe(false);
  });

  test('includes path when infraDir exists', async () => {
    const status = await checkInfraStatus('/tmp/test-infra');

    expect(status.path).toBe('/tmp/test-infra');
  });
});

// =============================================================================
// maskSecret Tests
// =============================================================================

describe('maskSecret', () => {
  test('returns "Not set" for null/undefined', () => {
    expect(maskSecret(null)).toBe('Not set');
    expect(maskSecret(undefined)).toBe('Not set');
    expect(maskSecret('')).toBe('Not set');
  });

  test('masks long secrets', () => {
    const secret = 'sk-test1234567890abcdef';
    const masked = maskSecret(secret);

    expect(masked).toContain('****');
    expect(masked).toBe('sk-t****cdef');
    expect(masked.length).toBeLessThan(secret.length);
  });

  test('masks very long secrets', () => {
    const secret = 'a'.repeat(100);
    const masked = maskSecret(secret);

    expect(masked).toBe('aaaa****aaaa');
  });

  test('shows **** for short secrets', () => {
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
  });

  test('masks 9-character secrets', () => {
    // 9 characters = first 4 + **** + last 4 = 12 characters
    expect(maskSecret('123456789')).toBe('1234****6789');
  });
});

// =============================================================================
// formatBytes Tests
// =============================================================================

describe('formatBytes', () => {
  test('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  test('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 Bytes');
  });

  test('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  test('formats megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
  });

  test('formats gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });

  test('formats terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
  });

  test('rounds to 2 decimal places', () => {
    const result = formatBytes(1536000);
    expect(result).toMatch(/1\.46\s+MB/);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  test('maskSecret handles unicode', () => {
    const masked = maskSecret('🔑secretkey🔑');
    expect(masked).toContain('****');
  });

  test('formatBytes handles very large numbers', () => {
    const result = formatBytes(1024 * 1024 * 1024 * 1024 * 10); // 10 TB
    expect(result).toBe('10 TB');
  });

  test('formatBytes handles floating point bytes', () => {
    // Though bytes are typically integers
    const result = formatBytes(100.5);
    expect(result).toBe('100.5 Bytes');
  });
});
