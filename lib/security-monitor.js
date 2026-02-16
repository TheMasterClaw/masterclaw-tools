/**
 * security-monitor.js - Security Monitoring and Threat Detection for MasterClaw CLI
 *
 * Provides comprehensive security monitoring capabilities:
 * - Anomaly detection in audit logs
 * - Brute force attack detection
 * - Configuration drift monitoring
 * - Privilege escalation detection
 * - Suspicious pattern recognition
 * - Automated threat response
 *
 * @module security-monitor
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { queryAuditLog, AuditEventType, logSecurityViolation } = require('./audit');
const { checkConfigPermissions, CONFIG_FILE, CONFIG_DIR } = require('./config');

// =============================================================================
// Configuration
// =============================================================================

/** Default monitoring thresholds */
const DEFAULT_THRESHOLDS = {
  // Brute force detection
  failedAuthThreshold: 5,        // Max failed auths in window
  failedAuthWindowMinutes: 15,   // Time window for failed auths
  
  // Rate limiting
  commandRateThreshold: 100,     // Max commands in window
  commandRateWindowMinutes: 5,   // Time window for commands
  
  // Anomaly detection
  errorRateThreshold: 0.3,       // 30% error rate is suspicious
  errorRateWindowMinutes: 10,    // Time window for error rate calc
  
  // Privilege escalation
  configChangeThreshold: 3,      // Max config changes in window
  configChangeWindowMinutes: 5,  // Time window for config changes
};

/** Threat severity levels */
const ThreatLevel = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
};

/** Threat types */
const ThreatType = {
  BRUTE_FORCE: 'brute_force',
  RATE_LIMIT_VIOLATION: 'rate_limit_violation',
  ERROR_SPIKE: 'error_spike',
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  CONFIG_DRIFT: 'config_drift',
  SUSPICIOUS_PATTERN: 'suspicious_pattern',
  PERMISSION_CHANGE: 'permission_change',
  AUDIT_TAMPERING: 'audit_tampering',
};

// =============================================================================
// Threat Detection
// =============================================================================

/**
 * Detects brute force authentication attempts
 * @param {number} [hours=24] - Look back period
 * @param {Object} [thresholds] - Detection thresholds
 * @returns {Promise<Array>} - Detected threats
 */
async function detectBruteForce(hours = 24, thresholds = {}) {
  const {
    failedAuthThreshold = DEFAULT_THRESHOLDS.failedAuthThreshold,
    failedAuthWindowMinutes = DEFAULT_THRESHOLDS.failedAuthWindowMinutes,
  } = thresholds;

  const threats = [];
  const events = await queryAuditLog({
    eventType: AuditEventType.AUTH_FAILURE,
    hours,
    limit: 1000,
  });

  // Group by source IP or user context
  const groupedEvents = groupEventsBySource(events);

  for (const [source, sourceEvents] of Object.entries(groupedEvents)) {
    // Sort events by timestamp (oldest first) for proper sliding window
    const sortedEvents = [...sourceEvents].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Sliding window analysis
    for (let i = 0; i <= sortedEvents.length - failedAuthThreshold; i++) {
      const windowStart = new Date(sortedEvents[i].timestamp);
      const windowEnd = new Date(windowStart.getTime() + failedAuthWindowMinutes * 60 * 1000);
      
      const eventsInWindow = sortedEvents.filter(e => {
        const eventTime = new Date(e.timestamp);
        return eventTime >= windowStart && eventTime <= windowEnd;
      });

      if (eventsInWindow.length >= failedAuthThreshold) {
        threats.push(createThreat({
          type: ThreatType.BRUTE_FORCE,
          level: eventsInWindow.length >= failedAuthThreshold * 2 ? ThreatLevel.CRITICAL : ThreatLevel.HIGH,
          source,
          details: {
            failedAttempts: eventsInWindow.length,
            windowMinutes: failedAuthWindowMinutes,
            firstAttempt: eventsInWindow[0].timestamp,
            lastAttempt: eventsInWindow[eventsInWindow.length - 1].timestamp,
          },
          relatedEvents: eventsInWindow.map(e => e.id),
        }));
        break; // Only report once per source
      }
    }
  }

  return threats;
}

/**
 * Detects rate limiting violations and command flooding
 * @param {number} [hours=24] - Look back period
 * @param {Object} [thresholds] - Detection thresholds
 * @returns {Promise<Array>} - Detected threats
 */
