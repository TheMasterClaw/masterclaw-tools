/**
 * Tests for scan.js module
 * Run with: npm test -- scan.test.js
 *
 * Tests container security scanning functionality.
 */

const {
  DEFAULT_SERVICES,
  SEVERITY_LEVELS,
  DEFAULT_SEVERITY_THRESHOLD,
  DEFAULT_SCAN_TIMEOUT_MS,
  TRIVY_MIN_VERSION,
  parseSeverity,
  formatVulnerabilityCount,
  meetsSeverityThreshold,
  generateScanSummary,
} = require('../lib/scan');

// =============================================================================
// Constants Tests
// =============================================================================

describe('Scan Module Constants', () => {
  test('DEFAULT_SERVICES contains expected services', () => {
    expect(DEFAULT_SERVICES).toContain('mc-core');
    expect(DEFAULT_SERVICES).toContain('mc-backend');
    expect(DEFAULT_SERVICES).toContain('mc-gateway');
    expect(DEFAULT_SERVICES).toContain('mc-interface');
    expect(DEFAULT_SERVICES).toContain('mc-chroma');
  });

  test('SEVERITY_LEVELS are in correct priority order', () => {
    expect(SEVERITY_LEVELS).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
  });

  test('DEFAULT_SEVERITY_THRESHOLD is HIGH', () => {
    expect(DEFAULT_SEVERITY_THRESHOLD).toBe('HIGH');
  });

  test('DEFAULT_SCAN_TIMEOUT_MS is 10 minutes', () => {
    expect(DEFAULT_SCAN_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test('TRIVY_MIN_VERSION is defined', () => {
    expect(TRIVY_MIN_VERSION).toBe('0.48.0');
  });
});

// =============================================================================
// parseSeverity Tests
// =============================================================================

describe('parseSeverity', () => {
  test('returns normalized severity for valid inputs', () => {
    expect(parseSeverity('CRITICAL')).toBe('CRITICAL');
    expect(parseSeverity('critical')).toBe('CRITICAL');
    expect(parseSeverity('Critical')).toBe('CRITICAL');
    expect(parseSeverity('HIGH')).toBe('HIGH');
    expect(parseSeverity('high')).toBe('HIGH');
    expect(parseSeverity('MEDIUM')).toBe('MEDIUM');
    expect(parseSeverity('LOW')).toBe('LOW');
    expect(parseSeverity('UNKNOWN')).toBe('UNKNOWN');
  });

  test('returns null for invalid severity', () => {
    expect(parseSeverity('invalid')).toBeNull();
    expect(parseSeverity('')).toBeNull();
    expect(parseSeverity(null)).toBeNull();
    expect(parseSeverity(undefined)).toBeNull();
  });
});

// =============================================================================
// formatVulnerabilityCount Tests
// =============================================================================

describe('formatVulnerabilityCount', () => {
  test('formats zero vulnerabilities', () => {
    expect(formatVulnerabilityCount(0)).toBe('0');
  });

  test('formats single vulnerability', () => {
    expect(formatVulnerabilityCount(1)).toBe('1');
  });

  test('formats multiple vulnerabilities', () => {
    expect(formatVulnerabilityCount(5)).toBe('5');
  });

  test('formats large numbers', () => {
    expect(formatVulnerabilityCount(1000)).toBe('1,000');
    expect(formatVulnerabilityCount(1000000)).toBe('1,000,000');
  });
});

// =============================================================================
// meetsSeverityThreshold Tests
// =============================================================================

describe('meetsSeverityThreshold', () => {
  test('CRITICAL meets all thresholds', () => {
    expect(meetsSeverityThreshold('CRITICAL', 'CRITICAL')).toBe(true);
    expect(meetsSeverityThreshold('CRITICAL', 'HIGH')).toBe(true);
    expect(meetsSeverityThreshold('CRITICAL', 'MEDIUM')).toBe(true);
    expect(meetsSeverityThreshold('CRITICAL', 'LOW')).toBe(true);
  });

  test('HIGH meets HIGH and below', () => {
    expect(meetsSeverityThreshold('HIGH', 'CRITICAL')).toBe(false);
    expect(meetsSeverityThreshold('HIGH', 'HIGH')).toBe(true);
    expect(meetsSeverityThreshold('HIGH', 'MEDIUM')).toBe(true);
    expect(meetsSeverityThreshold('HIGH', 'LOW')).toBe(true);
  });

  test('MEDIUM meets MEDIUM and below', () => {
    expect(meetsSeverityThreshold('MEDIUM', 'CRITICAL')).toBe(false);
    expect(meetsSeverityThreshold('MEDIUM', 'HIGH')).toBe(false);
    expect(meetsSeverityThreshold('MEDIUM', 'MEDIUM')).toBe(true);
    expect(meetsSeverityThreshold('MEDIUM', 'LOW')).toBe(true);
  });

  test('LOW meets only LOW', () => {
    expect(meetsSeverityThreshold('LOW', 'CRITICAL')).toBe(false);
    expect(meetsSeverityThreshold('LOW', 'HIGH')).toBe(false);
    expect(meetsSeverityThreshold('LOW', 'MEDIUM')).toBe(false);
    expect(meetsSeverityThreshold('LOW', 'LOW')).toBe(true);
  });

  test('handles case insensitivity', () => {
    expect(meetsSeverityThreshold('critical', 'high')).toBe(true);
    expect(meetsSeverityThreshold('HIGH', 'medium')).toBe(true);
  });

  test('handles unknown severity gracefully', () => {
    expect(meetsSeverityThreshold('UNKNOWN', 'CRITICAL')).toBe(false);
    expect(meetsSeverityThreshold('UNKNOWN', 'UNKNOWN')).toBe(true);
  });
});

// =============================================================================
// generateScanSummary Tests
// =============================================================================

describe('generateScanSummary', () => {
  test('generates summary with no vulnerabilities', () => {
    const results = [
      { service: 'mc-core', vulnerabilities: [], error: null },
      { service: 'mc-backend', vulnerabilities: [], error: null },
    ];

    const summary = generateScanSummary(results);

    expect(summary.totalServices).toBe(2);
    expect(summary.vulnerableServices).toBe(0);
    expect(summary.critical).toBe(0);
    expect(summary.high).toBe(0);
    expect(summary.medium).toBe(0);
    expect(summary.low).toBe(0);
    expect(summary.passed).toBe(true);
  });

  test('generates summary with vulnerabilities', () => {
    const results = [
      {
        service: 'mc-core',
        vulnerabilities: [
          { severity: 'CRITICAL' },
          { severity: 'HIGH' },
          { severity: 'HIGH' },
        ],
        error: null,
      },
      {
        service: 'mc-backend',
        vulnerabilities: [
          { severity: 'MEDIUM' },
          { severity: 'LOW' },
        ],
        error: null,
      },
    ];

    const summary = generateScanSummary(results);

    expect(summary.totalServices).toBe(2);
    expect(summary.vulnerableServices).toBe(2);
    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(2);
    expect(summary.medium).toBe(1);
    expect(summary.low).toBe(1);
    expect(summary.passed).toBe(false);
  });

  test('handles services with errors', () => {
    const results = [
      { service: 'mc-core', vulnerabilities: [], error: 'Scan failed' },
      { service: 'mc-backend', vulnerabilities: [], error: null },
    ];

    const summary = generateScanSummary(results);

    expect(summary.totalServices).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.passed).toBe(false);
  });

  test('handles empty results', () => {
    const summary = generateScanSummary([]);

    expect(summary.totalServices).toBe(0);
    expect(summary.vulnerableServices).toBe(0);
    expect(summary.passed).toBe(true);
  });

  test('handles mixed case severity', () => {
    const results = [
      {
        service: 'mc-core',
        vulnerabilities: [
          { severity: 'critical' },
          { severity: 'High' },
          { severity: 'MEDIUM' },
        ],
        error: null,
      },
    ];

    const summary = generateScanSummary(results);

    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(1);
    expect(summary.medium).toBe(1);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  test('handles null/undefined inputs gracefully', () => {
    expect(parseSeverity(null)).toBeNull();
    expect(parseSeverity(undefined)).toBeNull();
    expect(formatVulnerabilityCount(null)).toBe('0');
    expect(formatVulnerabilityCount(undefined)).toBe('0');
  });

  test('handles empty vulnerability arrays', () => {
    const results = [
      { service: 'mc-core', vulnerabilities: [], error: null },
    ];
    const summary = generateScanSummary(results);
    expect(summary.vulnerableServices).toBe(0);
  });

  test('handles vulnerabilities without severity', () => {
    const results = [
      {
        service: 'mc-core',
        vulnerabilities: [
          { severity: null },
          { severity: undefined },
          {},
        ],
        error: null,
      },
    ];

    // Should not throw
    const summary = generateScanSummary(results);
    expect(summary.totalServices).toBe(1);
  });
});
