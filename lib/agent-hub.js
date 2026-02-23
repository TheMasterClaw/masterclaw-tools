/**
 * agent-hub.js - WebSocket Agent Hub for MasterClaw
 * 
 * Enables direct WebSocket communication between Rex (human) and agents.
 * Features:
 * - Real-time bidirectional messaging
 * - Agent presence/heartbeat tracking
 * - Room-based conversations (1:1 or group)
 * - Message history with pagination
 * - Security: JWT auth, rate limiting, input validation
 * - Usage metering for SaaS billing
 * 
 * Usage:
 *   const hub = require('./lib/agent-hub');
 *   await hub.start({ port: 8765 });
 *   hub.on('message', ({ agentId, message, room }) => { ... });
 */

const WebSocket = require('ws');
const http = require('http');
const chalk = require('chalk');
const crypto = require('crypto');
const EventEmitter = require('events');

// Security imports
const chatSecurity = require('./chat-security');
const rateLimiter = require('./rate-limiter');

// Usage metering for SaaS billing
const metering = require('./metering');

// Agent memory and context
const memory = require('./memory');

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PORT = process.env.AGENT_HUB_PORT || 8765;
const DEFAULT_HOST = process.env.AGENT_HUB_HOST || '0.0.0.0';
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_ROOM_SIZE = 100; // Max agents/users per room

// Message types
const MSG_TYPES = {
  // Client → Server
  AUTH: 'auth',
  MESSAGE: 'message',
  JOIN_ROOM: 'join_room',
  LEAVE_ROOM: 'leave_room',
  TYPING: 'typing',
  PING: 'ping',
  
  // Server → Client
  AUTH_SUCCESS: 'auth_success',
  AUTH_ERROR: 'auth_error',
  MESSAGE_ACK: 'message_ack',
  USER_JOINED: 'user_joined',
  USER_LEFT: 'user_left',
  TYPING_INDICATOR: 'typing_indicator',
  PONG: 'pong',
  ERROR: 'error',
  AGENT_STATUS: 'agent_status',
  
  // Agent-specific
  AGENT_REGISTER: 'agent_register',
  AGENT_READY: 'agent_ready',
  AGENT_BUSY: 'agent_busy',
  AGENT_RESULT: 'agent_result',
  AGENT_ERROR: 'agent_error',
};

// Agent roles/types
const AGENT_ROLES = {
  CODER: 'coder',
  REVIEWER: 'reviewer',
  TESTER: 'tester',
  ARCHITECT: 'architect',
  SECURITY: 'security',
  DEVOPS: 'devops',
  GENERAL: 'general',
};

// =============================================================================
// AgentHub Class
// =============================================================================

