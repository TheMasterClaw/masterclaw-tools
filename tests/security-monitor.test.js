/**
 * Tests for security-monitor.js module
 * Run with: npm test -- security-monitor.test.js
 */

const securityMonitor = require('../lib/security-monitor');
const { queryAuditLog, AuditEventType, logSecurityViolation } = require('../lib/audit');
const { checkConfigPermissions } = require('../lib/config');

// Mock dependencies
jest.mock('../lib/audit', () => ({
  queryAuditLog: jest.fn(),
  logSecurityViolation: jest.fn().mockResolvedValue(true),
  AuditEventType: {
    AUTH_FAILURE: 'AUTH_FAILURE',
    AUTH_SUCCESS: 'AUTH_SUCCESS',
    DOCKER_EXEC: 'DOCKER_EXEC',
    DOCKER_COMPOSE: 'DOCKER_COMPOSE',
    CONFIG_WRITE: 'CONFIG_WRITE',
    CONFIG_READ: 'CONFIG_READ',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    SECURITY_VIOLATION: 'SECURITY_VIOLATION',
  },
}));

jest.mock('../lib/config', () => ({
  checkConfigPermissions: jest.fn(),
  CONFIG_FILE: '/home/test/.masterclaw/config.json',
  CONFIG_DIR: '/home/test/.masterclaw',
}));

jest.mock('fs-extra', () => ({
  pathExists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(true),
  ensureDir: jest.fn().mockResolvedValue(true),
}));

// =============================================================================
// Threat Detection Tests
// =============================================================================

