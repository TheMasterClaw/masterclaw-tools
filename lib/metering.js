/**
 * metering.js - Usage Metering & Billing for MasterClaw Agent Hub
 * 
 * Tracks resource usage for SaaS billing:
 * - Message counts and token usage
 * - Agent execution time
 * - API calls and storage
 * - Feature flags and tiers
 * 
 * Features:
 * - Real-time usage tracking
 * - Quota enforcement
 * - Usage reports and analytics
 * - Webhook notifications for billing
 * - Export to CSV/JSON for invoicing
 * 
 * Usage:
 *   const metering = require('./lib/metering');
 *   metering.recordEvent('message.sent', { userId: 'rex', tokens: 150 });
 *   const report = metering.getUsageReport('rex', '2025-01-01', '2025-01-31');
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const crypto = require('crypto');
const EventEmitter = require('events');

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_DATA_DIR = path.join(process.cwd(), '.masterclaw', 'metering');
const FLUSH_INTERVAL_MS = 60000; // 1 minute
const MAX_BUFFER_SIZE = 1000;

// Usage event types
const EVENT_TYPES = {
  // Messaging
  MESSAGE_SENT: 'message.sent',
  MESSAGE_RECEIVED: 'message.received',
  
  // Agent execution
  AGENT_REGISTER: 'agent.register',
  AGENT_EXECUTE_START: 'agent.execute.start',
  AGENT_EXECUTE_COMPLETE: 'agent.execute.complete',
  
  // Swarm operations
  SWARM_TASK_STARTED: 'swarm.task.started',
  SWARM_TASK_COMPLETED: 'swarm.task.completed',
  SWARM_TASK_FAILED: 'swarm.task.failed',
  
  // API usage
  API_CALL: 'api.call',
  WEBSOCKET_CONNECTION: 'websocket.connection',
  WEBSOCKET_MESSAGE: 'websocket.message',
  
  // Storage
  STORAGE_WRITE: 'storage.write',
  STORAGE_READ: 'storage.read',
};

// Default quotas by tier
const DEFAULT_QUOTAS = {
  free: {
    messagesPerDay: 100,
    agents: 1,
    swarms: 0,
    storageMB: 10,
    apiCallsPerDay: 1000,
  },
  starter: {
    messagesPerDay: 1000,
    agents: 5,
    swarms: 2,
    storageMB: 100,
    apiCallsPerDay: 10000,
    pricePerMonth: 9,
  },
  pro: {
    messagesPerDay: 10000,
    agents: 20,
    swarms: 10,
    storageMB: 1000,
    apiCallsPerDay: 100000,
    pricePerMonth: 49,
  },
  enterprise: {
    messagesPerDay: Infinity,
    agents: Infinity,
    swarms: Infinity,
    storageMB: 10000,
    apiCallsPerDay: Infinity,
    pricePerMonth: 299,
  },
};

// =============================================================================
// Metering Class
// =============================================================================

class Metering extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this.buffer = []; // In-memory event buffer
    this.flushInterval = null;
    this.quotas = options.quotas || DEFAULT_QUOTAS;
    this.userTiers = new Map(); // userId -> tier
    this.userUsage = new Map(); // userId -> { daily, monthly }
    
    // Webhook for billing notifications
    this.webhookUrl = options.webhookUrl || process.env.METERING_WEBHOOK_URL;
    
    // Feature flags
    this.enforceQuotas = options.enforceQuotas !== false;
    this.autoFlush = options.autoFlush !== false;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async init() {
    // Ensure data directory exists
    await fs.ensureDir(this.dataDir);
    await fs.ensureDir(path.join(this.dataDir, 'events'));
    await fs.ensureDir(path.join(this.dataDir, 'reports'));
    await fs.ensureDir(path.join(this.dataDir, 'users'));
    
    // Load user tiers
    await this.loadUserTiers();
    
    // Start auto-flush
    if (this.autoFlush) {
      this.startFlushTimer();
    }
    
    console.log(chalk.blue(`📊 Metering initialized at ${this.dataDir}`));
    this.emit('initialized');
    return this;
  }

  async stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Final flush
    await this.flush();
    
    console.log(chalk.blue('📊 Metering stopped'));
    this.emit('stopped');
  }

  // ===========================================================================
  // Event Recording
  // ===========================================================================

  recordEvent(eventType, data = {}) {
    const event = {
      id: this.generateId(),
      type: eventType,
      timestamp: Date.now(),
      userId: data.userId || 'anonymous',
      organizationId: data.organizationId,
      ...data,
    };

    // Add to buffer
    this.buffer.push(event);
    
    // Update in-memory usage stats
    this.updateUsageStats(event);
    
    // Check quota
    if (this.enforceQuotas) {
      const quotaCheck = this.checkQuota(event.userId, eventType);
      if (!quotaCheck.allowed) {
        this.emit('quotaExceeded', {
          userId: event.userId,
          eventType,
          quota: quotaCheck.quota,
          current: quotaCheck.current,
        });
      }
    }
    
    // Auto-flush if buffer is full
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.flush();
    }
    
    this.emit('event', event);
    return event;
  }

  recordMessage(userId, direction, metadata = {}) {
    const eventType = direction === 'sent' 
      ? EVENT_TYPES.MESSAGE_SENT 
      : EVENT_TYPES.MESSAGE_RECEIVED;
    
    return this.recordEvent(eventType, {
      userId,
      contentLength: metadata.contentLength || 0,
      tokens: metadata.tokens || 0,
      agentId: metadata.agentId,
      roomId: metadata.roomId,
    });
  }

  recordAgentExecution(userId, agentId, duration, success, metadata = {}) {
    const eventType = success
      ? EVENT_TYPES.AGENT_EXECUTE_COMPLETE
      : EVENT_TYPES.AGENT_EXECUTE_START;
    
    return this.recordEvent(eventType, {
      userId,
      agentId,
      duration,
      success,
      tokensUsed: metadata.tokensUsed || 0,
      model: metadata.model,
    });
  }

  recordSwarmTask(userId, taskId, status, metadata = {}) {
    const eventMap = {
      started: EVENT_TYPES.SWARM_TASK_STARTED,
      completed: EVENT_TYPES.SWARM_TASK_COMPLETED,
      failed: EVENT_TYPES.SWARM_TASK_FAILED,
    };
    
    return this.recordEvent(eventMap[status], {
      userId,
      taskId,
      duration: metadata.duration,
      agents: metadata.agents,
      turns: metadata.turns,
    });
  }

  recordApiCall(userId, endpoint, method, statusCode, duration) {
    return this.recordEvent(EVENT_TYPES.API_CALL, {
      userId,
      endpoint,
      method,
      statusCode,
      duration,
    });
  }

  // ===========================================================================
  // Usage Stats (In-Memory)
  // ===========================================================================

  updateUsageStats(event) {
    const userId = event.userId;
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7); // YYYY-MM
    
    if (!this.userUsage.has(userId)) {
      this.userUsage.set(userId, {
        daily: new Map(),
        monthly: new Map(),
      });
    }
    
    const userStats = this.userUsage.get(userId);
    
    // Daily stats
    if (!userStats.daily.has(today)) {
      userStats.daily.set(today, this.createEmptyStats());
    }
    const dailyStats = userStats.daily.get(today);
    
    // Monthly stats
    if (!userStats.monthly.has(month)) {
      userStats.monthly.set(month, this.createEmptyStats());
    }
    const monthlyStats = userStats.monthly.get(month);
    
    // Update counters
    this.incrementStats(dailyStats, event);
    this.incrementStats(monthlyStats, event);
  }

  createEmptyStats() {
    return {
      messagesSent: 0,
      messagesReceived: 0,
      agentExecutions: 0,
      swarmTasks: 0,
      apiCalls: 0,
      tokensUsed: 0,
      storageBytes: 0,
      events: [],
    };
  }

  incrementStats(stats, event) {
    switch (event.type) {
      case EVENT_TYPES.MESSAGE_SENT:
        stats.messagesSent++;
        break;
      case EVENT_TYPES.MESSAGE_RECEIVED:
        stats.messagesReceived++;
        break;
      case EVENT_TYPES.AGENT_EXECUTE_COMPLETE:
        stats.agentExecutions++;
        stats.tokensUsed += event.tokensUsed || 0;
        break;
      case EVENT_TYPES.SWARM_TASK_COMPLETED:
        stats.swarmTasks++;
        break;
      case EVENT_TYPES.API_CALL:
        stats.apiCalls++;
        break;
    }
    
    // Keep last 100 events for debugging
    stats.events.push({
      type: event.type,
      timestamp: event.timestamp,
    });
    if (stats.events.length > 100) {
      stats.events.shift();
    }
  }

  // ===========================================================================
  // Quota Management
  // ===========================================================================

  async setUserTier(userId, tier) {
    if (!this.quotas[tier]) {
      throw new Error(`Invalid tier: ${tier}`);
    }
    
    this.userTiers.set(userId, tier);
    await this.saveUserTiers();
    
    this.emit('tierChanged', { userId, tier });
  }

  getUserTier(userId) {
    return this.userTiers.get(userId) || 'free';
  }

  checkQuota(userId, eventType) {
    const tier = this.getUserTier(userId);
    const quota = this.quotas[tier];
    const today = new Date().toISOString().split('T')[0];
    
    const userStats = this.userUsage.get(userId);
    const dailyStats = userStats?.daily.get(today) || this.createEmptyStats();
    
    let allowed = true;
    let current = 0;
    let limit = 0;
    
    switch (eventType) {
      case EVENT_TYPES.MESSAGE_SENT:
      case EVENT_TYPES.MESSAGE_RECEIVED:
        current = dailyStats.messagesSent + dailyStats.messagesReceived;
        limit = quota.messagesPerDay;
        allowed = current < limit;
        break;
      
      case EVENT_TYPES.AGENT_EXECUTE_START:
      case EVENT_TYPES.AGENT_REGISTER:
        // Check active agent count (approximate)
        limit = quota.agents;
        allowed = true; // Would need to track active agents
        break;
      
      case EVENT_TYPES.SWARM_TASK_STARTED:
        limit = quota.swarms;
        allowed = dailyStats.swarmTasks < limit;
        break;
      
      case EVENT_TYPES.API_CALL:
        current = dailyStats.apiCalls;
        limit = quota.apiCallsPerDay;
        allowed = current < limit;
        break;
    }
    
    return { allowed, current, limit, tier };
  }

  getRemainingQuota(userId) {
    const tier = this.getUserTier(userId);
    const quota = this.quotas[tier];
    const today = new Date().toISOString().split('T')[0];
    
    const userStats = this.userUsage.get(userId);
    const dailyStats = userStats?.daily.get(today) || this.createEmptyStats();
    
    return {
      tier,
      messages: Math.max(0, quota.messagesPerDay - dailyStats.messagesSent - dailyStats.messagesReceived),
      apiCalls: Math.max(0, quota.apiCallsPerDay - dailyStats.apiCalls),
      swarmTasks: Math.max(0, quota.swarms - dailyStats.swarmTasks),
      storageMB: quota.storageMB,
    };
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  async flush() {
    if (this.buffer.length === 0) return;
    
    const events = [...this.buffer];
    this.buffer = [];
    
    // Group by date for file organization
    const eventsByDate = new Map();
    
    for (const event of events) {
      const date = new Date(event.timestamp).toISOString().split('T')[0];
      if (!eventsByDate.has(date)) {
        eventsByDate.set(date, []);
      }
      eventsByDate.get(date).push(event);
    }
    
    // Write to files
    for (const [date, dateEvents] of eventsByDate) {
      const filePath = path.join(this.dataDir, 'events', `${date}.jsonl`);
      const lines = dateEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(filePath, lines);
    }
    
    // Save user stats
    await this.saveUserStats();
    
    // Send webhook if configured
    if (this.webhookUrl) {
      this.sendWebhook(events).catch(console.error);
    }
    
    this.emit('flush', { count: events.length });
  }

  startFlushTimer() {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  async loadUserTiers() {
    const filePath = path.join(this.dataDir, 'user-tiers.json');
    try {
      if (await fs.pathExists(filePath)) {
        const data = await fs.readJson(filePath);
        this.userTiers = new Map(Object.entries(data));
      }
    } catch (error) {
      console.warn('Failed to load user tiers:', error.message);
    }
  }

  async saveUserTiers() {
    const filePath = path.join(this.dataDir, 'user-tiers.json');
    const data = Object.fromEntries(this.userTiers);
    await fs.writeJson(filePath, data);
  }

  async saveUserStats() {
    for (const [userId, stats] of this.userUsage) {
      const filePath = path.join(this.dataDir, 'users', `${userId}.json`);
      
      // Convert Maps to plain objects for JSON
      const serializable = {
        daily: Object.fromEntries(stats.daily),
        monthly: Object.fromEntries(stats.monthly),
      };
      
      await fs.writeJson(filePath, serializable);
    }
  }

  // ===========================================================================
  // Reporting
  // ===========================================================================

  async getUsageReport(userId, startDate, endDate) {
    const events = await this.getEvents(startDate, endDate, userId);
    
    const summary = {
      userId,
      period: { start: startDate, end: endDate },
      totalEvents: events.length,
      messagesSent: 0,
      messagesReceived: 0,
      agentExecutions: 0,
      swarmTasks: 0,
      apiCalls: 0,
      totalTokens: 0,
      breakdownByDay: {},
      breakdownByType: {},
    };
    
    for (const event of events) {
      // Count by type
      summary.breakdownByType[event.type] = (summary.breakdownByType[event.type] || 0) + 1;
      
      // Count by day
      const day = new Date(event.timestamp).toISOString().split('T')[0];
      summary.breakdownByDay[day] = (summary.breakdownByDay[day] || 0) + 1;
      
      // Aggregate metrics
      switch (event.type) {
        case EVENT_TYPES.MESSAGE_SENT:
          summary.messagesSent++;
          break;
        case EVENT_TYPES.MESSAGE_RECEIVED:
          summary.messagesReceived++;
          break;
        case EVENT_TYPES.AGENT_EXECUTE_COMPLETE:
          summary.agentExecutions++;
          summary.totalTokens += event.tokensUsed || 0;
          break;
        case EVENT_TYPES.SWARM_TASK_COMPLETED:
          summary.swarmTasks++;
          break;
        case EVENT_TYPES.API_CALL:
          summary.apiCalls++;
          break;
      }
    }
    
    return summary;
  }

  async getEvents(startDate, endDate, userId = null) {
    const events = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    // Iterate through dates
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const filePath = path.join(this.dataDir, 'events', `${dateStr}.jsonl`);
      
      if (await fs.pathExists(filePath)) {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (!userId || event.userId === userId) {
              events.push(event);
            }
          } catch (e) {
            // Skip invalid lines
          }
        }
      }
    }
    
    return events;
  }

  async exportReport(userId, startDate, endDate, format = 'json') {
    const report = await this.getUsageReport(userId, startDate, endDate);
    
    if (format === 'csv') {
      return this.toCSV(report);
    }
    
    return report;
  }

  toCSV(report) {
    const lines = [
      'Date,Event Type,Count',
    ];
    
    for (const [date, count] of Object.entries(report.breakdownByDay)) {
      lines.push(`${date},total,${count}`);
    }
    
    return lines.join('\n');
  }

  // ===========================================================================
  // Webhook
  // ===========================================================================

  async sendWebhook(events) {
    if (!this.webhookUrl) return;
    
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: Date.now(),
          eventCount: events.length,
          events: events.slice(0, 100), // Limit payload size
        }),
      });
      
      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status}`);
      }
    } catch (error) {
      console.error('Webhook error:', error.message);
      this.emit('webhookError', error);
    }
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  generateId() {
    return crypto.randomUUID();
  }

  getStats() {
    return {
      bufferSize: this.buffer.length,
      users: this.userUsage.size,
      totalEvents: this.buffer.length, // Approximate
    };
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

let meteringInstance = null;

function getMetering(options = {}) {
  if (!meteringInstance) {
    meteringInstance = new Metering(options);
  }
  return meteringInstance;
}

function resetMetering() {
  if (meteringInstance) {
    meteringInstance.removeAllListeners();
    meteringInstance = null;
  }
}

module.exports = {
  Metering,
  getMetering,
  resetMetering,
  EVENT_TYPES,
  DEFAULT_QUOTAS,
};