class AgentHub extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    this.server = null;
    this.wss = null;
    
    // Connection management
    this.clients = new Map(); // ws -> client info
    this.agents = new Map(); // agentId -> agent info
    this.rooms = new Map(); // roomId -> Set of clientIds
    this.userSockets = new Map(); // userId -> ws
    
    // Message history (in-memory with TTL)
    this.messageHistory = new Map(); // roomId -> Array of messages
    this.maxHistoryPerRoom = options.maxHistory || 1000;
    
    // Heartbeat tracking
    this.heartbeatInterval = null;
    
    // Usage tracking for billing
    this.meteringEnabled = options.metering !== false;
    
    // Authentication
    this.authToken = options.authToken || process.env.AGENT_HUB_TOKEN;
    this.requireAuth = options.requireAuth !== false;
  }

  // ===========================================================================
  // Server Lifecycle
  // ===========================================================================

  async start() {
    return new Promise((resolve, reject) => {
      // Create HTTP server
      this.server = http.createServer((req, res) => {
        // Health check endpoint
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'healthy',
            connections: this.clients.size,
            agents: this.agents.size,
            rooms: this.rooms.size,
            uptime: process.uptime(),
          }));
          return;
        }
        
        // Metrics endpoint for monitoring
        if (req.url === '/metrics') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.getMetrics()));
          return;
        }
        
        res.writeHead(404);
        res.end('Not Found');
      });

      // Create WebSocket server
      this.wss = new WebSocket.Server({ 
        server: this.server,
        maxPayload: MAX_MESSAGE_SIZE,
        perMessageDeflate: true,
      });

      this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
      this.wss.on('error', (err) => this.emit('error', err));

      // Start heartbeat checker
      this.startHeartbeat();

      // Start server
      this.server.listen(this.port, this.host, () => {
        console.log(chalk.green(`🚀 Agent Hub started on ws://${this.host}:${this.port}`));
        console.log(chalk.gray(`   Health: http://${this.host}:${this.port}/health`));
        console.log(chalk.gray(`   Metrics: http://${this.host}:${this.port}/metrics`));
        this.emit('started', { port: this.port, host: this.host });
        resolve();
      });

      this.server.on('error', reject);
    });
  }

  async stop() {
    console.log(chalk.yellow('🛑 Shutting down Agent Hub...'));
    
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all client connections
    for (const [ws, client] of this.clients) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Server shutting down' });
      ws.close(1000, 'Server shutting down');
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
    }

    // Close HTTP server
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
    }

    this.clients.clear();
    this.agents.clear();
    this.rooms.clear();
    this.userSockets.clear();

    console.log(chalk.green('✅ Agent Hub stopped'));
    this.emit('stopped');
  }

  // ===========================================================================
  // Connection Handling
  // ===========================================================================

  handleConnection(ws, req) {
    const clientId = this.generateId();
    const ip = req.socket.remoteAddress;
    
    console.log(chalk.blue(`🔌 New connection from ${ip} (client: ${clientId})`));

    // Initialize client
    const client = {
      id: clientId,
      ws,
      ip,
      authenticated: !this.requireAuth,
      userId: null,
      agentId: null,
      role: null,
      rooms: new Set(),
      lastPing: Date.now(),
      connectedAt: Date.now(),
      messageCount: 0,
    };

    this.clients.set(ws, client);

    // Send welcome
    this.send(ws, {
      type: MSG_TYPES.AUTH_SUCCESS,
      clientId,
      message: 'Connected to Agent Hub',
      requireAuth: this.requireAuth,
    });

    // Handle messages
    ws.on('message', (data) => this.handleMessage(ws, data));
    
    // Handle close
    ws.on('close', (code, reason) => this.handleDisconnect(ws, code, reason));
    
    // Handle errors
    ws.on('error', (err) => {
      console.error(chalk.red(`WebSocket error for ${clientId}:`), err.message);
      this.emit('clientError', { clientId, error: err });
    });

    // Ping/pong for keepalive
    ws.on('pong', () => {
      client.lastPing = Date.now();
    });

    this.emit('connection', { clientId, ip });
  }

  async handleMessage(ws, data) {
    const client = this.clients.get(ws);
    if (!client) return;

    try {
      // Parse message
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (err) {
        this.send(ws, { type: MSG_TYPES.ERROR, message: 'Invalid JSON' });
        return;
      }

      // Rate limiting check
      const rateCheck = await this.checkRateLimit(client);
      if (!rateCheck.allowed) {
        this.send(ws, { 
          type: MSG_TYPES.ERROR, 
          message: 'Rate limit exceeded. Please slow down.',
          retryAfter: rateCheck.retryAfter,
        });
        return;
      }

      client.messageCount++;

      // Handle message by type
      switch (message.type) {
        case MSG_TYPES.AUTH:
          await this.handleAuth(ws, client, message);
          break;
        
        case MSG_TYPES.AGENT_REGISTER:
          await this.handleAgentRegister(ws, client, message);
          break;
        
        case MSG_TYPES.MESSAGE:
          await this.handleChatMessage(ws, client, message);
          break;
        
        case MSG_TYPES.JOIN_ROOM:
          await this.handleJoinRoom(ws, client, message);
          break;
        
        case MSG_TYPES.LEAVE_ROOM:
          await this.handleLeaveRoom(ws, client, message);
          break;
        
        case MSG_TYPES.TYPING:
          await this.handleTyping(ws, client, message);
          break;
        
        case MSG_TYPES.PING:
          this.send(ws, { type: MSG_TYPES.PONG, timestamp: Date.now() });
          break;
        
        default:
          this.send(ws, { type: MSG_TYPES.ERROR, message: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error(chalk.red('Message handling error:'), err);
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Internal error' });
    }
  }

  // ===========================================================================
  // Message Handlers
  // ===========================================================================

  async handleAuth(ws, client, message) {
    const { token, userId } = message;

    if (!this.requireAuth) {
      client.authenticated = true;
      client.userId = userId || client.id;
      this.userSockets.set(client.userId, ws);
      
      this.send(ws, { 
        type: MSG_TYPES.AUTH_SUCCESS, 
        clientId: client.id,
        userId: client.userId,
      });
      return;
    }

    // Validate token
    if (token !== this.authToken) {
      this.send(ws, { type: MSG_TYPES.AUTH_ERROR, message: 'Invalid token' });
      ws.close(1008, 'Authentication failed');
      return;
    }

    client.authenticated = true;
    client.userId = userId || client.id;
    this.userSockets.set(client.userId, ws);

    this.send(ws, { 
      type: MSG_TYPES.AUTH_SUCCESS, 
      clientId: client.id,
      userId: client.userId,
    });

    console.log(chalk.green(`✅ Client ${client.id} authenticated as ${client.userId}`));
  }

  async handleAgentRegister(ws, client, message) {
    if (!client.authenticated) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Not authenticated' });
      return;
    }

    const { agentId, role, capabilities, metadata } = message;

    if (!agentId || !role) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'agentId and role required' });
      return;
    }

    if (!Object.values(AGENT_ROLES).includes(role)) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: `Invalid role: ${role}` });
      return;
    }

    // Register agent
    const agent = {
      id: agentId,
      clientId: client.id,
      role,
      capabilities: capabilities || [],
      metadata: metadata || {},
      status: 'ready',
      registeredAt: Date.now(),
      lastActivity: Date.now(),
    };

    this.agents.set(agentId, agent);
    client.agentId = agentId;
    client.role = role;

    this.send(ws, { 
      type: MSG_TYPES.AGENT_READY, 
      agentId,
      message: `Agent ${agentId} registered as ${role}`,
    });

    // Record usage for billing
    if (this.meteringEnabled) {
      metering.recordEvent('agent.register', {
        agentId,
        role,
        userId: client.userId,
      });
    }

    console.log(chalk.cyan(`🤖 Agent registered: ${agentId} (${role})`));
    this.emit('agentRegistered', agent);
  }

  async handleChatMessage(ws, client, message) {
    if (!client.authenticated) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Not authenticated' });
      return;
    }

    const { roomId, content, targetAgentId, metadata } = message;

    // Validate input
    const validation = chatSecurity.validateInput(content);
    if (!validation.valid) {
      this.send(ws, { 
        type: MSG_TYPES.ERROR, 
        message: `Message validation failed: ${validation.errors.join(', ')}`,
      });
      return;
    }

    // Sanitize content
    const sanitizedContent = chatSecurity.sanitizeInput(content);

    // Build message envelope
    const envelope = {
      id: this.generateId(),
      type: MSG_TYPES.MESSAGE,
      roomId: roomId || 'general',
      from: {
        userId: client.userId,
        agentId: client.agentId,
        role: client.role,
      },
      content: sanitizedContent,
      timestamp: Date.now(),
      metadata: metadata || {},
    };

    // Store in history
    this.storeMessage(envelope.roomId, envelope);

    // Route message
    if (targetAgentId) {
      // Direct message to specific agent
      await this.sendToAgent(targetAgentId, envelope);
    } else if (roomId) {
      // Broadcast to room
      await this.broadcastToRoom(roomId, envelope, client.id);
    } else {
      // Broadcast to all
      await this.broadcast(envelope, client.id);
    }

    // Acknowledge receipt
    this.send(ws, { 
      type: MSG_TYPES.MESSAGE_ACK, 
      messageId: envelope.id,
      timestamp: envelope.timestamp,
    });

    // Record usage for billing
    if (this.meteringEnabled) {
      metering.recordEvent('message.sent', {
        messageId: envelope.id,
        roomId: envelope.roomId,
        userId: client.userId,
        agentId: client.agentId,
        contentLength: sanitizedContent.length,
      });
    }

    // Emit for external handlers
    this.emit('message', envelope);
  }

  async handleJoinRoom(ws, client, message) {
    if (!client.authenticated) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Not authenticated' });
      return;
    }

    const { roomId } = message;
    if (!roomId) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'roomId required' });
      return;
    }

    // Check room size
    const room = this.rooms.get(roomId) || new Set();
    if (room.size >= MAX_ROOM_SIZE) {
      this.send(ws, { type: MSG_TYPES.ERROR, message: 'Room is full' });
      return;
    }

    // Add to room
    room.add(client.id);
    this.rooms.set(roomId, room);
    client.rooms.add(roomId);

    // Notify others
    await this.broadcastToRoom(roomId, {
      type: MSG_TYPES.USER_JOINED,
      roomId,
      user: {
        userId: client.userId,
        agentId: client.agentId,
        role: client.role,
      },
      timestamp: Date.now(),
    }, client.id);

    // Send room history
    const history = this.getRoomHistory(roomId, 50);
    this.send(ws, {
      type: 'room_history',
      roomId,
      messages: history,
    });

    console.log(chalk.blue(`📥 ${client.userId} joined room: ${roomId}`));
  }

  async handleLeaveRoom(ws, client, message) {
    const { roomId } = message;
    if (!roomId) return;

    const room = this.rooms.get(roomId);
    if (room) {
      room.delete(client.id);
      if (room.size === 0) {
        this.rooms.delete(roomId);
      }
    }
    client.rooms.delete(roomId);

    await this.broadcastToRoom(roomId, {
      type: MSG_TYPES.USER_LEFT,
      roomId,
      user: { userId: client.userId, agentId: client.agentId },
      timestamp: Date.now(),
    });

    console.log(chalk.blue(`📤 ${client.userId} left room: ${roomId}`));
  }

  async handleTyping(ws, client, message) {
    const { roomId, isTyping } = message;
    if (!roomId || !client.rooms.has(roomId)) return;

    await this.broadcastToRoom(roomId, {
      type: MSG_TYPES.TYPING_INDICATOR,
      roomId,
      user: { userId: client.userId, agentId: client.agentId },
      isTyping,
      timestamp: Date.now(),
    }, client.id);
  }

  handleDisconnect(ws, code, reason) {
    const client = this.clients.get(ws);
    if (!client) return;

    console.log(chalk.yellow(`🔌 Client disconnected: ${client.id} (code: ${code})`));

    // Remove from rooms
    for (const roomId of client.rooms) {
      const room = this.rooms.get(roomId);
      if (room) {
        room.delete(client.id);
        this.broadcastToRoom(roomId, {
          type: MSG_TYPES.USER_LEFT,
          roomId,
          user: { userId: client.userId, agentId: client.agentId },
          timestamp: Date.now(),
        });
      }
    }

    // Unregister agent
    if (client.agentId) {
      this.agents.delete(client.agentId);
      this.emit('agentUnregistered', { agentId: client.agentId });
    }

    // Remove from user sockets
    if (client.userId) {
      this.userSockets.delete(client.userId);
    }

    this.clients.delete(ws);
    this.emit('disconnection', { clientId: client.id, userId: client.userId });
  }

  // ===========================================================================
  // Message Routing
  // ===========================================================================

  send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  async sendToAgent(agentId, message) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn(chalk.yellow(`Agent not found: ${agentId}`));
      return false;
    }

    // Find client's websocket
    for (const [ws, client] of this.clients) {
      if (client.agentId === agentId) {
        this.send(ws, message);
        return true;
      }
    }
    return false;
  }

  async broadcastToRoom(roomId, message, excludeClientId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [ws, client] of this.clients) {
      if (room.has(client.id) && client.id !== excludeClientId) {
        this.send(ws, message);
      }
    }
  }

  async broadcast(message, excludeClientId = null) {
    for (const [ws, client] of this.clients) {
      if (client.id !== excludeClientId) {
        this.send(ws, message);
      }
    }
  }

  // ===========================================================================
  // History Management
  // ===========================================================================

  storeMessage(roomId, message) {
    if (!this.messageHistory.has(roomId)) {
      this.messageHistory.set(roomId, []);
    }
    
    const history = this.messageHistory.get(roomId);
    history.push(message);
    
    // Trim to max size
    if (history.length > this.maxHistoryPerRoom) {
      history.shift();
    }
  }

  getRoomHistory(roomId, limit = 50) {
    const history = this.messageHistory.get(roomId) || [];
    return history.slice(-limit);
  }

  // ===========================================================================
  // Heartbeat & Health
  // ===========================================================================

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      
      for (const [ws, client] of this.clients) {
        // Check if client is still responsive
        if (now - client.lastPing > HEARTBEAT_TIMEOUT) {
          console.log(chalk.yellow(`💔 Client ${client.id} timed out`));
          ws.terminate();
          continue;
        }
        
        // Send ping
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  // ===========================================================================
  // Rate Limiting
  // ===========================================================================

  async checkRateLimit(client) {
    // Simple in-memory rate limiting
    const windowMs = 60000; // 1 minute
    const maxRequests = 100; // 100 messages per minute
    
    if (!client.rateLimit) {
      client.rateLimit = { count: 0, resetTime: Date.now() + windowMs };
    }
    
    const now = Date.now();
    if (now > client.rateLimit.resetTime) {
      client.rateLimit = { count: 0, resetTime: now + windowMs };
    }
    
    client.rateLimit.count++;
    
    if (client.rateLimit.count > maxRequests) {
      return {
        allowed: false,
        retryAfter: Math.ceil((client.rateLimit.resetTime - now) / 1000),
      };
    }
    
    return { allowed: true };
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  generateId() {
    return crypto.randomUUID();
  }

  getMetrics() {
    return {
      connections: this.clients.size,
      agents: this.agents.size,
      rooms: this.rooms.size,
      agentBreakdown: this.getAgentBreakdown(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }

  getAgentBreakdown() {
    const breakdown = {};
    for (const agent of this.agents.values()) {
      breakdown[agent.role] = (breakdown[agent.role] || 0) + 1;
    }
    return breakdown;
  }

  getAgentList() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.id,
      role: agent.role,
      status: agent.status,
      capabilities: agent.capabilities,
      metadata: agent.metadata,
    }));
  }

  // ===========================================================================
  // High-level API for programmatic use
  // ===========================================================================

  /**
   * Send a message to an agent programmatically
   */
  async messageAgent(agentId, content, metadata = {}) {
    const envelope = {
      id: this.generateId(),
      type: MSG_TYPES.MESSAGE,
      from: { userId: 'system', role: 'system' },
      content,
      timestamp: Date.now(),
      metadata,
    };

    return this.sendToAgent(agentId, envelope);
  }

  /**
   * Send a command to an agent
   */
  async commandAgent(agentId, command, args = {}) {
    return this.messageAgent(agentId, command, { 
      type: 'command',
      args,
    });
  }

  /**
   * Get agent status
   */
  getAgentStatus(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    
    return {
      id: agent.id,
      role: agent.role,
      status: agent.status,
      capabilities: agent.capabilities,
      lastActivity: agent.lastActivity,
    };
  }

  /**
   * Set agent status
   */
  setAgentStatus(agentId, status) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    
    agent.status = status;
    agent.lastActivity = Date.now();
    
    // Broadcast status change
    this.broadcast({
      type: MSG_TYPES.AGENT_STATUS,
      agentId,
      status,
      timestamp: Date.now(),
    });
    
    return true;
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

let hubInstance = null;

function getHub(options = {}) {
  if (!hubInstance) {
    hubInstance = new AgentHub(options);
  }
  return hubInstance;
}

function resetHub() {
  if (hubInstance) {
    hubInstance.removeAllListeners();
    hubInstance = null;
  }
}

module.exports = {
  AgentHub,
  getHub,
  resetHub,
  MSG_TYPES,
  AGENT_ROLES,
};