async function detectRateLimitViolations(hours = 24, thresholds = {}) {
  const {
    commandRateThreshold = DEFAULT_THRESHOLDS.commandRateThreshold,
    commandRateWindowMinutes = DEFAULT_THRESHOLDS.commandRateWindowMinutes,
  } = thresholds;

  const threats = [];
  
  // Get all command execution events
  const events = await queryAuditLog({
    hours,
    limit: 2000,
  });

  const commandEvents = events.filter(e => 
    e.eventType === AuditEventType.DOCKER_EXEC ||
    e.eventType === AuditEventType.DOCKER_COMPOSE
  );

  // Group by session/user
  const groupedEvents = groupEventsBySource(commandEvents);

  for (const [source, sourceEvents] of Object.entries(groupedEvents)) {
    // Sort events by timestamp
    const sortedEvents = [...sourceEvents].sort((a, b) => 
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Check for command flooding in sliding windows
    for (let i = 0; i <= sortedEvents.length - commandRateThreshold; i++) {
      const windowStart = new Date(sortedEvents[i].timestamp);
      const windowEnd = new Date(windowStart.getTime() + commandRateWindowMinutes * 60 * 1000);
      
      const eventsInWindow = sortedEvents.filter(e => {
        const eventTime = new Date(e.timestamp);
        return eventTime >= windowStart && eventTime <= windowEnd;
      });

      if (eventsInWindow.length >= commandRateThreshold) {
        // Analyze command diversity - repetitive commands are more suspicious
        const uniqueCommands = new Set(eventsInWindow.map(e => e.details?.command)).size;
        const diversity = uniqueCommands / eventsInWindow.length;
        
        threats.push(createThreat({
          type: ThreatType.RATE_LIMIT_VIOLATION,
          level: diversity < 0.3 ? ThreatLevel.HIGH : ThreatLevel.MEDIUM,
          source,
          details: {
            commandCount: eventsInWindow.length,
            windowMinutes: commandRateWindowMinutes,
            uniqueCommands,
            commandDiversity: diversity.toFixed(2),
            startTime: eventsInWindow[0].timestamp,
            endTime: eventsInWindow[eventsInWindow.length - 1].timestamp,
          },
          relatedEvents: eventsInWindow.map(e => e.id),
        }));
        break;
      }
    }
  }

  return threats;
}

/**
 * Detects error spikes that might indicate attacks or system compromise
 * @param {number} [hours=24] - Look back period
 * @param {Object} [thresholds] - Detection thresholds
 * @returns {Promise<Array>} - Detected threats
 */
async function detectErrorSpikes(hours = 24, thresholds = {}) {
  const {
    errorRateThreshold = DEFAULT_THRESHOLDS.errorRateThreshold,
    errorRateWindowMinutes = DEFAULT_THRESHOLDS.errorRateWindowMinutes,
  } = thresholds;

  const threats = [];
  
  // Get all events
  const events = await queryAuditLog({
    hours,
    limit: 2000,
  });

  // Group by time windows
  const windows = createTimeWindows(events, errorRateWindowMinutes);

  for (const window of windows) {
    const totalEvents = window.length;
    const errorEvents = window.filter(e => 
      e.severity === 'error' || 
      e.severity === 'critical' ||
      e.eventType === AuditEventType.SECURITY_VIOLATION
    );
    
    const errorRate = errorEvents.length / totalEvents;

    if (errorRate >= errorRateThreshold && totalEvents >= 10) {
      // Analyze error types
      const errorTypes = {};
      errorEvents.forEach(e => {
        errorTypes[e.eventType] = (errorTypes[e.eventType] || 0) + 1;
      });

      threats.push(createThreat({
        type: ThreatType.ERROR_SPIKE,
        level: errorRate >= 0.5 ? ThreatLevel.HIGH : ThreatLevel.MEDIUM,
        source: 'system',
        details: {
          totalEvents,
          errorEvents: errorEvents.length,
          errorRate: (errorRate * 100).toFixed(1) + '%',
          windowStart: window[0]?.timestamp,
          windowEnd: window[window.length - 1]?.timestamp,
          errorTypes,
        },
        relatedEvents: errorEvents.map(e => e.id),
      }));
    }
  }

  return threats;
}

/**
 * Detects potential privilege escalation attempts
 * @param {number} [hours=24] - Look back period
 * @param {Object} [thresholds] - Detection thresholds
 * @returns {Promise<Array>} - Detected threats
 */
async function detectPrivilegeEscalation(hours = 24, thresholds = {}) {
  const {
    configChangeThreshold = DEFAULT_THRESHOLDS.configChangeThreshold,
    configChangeWindowMinutes = DEFAULT_THRESHOLDS.configChangeWindowMinutes,
  } = thresholds;

  const threats = [];
  
  // Monitor config changes, permission changes, and security-related events
  const events = await queryAuditLog({
    hours,
    limit: 1000,
  });

  const sensitiveEvents = events.filter(e =>
    e.eventType === AuditEventType.CONFIG_WRITE ||
    e.eventType === AuditEventType.PERMISSION_DENIED ||
    e.eventType === AuditEventType.SECURITY_VIOLATION
  );

  // Group by source
  const groupedEvents = groupEventsBySource(sensitiveEvents);

  for (const [source, sourceEvents] of Object.entries(groupedEvents)) {
    // Sort events by timestamp
    const sortedEvents = [...sourceEvents].sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)
    );
    
    // Look for rapid config changes
    for (let i = 0; i <= sortedEvents.length - configChangeThreshold; i++) {
      const windowStart = new Date(sortedEvents[i].timestamp);
      const windowEnd = new Date(windowStart.getTime() + configChangeWindowMinutes * 60 * 1000);
      
      const eventsInWindow = sortedEvents.filter(e => {
        const eventTime = new Date(e.timestamp);
        return eventTime >= windowStart && eventTime <= windowEnd;
      });

      if (eventsInWindow.length >= configChangeThreshold) {
        // Check for permission denied followed by config change (escalation pattern)
        const hasPermissionDenied = eventsInWindow.some(e => 
          e.eventType === AuditEventType.PERMISSION_DENIED
        );
        const hasConfigChange = eventsInWindow.some(e =>
          e.eventType === AuditEventType.CONFIG_WRITE
        );

        const escalationPattern = hasPermissionDenied && hasConfigChange;

        threats.push(createThreat({
          type: ThreatType.PRIVILEGE_ESCALATION,
          level: escalationPattern ? ThreatLevel.CRITICAL : ThreatLevel.HIGH,
          source,
          details: {
            eventCount: eventsInWindow.length,
            windowMinutes: configChangeWindowMinutes,
            escalationPattern,
            hasPermissionDenied,
            hasConfigChange,
            startTime: eventsInWindow[0].timestamp,
            events: eventsInWindow.map(e => ({
              type: e.eventType,
              timestamp: e.timestamp,
            })),
          },
          relatedEvents: eventsInWindow.map(e => e.id),
        }));
        break;
      }
    }
  }

  return threats;
}

