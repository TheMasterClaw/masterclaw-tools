/**
 * Tests for scan.js - Container Image Security Scanner
 * Run with: npm test -- scan.security.test.js
 */

const {
  detectScanner,
  getLocalImages,
  analyzeResults,
  DEFAULT_SERVICES,
  SEVERITY_LEVELS,
  DEFAULT_SEVERITY_THRESHOLD,
} = require('../lib/scan');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Scan Module Constants', () => {
  test('DEFAULT_SERVICES includes expected MasterClaw services', () => {
    expect(DEFAULT_SERVICES).toContain('mc-core');
    expect(DEFAULT_SERVICES).toContain('mc-backend');
    expect(DEFAULT_SERVICES).toContain('mc-gateway');
    expect(DEFAULT_SERVICES).toContain('mc-interface');
    expect(DEFAULT_SERVICES).toContain('mc-chroma');
    expect(DEFAULT_SERVICES).toContain('mc-redis');
    expect(DEFAULT_SERVICES).toContain('mc-traefik');
  });

  test('SEVERITY_LEVELS are in correct priority order', () => {
    expect(SEVERITY_LEVELS).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
  });

  test('DEFAULT_SEVERITY_THRESHOLD is HIGH', () => {
    expect(DEFAULT_SEVERITY_THRESHOLD).toBe('HIGH');
  });
});

// =============================================================================
// analyzeResults Tests
// =============================================================================

describe('analyzeResults', () => {
  test('analyzes Trivy JSON results correctly', () => {
    const mockResults = {
      Results: [
        {
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2024-0001',
              Severity: 'CRITICAL',
              PkgName: 'openssl',
              InstalledVersion: '1.1.1k',
              FixedVersion: '1.1.1l',
              Title: 'Buffer overflow in OpenSSL',
              Description: 'A buffer overflow vulnerability...',
            },
            {
              VulnerabilityID: 'CVE-2024-0002',
              Severity: 'HIGH',
              PkgName: 'nginx',
              InstalledVersion: '1.20.0',
              FixedVersion: '1.20.1',
              Title: 'Denial of service in nginx',
              Description: 'A DoS vulnerability...',
            },
            {
              VulnerabilityID: 'CVE-2024-0003',
              Severity: 'HIGH',
              PkgName: 'python',
              InstalledVersion: '3.9.0',
              FixedVersion: null,
              Title: 'Python security issue',
              Description: 'A security issue...',
            },
          ],
        },
      ],
    };

    const summary = analyzeResults(mockResults, 'trivy');

    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(2);
    expect(summary.medium).toBe(0);
    expect(summary.low).toBe(0);
    expect(summary.total).toBe(3);
    expect(summary.vulnerabilities).toHaveLength(3);

    // Check vulnerability structure
    expect(summary.vulnerabilities[0]).toMatchObject({
      id: 'CVE-2024-0001',
      severity: 'CRITICAL',
      package: 'openssl',
      version: '1.1.1k',
      fixedVersion: '1.1.1l',
      title: 'Buffer overflow in OpenSSL',
    });

    // Check that null fixedVersion is handled
    expect(summary.vulnerabilities[2].fixedVersion).toBeNull();
  });

  test('handles empty Trivy results', () => {
    const mockResults = { Results: [] };
    const summary = analyzeResults(mockResults, 'trivy');

    expect(summary.critical).toBe(0);
    expect(summary.high).toBe(0);
    expect(summary.total).toBe(0);
    expect(summary.vulnerabilities).toHaveLength(0);
  });

  test('handles Trivy results with no vulnerabilities', () => {
    const mockResults = {
      Results: [
        { Target: 'app', Class: 'os-pkgs', Type: 'debian' },
      ],
    };
    const summary = analyzeResults(mockResults, 'trivy');

    expect(summary.total).toBe(0);
    expect(summary.vulnerabilities).toHaveLength(0);
  });

  test('handles multiple Results from Trivy', () => {
    const mockResults = {
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-001', Severity: 'CRITICAL', PkgName: 'pkg1' },
          ],
        },
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-002', Severity: 'HIGH', PkgName: 'pkg2' },
            { VulnerabilityID: 'CVE-003', Severity: 'MEDIUM', PkgName: 'pkg3' },
          ],
        },
      ],
    };

    const summary = analyzeResults(mockResults, 'trivy');

    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(1);
    expect(summary.medium).toBe(1);
    expect(summary.total).toBe(3);
  });

  test('handles Docker Scout SARIF results', () => {
    const mockResults = {
      runs: [
        {
          results: [
            { level: 'error', message: { text: 'Critical vuln' } },
            { level: 'error', message: { text: 'Another critical' } },
            { level: 'warning', message: { text: 'Medium vuln' } },
            { level: 'note', message: { text: 'Low vuln' } },
          ],
        },
      ],
    };

    const summary = analyzeResults(mockResults, 'docker-scout');

    expect(summary.high).toBe(2); // error maps to high
    expect(summary.medium).toBe(1); // warning maps to medium
    expect(summary.low).toBe(1); // note maps to low
    expect(summary.total).toBe(4);
  });

  test('handles Docker Scout results with no vulnerabilities', () => {
    const mockResults = { runs: [{ tool: { driver: { name: 'Docker Scout' } } }] };
    const summary = analyzeResults(mockResults, 'docker-scout');

    expect(summary.total).toBe(0);
  });

  test('handles raw output fallback', () => {
    const mockResults = { raw: 'Some text output' };
    const summary = analyzeResults(mockResults, 'unknown');

    expect(summary.raw).toBe(true);
    expect(summary.total).toBe(0);
  });

  test('truncates long descriptions', () => {
    const longDescription = 'A'.repeat(500);
    const mockResults = {
      Results: [
        {
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2024-0001',
              Severity: 'HIGH',
              PkgName: 'test-pkg',
              InstalledVersion: '1.0.0',
              Description: longDescription,
            },
          ],
        },
      ],
    };

    const summary = analyzeResults(mockResults, 'trivy');
    expect(summary.vulnerabilities[0].description.length).toBeLessThanOrEqual(200);
  });
});