describe('Security Monitor - Brute Force Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects brute force attacks from single source', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 6 failed auth events within 15 minutes from same IP
    for (let i = 0; i < 6; i++) {
      mockEvents.push({
        id: `auth-${i}`,
        timestamp: new Date(now.getTime() - i * 2 * 60 * 1000).toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.100' },
        details: { username: 'admin' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectBruteForce(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].type).toBe('brute_force');
    expect(threats[0].level).toBe('high');
    expect(threats[0].source).toBe('192.168.1.100');
    expect(threats[0].details.failedAttempts).toBe(6);
  });

  test('detects critical level brute force (double threshold)', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 12 failed auth events (double threshold)
    for (let i = 0; i < 12; i++) {
      mockEvents.push({
        id: `auth-${i}`,
        timestamp: new Date(now.getTime() - i * 1 * 60 * 1000).toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.100' },
        details: { username: 'admin' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectBruteForce(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].level).toBe('critical');
  });

  test('does not detect brute force below threshold', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Only 4 failed auths (below threshold of 5)
    for (let i = 0; i < 4; i++) {
      mockEvents.push({
        id: `auth-${i}`,
        timestamp: new Date(now.getTime() - i * 2 * 60 * 1000).toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.100' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectBruteForce(24);

    expect(threats).toHaveLength(0);
  });

  test('handles events from multiple sources separately', async () => {
    const now = new Date();
    const mockEvents = [
      {
        id: 'auth-1',
        timestamp: now.toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.100' },
      },
      {
        id: 'auth-2',
        timestamp: now.toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.101' },
      },
    ];

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectBruteForce(24);

    // Should not detect brute force since each source only has 1 failure
    expect(threats).toHaveLength(0);
  });

  test('handles empty event log', async () => {
    queryAuditLog.mockResolvedValue([]);

    const threats = await securityMonitor.detectBruteForce(24);

    expect(threats).toHaveLength(0);
  });
});

describe('Security Monitor - Rate Limit Violations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects command flooding', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 110 command events within 5 minutes (above threshold of 100)
    for (let i = 0; i < 110; i++) {
      mockEvents.push({
        id: `cmd-${i}`,
        timestamp: new Date(now.getTime() - i * 2 * 1000).toISOString(),
        eventType: AuditEventType.DOCKER_EXEC,
        context: { sessionId: 'session-1' },
        details: { command: 'docker ps' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectRateLimitViolations(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].type).toBe('rate_limit_violation');
    expect(threats[0].details.commandCount).toBe(110);
  });

  test('flags repetitive commands as high severity', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 110 identical commands (low diversity)
    for (let i = 0; i < 110; i++) {
      mockEvents.push({
        id: `cmd-${i}`,
        timestamp: new Date(now.getTime() - i * 2 * 1000).toISOString(),
        eventType: AuditEventType.DOCKER_EXEC,
        context: { sessionId: 'session-1' },
        details: { command: 'docker ps' }, // Same command every time
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectRateLimitViolations(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].level).toBe('high');
    expect(threats[0].details.commandDiversity).toBe('0.01');
  });

  test('allows diverse commands at medium severity', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 110 different commands (high diversity)
    for (let i = 0; i < 110; i++) {
      mockEvents.push({
        id: `cmd-${i}`,
        timestamp: new Date(now.getTime() - i * 2 * 1000).toISOString(),
        eventType: AuditEventType.DOCKER_EXEC,
        context: { sessionId: 'session-1' },
        details: { command: `docker cmd-${i}` }, // Different command each time
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectRateLimitViolations(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].level).toBe('medium');
  });
});

describe('Security Monitor - Error Spike Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects error rate above threshold', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 40% error rate (above 30% threshold)
    for (let i = 0; i < 100; i++) {
      mockEvents.push({
        id: `event-${i}`,
        timestamp: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: i < 40 ? AuditEventType.SECURITY_VIOLATION : AuditEventType.AUTH_SUCCESS,
        severity: i < 40 ? 'error' : 'info',
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectErrorSpikes(24);

    expect(threats.length).toBeGreaterThan(0);
    expect(threats[0].type).toBe('error_spike');
    expect(threats[0].details.errorRate).toContain('40');
  });

  test('flags 50%+ error rate as high severity', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 60% error rate
    for (let i = 0; i < 100; i++) {
      mockEvents.push({
        id: `event-${i}`,
        timestamp: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: i < 60 ? AuditEventType.SECURITY_VIOLATION : AuditEventType.AUTH_SUCCESS,
        severity: i < 60 ? 'error' : 'info',
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectErrorSpikes(24);

    expect(threats.length).toBeGreaterThan(0);
    expect(threats[0].level).toBe('high');
  });

  test('ignores error spikes with fewer than 10 events', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Only 5 events with 100% error rate
    for (let i = 0; i < 5; i++) {
      mockEvents.push({
        id: `event-${i}`,
        timestamp: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: AuditEventType.SECURITY_VIOLATION,
        severity: 'error',
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectErrorSpikes(24);

    expect(threats).toHaveLength(0);
  });
});

describe('Security Monitor - Privilege Escalation Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects rapid config changes', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 4 config write events within 5 minutes
    for (let i = 0; i < 4; i++) {
      mockEvents.push({
        id: `config-${i}`,
        timestamp: new Date(now.getTime() - i * 60 * 1000).toISOString(),
        eventType: AuditEventType.CONFIG_WRITE,
        context: { userId: 'user-1' },
        details: { key: 'setting' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectPrivilegeEscalation(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].type).toBe('privilege_escalation');
    expect(threats[0].details.eventCount).toBe(4);
  });

  test('flags escalation pattern (permission denied + config change) as critical', async () => {
    const now = new Date();
    const mockEvents = [
      {
        id: 'perm-denied',
        timestamp: now.toISOString(),
        eventType: AuditEventType.PERMISSION_DENIED,
        context: { userId: 'user-1' },
      },
      {
        id: 'config-1',
        timestamp: new Date(now.getTime() + 60000).toISOString(),
        eventType: AuditEventType.CONFIG_WRITE,
        context: { userId: 'user-1' },
      },
      {
        id: 'config-2',
        timestamp: new Date(now.getTime() + 120000).toISOString(),
        eventType: AuditEventType.CONFIG_WRITE,
        context: { userId: 'user-1' },
      },
    ];

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectPrivilegeEscalation(24);

    expect(threats).toHaveLength(1);
    expect(threats[0].level).toBe('critical');
    expect(threats[0].details.escalationPattern).toBe(true);
  });
});

describe('Security Monitor - Suspicious Pattern Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('detects reconnaissance patterns', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create 10 reconnaissance-type commands
    for (let i = 0; i < 10; i++) {
      mockEvents.push({
        id: `cmd-${i}`,
        timestamp: new Date(now.getTime() - i * 1000).toISOString(),
        eventType: AuditEventType.DOCKER_EXEC,
        context: { sessionId: 'session-1' },
        details: { command: i % 2 === 0 ? 'docker ps' : 'docker inspect' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectSuspiciousPatterns(24);

    expect(threats.length).toBeGreaterThan(0);
    expect(threats[0].type).toBe('suspicious_pattern');
    expect(threats[0].details.pattern).toBe('reconnaissance');
  });

  test('detects after-hours activity', async () => {
    // Create a date at 2 AM
    const earlyMorning = new Date();
    earlyMorning.setHours(2, 0, 0, 0);
    
    const mockEvents = [];
    for (let i = 0; i < 5; i++) {
      mockEvents.push({
        id: `cmd-${i}`,
        timestamp: new Date(earlyMorning.getTime() - i * 60000).toISOString(),
        eventType: AuditEventType.DOCKER_EXEC,
        context: { sessionId: 'session-1' },
        details: { command: 'docker ps' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);

    const threats = await securityMonitor.detectSuspiciousPatterns(24);

    const afterHoursThreat = threats.find(t => t.details.pattern === 'after_hours_activity');
    expect(afterHoursThreat).toBeDefined();
    expect(afterHoursThreat.level).toBe('low');
  });
});

// =============================================================================
// Configuration Monitoring Tests
// =============================================================================

describe('Security Monitor - Configuration Monitoring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports healthy config when permissions are correct', async () => {
    checkConfigPermissions.mockResolvedValue({
      secure: true,
      issues: [],
      warnings: [],
    });

    const result = await securityMonitor.monitorConfiguration();

    expect(result.healthy).toBe(true);
    expect(result.threats).toHaveLength(0);
  });

  test('detects permission issues and creates threat', async () => {
    checkConfigPermissions.mockResolvedValue({
      secure: false,
      issues: ['Config file has permissive permissions: 644 (expected 600)'],
      warnings: [],
    });

    const result = await securityMonitor.monitorConfiguration();

    expect(result.healthy).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.threats).toHaveLength(1);
    expect(result.threats[0].type).toBe('config_drift');
    expect(result.threats[0].level).toBe('high');
  });

  test('flags writable-by-others as critical', async () => {
    checkConfigPermissions.mockResolvedValue({
      secure: false,
      issues: ['Config file is writable by others'],
      warnings: ['Config file is writable by other users'],
    });

    const result = await securityMonitor.monitorConfiguration();

    expect(result.threats[0].level).toBe('critical');
  });
});

// =============================================================================
// Helper Function Tests
// =============================================================================

describe('Security Monitor - Helper Functions', () => {
  test('groupEventsBySource groups by IP', () => {
    const events = [
      { id: 1, context: { sourceIp: '192.168.1.1' } },
      { id: 2, context: { sourceIp: '192.168.1.1' } },
      { id: 3, context: { sourceIp: '192.168.1.2' } },
    ];

    const grouped = securityMonitor.groupEventsBySource(events);

    expect(grouped['192.168.1.1']).toHaveLength(2);
    expect(grouped['192.168.1.2']).toHaveLength(1);
  });

  test('groupEventsBySource falls back to sessionId', () => {
    const events = [
      { id: 1, context: { sessionId: 'sess-1' } },
      { id: 2, context: { sessionId: 'sess-1' } },
    ];

    const grouped = securityMonitor.groupEventsBySource(events);

    expect(grouped['sess-1']).toHaveLength(2);
  });

  test('createTimeWindows creates correct windows', () => {
    const now = new Date();
    const events = [
      { timestamp: now.toISOString() },
      { timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString() },
      { timestamp: new Date(now.getTime() + 15 * 60 * 1000).toISOString() },
    ];

    const windows = securityMonitor.createTimeWindows(events, 10);

    expect(windows).toHaveLength(2);
    expect(windows[0]).toHaveLength(2);
    expect(windows[1]).toHaveLength(1);
  });

  test('createThreat creates standardized threat object', () => {
    const threat = securityMonitor.createThreat({
      type: 'test_threat',
      level: 'high',
      source: 'test-source',
      details: { test: 'data' },
    });

    expect(threat).toHaveProperty('id');
    expect(threat).toHaveProperty('timestamp');
    expect(threat.type).toBe('test_threat');
    expect(threat.level).toBe('high');
    expect(threat.source).toBe('test-source');
    expect(threat.status).toBe('active');
  });
});

// =============================================================================
// Integration Tests
// =============================================================================

describe('Security Monitor - Full Scan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runSecurityScan returns comprehensive results', async () => {
    queryAuditLog.mockResolvedValue([]);
    checkConfigPermissions.mockResolvedValue({
      secure: true,
      issues: [],
      warnings: [],
    });

    const result = await securityMonitor.runSecurityScan();

    expect(result).toHaveProperty('scanId');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('scanDurationMs');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('configHealthy');
    expect(result).toHaveProperty('threats');
    expect(result.summary).toHaveProperty('critical');
    expect(result.summary).toHaveProperty('high');
    expect(result.summary).toHaveProperty('medium');
    expect(result.summary).toHaveProperty('low');
  });

  test('runSecurityScan logs high-severity threats to audit', async () => {
    const now = new Date();
    const mockEvents = [];
    
    // Create critical-level brute force
    for (let i = 0; i < 12; i++) {
      mockEvents.push({
        id: `auth-${i}`,
        timestamp: new Date(now.getTime() - i * 1 * 60 * 1000).toISOString(),
        eventType: AuditEventType.AUTH_FAILURE,
        context: { sourceIp: '192.168.1.100' },
      });
    }

    queryAuditLog.mockResolvedValue(mockEvents);
    checkConfigPermissions.mockResolvedValue({
      secure: true,
      issues: [],
    });

    await securityMonitor.runSecurityScan();

    expect(logSecurityViolation).toHaveBeenCalled();
  });

  test('getQuickSecurityStatus returns fast status', async () => {
    queryAuditLog.mockResolvedValue([]);
    checkConfigPermissions.mockResolvedValue({
      secure: true,
      issues: [],
    });

    const status = await securityMonitor.getQuickSecurityStatus();

    expect(status).toHaveProperty('status');
    expect(status).toHaveProperty('lastHour');
    expect(status).toHaveProperty('configSecure');
    expect(status.status).toBe('ok');
  });

  test('getQuickSecurityStatus reports warning on security violations', async () => {
    const now = new Date();
    queryAuditLog.mockResolvedValue([
      {
        id: 'violation-1',
        timestamp: now.toISOString(),
        eventType: AuditEventType.SECURITY_VIOLATION,
        severity: 'error',
      },
    ]);
    checkConfigPermissions.mockResolvedValue({
      secure: true,
      issues: [],
    });

    const status = await securityMonitor.getQuickSecurityStatus();

    expect(status.status).toBe('warning');
  });
});

// =============================================================================
// Constants Tests
// =============================================================================

describe('Security Monitor - Constants', () => {
  test('ThreatLevel has expected values', () => {
    expect(securityMonitor.ThreatLevel.LOW).toBe('low');
    expect(securityMonitor.ThreatLevel.MEDIUM).toBe('medium');
    expect(securityMonitor.ThreatLevel.HIGH).toBe('high');
    expect(securityMonitor.ThreatLevel.CRITICAL).toBe('critical');
  });

  test('ThreatType has expected values', () => {
    expect(securityMonitor.ThreatType.BRUTE_FORCE).toBe('brute_force');
    expect(securityMonitor.ThreatType.RATE_LIMIT_VIOLATION).toBe('rate_limit_violation');
    expect(securityMonitor.ThreatType.ERROR_SPIKE).toBe('error_spike');
    expect(securityMonitor.ThreatType.PRIVILEGE_ESCALATION).toBe('privilege_escalation');
  });

  test('DEFAULT_THRESHOLDS has expected values', () => {
    expect(securityMonitor.DEFAULT_THRESHOLDS.failedAuthThreshold).toBe(5);
    expect(securityMonitor.DEFAULT_THRESHOLDS.failedAuthWindowMinutes).toBe(15);
    expect(securityMonitor.DEFAULT_THRESHOLDS.commandRateThreshold).toBe(100);
  });
});