/**
 * Detects suspicious command patterns
 * @param {number} [hours=24] - Look back period
 * @returns {Promise<Array>} - Detected threats
 */
async function detectSuspiciousPatterns(hours = 24) {
  const threats = [];
  
  const events = await queryAuditLog({
    hours,
    limit: 2000,
  });

  const commandEvents = events.filter(e =>
    e.eventType === AuditEventType.DOCKER_EXEC ||
    e.eventType === AuditEventType.DOCKER_COMPOSE
  );

  // Pattern 1: Reconnaissance (many status/info commands)
  const reconCommands = ['ps', 'top', 'inspect', 'logs', 'config', 'version'];
  const reconEvents = commandEvents.filter(e => {
    const cmd = e.details?.command?.toLowerCase() || '';
    return reconCommands.some(rc => cmd.includes(rc));
  });

  if (reconEvents.length >= 10) {
    const sourceGroups = groupEventsBySource(reconEvents);
    for (const [source, sourceEvents] of Object.entries(sourceGroups)) {
      if (sourceEvents.length >= 5) {
        threats.push(createThreat({
          type: ThreatType.SUSPICIOUS_PATTERN,
          level: ThreatLevel.MEDIUM,
          source,
          details: {
            pattern: 'reconnaissance',
            description: 'Multiple information gathering commands detected',
            commandCount: sourceEvents.length,
            commands: [...new Set(sourceEvents.map(e => e.details?.command))],
            firstSeen: sourceEvents[0].timestamp,
            lastSeen: sourceEvents[sourceEvents.length - 1].timestamp,
          },
          relatedEvents: sourceEvents.map(e => e.id),
        }));
      }
    }
  }

  // Pattern 2: After-hours activity (if system typically only used during business hours)
  const afterHoursEvents = commandEvents.filter(e => {
    const hour = new Date(e.timestamp).getHours();
    return hour < 6 || hour > 23; // Outside typical business hours
  });

  if (afterHoursEvents.length >= 5) {
    const sourceGroups = groupEventsBySource(afterHoursEvents);
    for (const [source, sourceEvents] of Object.entries(sourceGroups)) {
      threats.push(createThreat({
        type: ThreatType.SUSPICIOUS_PATTERN,
        level: ThreatLevel.LOW,
        source,
        details: {
          pattern: 'after_hours_activity',
          description: 'Activity detected during unusual hours',
          eventCount: sourceEvents.length,
          hours: [...new Set(sourceEvents.map(e => new Date(e.timestamp).getHours()))],
          dates: [...new Set(sourceEvents.map(e => e.timestamp.split('T')[0]))],
        },
        relatedEvents: sourceEvents.map(e => e.id),
      }));
    }
  }

  return threats;
}

