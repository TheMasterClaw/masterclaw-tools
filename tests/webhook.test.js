/**
 * Tests for webhook.js module
 * Run with: npm test -- webhook.test.js
 *
 * Tests webhook management functionality including secret generation,
 * environment variable handling, and utility functions.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');

// Mock dependencies before requiring webhook module
jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn().mockResolvedValue('/tmp/test-infra'),
}));

jest.mock('../lib/audit', () => ({
  logAudit: jest.fn().mockResolvedValue(true),
  AuditEventType: {
    CONFIG_CHANGE: 'config_change',
  },
}));

jest.mock('../lib/http-client', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

// Setup test directory
const testDir = path.join(os.tmpdir(), 'masterclaw-test-webhook-' + Date.now());

const {
  generateWebhookSecret,
  loadEnv,
  saveEnv,
  getApiUrl,
} = require('../lib/webhook');

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Webhook Module', () => {
  beforeEach(async () => {
    await fs.ensureDir(testDir);
  });

  afterEach(async () => {
    await fs.remove(testDir);
  });

  afterAll(async () => {
    await fs.remove(testDir);
  });

  // ===========================================================================
  // generateWebhookSecret Tests
  // ===========================================================================
  describe('generateWebhookSecret', () => {
    test('generates a secret string', () => {
      const secret = generateWebhookSecret();
      expect(typeof secret).toBe('string');
      expect(secret.length).toBeGreaterThan(0);
    });

    test('generates unique secrets', () => {
      const secret1 = generateWebhookSecret();
      const secret2 = generateWebhookSecret();
      expect(secret1).not.toBe(secret2);
    });

    test('generates hex string of correct length', () => {
      const secret = generateWebhookSecret();
      // 32 bytes = 64 hex characters
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    test('uses cryptographically secure random', () => {
      // Mock crypto to verify it's being used
      const mockRandomBytes = jest.spyOn(crypto, 'randomBytes');
      generateWebhookSecret();
      expect(mockRandomBytes).toHaveBeenCalledWith(32);
      mockRandomBytes.mockRestore();
    });
  });

  // ===========================================================================
  // loadEnv Tests
  // ===========================================================================
  describe('loadEnv', () => {
    test('returns empty object when .env does not exist', async () => {
      const env = await loadEnv(testDir);
      expect(env).toEqual({});
    });

    test('parses simple key-value pairs', async () => {
      const envContent = 'KEY1=value1\nKEY2=value2\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY1).toBe('value1');
      expect(env.KEY2).toBe('value2');
    });

    test('ignores comments', async () => {
      const envContent = '# This is a comment\nKEY=value\n# Another comment\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY).toBe('value');
      expect(env['# This is a comment']).toBeUndefined();
    });

    test('ignores empty lines', async () => {
      const envContent = 'KEY1=value1\n\n\nKEY2=value2\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY1).toBe('value1');
      expect(env.KEY2).toBe('value2');
      expect(Object.keys(env).length).toBe(2);
    });

    test('handles values with equals signs', async () => {
      const envContent = 'KEY=value=with=equals\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY).toBe('value=with=equals');
    });

    test('strips quotes from values', async () => {
      const envContent = 'KEY1="quoted value"\nKEY2=\'single quoted\'\nKEY3=unquoted\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY1).toBe('quoted value');
      expect(env.KEY2).toBe('single quoted');
      expect(env.KEY3).toBe('unquoted');
    });

    test('handles complex real-world .env', async () => {
      const envContent = `# MasterClaw Configuration
DOMAIN=example.com
ACME_EMAIL=admin@example.com
GITHUB_WEBHOOK_SECRET=abc123
# API Keys
OPENAI_API_KEY="sk-test123"
`;
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.DOMAIN).toBe('example.com');
      expect(env.ACME_EMAIL).toBe('admin@example.com');
      expect(env.GITHUB_WEBHOOK_SECRET).toBe('abc123');
      expect(env.OPENAI_API_KEY).toBe('sk-test123');
    });
  });

  // ===========================================================================
  // saveEnv Tests
  // ===========================================================================
  describe('saveEnv', () => {
    test('creates .env file with variables', async () => {
      const env = { KEY1: 'value1', KEY2: 'value2' };
      await saveEnv(testDir, env);

      const content = await fs.readFile(path.join(testDir, '.env'), 'utf8');
      expect(content).toContain('KEY1=value1');
      expect(content).toContain('KEY2=value2');
    });

    test('updates existing variables', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'KEY1=oldvalue\nKEY2=value2\n');

      const env = { KEY1: 'newvalue' };
      await saveEnv(testDir, env);

      const content = await fs.readFile(path.join(testDir, '.env'), 'utf8');
      expect(content).toContain('KEY1=newvalue');
      expect(content).toContain('KEY2=value2');
    });

    test('adds new variables to existing file', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'EXISTING=value\n');

      const env = { NEW_KEY: 'new_value' };
      await saveEnv(testDir, env);

      const content = await fs.readFile(path.join(testDir, '.env'), 'utf8');
      expect(content).toContain('EXISTING=value');
      expect(content).toContain('NEW_KEY=new_value');
    });

    test('preserves comments in existing file', async () => {
      const originalContent = '# This is a comment\nKEY=value\n';
      await fs.writeFile(path.join(testDir, '.env'), originalContent);

      const env = { NEW_KEY: 'new_value' };
      await saveEnv(testDir, env);

      const content = await fs.readFile(path.join(testDir, '.env'), 'utf8');
      expect(content).toContain('# This is a comment');
      expect(content).toContain('KEY=value');
      expect(content).toContain('NEW_KEY=new_value');
    });

    test('sets secure file permissions (0o600)', async () => {
      const env = { SECRET_KEY: 'secret_value' };
      await saveEnv(testDir, env);

      const stats = await fs.stat(path.join(testDir, '.env'));
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    test('handles multiple variables at once', async () => {
      const env = {
        KEY1: 'value1',
        KEY2: 'value2',
        KEY3: 'value3',
      };
      await saveEnv(testDir, env);

      const content = await fs.readFile(path.join(testDir, '.env'), 'utf8');
      expect(content).toContain('KEY1=value1');
      expect(content).toContain('KEY2=value2');
      expect(content).toContain('KEY3=value3');
    });
  });

  // ===========================================================================
  // getApiUrl Tests
  // ===========================================================================
  describe('getApiUrl', () => {
    test('returns localhost URL when DOMAIN is localhost', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'DOMAIN=localhost\n');

      const apiUrl = await getApiUrl(testDir);
      expect(apiUrl).toBe('http://localhost:8000');
    });

    test('returns localhost URL when DOMAIN is not set', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'OTHER_KEY=value\n');

      const apiUrl = await getApiUrl(testDir);
      expect(apiUrl).toBe('http://localhost:8000');
    });

    test('returns production URL with api subdomain', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'DOMAIN=example.com\n');

      const apiUrl = await getApiUrl(testDir);
      expect(apiUrl).toBe('https://api.example.com');
    });

    test('handles custom domains', async () => {
      await fs.writeFile(path.join(testDir, '.env'), 'DOMAIN=myapp.mydomain.io\n');

      const apiUrl = await getApiUrl(testDir);
      expect(apiUrl).toBe('https://api.myapp.mydomain.io');
    });
  });

  // ===========================================================================
  // Integration Tests
  // ===========================================================================
  describe('Integration', () => {
    test('full env lifecycle: load → modify → save → load', async () => {
      // Initial save
      await saveEnv(testDir, { KEY1: 'value1', KEY2: 'value2' });

      // Load and verify
      let env = await loadEnv(testDir);
      expect(env.KEY1).toBe('value1');
      expect(env.KEY2).toBe('value2');

      // Modify
      env.KEY1 = 'updated';
      env.KEY3 = 'new';

      // Save
      await saveEnv(testDir, env);

      // Reload and verify
      env = await loadEnv(testDir);
      expect(env.KEY1).toBe('updated');
      expect(env.KEY2).toBe('value2');
      expect(env.KEY3).toBe('new');
    });

    test('webhook secret generation and storage', async () => {
      // Generate secret
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^[a-f0-9]{64}$/);

      // Store in env
      await saveEnv(testDir, { GITHUB_WEBHOOK_SECRET: secret });

      // Load and verify
      const env = await loadEnv(testDir);
      expect(env.GITHUB_WEBHOOK_SECRET).toBe(secret);
    });

    test('preserves existing config when adding webhook settings', async () => {
      // Existing config
      await saveEnv(testDir, {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
      });

      // Add webhook config
      const secret = generateWebhookSecret();
      await saveEnv(testDir, {
        GITHUB_WEBHOOK_SECRET: secret,
        GITHUB_WEBHOOK_EVENTS: 'push,pull_request',
      });

      // Verify all values preserved
      const env = await loadEnv(testDir);
      expect(env.DOMAIN).toBe('example.com');
      expect(env.ACME_EMAIL).toBe('admin@example.com');
      expect(env.GITHUB_WEBHOOK_SECRET).toBe(secret);
      expect(env.GITHUB_WEBHOOK_EVENTS).toBe('push,pull_request');
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================
  describe('Edge Cases', () => {
    test('handles empty env object', async () => {
      await saveEnv(testDir, {});
      const env = await loadEnv(testDir);
      expect(env).toEqual({});
    });

    test('handles values with special characters', async () => {
      const env = {
        SPECIAL: 'value with spaces and !@#$%',
        JSON_VALUE: '{"key":"value"}',
        URL: 'https://api.example.com/webhook?token=abc123',
      };
      await saveEnv(testDir, env);

      const loaded = await loadEnv(testDir);
      expect(loaded.SPECIAL).toBe('value with spaces and !@#$%');
      expect(loaded.JSON_VALUE).toBe('{"key":"value"}');
      expect(loaded.URL).toBe('https://api.example.com/webhook?token=abc123');
    });

    test('handles very long values', async () => {
      const longValue = 'a'.repeat(10000);
      await saveEnv(testDir, { LONG_KEY: longValue });

      const env = await loadEnv(testDir);
      expect(env.LONG_KEY).toBe(longValue);
    });

    test('handles multiline values in env file', async () => {
      // Note: Standard .env format doesn't support multiline values well
      // This tests how our parser handles them
      const envContent = 'KEY=value\nMULTI=line1\\nline2\n';
      await fs.writeFile(path.join(testDir, '.env'), envContent);

      const env = await loadEnv(testDir);
      expect(env.KEY).toBe('value');
      expect(env.MULTI).toBe('line1\\nline2');
    });

    test('handles .env file with only comments', async () => {
      await fs.writeFile(path.join(testDir, '.env'), '# Just a comment\n# Another comment\n');

      const env = await loadEnv(testDir);
      expect(env).toEqual({});
    });
  });
});
