/**
 * Tests for events.js module
 * Run with: npm test -- events.test.js
 *
 * Tests event tracking, filtering, formatting, and statistics functionality.
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

// Setup mock before requiring events module
const mockTestHomeDir = path.join(os.tmpdir(), 'masterclaw-test-events-' + Date.now());

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => mockTestHomeDir),
}));

const {
  addEvent,
  loadEvents,
  initStorage,
  generateEventId,
  formatEvent,
  filterEvents,
  getRelativeTime,
  EVENT_TYPES,
  SEVERITY,
} = require('../lib/events');

// Use the mock directory for tests
const testHomeDir = mockTestHomeDir;

// =============================================================================
// Setup and Teardown
// =============================================================================

describe('Events Module', () => {
  beforeEach(async () => {
    // Ensure clean state
    await fs.remove(testHomeDir);
    await initStorage();
  });

  afterEach(async () => {
    await fs.remove(testHomeDir);
  });

  afterAll(async () => {
    await fs.remove(testHomeDir);
  });

  // ===========================================================================
  // Event ID Generation Tests
  // ===========================================================================
  describe('generateEventId', () => {
    test('generates unique IDs', () => {
      const id1 = generateEventId();
      const id2 = generateEventId();
      expect(id1).not.toBe(id2);
    });

    test('generates IDs with correct format', () => {
      const id = generateEventId();
      expect(id).toMatch(/^evt_\d+_[a-z0-9]+$/);
    });

    test('includes timestamp in ID', () => {
      const before = Date.now();
      const id = generateEventId();
      const after = Date.now();
      
      const timestamp = parseInt(id.split('_')[1], 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });

  // ===========================================================================
  // Event Storage Tests
  // ===========================================================================
  describe('initStorage', () => {
    test('creates events directory', async () => {
      await initStorage();
      const eventsDir = path.join(testHomeDir, '.masterclaw', 'events');
      expect(await fs.pathExists(eventsDir)).toBe(true);
    });

    test('creates events file with default structure', async () => {
      await initStorage();
      const eventsFile = path.join(testHomeDir, '.masterclaw', 'events', 'events.json');
      expect(await fs.pathExists(eventsFile)).toBe(true);
      
      const data = await fs.readJson(eventsFile);
      expect(data).toHaveProperty('events');
      expect(data).toHaveProperty('version');
      expect(Array.isArray(data.events)).toBe(true);
      expect(data.version).toBe(1);
    });

    test('does not overwrite existing file', async () => {
      await initStorage();
      await addEvent('info', 'Test Event', 'Test message');
      
      const eventsBefore = await loadEvents();
      await initStorage();
      const eventsAfter = await loadEvents();
      
      expect(eventsAfter.length).toBe(eventsBefore.length);
    });
  });

  // ===========================================================================
  // addEvent Tests
  // ===========================================================================
  describe('addEvent', () => {
    test('adds event with required fields', async () => {
      const event = await addEvent('info', 'Test Title', 'Test message');
      
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('timestamp');
      expect(event.type).toBe('info');
      expect(event.title).toBe('Test Title');
      expect(event.message).toBe('Test message');
      expect(event.severity).toBe('info');
      expect(event.source).toBe('cli');
      expect(event.acknowledged).toBe(false);
    });

    test('adds event with custom options', async () => {
      const event = await addEvent('error', 'Error Title', 'Error message', {
        severity: 'critical',
        source: 'test',
        metadata: { key: 'value' },
      });
      
      expect(event.type).toBe('error');
      expect(event.severity).toBe('critical');
      expect(event.source).toBe('test');
      expect(event.metadata).toEqual({ key: 'value' });
    });

    test('adds event to storage', async () => {
      await addEvent('info', 'Test Event', 'Test');
      const events = await loadEvents();
      
      expect(events.length).toBe(1);
      expect(events[0].title).toBe('Test Event');
    });

    test('adds multiple events', async () => {
      await addEvent('info', 'Event 1', 'Message 1');
      await addEvent('warning', 'Event 2', 'Message 2');
      await addEvent('error', 'Event 3', 'Message 3');
      
      const events = await loadEvents();
      expect(events.length).toBe(3);
    });

    test('newest events are first in list', async () => {
      await addEvent('info', 'First', 'Message');
      await new Promise(r => setTimeout(r, 10)); // Small delay
      await addEvent('info', 'Second', 'Message');
      
      const events = await loadEvents();
      expect(events[0].title).toBe('Second');
      expect(events[1].title).toBe('First');
    });

    test('handles null message', async () => {
      const event = await addEvent('info', 'No Message', null);
      expect(event.message).toBeNull();
    });

    test('handles empty metadata', async () => {
      const event = await addEvent('info', 'Test', 'Message');
      expect(event.metadata).toEqual({});
    });
  });

  // ===========================================================================
  // loadEvents Tests
  // ===========================================================================
  describe('loadEvents', () => {
    test('returns empty array when no events', async () => {
      const events = await loadEvents();
      expect(events).toEqual([]);
    });

    test('returns events from storage', async () => {
      await addEvent('info', 'Event 1', 'Message 1');
      await addEvent('info', 'Event 2', 'Message 2');
      
      const events = await loadEvents();
      expect(events.length).toBe(2);
    });

    test('returns copy of events (not reference)', async () => {
      await addEvent('info', 'Test', 'Message');
      const events1 = await loadEvents();
      const events2 = await loadEvents();
      
      expect(events1).not.toBe(events2);
      expect(events1).toEqual(events2);
    });

    test('handles corrupted events file gracefully', async () => {
      const eventsFile = path.join(testHomeDir, '.masterclaw', 'events', 'events.json');
      await fs.writeFile(eventsFile, 'invalid json');
      
      const events = await loadEvents();
      expect(events).toEqual([]);
    });
  });

  // ===========================================================================
  // filterEvents Tests
  // ===========================================================================
  describe('filterEvents', () => {
    const mockEvents = [
      { id: '1', type: 'backup', severity: 'info', source: 'cli', acknowledged: false, title: 'Backup completed', timestamp: new Date().toISOString() },
      { id: '2', type: 'error', severity: 'critical', source: 'system', acknowledged: false, title: 'System failure', timestamp: new Date().toISOString() },
      { id: '3', type: 'deploy', severity: 'info', source: 'cli', acknowledged: true, title: 'Deploy success', timestamp: new Date().toISOString() },
      { id: '4', type: 'warning', severity: 'high', source: 'system', acknowledged: false, title: 'Disk space low', timestamp: new Date().toISOString() },
    ];

    test('returns all events when no filters', () => {
      const result = filterEvents(mockEvents, {});
      expect(result.length).toBe(4);
    });

    test('filters by type', () => {
      const result = filterEvents(mockEvents, { type: 'backup' });
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('backup');
    });

    test('filters by severity', () => {
      const result = filterEvents(mockEvents, { severity: 'info' });
      expect(result.length).toBe(2);
      expect(result.every(e => e.severity === 'info')).toBe(true);
    });

    test('filters by source', () => {
      const result = filterEvents(mockEvents, { source: 'system' });
      expect(result.length).toBe(2);
      expect(result.every(e => e.source === 'system')).toBe(true);
    });

    test('filters by acknowledged status', () => {
      const result = filterEvents(mockEvents, { acknowledged: true });
      expect(result.length).toBe(1);
      expect(result[0].acknowledged).toBe(true);
    });

    test('filters by unacknowledged status', () => {
      const result = filterEvents(mockEvents, { acknowledged: false });
      expect(result.length).toBe(3);
    });

    test('combines multiple filters', () => {
      const result = filterEvents(mockEvents, { source: 'cli', acknowledged: false });
      expect(result.length).toBe(1);
      expect(result[0].source).toBe('cli');
      expect(result[0].acknowledged).toBe(false);
    });

    test('filters by search term in title', () => {
      const result = filterEvents(mockEvents, { search: 'backup' });
      expect(result.length).toBe(1);
      expect(result[0].title.toLowerCase()).toContain('backup');
    });

    test('filters by search term in message', () => {
      const eventsWithMessages = [
        ...mockEvents,
        { id: '5', type: 'info', severity: 'info', source: 'cli', acknowledged: false, title: 'Test', message: 'Important backup message', timestamp: new Date().toISOString() },
      ];
      const result = filterEvents(eventsWithMessages, { search: 'backup' });
      expect(result.length).toBe(2);
    });

    test('filters by since date', () => {
      const oldDate = new Date(Date.now() - 86400000 * 2).toISOString(); // 2 days ago
      const recentDate = new Date().toISOString();
      
      const events = [
        { ...mockEvents[0], timestamp: oldDate },
        { ...mockEvents[1], timestamp: recentDate },
      ];
      
      const since = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const result = filterEvents(events, { since });
      
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('2');
    });

    test('search is case insensitive', () => {
      const result = filterEvents(mockEvents, { search: 'BACKUP' });
      expect(result.length).toBe(1);
    });

    test('returns empty array when no matches', () => {
      const result = filterEvents(mockEvents, { type: 'nonexistent' });
      expect(result).toEqual([]);
    });
  });

  // ===========================================================================
  // getRelativeTime Tests
  // ===========================================================================
  describe('getRelativeTime', () => {
    test('returns "just now" for recent events', () => {
      const date = new Date(Date.now() - 1000); // 1 second ago
      expect(getRelativeTime(date)).toBe('just now');
    });

    test('returns minutes for events < 1 hour', () => {
      const date = new Date(Date.now() - 5 * 60000); // 5 minutes ago
      expect(getRelativeTime(date)).toBe('5m ago');
    });

    test('returns hours for events < 1 day', () => {
      const date = new Date(Date.now() - 3 * 3600000); // 3 hours ago
      expect(getRelativeTime(date)).toBe('3h ago');
    });

    test('returns days for events < 1 week', () => {
      const date = new Date(Date.now() - 2 * 86400000); // 2 days ago
      expect(getRelativeTime(date)).toBe('2d ago');
    });

    test('returns weeks for older events', () => {
      const date = new Date(Date.now() - 14 * 86400000); // 2 weeks ago
      expect(getRelativeTime(date)).toBe('2w ago');
    });
  });

  // ===========================================================================
  // formatEvent Tests
  // ===========================================================================
  describe('formatEvent', () => {
    const mockEvent = {
      id: 'evt_1234567890_abc',
      type: 'backup',
      severity: 'info',
      title: 'Backup completed',
      message: 'Daily backup was successful',
      source: 'cli',
      timestamp: new Date().toISOString(),
      acknowledged: false,
      metadata: { size: '1GB' },
    };

    test('formats event in compact mode', () => {
      const formatted = formatEvent(mockEvent, { compact: true });
      expect(formatted).toContain('Backup completed');
      expect(formatted).toContain('○'); // Unacknowledged marker
      expect(formatted).toContain('INFO');
    });

    test('formats event in full mode', () => {
      const formatted = formatEvent(mockEvent, { compact: false });
      expect(formatted).toContain('Backup completed');
      expect(formatted).toContain('evt_1234567890_abc');
      expect(formatted).toContain('backup');
      expect(formatted).toContain('info');
      expect(formatted).toContain('cli');
      expect(formatted).toContain('Daily backup was successful');
    });

    test('shows acknowledged status', () => {
      const acknowledgedEvent = { ...mockEvent, acknowledged: true };
      const formatted = formatEvent(acknowledgedEvent, { compact: true });
      expect(formatted).toContain('✓');
    });

    test('includes metadata in verbose mode', () => {
      const formatted = formatEvent(mockEvent, { verbose: true });
      expect(formatted).toContain('Metadata');
      expect(formatted).toContain('size');
      expect(formatted).toContain('1GB');
    });

    test('handles event without message', () => {
      const eventWithoutMessage = { ...mockEvent, message: null };
      const formatted = formatEvent(eventWithoutMessage, { compact: false });
      expect(formatted).toContain('Backup completed');
    });

    test('handles event without metadata', () => {
      const eventWithoutMetadata = { ...mockEvent, metadata: {} };
      const formatted = formatEvent(eventWithoutMetadata, { verbose: true });
      // Should not error
      expect(formatted).toContain('Backup completed');
    });
  });

  // ===========================================================================
  // EVENT_TYPES Constant Tests
  // ===========================================================================
  describe('EVENT_TYPES', () => {
    test('contains expected event types', () => {
      expect(EVENT_TYPES).toHaveProperty('backup');
      expect(EVENT_TYPES).toHaveProperty('deploy');
      expect(EVENT_TYPES).toHaveProperty('alert');
      expect(EVENT_TYPES).toHaveProperty('error');
      expect(EVENT_TYPES).toHaveProperty('warning');
      expect(EVENT_TYPES).toHaveProperty('info');
      expect(EVENT_TYPES).toHaveProperty('security');
      expect(EVENT_TYPES).toHaveProperty('maintenance');
      expect(EVENT_TYPES).toHaveProperty('restore');
      expect(EVENT_TYPES).toHaveProperty('update');
    });

    test('each event type has icon and color', () => {
      for (const [type, config] of Object.entries(EVENT_TYPES)) {
        expect(config).toHaveProperty('icon');
        expect(config).toHaveProperty('color');
        expect(typeof config.icon).toBe('string');
        expect(typeof config.color).toBe('function');
      }
    });
  });

  // ===========================================================================
  // SEVERITY Constant Tests
  // ===========================================================================
  describe('SEVERITY', () => {
    test('contains expected severity levels', () => {
      expect(SEVERITY).toHaveProperty('critical');
      expect(SEVERITY).toHaveProperty('high');
      expect(SEVERITY).toHaveProperty('medium');
      expect(SEVERITY).toHaveProperty('low');
      expect(SEVERITY).toHaveProperty('info');
    });

    test('severity levels have correct priority order', () => {
      expect(SEVERITY.critical.priority).toBe(0);
      expect(SEVERITY.high.priority).toBe(1);
      expect(SEVERITY.medium.priority).toBe(2);
      expect(SEVERITY.low.priority).toBe(3);
      expect(SEVERITY.info.priority).toBe(4);
    });

    test('each severity has color function', () => {
      for (const [level, config] of Object.entries(SEVERITY)) {
        expect(config).toHaveProperty('priority');
        expect(config).toHaveProperty('color');
        expect(typeof config.color).toBe('function');
      }
    });
  });
});