// =============================================================================
// Configuration Monitoring
// =============================================================================

/**
 * Monitors for configuration drift and permission changes
 * @returns {Promise<Object>} - Configuration health status
 */
async function monitorConfiguration() {
  const result = {
    healthy: true,
    issues: [],
    threats: [],
    lastCheck: new Date().toISOString(),
  };

  // Check config file permissions
  const permCheck = await checkConfigPermissions();
  if (!permCheck.secure) {
    result.healthy = false;
    result.issues.push(...permCheck.issues);
    
    // Create threat for permission issues
    result.threats.push(createThreat({
      type: ThreatType.CONFIG_DRIFT,
      level: permCheck.issues.some(i => i.includes('writable')) ? 
        ThreatLevel.CRITICAL : ThreatLevel.HIGH,
      source: 'filesystem',
      details: {
        issues: permCheck.issues,
        configPath: CONFIG_FILE,
        configDir: CONFIG_DIR,
      },
    }));
  }

  // Check for unexpected config file changes
  const currentHash = await getConfigFileHash();
  const lastHash = await getLastKnownConfigHash();
  
  if (lastHash && currentHash !== lastHash) {
    // Config file changed since last check
    result.issues.push('Configuration file has been modified');
    
    result.threats.push(createThreat({
      type: ThreatType.PERMISSION_CHANGE,
      level: ThreatLevel.MEDIUM,
      source: 'filesystem',
      details: {
        previousHash: lastHash,
        currentHash,
        configPath: CONFIG_FILE,
      },
    }));
  }

  // Save current hash for next check
  await saveConfigHash(currentHash);

  return result;
}

/**
 * Gets the hash of the current config file
 * @returns {Promise<string|null>} - File hash or null
 */