// =============================================================================
// detectScanner Tests
// =============================================================================

describe('detectScanner', () => {
  // Note: These tests assume the test environment may or may not have scanners installed
  // We test the function behavior rather than the specific result

  test('detectScanner returns a valid result object', async () => {
    const result = await detectScanner();

    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('installed');
    expect(typeof result.installed).toBe('boolean');

    if (result.installed) {
      expect(['trivy', 'docker-scout']).toContain(result.type);
    } else {
      expect(result.type).toBe('none');
    }
  });

  test('returns version when scanner is installed', async () => {
    const result = await detectScanner();

    if (result.installed && result.type === 'trivy') {
      expect(result.version).toBeDefined();
      // Version should follow semver format
      expect(result.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

// =============================================================================
// getLocalImages Tests
// =============================================================================

describe('getLocalImages', () => {
  test('returns an array', async () => {
    // This test assumes Docker might not be available in test environment
    // We handle both cases
    try {
      const images = await getLocalImages();
      expect(Array.isArray(images)).toBe(true);

      // If images exist, check structure
      for (const img of images) {
        expect(img).toHaveProperty('name');
        expect(img).toHaveProperty('tag');
        expect(img).toHaveProperty('id');
        expect(img).toHaveProperty('fullName');
      }
    } catch (err) {
      // Docker not available is acceptable in test environment
      expect(err.message).toMatch(/docker|command|failed/i);
    }
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe('Scan Security', () => {
  test('analyzeResults handles malformed input gracefully', () => {
    // Null/undefined input
    expect(() => analyzeResults(null, 'trivy')).not.toThrow();
    expect(() => analyzeResults(undefined, 'trivy')).not.toThrow();

    // Empty object
    expect(() => analyzeResults({}, 'trivy')).not.toThrow();

    // Malformed vulnerability entries
    const malformedResults = {
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: null, Severity: null, PkgName: null },
            { }, // empty vulnerability
          ],
        },
      ],
    };
    expect(() => analyzeResults(malformedResults, 'trivy')).not.toThrow();
  });

  test('analyzeResults handles unknown severity levels', () => {
    const mockResults = {
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-001', Severity: 'WEIRD', PkgName: 'pkg1' },
            { VulnerabilityID: 'CVE-002', Severity: '', PkgName: 'pkg2' },
          ],
        },
      ],
    };

    const summary = analyzeResults(mockResults, 'trivy');
    expect(summary.total).toBe(2);
    // Unknown severities should still be counted in vulnerabilities
    expect(summary.vulnerabilities).toHaveLength(2);
  });
});

// =============================================================================
// Integration-like Tests
// =============================================================================

describe('Scan Integration Scenarios', () => {
  test('correctly calculates pass/fail based on vulnerability counts', () => {
    // Image with only low/medium vulnerabilities should pass
    const lowRiskResults = {
      Results: [{
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-001', Severity: 'MEDIUM', PkgName: 'pkg1' },
          { VulnerabilityID: 'CVE-002', Severity: 'LOW', PkgName: 'pkg2' },
        ],
      }],
    };

    const lowSummary = analyzeResults(lowRiskResults, 'trivy');
    const lowPassed = lowSummary.critical === 0 && lowSummary.high === 0;
    expect(lowPassed).toBe(true);

    // Image with high vulnerabilities should fail
    const highRiskResults = {
      Results: [{
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-003', Severity: 'HIGH', PkgName: 'pkg3' },
        ],
      }],
    };

    const highSummary = analyzeResults(highRiskResults, 'trivy');
    const highPassed = highSummary.critical === 0 && highSummary.high === 0;
    expect(highPassed).toBe(false);

    // Image with critical vulnerabilities should fail
    const criticalResults = {
      Results: [{
        Vulnerabilities: [
          { VulnerabilityID: 'CVE-004', Severity: 'CRITICAL', PkgName: 'pkg4' },
        ],
      }],
    };

    const criticalSummary = analyzeResults(criticalResults, 'trivy');
    const criticalPassed = criticalSummary.critical === 0 && criticalSummary.high === 0;
    expect(criticalPassed).toBe(false);
  });
});
