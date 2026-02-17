/**
 * Tests for environment configuration management
 */

const { 
  parseEnvFile, 
  serializeEnv, 
  compareEnvs, 
  validateEnv, 
  generateTemplate,
  ENV_SCHEMA,
} = require('../lib/env');

describe('Environment Management', () => {
  
  describe('parseEnvFile', () => {
    test('parses basic key=value pairs', () => {
      const content = 'DOMAIN=example.com\nACME_EMAIL=admin@example.com';
      const env = parseEnvFile(content);
      expect(env).toEqual({
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
      });
    });
    
    test('ignores comments and empty lines', () => {
      const content = `
# This is a comment
DOMAIN=example.com

ACME_EMAIL=admin@example.com
# Another comment
`;
      const env = parseEnvFile(content);
      expect(env).toEqual({
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
      });
    });
    
    test('handles quoted values', () => {
      const content = 'DOMAIN="example.com"\nKEY=\'value with spaces\'';
      const env = parseEnvFile(content);
      expect(env).toEqual({
        DOMAIN: 'example.com',
        KEY: 'value with spaces',
      });
    });
    
    test('handles values with equals signs', () => {
      const content = 'KEY=val=ue=with=equals';
      const env = parseEnvFile(content);
      expect(env).toEqual({
        KEY: 'val=ue=with=equals',
      });
    });
  });
  
  describe('serializeEnv', () => {
    test('serializes env to string', () => {
      const env = {
        DOMAIN: 'example.com',
        KEY: 'value',
      };
      const result = serializeEnv(env);
      expect(result).toContain('DOMAIN=example.com');
      expect(result).toContain('KEY=value');
    });
    
    test('quotes values with spaces', () => {
      const env = {
        KEY: 'value with spaces',
      };
      const result = serializeEnv(env);
      expect(result).toContain('KEY="value with spaces"');
    });
    
    test('includes comments', () => {
      const env = {
        DOMAIN: 'example.com',
      };
      const comments = {
        DOMAIN: 'Your domain',
      };
      const result = serializeEnv(env, comments);
      expect(result).toContain('# Your domain');
      expect(result).toContain('DOMAIN=example.com');
    });
  });
  
  describe('compareEnvs', () => {
    test('detects added keys', () => {
      const local = { A: '1' };
      const remote = { A: '1', B: '2' };
      const diff = compareEnvs(local, remote);
      expect(diff.added).toHaveLength(1);
      expect(diff.added[0].key).toBe('B');
    });
    
    test('detects removed keys', () => {
      const local = { A: '1', B: '2' };
      const remote = { A: '1' };
      const diff = compareEnvs(local, remote);
      expect(diff.removed).toHaveLength(1);
      expect(diff.removed[0].key).toBe('B');
    });
    
    test('detects modified keys', () => {
      const local = { A: '1' };
      const remote = { A: '2' };
      const diff = compareEnvs(local, remote);
      expect(diff.modified).toHaveLength(1);
      expect(diff.modified[0]).toEqual({
        key: 'A',
        local: '1',
        remote: '2',
      });
    });
    
    test('handles sensitive keys separately', () => {
      const local = { GATEWAY_TOKEN: 'abc' };
      const remote = { GATEWAY_TOKEN: 'xyz' };
      const diff = compareEnvs(local, remote);
      expect(diff.sensitive).toHaveLength(1);
      expect(diff.modified).toHaveLength(0);
    });
    
    test('detects unchanged keys', () => {
      const local = { A: '1', B: '2' };
      const remote = { A: '1', B: '2' };
      const diff = compareEnvs(local, remote);
      expect(diff.unchanged).toHaveLength(2);
    });
  });
  
  describe('validateEnv', () => {
    test('validates required variables', () => {
      const env = {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
        GATEWAY_TOKEN: 'token123',
      };
      const result = validateEnv(env);
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
    });
    
    test('detects missing required variables', () => {
      const env = {};
      const result = validateEnv(env);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.some(i => i.type === 'required')).toBe(true);
    });
    
    test('detects placeholder values', () => {
      const env = {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
        GATEWAY_TOKEN: 'your-gateway-token-here',
      };
      const result = validateEnv(env);
      expect(result.issues.some(i => i.type === 'placeholder')).toBe(true);
    });
    
    test('validates email format', () => {
      const env = {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'invalid-email',
        GATEWAY_TOKEN: 'token123',
      };
      const result = validateEnv(env);
      expect(result.issues.some(i => i.type === 'format' && i.key === 'ACME_EMAIL')).toBe(true);
    });
    
    test('validates URL format (no protocol)', () => {
      const env = {
        DOMAIN: 'https://example.com',
        ACME_EMAIL: 'admin@example.com',
        GATEWAY_TOKEN: 'token123',
      };
      const result = validateEnv(env);
      expect(result.issues.some(i => i.type === 'format' && i.key === 'DOMAIN')).toBe(true);
    });
    
    test('generates warnings for recommended variables', () => {
      const env = {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
        GATEWAY_TOKEN: 'token123',
      };
      const result = validateEnv(env);
      expect(result.warnings.some(w => w.type === 'recommended')).toBe(true);
    });
    
    test('skips recommended check when specified', () => {
      const env = {
        DOMAIN: 'example.com',
        ACME_EMAIL: 'admin@example.com',
        GATEWAY_TOKEN: 'token123',
      };
      const result = validateEnv(env, { skipRecommended: true });
      expect(result.warnings.filter(w => w.type === 'recommended')).toHaveLength(0);
    });
  });
  
  describe('generateTemplate', () => {
    test('generates template with required fields', () => {
      const template = generateTemplate();
      expect(template).toContain('DOMAIN=');
      expect(template).toContain('ACME_EMAIL=');
      expect(template).toContain('GATEWAY_TOKEN=');
    });
    
    test('includes optional keys when specified', () => {
      const template = generateTemplate({ includeOptional: true });
      expect(template).toContain('OPENAI_API_KEY=');
      expect(template).toContain('ANTHROPIC_API_KEY=');
    });
    
    test('excludes optional keys by default', () => {
      const template = generateTemplate();
      expect(template).not.toContain('OPENAI_API_KEY=sk-');
    });
  });
  
  describe('ENV_SCHEMA', () => {
    test('has required fields defined', () => {
      expect(ENV_SCHEMA.required).toContain('DOMAIN');
      expect(ENV_SCHEMA.required).toContain('ACME_EMAIL');
      expect(ENV_SCHEMA.required).toContain('GATEWAY_TOKEN');
    });
    
    test('has sensitive fields defined', () => {
      expect(ENV_SCHEMA.sensitive).toContain('GATEWAY_TOKEN');
      expect(ENV_SCHEMA.sensitive).toContain('OPENAI_API_KEY');
      expect(ENV_SCHEMA.sensitive).toContain('ANTHROPIC_API_KEY');
    });
  });
});
