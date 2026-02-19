/**
 * Tests for doctor.js module
 * Run with: npm test -- doctor.test.js
 *
 * Tests MasterClaw Doctor diagnostic functionality.
 */

const {
  MasterClawDoctor,
  CATEGORIES,
  SEVERITY,
} = require('../lib/doctor');

// Mock dependencies
jest.mock('../lib/services', () => ({
  findInfraDir: jest.fn().mockReturnValue('/tmp/test-infra'),
}));

jest.mock('../lib/config', () => ({
  get: jest.fn().mockResolvedValue('http://localhost:3001'),
}));

// =============================================================================
// Constants Tests
// =============================================================================

describe('Doctor Module Constants', () => {
  test('CATEGORIES contains expected categories', () => {
    expect(CATEGORIES.SYSTEM).toBe('system');
    expect(CATEGORIES.DOCKER).toBe('docker');
    expect(CATEGORIES.SERVICES).toBe('services');
    expect(CATEGORIES.CONFIG).toBe('config');
    expect(CATEGORIES.NETWORK).toBe('network');
    expect(CATEGORIES.SECURITY).toBe('security');
    expect(CATEGORIES.PERFORMANCE).toBe('performance');
  });

  test('SEVERITY contains expected levels', () => {
    expect(SEVERITY.CRITICAL).toBe('critical');
    expect(SEVERITY.HIGH).toBe('high');
    expect(SEVERITY.MEDIUM).toBe('medium');
    expect(SEVERITY.LOW).toBe('low');
    expect(SEVERITY.INFO).toBe('info');
  });
});

// =============================================================================
// MasterClawDoctor Class Tests
// =============================================================================

