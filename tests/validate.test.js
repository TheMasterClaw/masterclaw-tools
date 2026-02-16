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

  describe('Security Constants', () => {
    test('DANGEROUS_ENV_KEYS contains expected values', () => {
      expect(validate.DANGEROUS_ENV_KEYS.has('__proto__')).toBe(true);
      expect(validate.DANGEROUS_ENV_KEYS.has('constructor')).toBe(true);
      expect(validate.DANGEROUS_ENV_KEYS.has('prototype')).toBe(true);
    });

    test('MAX_ENV_FILE_SIZE is reasonable', () => {
      expect(validate.MAX_ENV_FILE_SIZE).toBe(1024 * 1024); // 1MB
      expect(validate.MAX_ENV_FILE_SIZE).toBeGreaterThan(0);
    });

    test('MAX_ENV_FILE_LINES is reasonable', () => {
      expect(validate.MAX_ENV_FILE_LINES).toBe(10000);
      expect(validate.MAX_ENV_FILE_LINES).toBeGreaterThan(0);
    });
  });

  describe('isDangerousEnvKey', () => {
    test('identifies dangerous keys', () => {
      expect(validate.isDangerousEnvKey('__proto__')).toBe(true);
      expect(validate.isDangerousEnvKey('constructor')).toBe(true);
      expect(validate.isDangerousEnvKey('prototype')).toBe(true);
    });

    test('allows safe keys', () => {
      expect(validate.isDangerousEnvKey('DOMAIN')).toBe(false);
      expect(validate.isDangerousEnvKey('TOKEN')).toBe(false);
      expect(validate.isDangerousEnvKey('__proto')).toBe(false); // Missing underscore
      expect(validate.isDangerousEnvKey('constructor__')).toBe(false);
      expect(validate.isDangerousEnvKey('Prototype')).toBe(false); // Case sensitive
    });
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

    test('creates object with null prototype (safe from pollution)', async () => {
      const envContent = 'DOMAIN=example.com';
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      // Object should not have prototype chain
      expect(Object.getPrototypeOf(vars)).toBeNull();
    });

    test('skips dangerous __proto__ key', async () => {
      const envContent = `
DOMAIN=example.com
__proto__=polluted
TOKEN=secret
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.TOKEN).toBe('secret');
      expect(vars.__proto__).toBeUndefined();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('__proto__')
      );
      
      consoleSpy.mockRestore();
    });

    test('skips dangerous constructor key', async () => {
      const envContent = `
DOMAIN=example.com
constructor=polluted
TOKEN=secret
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.TOKEN).toBe('secret');
      expect(vars.constructor).toBeUndefined();
      
      consoleSpy.mockRestore();
    });

    test('skips dangerous prototype key', async () => {
      const envContent = `
DOMAIN=example.com
prototype=polluted
TOKEN=secret
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.TOKEN).toBe('secret');
      expect(vars.prototype).toBeUndefined();
      
      consoleSpy.mockRestore();
    });

    test('prevents prototype pollution attack simulation', async () => {
      const envContent = `
DOMAIN=example.com
__proto__.isAdmin=true
constructor.prototype.isAdmin=true
`;
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      // Verify object prototype was not polluted
      expect(({}).isAdmin).toBeUndefined();
      expect(vars.isAdmin).toBeUndefined();
      
      consoleSpy.mockRestore();
    });

    test('rejects files exceeding size limit', async () => {
      const largeContent = 'A'.repeat(validate.MAX_ENV_FILE_SIZE + 1);
      await fs.writeFile(path.join(tempDir, '.env'), largeContent);
      
      await expect(
        validate.parseEnvFile(path.join(tempDir, '.env'))
      ).rejects.toThrow('exceeds maximum allowed');
    });

    test('rejects files with too many lines', async () => {
      const manyLines = Array(validate.MAX_ENV_FILE_LINES + 1).fill('KEY=value').join('\n');
      await fs.writeFile(path.join(tempDir, '.env'), manyLines);
      
      await expect(
        validate.parseEnvFile(path.join(tempDir, '.env'))
      ).rejects.toThrow('line count');
    });

    test('handles env files at size boundary', async () => {
      const boundaryContent = 'A'.repeat(validate.MAX_ENV_FILE_SIZE);
      await fs.writeFile(path.join(tempDir, '.env'), boundaryContent);
      
      // Should not throw
      await expect(
        validate.parseEnvFile(path.join(tempDir, '.env'))
      ).resolves.toBeDefined();
    });

    test('handles env files at line count boundary', async () => {
      const boundaryLines = Array(validate.MAX_ENV_FILE_LINES).fill('KEY=value').join('\n');
      await fs.writeFile(path.join(tempDir, '.env'), boundaryLines);
      
      // Should not throw
      await expect(
        validate.parseEnvFile(path.join(tempDir, '.env'))
      ).resolves.toBeDefined();
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

    test('handles malicious env files gracefully', async () => {
      const maliciousEnv = `
DOMAIN=example.com
__proto__={"isAdmin":true}
constructor={"evil":true}
GATEWAY_TOKEN=valid_token_123456789
`;
      await fs.writeFile(path.join(tempDir, '.env'), maliciousEnv);
      
      const results = await validate.validate({ infraDir: tempDir });
      
      // Should not crash and should properly validate
      expect(results).toBeDefined();
      expect(results.checks).toBeDefined();
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

  describe('Prototype Pollution Security Integration', () => {
    test('env file parsing does not pollute Object.prototype', async () => {
      // Save original prototype
      const originalProto = Object.prototype.toString;
      
      const maliciousEnv = `
__proto__.polluted=true
constructor.prototype.polluted=true
prototype.polluted=true
`;
      await fs.writeFile(path.join(tempDir, '.env'), maliciousEnv);
      
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      // Verify Object.prototype was not polluted
      expect(({}).polluted).toBeUndefined();
      expect(Object.prototype.polluted).toBeUndefined();
      expect(Object.prototype.toString).toBe(originalProto);
      
      consoleSpy.mockRestore();
    });

    test('validates that parsed object has null prototype', async () => {
      const envContent = 'DOMAIN=example.com\nTOKEN=secret';
      await fs.writeFile(path.join(tempDir, '.env'), envContent);
      
      const vars = await validate.parseEnvFile(path.join(tempDir, '.env'));
      
      // Object.create(null) objects don't have standard methods
      expect(vars.toString).toBeUndefined();
      expect(vars.hasOwnProperty).toBeUndefined();
      expect(vars.constructor).toBeUndefined();
      
      // But they can still be used normally
      expect(vars.DOMAIN).toBe('example.com');
      expect(vars.TOKEN).toBe('secret');
      expect(Object.keys(vars)).toEqual(['DOMAIN', 'TOKEN']);
    });
  });
});