async function getConfigFileHash() {
  try {
    if (!await fs.pathExists(CONFIG_FILE)) {
      return null;
    }
    const content = await fs.readFile(CONFIG_FILE);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * Gets the last known config hash
 * @returns {Promise<string|null>} - Last hash or null
 */
async function getLastKnownConfigHash() {
  try {
    const hashFile = path.join(CONFIG_DIR, '.config.hash');
    if (!await fs.pathExists(hashFile)) {
      return null;
    }
    return await fs.readFile(hashFile, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * Saves the current config hash
 * @param {string} hash - Hash to save
 */
async function saveConfigHash(hash) {
  try {
    const hashFile = path.join(CONFIG_DIR, '.config.hash');
    await fs.writeFile(hashFile, hash, { mode: 0o600 });
  } catch (err) {
    // Non-critical error
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Groups events by source (IP, user, or session)
 * @param {Array} events - Events to group
 * @returns {Object} - Grouped events
 */
function groupEventsBySource(events) {
  const grouped = {};
  
  for (const event of events) {
    const source = event.context?.sourceIp || 
                   event.context?.userId || 
                   event.context?.sessionId || 
                   'unknown';
    
    if (!grouped[source]) {
      grouped[source] = [];
    }
    grouped[source].push(event);
  }
  
  return grouped;
}

/**
 * Creates time windows from events
 * @param {Array} events - Events to window
 * @param {number} windowMinutes - Window size in minutes
 * @returns {Array} - Array of event windows
 */
function createTimeWindows(events, windowMinutes) {
  if (events.length === 0) return [];
  
  // Sort by timestamp
  const sorted = [...events].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  const windows = [];
  const windowMs = windowMinutes * 60 * 1000;
  
  let currentWindow = [sorted[0]];
  let windowStart = new Date(sorted[0].timestamp);
  
  for (let i = 1; i < sorted.length; i++) {
    const eventTime = new Date(sorted[i].timestamp);
    
    if (eventTime.getTime() - windowStart.getTime() <= windowMs) {
      currentWindow.push(sorted[i]);
    } else {
      windows.push(currentWindow);
      currentWindow = [sorted[i]];
      windowStart = eventTime;
    }
  }
  
  if (currentWindow.length > 0) {
    windows.push(currentWindow);
  }
  
  return windows;
}

/**
 * Creates a standardized threat object
 * @param {Object} params - Threat parameters
 * @returns {Object} - Standardized threat object
 */
function createThreat({ type, level, source, details, relatedEvents = [] }) {
  return {
    id: `threat-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    type,
    level,
    source,
    details,
    relatedEvents,
    status: 'active',
  };
}

// =============================================================================
// Main Monitoring Functions
// =============================================================================

/**
 * Runs a comprehensive security scan
 * @param {Object} options - Scan options
 * @returns {Promise<Object>} - Scan results
 */
async function runSecurityScan(options = {}) {
  const {
    hours = 24,
    thresholds = {},
    includeConfig = true,
  } = options;

  const startTime = Date.now();
  
  // Run all detection methods
  const [
    bruteForceThreats,
    rateLimitThreats,
    errorSpikeThreats,
    privilegeEscalationThreats,
    suspiciousPatternThreats,
    configStatus,
  ] = await Promise.all([
    detectBruteForce(hours, thresholds),
    detectRateLimitViolations(hours, thresholds),
    detectErrorSpikes(hours, thresholds),
    detectPrivilegeEscalation(hours, thresholds),
    detectSuspiciousPatterns(hours),
    includeConfig ? monitorConfiguration() : Promise.resolve({ healthy: true, threats: [] }),
  ]);

  // Combine all threats
  const allThreats = [
    ...bruteForceThreats,
    ...rateLimitThreats,
    ...errorSpikeThreats,
    ...privilegeEscalationThreats,
    ...suspiciousPatternThreats,
    ...configStatus.threats,
  ];

  // Sort by severity
  const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
  allThreats.sort((a, b) => severityOrder[b.level] - severityOrder[a.level]);

  // Generate summary
  const summary = {
    critical: allThreats.filter(t => t.level === ThreatLevel.CRITICAL).length,
    high: allThreats.filter(t => t.level === ThreatLevel.HIGH).length,
    medium: allThreats.filter(t => t.level === ThreatLevel.MEDIUM).length,
    low: allThreats.filter(t => t.level === ThreatLevel.LOW).length,
  };

  const scanDuration = Date.now() - startTime;

  // Log high-severity threats to audit log
  for (const threat of allThreats) {
    if (threat.level === ThreatLevel.HIGH || threat.level === ThreatLevel.CRITICAL) {
      await logSecurityViolation('THREAT_DETECTED', {
        threatId: threat.id,
        threatType: threat.type,
        threatLevel: threat.level,
        source: threat.source,
        details: threat.details,
      });
    }
  }

  return {
    scanId: `scan-${Date.now()}`,
    timestamp: new Date().toISOString(),
    scanDurationMs: scanDuration,
    timeWindow: { hours, since: new Date(Date.now() - hours * 60 * 60 * 1000).toISOString() },
    summary,
    configHealthy: configStatus.healthy,
    configIssues: configStatus.issues || [],
    threats: allThreats,
  };
}

/**
 * Gets a quick security status (for health checks)
 * @returns {Promise<Object>} - Quick status
 */
async function getQuickSecurityStatus() {
  const events = await queryAuditLog({ hours: 1, limit: 100 });
  
  const criticalEvents = events.filter(e => e.severity === 'critical');
  const securityViolations = events.filter(e => 
    e.eventType === AuditEventType.SECURITY_VIOLATION
  );
  
  // Check config
  const configStatus = await checkConfigPermissions();
  
  return {
    status: criticalEvents.length > 0 || securityViolations.length > 0 || !configStatus.secure
      ? 'warning'
      : 'ok',
    lastHour: {
      totalEvents: events.length,
      criticalEvents: criticalEvents.length,
      securityViolations: securityViolations.length,
    },
    configSecure: configStatus.secure,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Export
// =============================================================================

module.exports = {
  // Main monitoring functions
  runSecurityScan,
  getQuickSecurityStatus,
  monitorConfiguration,
  
  // Individual detection functions
  detectBruteForce,
  detectRateLimitViolations,
  detectErrorSpikes,
  detectPrivilegeEscalation,
  detectSuspiciousPatterns,
  
  // Utilities
  groupEventsBySource,
  createTimeWindows,
  createThreat,
  
  // Constants
  ThreatLevel,
  ThreatType,
  DEFAULT_THRESHOLDS,
};
