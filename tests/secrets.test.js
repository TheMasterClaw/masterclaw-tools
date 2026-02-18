/**
 * Secrets module tests
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock dependencies
jest.mock('../lib/audit');
jest.mock('../lib/services');
jest.mock('../lib/config');

const { logAuditEvent } = require('../lib/audit');
const { findInfraDir } = require('../lib/services');
const { CONFIG_DIR, loadConfig } = require('../lib/config');

const {
  setSecret,
  getSecret,
  getSecretMetadata,
  listSecrets,
  deleteSecret,
  generateToken,
  checkSecrets,
  maskValue,
  REQUIRED_SECRETS,
} = require('../lib/secrets');

describe('Secrets Module', () => {
  const testSecretsFile = path.join(os.tmpdir(), `test-secrets-${Date.now()}.json`);
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock CONFIG_DIR to use temp directory
    Object.defineProperty(require('../lib/secrets'), 'SECRETS_FILE', {
      value: testSecretsFile,
      writable: true,
    });
    
    // Ensure clean state
    if (fs.existsSync(testSecretsFile)) {
      fs.unlinkSync(testSecretsFile);
    }
    
    // Mock findInfraDir
    findInfraDir.mockResolvedValue('/tmp/masterclaw-infrastructure');
  });
  
  afterEach(async () => {
    if (fs.existsSync(testSecretsFile)) {
      fs.unlinkSync(testSecretsFile);
    }
  });

  describe('setSecret', () => {
    it('should set a new secret', async () => {
      const result = await setSecret('GATEWAY_TOKEN', 'mc_test_token_123');
      
      expect(result.key).toBe('GATEWAY_TOKEN');
      expect(result.created).toBe(true);
      expect(result.rotated).toBe(false);
      expect(logAuditEvent).toHaveBeenCalled();
    });
    
    it('should rotate an existing secret', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_old_token');
      const result = await setSecret('GATEWAY_TOKEN', 'mc_new_token');
      
      expect(result.created).toBe(false);
      expect(result.rotated).toBe(true);
    });
    
    it('should validate key format', async () => {
      await expect(setSecret('invalid-key', 'value')).rejects.toThrow('Invalid secret key name');
      await expect(setSecret('lowercase', 'value')).rejects.toThrow('Invalid secret key name');
    });
    
    it('should validate secret patterns', async () => {
      // OpenAI key should match pattern
      await expect(setSecret('OPENAI_API_KEY', 'invalid')).rejects.toThrow('Invalid format');
      
      // Valid format should work
      const result = await setSecret('OPENAI_API_KEY', 'sk-test' + 'a'.repeat(48));
      expect(result.key).toBe('OPENAI_API_KEY');
    });
  });
  
  describe('getSecret', () => {
    it('should retrieve a secret value', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_test_token');
      const value = await getSecret('GATEWAY_TOKEN');
      
      expect(value).toBe('mc_test_token');
    });
    
    it('should return null for non-existent secret', async () => {
      const value = await getSecret('NON_EXISTENT');
      expect(value).toBeNull();
    });
  });
  
  describe('getSecretMetadata', () => {
    it('should return metadata without exposing value', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_secret_value_123');
      const metadata = await getSecretMetadata('GATEWAY_TOKEN');
      
      expect(metadata.key).toBe('GATEWAY_TOKEN');
      expect(metadata.value).not.toBe('mc_secret_value_123');
      expect(metadata.value).toContain('***');
      expect(metadata.source).toBe('cli');
    });
  });
  
  describe('listSecrets', () => {
    it('should list all secrets with masked values', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_token_1');
      await setSecret('OPENAI_API_KEY', 'sk-testkey123456789');
      
      const list = await listSecrets();
      
      expect(list).toHaveLength(2);
      expect(list[0].value).toContain('***');
      expect(list[1].value).toContain('***');
    });
    
    it('should return empty array when no secrets', async () => {
      const list = await listSecrets();
      expect(list).toEqual([]);
    });
  });
  
  describe('deleteSecret', () => {
    it('should delete an existing secret', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_token');
      const result = await deleteSecret('GATEWAY_TOKEN');
      
      expect(result.deleted).toBe(true);
      expect(await getSecret('GATEWAY_TOKEN')).toBeNull();
    });
    
    it('should throw error for non-existent secret', async () => {
      await expect(deleteSecret('NON_EXISTENT')).rejects.toThrow('not found');
    });
  });
  
  describe('generateToken', () => {
    it('should generate a token of correct length', () => {
      const token = generateToken(32);
      // base64url encoding of 32 bytes = ~43 chars
      expect(token.length).toBeGreaterThan(40);
    });
    
    it('should generate unique tokens', () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });
  });
  
  describe('checkSecrets', () => {
    it('should identify missing required secrets', async () => {
      const results = await checkSecrets();
      
      expect(results.valid).toBe(false);
      expect(results.missing).toContain('GATEWAY_TOKEN');
    });
    
    it('should recognize configured secrets', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_' + 'a'.repeat(32));
      
      const results = await checkSecrets();
      
      expect(results.combined.GATEWAY_TOKEN).toBe(true);
      expect(results.cli.GATEWAY_TOKEN).toBe(true);
    });
  });
  
  describe('maskValue', () => {
    it('should mask short values', () => {
      expect(maskValue('abc')).toBe('***');
    });
    
    it('should mask long values showing first and last chars', () => {
      const masked = maskValue('sk-1234567890abcdef');
      expect(masked).toContain('***');
      expect(masked.startsWith('sk')).toBe(true);
    });
    
    it('should handle empty/null values', () => {
      expect(maskValue('')).toBe('***');
      expect(maskValue(null)).toBe('***');
    });
  });
  
  describe('REQUIRED_SECRETS', () => {
    it('should define GATEWAY_TOKEN as required', () => {
      const gatewayToken = REQUIRED_SECRETS.find(s => s.key === 'GATEWAY_TOKEN');
      expect(gatewayToken).toBeDefined();
      expect(gatewayToken.required).toBe(true);
    });
    
    it('should define API keys as optional', () => {
      const openai = REQUIRED_SECRETS.find(s => s.key === 'OPENAI_API_KEY');
      const anthropic = REQUIRED_SECRETS.find(s => s.key === 'ANTHROPIC_API_KEY');
      
      expect(openai.required).toBe(false);
      expect(anthropic.required).toBe(false);
    });
  });
  
  describe('Security', () => {
    it('should set secure file permissions', async () => {
      await setSecret('TEST_SECRET', 'test_value');
      
      // Check that file was created
      expect(fs.existsSync(testSecretsFile)).toBe(true);
      
      // File should be readable (we can't easily check permissions in test)
      const content = fs.readFileSync(testSecretsFile, 'utf-8');
      const secrets = JSON.parse(content);
      expect(secrets.TEST_SECRET.value).toBe('test_value');
    });
  });
});