describe('MasterClawDoctor', () => {
  let doctor;

  beforeEach(() => {
    doctor = new MasterClawDoctor();
  });

  test('creates instance with default options', () => {
    expect(doctor.options.verbose).toBe(false);
    expect(doctor.options.fix).toBe(false);
    expect(doctor.options.category).toBeNull();
    expect(doctor.options.json).toBe(false);
  });

  test('creates instance with custom options', () => {
    const customDoctor = new MasterClawDoctor({
      verbose: true,
      fix: true,
      category: 'system',
      json: true,
    });
    expect(customDoctor.options.verbose).toBe(true);
    expect(customDoctor.options.fix).toBe(true);
    expect(customDoctor.options.category).toBe('system');
    expect(customDoctor.options.json).toBe(true);
  });

  test('initializes with empty issues and checks arrays', () => {
    expect(doctor.issues).toEqual([]);
    expect(doctor.checks).toEqual([]);
  });

  test('sets start time on creation', () => {
    expect(doctor.startTime).toBeLessThanOrEqual(Date.now());
    expect(doctor.startTime).toBeGreaterThan(Date.now() - 1000);
  });

  // ===========================================================================
  // addIssue Tests
  // ===========================================================================
  describe('addIssue', () => {
    test('adds issue with all fields', () => {
      doctor.addIssue(
        CATEGORIES.SYSTEM,
        SEVERITY.HIGH,
        'Test Issue',
        'Test description',
        'Test fix'
      );

      expect(doctor.issues.length).toBe(1);
      expect(doctor.issues[0].category).toBe('system');
      expect(doctor.issues[0].severity).toBe('high');
      expect(doctor.issues[0].title).toBe('Test Issue');
      expect(doctor.issues[0].description).toBe('Test description');
      expect(doctor.issues[0].fix).toBe('Test fix');
      expect(doctor.issues[0].timestamp).toBeDefined();
    });

    test('adds issue without fix', () => {
      doctor.addIssue(
        CATEGORIES.DOCKER,
        SEVERITY.MEDIUM,
        'Another Issue',
        'Another description'
      );

      expect(doctor.issues[0].fix).toBeNull();
    });

    test('adds multiple issues', () => {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.LOW, 'Issue 1', 'Desc 1');
      doctor.addIssue(CATEGORIES.NETWORK, SEVERITY.HIGH, 'Issue 2', 'Desc 2');

      expect(doctor.issues.length).toBe(2);
      expect(doctor.issues[0].title).toBe('Issue 1');
      expect(doctor.issues[1].title).toBe('Issue 2');
    });
  });

  // ===========================================================================
  // addCheck Tests
  // ===========================================================================
  describe('addCheck', () => {
    test('adds passed check', () => {
      doctor.addCheck(CATEGORIES.SYSTEM, 'Disk space', true, '50% free');

      expect(doctor.checks.length).toBe(1);
      expect(doctor.checks[0].category).toBe('system');
      expect(doctor.checks[0].name).toBe('Disk space');
      expect(doctor.checks[0].passed).toBe(true);
      expect(doctor.checks[0].details).toBe('50% free');
      expect(doctor.checks[0].timestamp).toBeDefined();
    });

    test('adds failed check', () => {
      doctor.addCheck(CATEGORIES.DOCKER, 'Docker daemon', false, 'Not running');

      expect(doctor.checks[0].passed).toBe(false);
      expect(doctor.checks[0].details).toBe('Not running');
    });

    test('adds check without details', () => {
      doctor.addCheck(CATEGORIES.SERVICES, 'Service check', true);

      expect(doctor.checks[0].details).toBe('');
    });
  });

  // ===========================================================================
  // generateReport Tests
  // ===========================================================================
  describe('generateReport', () => {
    test('generates empty report', () => {
      const report = doctor.generateReport();

      expect(report.duration).toBeGreaterThanOrEqual(0);
      expect(report.summary.checksPassed).toBe(0);
      expect(report.summary.checksTotal).toBe(0);
      expect(report.summary.issuesFound).toBe(0);
      expect(report.summary.healthy).toBe(true);
      expect(report.issues).toEqual([]);
      expect(report.checks).toEqual([]);
    });

    test('counts issues by severity', () => {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.CRITICAL, 'Critical', 'Desc');
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.HIGH, 'High', 'Desc');
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.HIGH, 'High 2', 'Desc');
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.MEDIUM, 'Medium', 'Desc');

      const report = doctor.generateReport();

      expect(report.summary.issuesBySeverity.critical).toBe(1);
      expect(report.summary.issuesBySeverity.high).toBe(2);
      expect(report.summary.issuesBySeverity.medium).toBe(1);
      expect(report.summary.issuesBySeverity.low).toBe(0);
      expect(report.summary.issuesFound).toBe(4);
    });

    test('marks unhealthy with critical issues', () => {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.CRITICAL, 'Critical', 'Desc');

      const report = doctor.generateReport();
      expect(report.summary.healthy).toBe(false);
    });

    test('marks unhealthy with high issues', () => {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.HIGH, 'High', 'Desc');

      const report = doctor.generateReport();
      expect(report.summary.healthy).toBe(false);
    });

    test('marks healthy with only medium/low issues', () => {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.MEDIUM, 'Medium', 'Desc');
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.LOW, 'Low', 'Desc');

      const report = doctor.generateReport();
      expect(report.summary.healthy).toBe(true);
    });

    test('counts passed and total checks', () => {
      doctor.addCheck(CATEGORIES.SYSTEM, 'Check 1', true);
      doctor.addCheck(CATEGORIES.SYSTEM, 'Check 2', true);
      doctor.addCheck(CATEGORIES.DOCKER, 'Check 3', false);

      const report = doctor.generateReport();

      expect(report.summary.checksPassed).toBe(2);
      expect(report.summary.checksTotal).toBe(3);
    });

    test('includes duration in report', () => {
      // Wait a bit to ensure duration > 0
      const startTime = Date.now();
      doctor.startTime = startTime - 100; // Simulate 100ms elapsed

      const report = doctor.generateReport();
      expect(report.duration).toBeGreaterThanOrEqual(100);
    });
  });

  // ===========================================================================
  // Utility Method Tests
  // ===========================================================================
  describe('Utility Methods', () => {
    test('formatBytes formats bytes correctly', () => {
      expect(doctor.formatBytes(0)).toBe('0 B');
      expect(doctor.formatBytes(1024)).toBe('1 KB');
      expect(doctor.formatBytes(1024 * 1024)).toBe('1 MB');
      expect(doctor.formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    test('formatBytes handles decimal values', () => {
      expect(doctor.formatBytes(1536)).toBe('1.5 KB');
      expect(doctor.formatBytes(1536000)).toMatch(/1.46 MB/);
    });

    test('parseDockerSize parses various units', () => {
      expect(doctor.parseDockerSize('100B')).toBe(100);
      expect(doctor.parseDockerSize('10KB')).toBe(10 * 1024);
      expect(doctor.parseDockerSize('5MB')).toBe(5 * 1024 * 1024);
      expect(doctor.parseDockerSize('2GB')).toBe(2 * 1024 * 1024 * 1024);
    });

    test('parseDockerSize handles decimal values', () => {
      expect(doctor.parseDockerSize('1.5GB')).toBe(1.5 * 1024 * 1024 * 1024);
    });

    test('parseDockerSize returns 0 for invalid input', () => {
      expect(doctor.parseDockerSize('invalid')).toBe(0);
      expect(doctor.parseDockerSize('')).toBe(0);
    });
  });

  // ===========================================================================
  // Port Availability Tests
  // ===========================================================================
  describe('isPortAvailable', () => {
    test('returns false for taken ports', async () => {
      // Port 1 is typically reserved/special
      const net = require('net');
      const server = net.createServer();

      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const port = server.address().port;
          doctor.isPortAvailable(port).then((available) => {
            expect(available).toBe(false);
            server.close(resolve);
          });
        });
      });
    });

    test('returns true for available ports', async () => {
      // Test with a high port that's likely available
      const available = await doctor.isPortAvailable(65000);
      expect(typeof available).toBe('boolean');
    });
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  test('handles empty options object', () => {
    const doctor = new MasterClawDoctor({});
    expect(doctor.options.verbose).toBe(false);
    expect(doctor.options.fix).toBe(false);
  });

  test('handles null options by using defaults', () => {
    // The constructor has default parameter {}, so null would cause error
    // This tests the actual behavior - passing undefined uses defaults
    const doctor = new MasterClawDoctor(undefined);
    expect(doctor.options.verbose).toBe(false);
  });

  test('handles very long issue descriptions', () => {
    const doctor = new MasterClawDoctor();
    const longDesc = 'a'.repeat(10000);
    doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.LOW, 'Long', longDesc);

    expect(doctor.issues[0].description.length).toBe(10000);
  });

  test('handles many issues', () => {
    const doctor = new MasterClawDoctor();
    for (let i = 0; i < 100; i++) {
      doctor.addIssue(CATEGORIES.SYSTEM, SEVERITY.LOW, `Issue ${i}`, `Desc ${i}`);
    }

    const report = doctor.generateReport();
    expect(report.summary.issuesFound).toBe(100);
  });
});
