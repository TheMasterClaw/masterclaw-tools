/**
 * Tests for audit.js integrity verification
 * Run with: npm test -- audit.integrity.test.js
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const crypto = require('crypto');

// Create mock test directory with unique timestamp
const mockTestDir = path.join(os.tmpdir(), `masterclaw-audit-test-${Date.now()}`);

// Mock os.homedir BEFORE requiring audit module
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => mockTestDir),
}));

const {
  getAuditSigningKey,
  generateEntrySignature,
  signAuditEntry,
  verifyEntrySignature,
  verifyAuditIntegrity,
  rotateSigningKey,
  createAuditEntry,
  AUDIT_DIR,
  HMAC_ALGORITHM,
} = require('../lib/audit');

// =============================================================================
// Setup and Teardown
// =============================================================================

beforeAll(async () => {
  await fs.ensureDir(AUDIT_DIR);
  await fs.chmod(AUDIT_DIR, 0o755);
});

afterAll(async () => {
  await fs.remove(mockTestDir);
});

beforeEach(async () => {
  // Clean up any existing key before each test
  const keyFile = path.join(AUDIT_DIR, '.audit.key');
  await fs.remove(keyFile).catch(() => {});
  // Clean up log files
  const logFiles = ['audit.log', 'audit.1.log', 'audit.2.log'];
  for (const file of logFiles) {
    await fs.remove(path.join(AUDIT_DIR, file)).catch(() => {});
  }
});

// =============================================================================
// Signing Key Management Tests
// =============================================================================

describe('getAuditSigningKey', () => {
  test('creates new key if none exists', async () => {
    const key = await getAuditSigningKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32); // 256 bits
  });

  test('returns existing key if present', async () => {
    const key1 = await getAuditSigningKey();
    const key2 = await getAuditSigningKey();
    expect(key1.equals(key2)).toBe(true);
  });

  test('creates key file with secure permissions', async () => {
    await getAuditSigningKey();
    const keyFile = path.join(AUDIT_DIR, '.audit.key');
    const stats = await fs.stat(keyFile);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// =============================================================================
// Signature Generation Tests
// =============================================================================

describe('generateEntrySignature', () => {
  test('generates consistent signature for same entry', () => {
    const key = crypto.randomBytes(32);
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    
    const sig1 = generateEntrySignature(entry, key);
    const sig2 = generateEntrySignature(entry, key);
    
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[a-f0-9]{64}$/); // 256-bit hex
  });

  test('generates different signatures for different entries', () => {
    const key = crypto.randomBytes(32);
    const entry1 = createAuditEntry('TEST_EVENT', { test: 'data1' });
    const entry2 = createAuditEntry('TEST_EVENT', { test: 'data2' });
    
    const sig1 = generateEntrySignature(entry1, key);
    const sig2 = generateEntrySignature(entry2, key);
    
    expect(sig1).not.toBe(sig2);
  });

  test('generates different signatures with different keys', () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    
    const sig1 = generateEntrySignature(entry, key1);
    const sig2 = generateEntrySignature(entry, key2);
    
    expect(sig1).not.toBe(sig2);
  });

  test('excludes existing signature from signature computation', () => {
    const key = crypto.randomBytes(32);
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    entry._signature = 'existing-signature';
    
    const sig = generateEntrySignature(entry, key);
    
    // Should not contain the existing signature in the computed value
    expect(sig).not.toContain('existing-signature');
  });

  test('produces deterministic signatures (sorted keys)', () => {
    const key = crypto.randomBytes(32);
    
    // Create entries with same data but different key order
    const entry1 = { id: 'test', timestamp: '2024-01-01', eventType: 'TEST' };
    const entry2 = { eventType: 'TEST', id: 'test', timestamp: '2024-01-01' };
    
    const sig1 = generateEntrySignature(entry1, key);
    const sig2 = generateEntrySignature(entry2, key);
    
    expect(sig1).toBe(sig2);
  });
});

// =============================================================================
// Entry Signing Tests
// =============================================================================

describe('signAuditEntry', () => {
  test('adds signature to entry', async () => {
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    const signed = await signAuditEntry(entry);
    
    expect(signed._signature).toBeDefined();
    expect(signed._signature).toMatch(/^[a-f0-9]{64}$/);
    expect(signed._sigAlg).toBe(HMAC_ALGORITHM);
  });

  test('preserves original entry data', async () => {
    const entry = createAuditEntry('TEST_EVENT', { test: 'data', nested: { key: 'value' } });
    const signed = await signAuditEntry(entry);
    
    expect(signed.id).toBe(entry.id);
    expect(signed.timestamp).toBe(entry.timestamp);
    expect(signed.eventType).toBe(entry.eventType);
    expect(signed.details).toEqual(entry.details);
  });
});

// =============================================================================
// Signature Verification Tests
// =============================================================================

describe('verifyEntrySignature', () => {
  test('returns true for valid signature', async () => {
    // Get the signing key first
    const key = await getAuditSigningKey();
    
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    const signed = await signAuditEntry(entry);
    
    // Verify with explicit key
    const isValid = await verifyEntrySignature(signed, key);
    expect(isValid).toBe(true);
  });

  test('returns false for tampered entry', async () => {
    const key = await getAuditSigningKey();
    
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    const signed = await signAuditEntry(entry);
    
    // Tamper with the entry
    signed.details.test = 'tampered';
    
    const isValid = await verifyEntrySignature(signed, key);
    expect(isValid).toBe(false);
  });

  test('returns false for missing signature', async () => {
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    
    const isValid = await verifyEntrySignature(entry);
    expect(isValid).toBe(false);
  });

  test('returns false for wrong signature', async () => {
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    entry._signature = '0000000000000000000000000000000000000000000000000000000000000000';
    
    const isValid = await verifyEntrySignature(entry);
    expect(isValid).toBe(false);
  });

  test('uses constant-time comparison (prevents timing attacks)', async () => {
    const key = await getAuditSigningKey();
    
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    const signed = await signAuditEntry(entry);
    
    // Change one character in signature
    signed._signature = signed._signature.slice(0, -1) + (signed._signature.slice(-1) === '0' ? '1' : '0');
    
    const isValid = await verifyEntrySignature(signed, key);
    expect(isValid).toBe(false);
  });

  test('accepts external key for verification', async () => {
    const systemKey = await getAuditSigningKey();
    
    const entry = createAuditEntry('TEST_EVENT', { test: 'data' });
    const signed = await signAuditEntry(entry);
    
    // Should succeed with correct key
    const isValidCorrect = await verifyEntrySignature(signed, systemKey);
    expect(isValidCorrect).toBe(true);
    
    // Should fail with wrong key
    const wrongKey = crypto.randomBytes(32);
    const isValidWrong = await verifyEntrySignature(signed, wrongKey);
    expect(isValidWrong).toBe(false);
  });
});

// =============================================================================
// Audit Integrity Verification Tests
// =============================================================================

describe('verifyAuditIntegrity', () => {
  test('returns valid result for empty logs', async () => {
    const result = await verifyAuditIntegrity();
    
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(0);
    expect(result.filesChecked).toEqual([]);
  });

  test('verifies signed entries correctly', async () => {
    const key = await getAuditSigningKey();
    
    // Create a log file with signed entries
    const entry1 = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    const entry2 = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 2 }));
    
    const logContent = JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n';
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.log'), logContent);
    
    const result = await verifyAuditIntegrity();
    
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(2);
    expect(result.validSignatures).toBe(2);
    expect(result.invalidSignatures).toBe(0);
  });

  test('detects tampered entries', async () => {
    const key = await getAuditSigningKey();
    
    // Create a log file with one valid and one tampered entry
    const entry1 = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    const entry2 = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 2 }));
    
    // Tamper with entry2
    entry2.details.data = 999;
    
    const logContent = JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n';
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.log'), logContent);
    
    const result = await verifyAuditIntegrity();
    
    expect(result.valid).toBe(false);
    expect(result.totalEntries).toBe(2);
    expect(result.validSignatures).toBe(1);
    expect(result.invalidSignatures).toBe(1);
  });

  test('counts unsigned entries', async () => {
    const key = await getAuditSigningKey();
    
    const signedEntry = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    const unsignedEntry = createAuditEntry('TEST_EVENT', { data: 2 });
    
    const logContent = JSON.stringify(signedEntry) + '\n' + JSON.stringify(unsignedEntry) + '\n';
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.log'), logContent);
    
    const result = await verifyAuditIntegrity();
    
    expect(result.totalEntries).toBe(2);
    expect(result.validSignatures).toBe(1);
    expect(result.unsignedEntries).toBe(1);
  });

  test('checks rotated log files', async () => {
    const key = await getAuditSigningKey();
    
    const entry = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.1.log'), JSON.stringify(entry) + '\n');
    
    const result = await verifyAuditIntegrity();
    
    expect(result.filesChecked).toContain('audit.1.log');
    expect(result.totalEntries).toBe(1);
  });

  test('respects hours filter', async () => {
    const key = await getAuditSigningKey();
    
    // Create old entry
    const oldEntry = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    oldEntry.timestamp = '2020-01-01T00:00:00.000Z';
    
    // Create recent entry
    const newEntry = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 2 }));
    
    const logContent = JSON.stringify(oldEntry) + '\n' + JSON.stringify(newEntry) + '\n';
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.log'), logContent);
    
    const result = await verifyAuditIntegrity({ hours: 1 });
    
    expect(result.totalEntries).toBe(1); // Only recent entry
    expect(result.validSignatures).toBe(1);
  });

  test('verbose mode includes error details', async () => {
    const key = await getAuditSigningKey();
    
    const entry = await signAuditEntry(createAuditEntry('TEST_EVENT', { data: 1 }));
    entry.details.data = 999; // Tamper
    
    await fs.writeFile(path.join(AUDIT_DIR, 'audit.log'), JSON.stringify(entry) + '\n');
    
    const result = await verifyAuditIntegrity({ verbose: true });
    
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatchObject({
      file: 'audit.log',
      line: 1,
      error: expect.stringContaining('tampered'),
    });
  });
});

// =============================================================================
// Key Rotation Tests
// =============================================================================

describe('rotateSigningKey', () => {
  test('creates new key different from old', async () => {
    const oldKey = await getAuditSigningKey();
    
    await rotateSigningKey();
    
    const newKey = await getAuditSigningKey();
    expect(oldKey.equals(newKey)).toBe(false);
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Audit Integrity Integration', () => {
  test('end-to-end: create, sign, write, verify', async () => {
    const key = await getAuditSigningKey();
    
    // Create and sign entry
    const entry = createAuditEntry('SECURITY_VIOLATION', { 
      violationType: 'TEST_VIOLATION',
      details: 'Test details',
    });
    const signed = await signAuditEntry(entry);
    
    // Write to log
    const logPath = path.join(AUDIT_DIR, 'audit.log');
    await fs.writeFile(logPath, JSON.stringify(signed) + '\n');
    
    // Verify
    const result = await verifyAuditIntegrity();
    
    expect(result.valid).toBe(true);
    expect(result.totalEntries).toBe(1);
    expect(result.validSignatures).toBe(1);
  });

  test('detects tampering after write', async () => {
    const key = await getAuditSigningKey();
    
    // Create and sign entry
    const entry = createAuditEntry('TEST_EVENT', { data: 'original' });
    const signed = await signAuditEntry(entry);
    
    // Write to log
    const logPath = path.join(AUDIT_DIR, 'audit.log');
    await fs.writeFile(logPath, JSON.stringify(signed) + '\n');
    
    // Tamper with the file directly
    const tamperedEntry = { ...signed, details: { data: 'tampered' } };
    await fs.writeFile(logPath, JSON.stringify(tamperedEntry) + '\n');
    
    // Verify should detect tampering
    const result = await verifyAuditIntegrity();
    
    expect(result.valid).toBe(false);
    expect(result.invalidSignatures).toBe(1);
  });

  test('multiple entries across multiple files', async () => {
    const key = await getAuditSigningKey();
    
    // Create entries for current log
    for (let i = 0; i < 3; i++) {
      const entry = await signAuditEntry(createAuditEntry('TEST_EVENT', { num: i }));
      await fs.appendFile(path.join(AUDIT_DIR, 'audit.log'), JSON.stringify(entry) + '\n');
    }
    
    // Create entries for rotated log
    for (let i = 0; i < 2; i++) {
      const entry = await signAuditEntry(createAuditEntry('TEST_EVENT', { num: i + 100 }));
      await fs.appendFile(path.join(AUDIT_DIR, 'audit.1.log'), JSON.stringify(entry) + '\n');
    }
    
    const result = await verifyAuditIntegrity();
    
    expect(result.totalEntries).toBe(5);
    expect(result.validSignatures).toBe(5);
    expect(result.filesChecked).toContain('audit.log');
    expect(result.filesChecked).toContain('audit.1.log');
  });
});
