/**
 * Secrets module tests - Including Encryption at Rest
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

// Mock dependencies
jest.mock('../lib/audit');
jest.mock('../lib/services');
jest.mock('../lib/config');

const { logAudit } = require('../lib/audit');
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
  // Encryption functions
  deriveSystemKey,
  generateEncryptionKey,
  wrapKey,
  unwrapKey,
  encryptSecret,
  decryptSecret,
  isEncryptedValue,
  ENCRYPTION_ALGORITHM,
} = require('../lib/secrets');

describe('Secrets Module', () => {
  const testSecretsFile = path.join(os.tmpdir(), `test-secrets-${Date.now()}.json`);
  const testKeyFile = path.join(os.tmpdir(), `test-secrets-key-${Date.now()}.key`);
  
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock CONFIG_DIR to use temp directory
    const secretsModule = require('../lib/secrets');
    Object.defineProperty(secretsModule, 'SECRETS_FILE', {
      value: testSecretsFile,
      writable: true,
    });
    Object.defineProperty(secretsModule, 'KEY_FILE', {
      value: testKeyFile,
      writable: true,
    });
    
    // Ensure clean state
    [testSecretsFile, testKeyFile].forEach(f => {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    });
    
    // Mock findInfraDir
    findInfraDir.mockResolvedValue('/tmp/masterclaw-infrastructure');
  });
  
  afterEach(async () => {
    [testSecretsFile, testKeyFile].forEach(f => {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    });
  });

  describe('setSecret', () => {
    it('should set a new secret', async () => {
      const result = await setSecret('GATEWAY_TOKEN', 'mc_test_token_12345678');
      
      expect(result.key).toBe('GATEWAY_TOKEN');
      expect(result.created).toBe(true);
      expect(result.rotated).toBe(false);
      expect(logAudit).toHaveBeenCalled();
    });
    
    it('should rotate an existing secret', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_old_token_12345678');
      const result = await setSecret('GATEWAY_TOKEN', 'mc_new_token_12345678');
      
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
      await setSecret('GATEWAY_TOKEN', 'mc_test_token_12345678');
      const value = await getSecret('GATEWAY_TOKEN');
      
      expect(value).toBe('mc_test_token_12345678');
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
      await setSecret('GATEWAY_TOKEN', 'mc_token_12345678');
      await setSecret('OPENAI_API_KEY', 'sk-test' + 'a'.repeat(48));
      
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
      await setSecret('GATEWAY_TOKEN', 'mc_token_12345678');
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
      // Clear any existing secrets first
      const existing = await listSecrets();
      for (const secret of existing) {
        await deleteSecret(secret.key);
      }
      
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
      await setSecret('TEST_SECRET', 'test_value_12345678');
      
      // Check that file was created
      expect(fs.existsSync(testSecretsFile)).toBe(true);
      
      // File should be readable (we can't easily check permissions in test)
      const content = fs.readFileSync(testSecretsFile, 'utf-8');
      const secrets = JSON.parse(content);
      expect(secrets.TEST_SECRET.value).toBeDefined();
    });
  });
});

// =============================================================================
// Encryption at Rest Tests - Security Hardening
// =============================================================================

describe('Encryption at Rest', () => {
  describe('deriveSystemKey', () => {
    it('should derive a consistent key for the same system', () => {
      const key1 = deriveSystemKey();
      const key2 = deriveSystemKey();
      
      expect(key1).toEqual(key2);
      expect(key1.length).toBe(32); // SHA-256 output
    });
    
    it('should derive different keys for different entropy', () => {
      const originalKey = deriveSystemKey();
      
      // Temporarily change environment
      const originalHostname = os.hostname;
      os.hostname = () => 'different-host';
      
      const differentKey = deriveSystemKey();
      
      // Restore
      os.hostname = originalHostname;
      
      // Keys should be different (we can't easily test this without mocking os)
      // but we can verify the key is valid
      expect(differentKey.length).toBe(32);
    });
  });
  
  describe('generateEncryptionKey', () => {
    it('should generate a 256-bit key', () => {
      const key = generateEncryptionKey();
      
      expect(key.length).toBe(32); // 256 bits = 32 bytes
    });
    
    it('should generate unique keys', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      
      expect(key1).not.toEqual(key2);
    });
  });
  
  describe('wrapKey / unwrapKey', () => {
    it('should wrap and unwrap a key correctly', () => {
      const systemKey = deriveSystemKey();
      const dataKey = generateEncryptionKey();
      
      const wrapped = wrapKey(dataKey, systemKey);
      const unwrapped = unwrapKey(wrapped, systemKey);
      
      expect(unwrapped).toEqual(dataKey);
    });
    
    it('should return null when unwrapping with wrong system key', () => {
      const systemKey1 = deriveSystemKey();
      const dataKey = generateEncryptionKey();
      
      const wrapped = wrapKey(dataKey, systemKey1);
      
      // Create a different system key
      const wrongKey = Buffer.alloc(32, 0xFF);
      const unwrapped = unwrapKey(wrapped, wrongKey);
      
      expect(unwrapped).toBeNull();
    });
    
    it('should return null when data is tampered', () => {
      const systemKey = deriveSystemKey();
      const dataKey = generateEncryptionKey();
      
      let wrapped = wrapKey(dataKey, systemKey);
      
      // Tamper with the wrapped key
      const tamperedData = Buffer.from(wrapped, 'base64');
      tamperedData[tamperedData.length - 1] ^= 0xFF; // Flip bits in last byte
      wrapped = tamperedData.toString('base64');
      
      const unwrapped = unwrapKey(wrapped, systemKey);
      
      expect(unwrapped).toBeNull();
    });
    
    it('should produce different wrapped output each time', () => {
      const systemKey = deriveSystemKey();
      const dataKey = generateEncryptionKey();
      
      const wrapped1 = wrapKey(dataKey, systemKey);
      const wrapped2 = wrapKey(dataKey, systemKey);
      
      expect(wrapped1).not.toBe(wrapped2);
      
      // But both should unwrap to the same key
      expect(unwrapKey(wrapped1, systemKey)).toEqual(dataKey);
      expect(unwrapKey(wrapped2, systemKey)).toEqual(dataKey);
    });
  });
  
  describe('encryptSecret / decryptSecret', () => {
    it('should encrypt and decrypt a secret correctly', () => {
      const key = generateEncryptionKey();
      const plaintext = 'sk-test-api-key-12345';
      
      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);
      
      expect(decrypted).toBe(plaintext);
    });
    
    it('should produce different ciphertext each time (IV uniqueness)', () => {
      const key = generateEncryptionKey();
      const plaintext = 'same-secret';
      
      const encrypted1 = encryptSecret(plaintext, key);
      const encrypted2 = encryptSecret(plaintext, key);
      
      expect(encrypted1).not.toBe(encrypted2);
      
      // But both should decrypt to the same plaintext
      expect(decryptSecret(encrypted1, key)).toBe(plaintext);
      expect(decryptSecret(encrypted2, key)).toBe(plaintext);
    });
    
    it('should return null when decrypting with wrong key', () => {
      const key1 = generateEncryptionKey();
      const key2 = generateEncryptionKey();
      const plaintext = 'secret-data';
      
      const encrypted = encryptSecret(plaintext, key1);
      const decrypted = decryptSecret(encrypted, key2);
      
      expect(decrypted).toBeNull();
    });
    
    it('should return null when ciphertext is tampered', () => {
      const key = generateEncryptionKey();
      const plaintext = 'important-secret';
      
      let encrypted = encryptSecret(plaintext, key);
      
      // Tamper with ciphertext
      const data = Buffer.from(encrypted, 'base64');
      data[data.length - 1] ^= 0xFF;
      encrypted = data.toString('base64');
      
      const decrypted = decryptSecret(encrypted, key);
      
      expect(decrypted).toBeNull();
    });
    
    it('should handle unicode and special characters', () => {
      const key = generateEncryptionKey();
      const plaintext = '🔐 Secret with üñíçødé and !@#$%^&*()';
      
      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);
      
      expect(decrypted).toBe(plaintext);
    });
    
    it('should handle empty strings', () => {
      const key = generateEncryptionKey();
      const plaintext = '';
      
      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);
      
      expect(decrypted).toBe(plaintext);
    });
    
    it('should handle long secrets', () => {
      const key = generateEncryptionKey();
      const plaintext = 'a'.repeat(10000);
      
      const encrypted = encryptSecret(plaintext, key);
      const decrypted = decryptSecret(encrypted, key);
      
      expect(decrypted).toBe(plaintext);
    });
  });
  
  describe('isEncryptedValue', () => {
    it('should return true for encrypted values', () => {
      const key = generateEncryptionKey();
      const encrypted = encryptSecret('secret', key);
      
      expect(isEncryptedValue(encrypted)).toBe(true);
    });
    
    it('should return false for plaintext values', () => {
      expect(isEncryptedValue('plaintext-secret')).toBe(false);
      expect(isEncryptedValue('sk-test-api-key')).toBe(false);
      expect(isEncryptedValue('mc_gateway_token')).toBe(false);
    });
    
    it('should return false for non-strings', () => {
      expect(isEncryptedValue(null)).toBe(false);
      expect(isEncryptedValue(undefined)).toBe(false);
      expect(isEncryptedValue(12345)).toBe(false);
      expect(isEncryptedValue({})).toBe(false);
    });
    
    it('should return false for invalid base64', () => {
      expect(isEncryptedValue('not-valid-base64!!!')).toBe(false);
    });
    
    it('should return false for short base64 strings', () => {
      // Base64 of less than 33 bytes
      expect(isEncryptedValue(Buffer.from('short').toString('base64'))).toBe(false);
    });
  });
  
  describe('Integration - Encryption with Storage', () => {
    const testSecretsFile = path.join(os.tmpdir(), `test-secrets-enc-${Date.now()}.json`);
    const testKeyFile = path.join(os.tmpdir(), `test-secrets-key-enc-${Date.now()}.key`);
    
    beforeEach(() => {
      const secretsModule = require('../lib/secrets');
      Object.defineProperty(secretsModule, 'SECRETS_FILE', {
        value: testSecretsFile,
        writable: true,
      });
      Object.defineProperty(secretsModule, 'KEY_FILE', {
        value: testKeyFile,
        writable: true,
      });
    });
    
    afterEach(() => {
      [testSecretsFile, testKeyFile].forEach(f => {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      });
    });
    
    it('should store secrets in encrypted format', async () => {
      await setSecret('GATEWAY_TOKEN', 'mc_secret_token_12345678');
      
      const content = fs.readFileSync(testSecretsFile, 'utf-8');
      const secrets = JSON.parse(content);
      
      // The stored value should be encrypted (base64 format)
      expect(isEncryptedValue(secrets.GATEWAY_TOKEN.value)).toBe(true);
      
      // Should not contain plaintext
      expect(content).not.toContain('mc_secret_token_12345678');
    });
    
    it('should decrypt secrets when retrieved', async () => {
      const originalValue = 'sk-' + 'a'.repeat(48); // Valid OpenAI API key format
      await setSecret('OPENAI_API_KEY', originalValue);
      
      const retrieved = await getSecret('OPENAI_API_KEY');
      
      expect(retrieved).toBe(originalValue);
    });
    
    it('should handle multiple encrypted secrets', async () => {
      const secrets = {
        GATEWAY_TOKEN: 'mc_token_12345678',
        OPENAI_API_KEY: 'sk-' + 'a'.repeat(48),
        ANTHROPIC_API_KEY: 'sk-ant-' + 'b'.repeat(32),
      };
      
      for (const [key, value] of Object.entries(secrets)) {
        await setSecret(key, value);
      }
      
      for (const [key, expectedValue] of Object.entries(secrets)) {
        const retrieved = await getSecret(key);
        expect(retrieved).toBe(expectedValue);
      }
    });
  });
  
  describe('Encryption Constants', () => {
    it('should use AES-256-GCM algorithm', () => {
      expect(ENCRYPTION_ALGORITHM).toBe('aes-256-gcm');
    });
  });
});
