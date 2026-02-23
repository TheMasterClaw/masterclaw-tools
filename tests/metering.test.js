/**
 * metering.test.js - Tests for usage metering and billing
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { Metering, getMetering, resetMetering, EVENT_TYPES, DEFAULT_QUOTAS } = require('../lib/metering');

describe('Metering', () => {
  let metering;
  let tempDir;

  beforeEach(async () => {
    // Create temp directory for test data
    tempDir = path.join(os.tmpdir(), `metering-test-${Date.now()}`);
    await fs.ensureDir(tempDir);
    
    resetMetering();
    metering = new Metering({
      dataDir: tempDir,
      autoFlush: false,
      enforceQuotas: true,
    });
  });

  afterEach(async () => {
    await metering.stop();
    resetMetering();
    
    // Clean up temp directory
    await fs.remove(tempDir);
  });

  describe('Initialization', () => {
    test('should initialize with correct defaults', () => {
      expect(metering.dataDir).toBe(tempDir);
      expect(metering.buffer).toEqual([]);
      expect(metering.enforceQuotas).toBe(true);
    });

    test('should create data directories on init', async () => {
      await metering.init();
      
      expect(await fs.pathExists(tempDir)).toBe(true);
      expect(await fs.pathExists(path.join(tempDir, 'events'))).toBe(true);
      expect(await fs.pathExists(path.join(tempDir, 'reports'))).toBe(true);
      expect(await fs.pathExists(path.join(tempDir, 'users'))).toBe(true);
    });

    test('should emit initialized event', async () => {
      const spy = jest.fn();
      metering.on('initialized', spy);
      
      await metering.init();
      
      expect(spy).toHaveBeenCalled();
    });

    test('should start flush timer when autoFlush enabled', async () => {
      const meter = new Metering({
        dataDir: tempDir,
        autoFlush: true,
      });
      
      await meter.init();
      
      expect(meter.flushInterval).toBeTruthy();
      
      await meter.stop();
    });
  });

  describe('Event Recording', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should record event to buffer', () => {
      const event = metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, {
        userId: 'test-user',
        contentLength: 100,
      });
      
      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.type).toBe(EVENT_TYPES.MESSAGE_SENT);
      expect(event.userId).toBe('test-user');
      expect(metering.buffer.length).toBe(1);
    });

    test('should emit event when recorded', () => {
      const spy = jest.fn();
      metering.on('event', spy);
      
      metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, { userId: 'test-user' });
      
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0].type).toBe(EVENT_TYPES.MESSAGE_SENT);
    });

    test('should record message sent', () => {
      const event = metering.recordMessage('test-user', 'sent', {
        contentLength: 150,
        tokens: 50,
      });
      
      expect(event.type).toBe(EVENT_TYPES.MESSAGE_SENT);
      expect(event.contentLength).toBe(150);
      expect(event.tokens).toBe(50);
    });

    test('should record message received', () => {
      const event = metering.recordMessage('test-user', 'received', {
        contentLength: 200,
      });
      
      expect(event.type).toBe(EVENT_TYPES.MESSAGE_RECEIVED);
    });

    test('should record agent execution', () => {
      const event = metering.recordAgentExecution(
        'test-user',
        'agent-1',
        1500,
        true,
        { tokensUsed: 100, model: 'claude-sonnet' }
      );
      
      expect(event.type).toBe(EVENT_TYPES.AGENT_EXECUTE_COMPLETE);
      expect(event.agentId).toBe('agent-1');
      expect(event.duration).toBe(1500);
      expect(event.tokensUsed).toBe(100);
    });

    test('should record swarm task', () => {
      const event = metering.recordSwarmTask(
        'test-user',
        'task-123',
        'completed',
        { duration: 5000, agents: 3, turns: 5 }
      );
      
      expect(event.type).toBe(EVENT_TYPES.SWARM_TASK_COMPLETED);
      expect(event.taskId).toBe('task-123');
      expect(event.agents).toBe(3);
    });

    test('should record API call', () => {
      const event = metering.recordApiCall(
        'test-user',
        '/api/v1/agents',
        'POST',
        200,
        150
      );
      
      expect(event.type).toBe(EVENT_TYPES.API_CALL);
      expect(event.endpoint).toBe('/api/v1/agents');
      expect(event.statusCode).toBe(200);
    });
  });

  describe('Usage Stats', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should track daily usage stats', () => {
      metering.recordMessage('user-1', 'sent', {});
      metering.recordMessage('user-1', 'sent', {});
      metering.recordMessage('user-1', 'received', {});
      
      const stats = metering.userUsage.get('user-1');
      const today = new Date().toISOString().split('T')[0];
      const dailyStats = stats.daily.get(today);
      
      expect(dailyStats.messagesSent).toBe(2);
      expect(dailyStats.messagesReceived).toBe(1);
    });

    test('should track monthly usage stats', () => {
      metering.recordAgentExecution('user-1', 'agent-1', 1000, true, { tokensUsed: 50 });
      
      const stats = metering.userUsage.get('user-1');
      const month = new Date().toISOString().substring(0, 7);
      const monthlyStats = stats.monthly.get(month);
      
      expect(monthlyStats.agentExecutions).toBe(1);
      expect(monthlyStats.tokensUsed).toBe(50);
    });

    test('should limit event history per stats', () => {
      for (let i = 0; i < 110; i++) {
        metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, { userId: 'user-1' });
      }
      
      const stats = metering.userUsage.get('user-1');
      const today = new Date().toISOString().split('T')[0];
      const dailyStats = stats.daily.get(today);
      
      expect(dailyStats.events.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Quota Management', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should set user tier', async () => {
      await metering.setUserTier('user-1', 'pro');
      
      expect(metering.getUserTier('user-1')).toBe('pro');
    });

    test('should default to free tier', () => {
      expect(metering.getUserTier('unknown-user')).toBe('free');
    });

    test('should reject invalid tier', async () => {
      await expect(metering.setUserTier('user-1', 'invalid')).rejects.toThrow('Invalid tier');
    });

    test('should emit tierChanged event', async () => {
      const spy = jest.fn();
      metering.on('tierChanged', spy);
      
      await metering.setUserTier('user-1', 'starter');
      
      expect(spy).toHaveBeenCalledWith({ userId: 'user-1', tier: 'starter' });
    });

    test('should check quota for messages', async () => {
      await metering.setUserTier('user-1', 'free');
      
      // Simulate usage up to limit
      const today = new Date().toISOString().split('T')[0];
      metering.userUsage.set('user-1', {
        daily: new Map([[today, {
          messagesSent: 50,
          messagesReceived: 50,
          agentExecutions: 0,
          swarmTasks: 0,
          apiCalls: 0,
          tokensUsed: 0,
          storageBytes: 0,
          events: [],
        }]]),
        monthly: new Map(),
      });
      
      const check = metering.checkQuota('user-1', EVENT_TYPES.MESSAGE_SENT);
      
      expect(check.allowed).toBe(false);
      expect(check.current).toBe(100);
      expect(check.limit).toBe(100); // free tier limit
    });

    test('should get remaining quota', async () => {
      await metering.setUserTier('user-1', 'starter');
      
      const today = new Date().toISOString().split('T')[0];
      metering.userUsage.set('user-1', {
        daily: new Map([[today, {
          messagesSent: 500,
          messagesReceived: 0,
          agentExecutions: 0,
          swarmTasks: 1,
          apiCalls: 100,
          tokensUsed: 0,
          storageBytes: 0,
          events: [],
        }]]),
        monthly: new Map(),
      });
      
      const remaining = metering.getRemainingQuota('user-1');
      
      expect(remaining.tier).toBe('starter');
      expect(remaining.messages).toBe(500); // 1000 - 500
      expect(remaining.swarmTasks).toBe(1); // 2 - 1
    });

    test('should emit quotaExceeded event', async () => {
      await metering.setUserTier('user-1', 'free');
      
      const today = new Date().toISOString().split('T')[0];
      metering.userUsage.set('user-1', {
        daily: new Map([[today, {
          messagesSent: 100,
          messagesReceived: 0,
          agentExecutions: 0,
          swarmTasks: 0,
          apiCalls: 0,
          tokensUsed: 0,
          storageBytes: 0,
          events: [],
        }]]),
        monthly: new Map(),
      });
      
      const spy = jest.fn();
      metering.on('quotaExceeded', spy);
      
      metering.recordMessage('user-1', 'sent', {});
      
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Persistence', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should flush buffer to file', async () => {
      metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, { userId: 'user-1' });
      metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, { userId: 'user-2' });
      
      await metering.flush();
      
      expect(metering.buffer.length).toBe(0);
      
      const today = new Date().toISOString().split('T')[0];
      const filePath = path.join(tempDir, 'events', `${today}.jsonl`);
      expect(await fs.pathExists(filePath)).toBe(true);
      
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });

    test('should emit flush event', async () => {
      metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, {});
      
      const spy = jest.fn();
      metering.on('flush', spy);
      
      await metering.flush();
      
      expect(spy).toHaveBeenCalledWith({ count: 1 });
    });

    test('should save user tiers to file', async () => {
      await metering.setUserTier('user-1', 'pro');
      await metering.setUserTier('user-2', 'starter');
      
      const filePath = path.join(tempDir, 'user-tiers.json');
      const content = await fs.readJson(filePath);
      
      expect(content['user-1']).toBe('pro');
      expect(content['user-2']).toBe('starter');
    });

    test('should load user tiers from file', async () => {
      // Pre-create tier file
      await fs.writeJson(path.join(tempDir, 'user-tiers.json'), {
        'existing-user': 'enterprise',
      });
      
      await metering.loadUserTiers();
      
      expect(metering.getUserTier('existing-user')).toBe('enterprise');
    });

    test('should auto-flush when buffer is full', async () => {
      const spy = jest.spyOn(metering, 'flush');
      
      // Fill buffer to max
      for (let i = 0; i < 1000; i++) {
        metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, {});
      }
      
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('Reporting', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should generate usage report', async () => {
      // Record some events
      metering.recordMessage('user-1', 'sent', { contentLength: 100 });
      metering.recordMessage('user-1', 'sent', { contentLength: 200 });
      metering.recordAgentExecution('user-1', 'agent-1', 1000, true, { tokensUsed: 50 });
      metering.recordSwarmTask('user-1', 'task-1', 'completed', {});
      
      await metering.flush();
      
      const today = new Date().toISOString().split('T')[0];
      const report = await metering.getUsageReport('user-1', today, today);
      
      expect(report.userId).toBe('user-1');
      expect(report.totalEvents).toBe(4);
      expect(report.messagesSent).toBe(2);
      expect(report.agentExecutions).toBe(1);
      expect(report.swarmTasks).toBe(1);
    });

    test('should export report as CSV', async () => {
      metering.recordMessage('user-1', 'sent', {});
      await metering.flush();
      
      const today = new Date().toISOString().split('T')[0];
      const csv = await metering.exportReport('user-1', today, today, 'csv');
      
      expect(csv).toContain('Date,Event Type,Count');
    });

    test('should export report as JSON', async () => {
      metering.recordMessage('user-1', 'sent', {});
      await metering.flush();
      
      const today = new Date().toISOString().split('T')[0];
      const report = await metering.exportReport('user-1', today, today, 'json');
      
      expect(report.userId).toBe('user-1');
    });

    test('should filter events by date range', async () => {
      // This would require manipulating dates, simplified test
      const today = new Date().toISOString().split('T')[0];
      
      metering.recordEvent(EVENT_TYPES.MESSAGE_SENT, { userId: 'user-1' });
      await metering.flush();
      
      const events = await metering.getEvents(today, today, 'user-1');
      expect(events.length).toBe(1);
      expect(events[0].userId).toBe('user-1');
    });
  });

  describe('Webhook', () => {
    beforeEach(async () => {
      await metering.init();
    });

    test('should send webhook on flush', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      
      const meter = new Metering({
        dataDir: tempDir,
        autoFlush: false,
        webhookUrl: 'https://example.com/webhook',
      });
      
      await meter.init();
      meter.recordEvent(EVENT_TYPES.MESSAGE_SENT, {});
      await meter.flush();
      
      expect(fetch).toHaveBeenCalledWith(
        'https://example.com/webhook',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
      
      await meter.stop();
    });

    test('should emit webhookError on failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
      
      const meter = new Metering({
        dataDir: tempDir,
        autoFlush: false,
        webhookUrl: 'https://example.com/webhook',
      });
      
      await meter.init();
      
      const spy = jest.fn();
      meter.on('webhookError', spy);
      
      meter.recordEvent(EVENT_TYPES.MESSAGE_SENT, {});
      await meter.flush();
      
      expect(spy).toHaveBeenCalled();
      
      await meter.stop();
    });
  });

  describe('Default Quotas', () => {
    test('should have correct free tier quotas', () => {
      expect(DEFAULT_QUOTAS.free.messagesPerDay).toBe(100);
      expect(DEFAULT_QUOTAS.free.agents).toBe(1);
      expect(DEFAULT_QUOTAS.free.swarms).toBe(0);
      expect(DEFAULT_QUOTAS.free.pricePerMonth).toBeUndefined();
    });

    test('should have correct starter tier quotas', () => {
      expect(DEFAULT_QUOTAS.starter.messagesPerDay).toBe(1000);
      expect(DEFAULT_QUOTAS.starter.agents).toBe(5);
      expect(DEFAULT_QUOTAS.starter.pricePerMonth).toBe(9);
    });

    test('should have correct pro tier quotas', () => {
      expect(DEFAULT_QUOTAS.pro.messagesPerDay).toBe(10000);
      expect(DEFAULT_QUOTAS.pro.agents).toBe(20);
      expect(DEFAULT_QUOTAS.pro.pricePerMonth).toBe(49);
    });

    test('should have correct enterprise tier quotas', () => {
      expect(DEFAULT_QUOTAS.enterprise.messagesPerDay).toBe(Infinity);
      expect(DEFAULT_QUOTAS.enterprise.agents).toBe(Infinity);
      expect(DEFAULT_QUOTAS.enterprise.pricePerMonth).toBe(299);
    });
  });

  describe('Singleton', () => {
    test('should return same instance', () => {
      const m1 = getMetering();
      const m2 = getMetering();
      
      expect(m1).toBe(m2);
    });

    test('should reset instance', () => {
      const m1 = getMetering();
      resetMetering();
      const m2 = getMetering();
      
      expect(m1).not.toBe(m2);
    });
  });
});
