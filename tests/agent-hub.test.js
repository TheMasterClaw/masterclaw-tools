/**
 * agent-hub.test.js - Tests for AgentHub WebSocket server
 * @jest-environment node
 */

const WebSocket = require('ws');
const http = require('http');
const { AgentHub, getHub, resetHub, MSG_TYPES, AGENT_ROLES } = require('../lib/agent-hub');

describe('AgentHub', () => {
  let hub;
  const TEST_PORT = 18765; // Use different port to avoid conflicts

  beforeEach(async () => {
    resetHub();
    hub = new AgentHub({ 
      port: TEST_PORT, 
      host: '127.0.0.1',
      requireAuth: false,
      metering: false,
    });
  });

  afterEach(async () => {
    if (hub) {
      await hub.stop();
      resetHub();
    }
  });

  describe('Server Lifecycle', () => {
    test('should start and stop server', async () => {
      await hub.start();
      expect(hub.server).toBeTruthy();
      expect(hub.wss).toBeTruthy();
    });

    test('should respond to health check', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${TEST_PORT}/health`, (res) => {
          expect(res.statusCode).toBe(200);
          
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const response = JSON.parse(data);
            expect(response.status).toBe('healthy');
            expect(response.connections).toBe(0);
            expect(response.agents).toBe(0);
            resolve();
          });
        }).on('error', reject);
      });
    });

    test('should respond to metrics endpoint', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${TEST_PORT}/metrics`, (res) => {
          expect(res.statusCode).toBe(200);
          
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            const response = JSON.parse(data);
            expect(response.connections).toBeDefined();
            expect(response.agents).toBeDefined();
            expect(response.rooms).toBeDefined();
            resolve();
          });
        }).on('error', reject);
      });
    });
  });

  describe('WebSocket Connections', () => {
    test('should accept WebSocket connections', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        
        ws.on('open', () => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
        });
        
        ws.on('close', () => resolve());
        ws.on('error', reject);
      });
    });

    test('should send welcome message on connect', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          expect(message.type).toBe(MSG_TYPES.AUTH_SUCCESS);
          expect(message.clientId).toBeDefined();
          ws.close();
          resolve();
        });
        
        ws.on('error', reject);
      });
    });

    test('should handle agent registration', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        let registered = false;
        
        ws.on('open', () => {
          // First auth
          ws.send(JSON.stringify({
            type: MSG_TYPES.AUTH,
            userId: 'test-user',
          }));
          
          setTimeout(() => {
            ws.send(JSON.stringify({
              type: MSG_TYPES.AGENT_REGISTER,
              agentId: 'test-agent-1',
              role: AGENT_ROLES.CODER,
              capabilities: ['javascript', 'nodejs'],
            }));
          }, 100);
        });
        
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString());
          
          if (message.type === MSG_TYPES.AGENT_READY) {
            expect(message.agentId).toBe('test-agent-1');
            registered = true;
            
            // Verify agent is in hub
            const agent = hub.agents.get('test-agent-1');
            expect(agent).toBeDefined();
            expect(agent.role).toBe(AGENT_ROLES.CODER);
            
            ws.close();
            resolve();
          }
        });
        
        ws.on('close', () => {
          if (!registered) reject(new Error('Agent not registered'));
        });
        
        ws.on('error', reject);
      });
    });

    test('should handle messages between agents', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        let client1Id, client2Id;
        let messagesReceived = 0;
        
        ws1.on('open', () => {
          ws1.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'user1' }));
        });
        
        ws2.on('open', () => {
          ws2.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'user2' }));
        });
        
        ws1.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            client1Id = msg.clientId;
            
            // Join room
            ws1.send(JSON.stringify({
              type: MSG_TYPES.JOIN_ROOM,
              roomId: 'test-room',
            }));
          } else if (msg.type === MSG_TYPES.MESSAGE) {
            expect(msg.content).toBe('Hello from user2');
            messagesReceived++;
            ws1.close();
            ws2.close();
            resolve();
          }
        });
        
        ws2.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            client2Id = msg.clientId;
            
            // Join same room
            setTimeout(() => {
              ws2.send(JSON.stringify({
                type: MSG_TYPES.JOIN_ROOM,
                roomId: 'test-room',
              }));
              
              // Send message
              setTimeout(() => {
                ws2.send(JSON.stringify({
                  type: MSG_TYPES.MESSAGE,
                  roomId: 'test-room',
                  content: 'Hello from user2',
                }));
              }, 100);
            }, 100);
          }
        });
        
        setTimeout(() => {
          ws1.close();
          ws2.close();
          reject(new Error('Timeout'));
        }, 5000);
      });
    });
  });

  describe('Room Management', () => {
    test('should track room membership', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'test-user' }));
        });
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            ws.send(JSON.stringify({
              type: MSG_TYPES.JOIN_ROOM,
              roomId: 'room-1',
            }));
            
            setTimeout(() => {
              const room = hub.rooms.get('room-1');
              expect(room).toBeDefined();
              expect(room.size).toBe(1);
              ws.close();
              resolve();
            }, 100);
          }
        });
        
        ws.on('error', reject);
      });
    });

    test('should send room history on join', async () => {
      await hub.start();
      
      // Pre-populate history
      hub.storeMessage('history-room', {
        id: 'msg-1',
        type: MSG_TYPES.MESSAGE,
        content: 'Previous message',
        timestamp: Date.now(),
      });
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'test-user' }));
        });
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            ws.send(JSON.stringify({
              type: MSG_TYPES.JOIN_ROOM,
              roomId: 'history-room',
            }));
          } else if (msg.type === 'room_history') {
            expect(msg.roomId).toBe('history-room');
            expect(msg.messages.length).toBe(1);
            expect(msg.messages[0].content).toBe('Previous message');
            ws.close();
            resolve();
          }
        });
        
        ws.on('error', reject);
      });
    });
  });

  describe('Agent Management', () => {
    test('should get agent list', async () => {
      await hub.start();
      
      // Register some agents
      hub.agents.set('agent-1', {
        id: 'agent-1',
        role: AGENT_ROLES.CODER,
        capabilities: ['js'],
        status: 'ready',
      });
      
      hub.agents.set('agent-2', {
        id: 'agent-2',
        role: AGENT_ROLES.TESTER,
        capabilities: ['jest'],
        status: 'ready',
      });
      
      const agentList = hub.getAgentList();
      expect(agentList.length).toBe(2);
      expect(agentList[0].role).toBeDefined();
      expect(agentList[0].capabilities).toBeDefined();
    });

    test('should get agent breakdown', async () => {
      await hub.start();
      
      hub.agents.set('agent-1', { id: 'agent-1', role: AGENT_ROLES.CODER });
      hub.agents.set('agent-2', { id: 'agent-2', role: AGENT_ROLES.CODER });
      hub.agents.set('agent-3', { id: 'agent-3', role: AGENT_ROLES.TESTER });
      
      const breakdown = hub.getAgentBreakdown();
      expect(breakdown[AGENT_ROLES.CODER]).toBe(2);
      expect(breakdown[AGENT_ROLES.TESTER]).toBe(1);
    });

    test('should message agent programmatically', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        let agentId;
        
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'test-user' }));
        });
        
        ws.on('message', async (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            ws.send(JSON.stringify({
              type: MSG_TYPES.AGENT_REGISTER,
              agentId: 'target-agent',
              role: AGENT_ROLES.GENERAL,
            }));
          } else if (msg.type === MSG_TYPES.AGENT_READY) {
            agentId = msg.agentId;
            
            // Send message programmatically
            const sent = await hub.messageAgent(agentId, 'Hello from system', { priority: 'high' });
            expect(sent).toBe(true);
          } else if (msg.type === MSG_TYPES.MESSAGE) {
            expect(msg.content).toBe('Hello from system');
            expect(msg.metadata.priority).toBe('high');
            ws.close();
            resolve();
          }
        });
        
        ws.on('error', reject);
        
        setTimeout(() => {
          ws.close();
          reject(new Error('Timeout waiting for message'));
        }, 3000);
      });
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce rate limits', async () => {
      await hub.start();
      
      const mockClient = {
        id: 'test-client',
        rateLimit: null,
      };
      
      // Should allow under limit
      const check1 = await hub.checkRateLimit(mockClient);
      expect(check1.allowed).toBe(true);
      
      // Simulate many requests
      for (let i = 0; i < 101; i++) {
        await hub.checkRateLimit(mockClient);
      }
      
      // Should block over limit
      const check2 = await hub.checkRateLimit(mockClient);
      expect(check2.allowed).toBe(false);
      expect(check2.retryAfter).toBeDefined();
    });
  });

  describe('Input Validation', () => {
    test('should reject invalid agent roles', async () => {
      await hub.start();
      
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
        let resolved = false;
        
        const timeout = setTimeout(() => {
          if (!resolved) {
            ws.terminate();
            // Check that agent was NOT registered
            const agent = hub.agents.get('bad-agent');
            if (!agent) {
              resolved = true;
              resolve();
            } else {
              reject(new Error('Invalid agent was registered'));
            }
          }
        }, 1000);
        
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: MSG_TYPES.AUTH, userId: 'test-user' }));
        });
        
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === MSG_TYPES.AUTH_SUCCESS) {
            ws.send(JSON.stringify({
              type: MSG_TYPES.AGENT_REGISTER,
              agentId: 'bad-agent',
              role: 'invalid-role',
            }));
          } else if (msg.type === MSG_TYPES.ERROR) {
            // Verify agent was not registered
            const agent = hub.agents.get('bad-agent');
            if (!agent) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          } else if (msg.type === MSG_TYPES.AGENT_READY) {
            // Should not receive this for invalid role
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            reject(new Error('Agent registered with invalid role'));
          }
        });
        
        ws.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    });
  });
});
