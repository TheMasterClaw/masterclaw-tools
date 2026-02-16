/**
 * Tests for the validate module
 */

const validate = require('../lib/validate');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

describe('Validate Module', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-validate-test-'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  describe('parseEnvFile', () => {
    test('parses basic env file', async () => {
      const envContent = `
DOMAIN=example.com
ACME_EMAIL=admin@example.com
GATEWAY_TOKEN=secret123
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.ACME_EMAIL).toBe('admin@example.com');
      expect(vars.GATEWAY_TOKEN).toBe('secret123');
    });

    test('handles quoted values', async () => {
      const envContent = `DOMAIN="example.com"\nTOKEN='secret123'`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.TOKEN).toBe('secret123');
    });

    test('ignores comments and empty lines', async () => {
      const envContent = `
# This is a comment
DOMAIN=example.com

# Another comment
TOKEN=secret
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(Object.keys(vars).length).toBe(2);
      expect(vars.DOMAIN).toBe('example.com');
    });

    test('returns empty object for missing file', async () => {
      const vars = await validate.parseEnvFile(path.join(tempDir, 'nonexistent.env'));
      expect(vars).toEqual({});
    });
  });

  describe('isValidEmail', () => {
    test('accepts valid emails', () => {
      expect(validate.isValidEmail('admin@example.com')).toBe(true);
      expect(validate.isValidEmail('user.name@domain.co.uk')).toBe(true);
      expect(validate.isValidEmail('user+tag@example.com')).toBe(true);
    });

    test('rejects invalid emails', () => {
      expect(validate.isValidEmail('notanemail')).toBe(false);
      expect(validate.isValidEmail('@example.com')).toBe(false);
      expect(validate.isValidEmail('user@')).toBe(false);
      expect(validate.isValidEmail('')).toBe(false);
    });
  });

  describe('isValidDomain', () => {
    test('accepts valid domains', () => {
      expect(validate.isValidDomain('example.com')).toBe(true);
      expect(validate.isValidDomain('sub.domain.co.uk')).toBe(true);
      expect(validate.isValidDomain('localhost')).toBe(true);
    });

    test('rejects invalid domains', () => {
      expect(validate.isValidDomain('-invalid.com')).toBe(false);
      expect(validate.isValidDomain('invalid-.com')).toBe(false);
      expect(validate.isValidDomain('')).toBe(false);
    });
  });

  describe('validateTokenStrength', () => {
    test('identifies weak tokens', () => {
      const result = validate.validateTokenStrength('short');
      expect(result.strength).toBe('weak');
      expect(result.valid).toBe(false);
    });

    test('identifies medium strength tokens', () => {
      const result = validate.validateTokenStrength('longertokenbutnouppercaseornumbers');
      expect(result.strength).toBe('medium');
      expect(result.valid).toBe(true);
    });

    test('identifies strong tokens', () => {
      const result = validate.validateTokenStrength('StrongToken123WithMixedCaseAndNumbers');
      expect(result.strength).toBe('strong');
      expect(result.valid).toBe(true);
    });
  });

  describe('checkDocker', () => {
    test('returns status object', async () => {
      const result = await validate.checkDocker();
      
      expect(result).toHaveProperty('installed');
      expect(result).toHaveProperty('running');
      expect(typeof result.installed).toBe('boolean');
    });
  });

  describe('checkDockerCompose', () => {
    test('returns status object', async () => {
      const result = await validate.checkDockerCompose();
      
      expect(result).toHaveProperty('installed');
      expect(typeof result.installed).toBe('boolean');
    });
  });

  describe('validate', () => {
    test('fails when .env is missing', async () => {
      const results = await validate.validate({ infraDir: tempDir });
      
      expect(results.passed).toBe(false);
      expect(results.errors.some(e => e.message.includes('.env file not found'))).toBe(true);
    });

    test('fails when required env vars are missing', async () => {
      await fs.writeFile(path.join(tempDir, '.env'), 'SOME_OTHER_VAR=value');
      
      const results = await validate.validate({ infraDir: tempDir });
      
      expect(results.passed).toBe(false);
      expect(results.errors.some(e => e.message.includes('DOMAIN'))).toBe(true);
    });

    test('warns about weak tokens', async () => {
      const envContent = `
DOMAIN=example.com
ACME_EMAIL=admin@example.com
GATEWAY_TOKEN=weak
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const results = await validate.validate({ infraDir: tempDir });
      
      expect(results.warnings.some(w => w.message.includes('GATEWAY_TOKEN'))).toBe(true);
    });

    test('warns about invalid email format', async () => {
      const envContent = `
DOMAIN=example.com
ACME_EMAIL=not-an-email
GATEWAY_TOKEN=strongToken123456789
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const results = await validate.validate({ infraDir: tempDir });
      
      expect(results.warnings.some(w => w.message.includes('ACME_EMAIL'))).toBe(true);
    });

    test('warns about placeholder values', async () => {
      const envContent = `
DOMAIN=your-domain.com
ACME_EMAIL=admin@example.com
GATEWAY_TOKEN=your-token-here
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const results = await validate.validate({ infraDir: tempDir });
      
      expect(results.warnings.some(w => w.message.includes('placeholder'))).toBe(true);
    });
  });

  describe('checkSystemResources', () => {
    test('returns resource information', async () => {
      const resources = await validate.checkSystemResources();
      
      expect(resources).toHaveProperty('totalMemoryGB');
      expect(resources).toHaveProperty('freeMemoryGB');
      expect(resources).toHaveProperty('memoryUsagePercent');
      expect(parseFloat(resources.totalMemoryGB)).toBeGreaterThan(0);
    });
  });
});
